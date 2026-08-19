import multer from 'multer';
import path from 'path';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Request } from 'express';
import { randomUUID } from 'crypto';
import config from '../config/index';
import { logger } from './logger';

// Cloudflare R2 Client (S3-compatible)
const r2Client = new S3Client({
  region: 'auto',
  endpoint: `https://${config.cloudflareR2.account_id}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: config.cloudflareR2.access_key_id!,
    secretAccessKey: config.cloudflareR2.secret_access_key!,
  },
});

const allowedTypes = /jpeg|jpg|png|gif|webp|heic|heif|ico|pdf|doc|docx/;

const storage = multer.memoryStorage();

const fileFilter = (
  _req: Request,
  file: Express.Multer.File,
  cb: multer.FileFilterCallback,
) => {
  const fileExtension = path.extname(file.originalname).toLowerCase();
  const extname = allowedTypes.test(fileExtension);

  const heicMimeTypes = [
    'image/heic',
    'image/heif',
    'image/heic-sequence',
    'image/heif-sequence',
  ];
  const isHeicFile = heicMimeTypes.includes(file.mimetype.toLowerCase());

  const isHeicExtensionWithGenericMime =
    (fileExtension === '.heic' || fileExtension === '.heif') &&
    file.mimetype === 'application/octet-stream';

  const icoMimeTypes = ['image/x-icon', 'image/vnd.microsoft.icon'];
  const isIcoFile =
    fileExtension === '.ico' ||
    icoMimeTypes.includes(file.mimetype.toLowerCase());

  const mimetype =
    allowedTypes.test(file.mimetype) ||
    isHeicFile ||
    isHeicExtensionWithGenericMime ||
    isIcoFile;

  if (extname && mimetype) {
    cb(null, true);
  } else {
    cb(
      new Error(
        'Only images (jpeg, jpg, png, gif, webp, heic, heif, ico), PDFs, and DOC/DOCX files are allowed',
      ),
    );
  }
};

const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: { fileSize: 30 * 1024 * 1024 },
});

const productMediaAllowedExtensions = /jpeg|jpg|png|gif|webp|heic|heif|ico/;

const productMediaFileFilter = (
  _req: Request,
  file: Express.Multer.File,
  cb: multer.FileFilterCallback,
) => {
  const fileExtension = path.extname(file.originalname).toLowerCase();
  const extname = productMediaAllowedExtensions.test(fileExtension);

  const heicMimeTypes = [
    'image/heic',
    'image/heif',
    'image/heic-sequence',
    'image/heif-sequence',
  ];
  const isHeicFile = heicMimeTypes.includes(file.mimetype.toLowerCase());

  const isHeicExtensionWithGenericMime =
    (fileExtension === '.heic' || fileExtension === '.heif') &&
    file.mimetype === 'application/octet-stream';

  const icoMimeTypes = ['image/x-icon', 'image/vnd.microsoft.icon'];
  const isIcoFile =
    fileExtension === '.ico' ||
    icoMimeTypes.includes(file.mimetype.toLowerCase());

  const mimetype =
    productMediaAllowedExtensions.test(file.mimetype) ||
    isHeicFile ||
    isHeicExtensionWithGenericMime ||
    isIcoFile;

  if (extname && mimetype) {
    cb(null, true);
  } else {
    cb(
      new Error(
        'Only images (jpeg, jpg, png, gif, webp, heic, heif, ico) are allowed. Use a YouTube URL for video.',
      ),
    );
  }
};

const productMediaUpload = multer({
  storage: storage,
  fileFilter: productMediaFileFilter,
  limits: { fileSize: 100 * 1024 * 1024 },
});

const accommodationMediaAllowedExtensions = /jpeg|jpg|png|gif|webp|heic|heif/;

const accommodationMediaFileFilter = (
  _req: Request,
  file: Express.Multer.File,
  cb: multer.FileFilterCallback,
) => {
  const fileExtension = path.extname(file.originalname).toLowerCase();
  const extname = accommodationMediaAllowedExtensions.test(
    fileExtension.replace('.', ''),
  );

  const heicMimeTypes = [
    'image/heic',
    'image/heif',
    'image/heic-sequence',
    'image/heif-sequence',
  ];
  const isHeicFile = heicMimeTypes.includes(file.mimetype.toLowerCase());
  const isHeicExtensionWithGenericMime =
    (fileExtension === '.heic' || fileExtension === '.heif') &&
    file.mimetype === 'application/octet-stream';

  const imageOk =
    /jpeg|jpg|png|gif|webp|heic|heif/.test(fileExtension) &&
    (/jpeg|jpg|png|gif|webp|heic|heif/.test(file.mimetype) ||
      isHeicFile ||
      isHeicExtensionWithGenericMime);

  if (extname && imageOk) {
    cb(null, true);
  } else {
    cb(new Error('Only images (jpeg, jpg, png, gif, webp, heic) are allowed'));
  }
};

const foodMediaFileFilter = (
  _req: Request,
  file: Express.Multer.File,
  cb: multer.FileFilterCallback,
) => {
  const fileExtension = path.extname(file.originalname).toLowerCase();
  const extname = /jpeg|jpg|png|gif|webp|heic|heif/.test(fileExtension);

  const heicMimeTypes = [
    'image/heic',
    'image/heif',
    'image/heic-sequence',
    'image/heif-sequence',
  ];
  const isHeicFile = heicMimeTypes.includes(file.mimetype.toLowerCase());
  const isHeicExtensionWithGenericMime =
    (fileExtension === '.heic' || fileExtension === '.heif') &&
    file.mimetype === 'application/octet-stream';

  const imageOk =
    extname &&
    (/jpeg|jpg|png|gif|webp|heic|heif/.test(file.mimetype) ||
      isHeicFile ||
      isHeicExtensionWithGenericMime);

  if (imageOk) {
    cb(null, true);
  } else {
    cb(new Error('Only images (jpeg, jpg, png, gif, webp, heic) are allowed'));
  }
};

const foodMediaUpload = multer({
  storage: storage,
  fileFilter: foodMediaFileFilter,
  limits: { fileSize: 10 * 1024 * 1024 },
});

const accommodationMediaUpload = multer({
  storage: storage,
  fileFilter: accommodationMediaFileFilter,
  limits: { fileSize: 100 * 1024 * 1024 },
});

const convertHeicToJpeg = async (
  buffer: Buffer,
): Promise<{ buffer: Buffer; mimetype: string }> => {
  try {
    const convert = await import('heic-convert');

    const convertedBuffer = await convert.default({
      buffer: buffer,
      format: 'JPEG',
      quality: 1,
    });

    const finalBuffer = Buffer.isBuffer(convertedBuffer)
      ? convertedBuffer
      : Buffer.from(convertedBuffer);

    return {
      buffer: finalBuffer,
      mimetype: 'image/jpeg',
    };
  } catch (error) {
    throw new Error(`HEIC conversion failed: ${error}`);
  }
};

const uploadToR2 = async (
  file: Express.Multer.File,
  options: { folder?: string; filename?: string } = {},
): Promise<{ url: string; key: string }> => {
  try {
    let fileBuffer = file.buffer;
    let contentType = file.mimetype;
    let fileExtension = path.extname(file.originalname);
    const isHeicFile =
      fileExtension.toLowerCase() === '.heic' ||
      fileExtension.toLowerCase() === '.heif' ||
      (file.mimetype === 'application/octet-stream' &&
        (fileExtension.toLowerCase() === '.heic' ||
          fileExtension.toLowerCase() === '.heif'));

    if (isHeicFile) {
      const converted = await convertHeicToJpeg(fileBuffer);
      fileBuffer = converted.buffer;
      contentType = converted.mimetype;
      fileExtension = '.jpg';
    }

    const fileName = options.filename || `${randomUUID()}${fileExtension}`;
    const folder = options.folder || 'uploads';
    const environmentFolder =
      config.nodeEnv === 'development' ? 'development' : '';
    const key = environmentFolder
      ? `${environmentFolder}/${folder}/${fileName}`
      : `${folder}/${fileName}`;

    const uploadParams = {
      Bucket: config.cloudflareR2.bucket_name!,
      Key: key,
      Body: fileBuffer,
      ContentType: contentType,
    };

    const command = new PutObjectCommand(uploadParams);
    await r2Client.send(command);

    // Construct public URL
    const publicUrl = config.cloudflareR2.public_url
      ? `${config.cloudflareR2.public_url}/${key}`
      : `https://${config.cloudflareR2.bucket_name}.${config.cloudflareR2.account_id}.r2.cloudflarestorage.com/${key}`;

    return {
      url: publicUrl,
      key: key,
    };
  } catch (error) {
    logger.error('Error uploading to Cloudflare R2:', error);
    throw new Error(`Cloudflare R2 upload failed: ${error}`);
  }
};

const deleteFromR2 = async (key: string): Promise<void> => {
  try {
    const deleteParams = {
      Bucket: config.cloudflareR2.bucket_name!,
      Key: key,
    };

    const command = new DeleteObjectCommand(deleteParams);
    await r2Client.send(command);
  } catch (error) {
    logger.error('Error deleting from Cloudflare R2:', error);
    throw new Error(`Failed to delete from Cloudflare R2: ${error}`);
  }
};

const deleteMultipleFromR2 = async (keys: string[]): Promise<void> => {
  try {
    if (keys.length === 0) return;

    const deleteParams = {
      Bucket: config.cloudflareR2.bucket_name!,
      Delete: {
        Objects: keys.map((key) => ({ Key: key })),
        Quiet: true,
      },
    };

    const command = new DeleteObjectsCommand(deleteParams);
    await r2Client.send(command);
  } catch (error) {
    logger.error('Error deleting multiple files from Cloudflare R2:', error);
    throw new Error(
      `Failed to delete multiple files from Cloudflare R2: ${error}`,
    );
  }
};

const extractKeyFromUrl = (url: string): string | null => {
  try {
    const urlObj = new URL(url);
    const bucketName = config.cloudflareR2.bucket_name!;

    // Handle custom domain URLs
    if (config.cloudflareR2.public_url) {
      const publicUrlObj = new URL(config.cloudflareR2.public_url);
      if (urlObj.hostname === publicUrlObj.hostname) {
        return urlObj.pathname.slice(1);
      }
    }

    // Handle standard R2 URLs
    if (urlObj.hostname.startsWith(bucketName)) {
      return urlObj.pathname.slice(1);
    } else {
      const pathParts = urlObj.pathname.split('/');
      if (pathParts[1] === bucketName) {
        return pathParts.slice(2).join('/');
      }
    }

    return null;
  } catch (error) {
    logger.error('Error extracting key from URL:', error);
    return null;
  }
};

const generateSignedUrl = async (
  key: string,
  expiresIn: number = 3600,
): Promise<string> => {
  try {
    const command = new GetObjectCommand({
      Bucket: config.cloudflareR2.bucket_name!,
      Key: key,
    });

    const signedUrl = await getSignedUrl(r2Client, command, {
      expiresIn,
    });

    return signedUrl;
  } catch (error) {
    logger.error('Error generating signed URL:', error);
    throw new Error(`Failed to generate signed URL: ${error}`);
  }
};

const createPresignedUploadUrl = async (
  key: string,
  contentType: string,
  expiresIn: number = 900,
): Promise<string> => {
  const command = new PutObjectCommand({ Bucket: config.cloudflareR2.bucket_name!, Key: key, ContentType: contentType });
  return getSignedUrl(r2Client, command, { expiresIn });
};

export {
  upload,
  productMediaUpload,
  foodMediaUpload,
  accommodationMediaUpload,
  uploadToR2,
  deleteFromR2,
  deleteMultipleFromR2,
  extractKeyFromUrl,
  generateSignedUrl,
  createPresignedUploadUrl,
  convertHeicToJpeg,
  r2Client,
};
