import mongoose from 'mongoose';
const { Schema, model } = mongoose;

// A user document exists ONLY after the email OTP has been verified.
export const User = model('User', new Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  emailVerified: { type: Boolean, default: true },
}, { timestamps: true }));

// Pending signups and password resets. Only a keyed hash of the code is stored.
const otpSchema = new Schema({
  email: { type: String, required: true, lowercase: true },
  purpose: { type: String, enum: ['signup', 'reset'], required: true },
  codeHash: String,
  passwordHash: String,            // signup only: held until verification succeeds
  attempts: { type: Number, default: 0 },
  lastSentAt: Date,
  expiresAt: { type: Date, index: { expires: 0 } }, // Mongo TTL cleanup
});
otpSchema.index({ email: 1, purpose: 1 }, { unique: true });
export const Otp = model('Otp', otpSchema);

// ---- Profile ----
const photoSchema = new Schema({
  url: { type: String, required: true },
  publicId: { type: String, required: true },   // Cloudinary id, needed for delete/replace
  caption: { type: String, trim: true, maxlength: 100, default: '' },
}, { _id: false });

export const Profile = model('Profile', new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  name: { type: String, required: true, trim: true, maxlength: 50 },
  dob: { type: Date, required: true },
  gender: { type: String, enum: ['male', 'female', 'other'], required: true },
  location: { type: String, required: true, trim: true, maxlength: 80 },
  languages: { type: [String], default: [] },
  interests: { type: [String], default: [] },
  lookingFor: { type: String, enum: ['one-day', 'long-term'], required: true },
  bio: { type: String, trim: true, maxlength: 300, default: '' },
  datingPace: { type: String, enum: ['reserved', 'moderate', 'open'], required: true },
  chatComfort: { type: String, enum: ['normal', 'open', 'anything'], required: true },
  photos: { type: [photoSchema], validate: v => v.length === 4 },
}, { timestamps: true }));

// ---- Requests between users ----
const requestSchema = new Schema({
  fromUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  toUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  status: { type: String, enum: ['pending', 'accepted', 'declined'], default: 'pending' },
  note: { type: String, trim: true, maxlength: 150, default: '' },   // one-line message sent with the request
}, { timestamps: true });
requestSchema.index({ fromUserId: 1, toUserId: 1 }, { unique: true }); // one request per pair
export const ConnectRequest = model('ConnectRequest', requestSchema);

// ---- Chat messages (named ChatMessage so it doesn't touch any old "messages" collection in your DB) ----
const chatSchema = new Schema({
  fromUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  toUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  text: { type: String, required: true, trim: true, maxlength: 1000 },
  readAt: { type: Date, default: null },   // null = unread
  cid: { type: String },                      // client-generated id: makes retries idempotent
}, { timestamps: true });
chatSchema.index({ fromUserId: 1, toUserId: 1, createdAt: -1 });
chatSchema.index({ toUserId: 1, fromUserId: 1, readAt: 1 });            // unread counts
chatSchema.index({ fromUserId: 1, cid: 1 }, { unique: true, partialFilterExpression: { cid: { $type: 'string' } } });
export const ChatMessage = model('ChatMessage', chatSchema);