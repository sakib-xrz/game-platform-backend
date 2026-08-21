import { randomUUID } from 'node:crypto';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import httpStatus from 'http-status';
import sharp, { Metadata } from 'sharp';
import { AdminAssetStatus, Prisma } from '@/generated/prisma/client';
import AppError from '@/errors/app-error';
import config from '@/config';
import prisma from '@/lib/prisma';
import { createPresignedUploadUrl, r2Client } from '@/utils/handle-cloudflare-r2-file';
import { sha256 } from '@/utils/hash';
import type { AdminAuditContext } from '@/modules/admin/admin.services';
import { writeAdminAudit } from '@/modules/admin/admin.services';

const MAX_ASSET_BYTES = 2 * 1024 * 1024;
const allowedContentTypes = ['image/png', 'image/jpeg', 'image/webp'] as const;
type AllowedContentType = (typeof allowedContentTypes)[number];

const requireStorage = () => {
  if (!config.cloudflareR2.account_id || !config.cloudflareR2.access_key_id || !config.cloudflareR2.secret_access_key || !config.cloudflareR2.bucket_name || !config.cloudflareR2.public_url) {
    throw new AppError(httpStatus.SERVICE_UNAVAILABLE, 'S3-compatible asset storage and CDN URL are not configured');
  }
};

const cdnUrl = (key: string): string => `${config.cloudflareR2.public_url.replace(/\/$/, '')}/${key}`;
const quarantineKey = (): string => `greedy-classic/quarantine/${randomUUID()}`;
const publishedKey = (checksum: string): string => `greedy-classic/options/sha256/${checksum}.webp`;

const normalizeOptionImage = async (file: Express.Multer.File): Promise<{ buffer: Buffer; checksum: string }> => {
  if (!allowedContentTypes.includes(file.mimetype as AllowedContentType)) throw new AppError(httpStatus.BAD_REQUEST, 'Only PNG, JPEG, and WebP assets are supported');
  if (file.size <= 0 || file.size > MAX_ASSET_BYTES) throw new AppError(httpStatus.BAD_REQUEST, 'Asset must be 2 MB or smaller');
  let metadata: Metadata;
  try { metadata = await sharp(file.buffer, { failOn: 'error', limitInputPixels: 2048 * 2048 }).metadata(); }
  catch { throw new AppError(httpStatus.BAD_REQUEST, 'Asset is not a valid decodable image'); }
  const expectedFormat: Record<AllowedContentType, string> = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp' };
  if (metadata.format !== expectedFormat[file.mimetype as AllowedContentType]) throw new AppError(httpStatus.BAD_REQUEST, 'Asset signature does not match its declared MIME type');
  if (!metadata.width || !metadata.height || metadata.width !== metadata.height || metadata.width < 256 || metadata.width > 2048) throw new AppError(httpStatus.BAD_REQUEST, 'Option assets must be square and between 256px and 2048px');
  const buffer = await sharp(file.buffer, { failOn: 'error', limitInputPixels: 2048 * 2048 }).rotate().webp({ quality: 90, effort: 4 }).toBuffer();
  if (buffer.byteLength > MAX_ASSET_BYTES) throw new AppError(httpStatus.BAD_REQUEST, 'Normalized asset must be 2 MB or smaller');
  return { buffer, checksum: sha256(buffer) };
};

const putPublishedObject = async (key: string, buffer: Buffer, checksum: string): Promise<void> => {
  await r2Client.send(new PutObjectCommand({
    Bucket: config.cloudflareR2.bucket_name,
    Key: key,
    Body: buffer,
    ContentType: 'image/webp',
    CacheControl: 'public, max-age=31536000, immutable',
    Metadata: { sha256: checksum },
  }));
};

const deleteObject = async (key: string): Promise<void> => {
  await r2Client.send(new DeleteObjectCommand({ Bucket: config.cloudflareR2.bucket_name, Key: key }));
};

const readyAssetByChecksum = (checksum: string) => prisma.adminAsset.findFirst({ where: { checksum_sha256: checksum, status: AdminAssetStatus.ready }, orderBy: { completed_at: 'asc' } });

const requireAdmin = (context: AdminAuditContext): string => {
  if (!context.admin_user_id) throw new AppError(httpStatus.UNAUTHORIZED, 'Admin identity is required');
  return context.admin_user_id;
};

const auditReuse = async (context: AdminAuditContext, asset_id: string, source: string): Promise<void> =>
  prisma.$transaction((tx) => writeAdminAudit(tx, { ...context, outcome: 'success' }, { action: 'greedy_classic.asset.reused', entity_type: 'admin_asset', entity_id: asset_id, new_values: { source } }));

const uploadAsset = async (file: Express.Multer.File | undefined, context: AdminAuditContext = {}) => {
  if (!file) throw new AppError(httpStatus.BAD_REQUEST, 'A file is required');
  const admin_user_id = requireAdmin(context);
  requireStorage();
  const normalized = await normalizeOptionImage(file);
  const existing = await readyAssetByChecksum(normalized.checksum);
  if (existing) {
    await auditReuse(context, existing.id, 'direct_upload');
    return existing;
  }
  const key = publishedKey(normalized.checksum);
  await putPublishedObject(key, normalized.buffer, normalized.checksum);
  try {
    return await prisma.$transaction(async (tx) => {
      const asset = await tx.adminAsset.create({ data: { object_key: key, bucket: config.cloudflareR2.bucket_name, content_type: 'image/webp', byte_size: normalized.buffer.byteLength, checksum_sha256: normalized.checksum, status: AdminAssetStatus.ready, cdn_url: cdnUrl(key), uploaded_by_admin_id: admin_user_id, completed_at: new Date() } });
      await writeAdminAudit(tx, { ...context, outcome: 'success' }, { action: 'greedy_classic.asset.uploaded', entity_type: 'admin_asset', entity_id: asset.id, new_values: { object_key: key, checksum_sha256: normalized.checksum, content_type: 'image/webp', byte_size: normalized.buffer.byteLength } });
      return asset;
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const raced = await readyAssetByChecksum(normalized.checksum);
      if (raced) return raced;
    }
    throw error;
  }
};

const presignAsset = async (input: { content_type: AllowedContentType; byte_size: number; checksum_sha256: string }, context: AdminAuditContext = {}) => {
  const admin_user_id = requireAdmin(context);
  requireStorage();
  const checksum = input.checksum_sha256.toLowerCase();
  const ready = await readyAssetByChecksum(checksum);
  if (ready) {
    await auditReuse(context, ready.id, 'presign_checksum');
    return { reused: true, asset_id: ready.id, object_key: ready.object_key, cdn_url: ready.cdn_url, upload_url: null, expires_in_seconds: 0 };
  }
  let asset = await prisma.adminAsset.findFirst({ where: { status: AdminAssetStatus.pending, checksum_sha256: checksum, content_type: input.content_type, byte_size: input.byte_size, uploaded_by_admin_id: admin_user_id }, orderBy: { created_at: 'desc' } });
  if (!asset) asset = await prisma.adminAsset.create({ data: { object_key: quarantineKey(), bucket: config.cloudflareR2.bucket_name, content_type: input.content_type, byte_size: input.byte_size, checksum_sha256: checksum, status: AdminAssetStatus.pending, uploaded_by_admin_id: admin_user_id } });
  const upload_url = await createPresignedUploadUrl(asset.object_key, input.content_type);
  await prisma.$transaction((tx) => writeAdminAudit(tx, { ...context, outcome: 'success' }, { action: 'greedy_classic.asset.presigned', entity_type: 'admin_asset', entity_id: asset.id, new_values: { content_type: input.content_type, byte_size: input.byte_size, checksum_sha256: checksum } }));
  return { reused: false, asset_id: asset.id, object_key: asset.object_key, upload_url, expires_in_seconds: 900 };
};

const bodyToBuffer = async (body: unknown): Promise<Buffer> => {
  if (body instanceof Buffer) {
    if (body.byteLength > MAX_ASSET_BYTES) throw new AppError(httpStatus.BAD_REQUEST, 'Uploaded asset exceeds 2 MB');
    return body;
  }
  if (body && typeof (body as { transformToByteArray?: () => Promise<Uint8Array> }).transformToByteArray === 'function') {
    const bytes = Buffer.from(await (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray());
    if (bytes.byteLength > MAX_ASSET_BYTES) throw new AppError(httpStatus.BAD_REQUEST, 'Uploaded asset exceeds 2 MB');
    return bytes;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    const buffer = Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_ASSET_BYTES) throw new AppError(httpStatus.BAD_REQUEST, 'Uploaded asset exceeds 2 MB');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
};

const completePresignedAsset = async (asset_id: string, context: AdminAuditContext = {}) => {
  const admin_user_id = requireAdmin(context);
  requireStorage();
  const asset = await prisma.adminAsset.findUnique({ where: { id: asset_id } });
  if (!asset || asset.status !== AdminAssetStatus.pending) throw new AppError(httpStatus.NOT_FOUND, 'Pending asset not found');
  let normalizedChecksum: string | undefined;
  try {
    const response = await r2Client.send(new GetObjectCommand({ Bucket: asset.bucket, Key: asset.object_key }));
    if (!response.Body) throw new AppError(httpStatus.BAD_REQUEST, 'Uploaded asset body is missing');
    if (response.ContentLength && response.ContentLength > MAX_ASSET_BYTES) throw new AppError(httpStatus.BAD_REQUEST, 'Uploaded asset exceeds 2 MB');
    const raw = await bodyToBuffer(response.Body);
    if (raw.byteLength !== asset.byte_size || sha256(raw) !== asset.checksum_sha256) throw new AppError(httpStatus.CONFLICT, 'Uploaded asset checksum or size does not match the presigned request');
    const normalized = await normalizeOptionImage({ fieldname: 'file', originalname: 'asset', encoding: '7bit', mimetype: asset.content_type, size: raw.byteLength, destination: '', filename: 'asset', path: '', buffer: raw, stream: undefined as never });
    normalizedChecksum = normalized.checksum;
    const existing = await readyAssetByChecksum(normalized.checksum);
    if (existing) {
      await deleteObject(asset.object_key);
      await prisma.$transaction(async (tx) => {
        await tx.adminAsset.update({ where: { id: asset.id }, data: { status: AdminAssetStatus.deleted } });
        await writeAdminAudit(tx, { ...context, outcome: 'success' }, { action: 'greedy_classic.asset.reused', entity_type: 'admin_asset', entity_id: existing.id, new_values: { source: 'presigned_completion', duplicate_asset_id: asset.id } });
      });
      return existing;
    }
    const key = publishedKey(normalized.checksum);
    await putPublishedObject(key, normalized.buffer, normalized.checksum);
    await deleteObject(asset.object_key);
    return await prisma.$transaction(async (tx) => {
      const updated = await tx.adminAsset.update({ where: { id: asset.id }, data: { object_key: key, content_type: 'image/webp', byte_size: normalized.buffer.byteLength, checksum_sha256: normalized.checksum, status: AdminAssetStatus.ready, cdn_url: cdnUrl(key), completed_at: new Date() } });
      await writeAdminAudit(tx, { ...context, outcome: 'success' }, { action: 'greedy_classic.asset.completed', entity_type: 'admin_asset', entity_id: asset.id, new_values: { object_key: key, checksum_sha256: normalized.checksum, byte_size: normalized.buffer.byteLength } });
      return updated;
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002' && normalizedChecksum) {
      const raced = await readyAssetByChecksum(normalizedChecksum);
      if (raced) {
        await deleteObject(asset.object_key).catch(() => undefined);
        await prisma.adminAsset.updateMany({ where: { id: asset.id, status: AdminAssetStatus.pending }, data: { status: AdminAssetStatus.deleted } });
        await auditReuse(context, raced.id, 'presigned_completion_race');
        return raced;
      }
    }
    await prisma.adminAsset.updateMany({ where: { id: asset.id, status: AdminAssetStatus.pending }, data: { status: AdminAssetStatus.rejected } }).catch(() => undefined);
    await prisma.$transaction((tx) => writeAdminAudit(tx, { ...context, outcome: 'failed' }, { action: 'greedy_classic.asset.completion_failed', entity_type: 'admin_asset', entity_id: asset.id, new_values: { reason: error instanceof Error ? error.message.slice(0, 240) : 'unknown_error' } })).catch(() => undefined);
    await deleteObject(asset.object_key).catch(() => undefined);
    throw error;
  }
};

const listAssets = async () => prisma.adminAsset.findMany({ where: { status: { not: AdminAssetStatus.deleted } }, orderBy: { created_at: 'desc' }, include: { _count: { select: { greedy_classic_options: true } } } });

const getAsset = async (asset_id: string) => {
  const asset = await prisma.adminAsset.findUnique({ where: { id: asset_id }, include: { _count: { select: { greedy_classic_options: true } } } });
  if (!asset || asset.status === AdminAssetStatus.deleted) throw new AppError(httpStatus.NOT_FOUND, 'Asset not found');
  return asset;
};

const deleteAsset = async (asset_id: string, context: AdminAuditContext = {}) => {
  requireAdmin(context);
  const asset = await prisma.adminAsset.findUnique({ where: { id: asset_id }, include: { _count: { select: { greedy_classic_options: true } } } });
  if (!asset || asset.status === AdminAssetStatus.deleted) throw new AppError(httpStatus.NOT_FOUND, 'Asset not found');
  if (asset._count.greedy_classic_options) throw new AppError(httpStatus.CONFLICT, 'An asset referenced by a configuration or historical round cannot be deleted');
  requireStorage();
  const deleted = await prisma.$transaction(async (tx) => {
    const updated = await tx.adminAsset.update({ where: { id: asset.id }, data: { status: AdminAssetStatus.deleted } });
    await writeAdminAudit(tx, { ...context, outcome: 'success' }, { action: 'greedy_classic.asset.deleted', entity_type: 'admin_asset', entity_id: asset.id, old_values: { status: asset.status, object_key: asset.object_key }, new_values: { status: AdminAssetStatus.deleted } });
    return updated;
  });
  await deleteObject(asset.object_key);
  return deleted;
};

export default { uploadAsset, presignAsset, completePresignedAsset, listAssets, getAsset, deleteAsset };
