import { Router } from 'express';
import multer from 'multer';
import mongoose from 'mongoose';
import { Profile, ConnectRequest } from './models.js';
import { requireAuth } from './routes.js';
import { uploadImage, deleteImage } from './cloudinary.js';
import { notifyNewRequest } from './notify.js';

const httpErr = (status, message) => Object.assign(new Error(message), { status });
const h = fn => (req, res, next) => fn(req, res, next).catch(next);

const GENDERS = ['male', 'female', 'other'];
const LOOKING_FOR = ['one-day', 'long-term'];
const PACES = ['reserved', 'moderate', 'open'];
const CHAT = ['normal', 'open', 'anything'];
const SLOTS = [0, 1, 2, 3];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 4 },
  fileFilter: (req, file, cb) =>
    ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)
      ? cb(null, true)
      : cb(httpErr(400, 'Sirf JPG, PNG ya WebP photo allowed hai.')),
}).fields(SLOTS.map(i => ({ name: `photo${i}`, maxCount: 1 })));

// Turns multer errors (e.g. file too large) into clean 400s.
const parseUpload = (req, res, next) => upload(req, res, err => {
  if (!err) return next();
  if (err.code === 'LIMIT_FILE_SIZE') return next(httpErr(400, 'Har photo 5MB se chhoti honi chahiye.'));
  next(err.status ? err : httpErr(400, 'Photo upload nahi ho paya.'));
});

const json = (v, fallback) => { try { return JSON.parse(v); } catch { return fallback; } };
const list = (v, label, min, max) => {
  const arr = [...new Set((json(v, []) || []).map(x => String(x).trim()).filter(Boolean))];
  if (arr.length < min || arr.length > max) throw httpErr(400, `${label}: ${min} se ${max} choose karo.`);
  return arr;
};
const oneOf = (v, allowed, label) => { if (!allowed.includes(v)) throw httpErr(400, `${label} sahi se choose karo.`); return v; };

const ageFrom = dob => {
  const t = new Date(); let a = t.getFullYear() - dob.getFullYear();
  if (t < new Date(t.getFullYear(), dob.getMonth(), dob.getDate())) a -= 1;
  return a;
};

function parseFields(b) {
  const name = String(b.name || '').trim();
  if (name.length < 2 || name.length > 50) throw httpErr(400, 'Naam 2 se 50 characters ka hona chahiye.');
  const dob = new Date(b.dob);
  if (Number.isNaN(dob.getTime())) throw httpErr(400, 'Sahi date of birth daalo.');
  if (ageFrom(dob) < 18) throw httpErr(400, 'Aapki age kam se kam 18 honi chahiye.');
  const location = String(b.location || '').trim();
  if (!location || location.length > 80) throw httpErr(400, 'Location daalo.');
  const bio = String(b.bio || '').trim();
  if (bio.length > 300) throw httpErr(400, 'Bio 300 characters se chhoti rakho.');
  return {
    name, dob, location, bio,
    gender: oneOf(b.gender, GENDERS, 'Gender'),
    lookingFor: oneOf(b.lookingFor, LOOKING_FOR, 'Looking for'),
    datingPace: oneOf(b.datingPace, PACES, 'Dating pace'),
    chatComfort: oneOf(b.chatComfort, CHAT, 'Chat comfort'),
    languages: list(b.languages, 'Languages', 1, 5),
    interests: list(b.interests, 'Interests', 1, 10),
  };
}

const publicProfile = p => ({
  id: p.id, name: p.name, dob: p.dob, age: ageFrom(p.dob), gender: p.gender, location: p.location,
  languages: p.languages, interests: p.interests, lookingFor: p.lookingFor, bio: p.bio,
  datingPace: p.datingPace, chatComfort: p.chatComfort,
  photos: p.photos.map(x => ({ url: x.url, caption: x.caption })),
});

// create = true -> POST (must not exist). create = false -> PUT (must exist, photos optional per slot).
const save = create => h(async (req, res) => {
  const existing = await Profile.findOne({ userId: req.user.id });
  if (create && existing) throw httpErr(409, 'Profile pehle se bana hua hai.');
  if (!create && !existing) throw httpErr(404, 'Pehle profile banao.');

  const fields = parseFields(req.body);
  const captions = json(req.body.captions, []);
  const photos = existing ? existing.photos.map(p => ({ url: p.url, publicId: p.publicId, caption: p.caption })) : [];
  const uploaded = [], replaced = [];

  try {
    for (const i of SLOTS) {
      const file = req.files?.[`photo${i}`]?.[0];
      const caption = String(captions[i] || '').trim().slice(0, 100);
      if (file) {
        const r = await uploadImage(file.buffer, req.user.id);
        uploaded.push(r.public_id);
        if (photos[i]) replaced.push(photos[i].publicId);
        photos[i] = { url: r.secure_url, publicId: r.public_id, caption };
      } else if (photos[i]) photos[i].caption = caption;
    }
    if (!SLOTS.every(i => photos[i])) throw httpErr(400, 'Pure 4 photos upload karo.');

    const doc = existing || new Profile({ userId: req.user.id });
    Object.assign(doc, fields, { photos });
    await doc.save();
    await Promise.all(replaced.map(deleteImage)); // remove old Cloudinary images only after save succeeds
    res.status(create ? 201 : 200).json({ profile: publicProfile(doc) });
  } catch (e) {
    await Promise.all(uploaded.map(deleteImage)); // rollback new uploads on failure
    throw e;
  }
});

export const profile = Router();
profile.use(requireAuth);
profile.get('/me', h(async (req, res) => {
  const p = await Profile.findOne({ userId: req.user.id });
  res.json({ profile: p ? publicProfile(p) : null });
}));
profile.post('/', parseUpload, save(true));
profile.put('/me', parseUpload, save(false));

// Delete own profile (also removes the photos from Cloudinary).
profile.delete('/me', h(async (req, res) => {
  const p = await Profile.findOneAndDelete({ userId: req.user.id });
  if (p) await Promise.all(p.photos.map(x => deleteImage(x.publicId)));
  res.json({ ok: true });
}));

// Male sees only female, female sees only male. "other" sees everyone.
const wantedGender = g => (g === 'male' ? 'female' : g === 'female' ? 'male' : null);
export const cardProfile = p => { const { dob, ...rest } = publicProfile(p); return rest; }; // dob never leaves the server

const yearsAgo = years => { const d = new Date(); d.setFullYear(d.getFullYear() - years); return d; };
const escapeRegex = v => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Optional filters from the query string: ageMin, ageMax, city, language, interests (comma list), lookingFor.
function browseFilter(q) {
  const f = {};
  const min = parseInt(q.ageMin, 10), max = parseInt(q.ageMax, 10);
  const dob = {};
  if (min >= 18) dob.$lte = yearsAgo(min);          // at least `min` years old
  if (max >= 18) dob.$gt = yearsAgo(max + 1);       // at most `max` years old
  if (Object.keys(dob).length) f.dob = dob;
  const city = String(q.city || '').trim().slice(0, 60);
  if (city) f.location = { $regex: escapeRegex(city), $options: 'i' };
  const language = String(q.language || '').trim().slice(0, 30);
  if (language) f.languages = language;
  const interests = String(q.interests || '').split(',').map(x => x.trim()).filter(Boolean).slice(0, 12);
  if (interests.length) f.interests = { $in: interests };
  if (LOOKING_FOR.includes(q.lookingFor)) f.lookingFor = q.lookingFor;
  return f;
}

// Profiles to browse: opposite gender, not me, not already requested, plus optional filters.
profile.get('/browse', h(async (req, res) => {
  const mine = await Profile.findOne({ userId: req.user.id });
  if (!mine) throw httpErr(403, 'Pehle apna profile banao.');
  // Hide everyone I already have any link with: I sent a request, they sent me one, accepted (in Messages) or declined.
  const links = await ConnectRequest.find({ $or: [{ fromUserId: req.user._id }, { toUserId: req.user._id }] });
  const seen = links.map(l => (String(l.fromUserId) === String(req.user._id) ? l.toUserId : l.fromUserId));
  const want = wantedGender(mine.gender);
  const filter = { ...browseFilter(req.query), userId: { $nin: [req.user._id, ...seen] }, ...(want && { gender: want }) };
  const items = await Profile.find(filter).sort({ createdAt: -1 }).limit(50);
  res.json({ profiles: items.map(cardProfile) });
}));

// Send a request (optionally with a one-line note). :id is the Profile id shown in browse.
profile.post('/:id/request', h(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw httpErr(404, 'Profile nahi mila.');
  const [mine, target] = await Promise.all([Profile.findOne({ userId: req.user.id }), Profile.findById(req.params.id)]);
  if (!mine) throw httpErr(403, 'Pehle apna profile banao.');
  if (!target || target.userId.equals(req.user._id)) throw httpErr(404, 'Profile nahi mila.');
  const want = wantedGender(mine.gender);
  if (want && target.gender !== want) throw httpErr(403, 'Ye profile aapke liye available nahi hai.');
  const note = String(req.body?.note || '').trim().slice(0, 150);
  const me = req.user._id, them = target.userId;
  if (await ConnectRequest.exists({ $or: [{ fromUserId: me, toUserId: them }, { fromUserId: them, toUserId: me }] }))
    throw httpErr(409, 'Is profile ke saath pehle se request ya connection hai.');
  let doc;
  try { doc = await ConnectRequest.create({ fromUserId: req.user._id, toUserId: target.userId, note }); }
  catch (e) { if (e.code === 11000) throw httpErr(409, 'Request pehle hi bhej di hai.'); throw e; }
  notifyNewRequest(target.userId, mine, { id: doc.id, note: doc.note, createdAt: doc.createdAt, profile: cardProfile(mine) }).catch(e => console.error('Notify failed:', e.message));
  res.status(201).json({ ok: true });
}));
