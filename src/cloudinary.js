import { v2 as cloudinary } from 'cloudinary';

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Upload an image buffer (from multer memory storage) to Cloudinary.
export const uploadImage = (buffer, userId) => new Promise((resolve, reject) => {
  cloudinary.uploader.upload_stream(
    {
      folder: `kindred/profiles/${userId}`,
      resource_type: 'image',
      transformation: [{ width: 1080, height: 1350, crop: 'limit' }, { quality: 'auto', fetch_format: 'auto' }],
    },
    (err, result) => (err ? reject(err) : resolve(result)),
  ).end(buffer);
});

export const deleteImage = publicId => cloudinary.uploader.destroy(publicId).catch(() => {});