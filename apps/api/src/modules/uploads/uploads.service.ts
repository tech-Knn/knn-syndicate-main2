import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { env } from '@knn/config';
import { type CreativeType } from '@knn/shared';
import { AppError } from '../../lib/errors.js';
import { runScoped } from '../../lib/scope.js';
import type { AuthContext } from '../../middleware/authenticate.js';

const IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const VIDEO_MIME = new Set(['video/mp4', 'video/quicktime']);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_VIDEO_BYTES = 200 * 1024 * 1024; // 200 MB

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
};

export interface UploadResult {
  id: string;
  filename: string;
  kind: CreativeType;
  mimeType: string;
  sizeBytes: number;
}

/** Validate (type + size), persist the bytes under UPLOAD_DIR, and record the row. */
export async function storeUpload(
  auth: AuthContext,
  file: { filename: string; mimeType: string; data: Buffer },
): Promise<UploadResult> {
  const { mimeType, data } = file;

  let kind: CreativeType;
  if (IMAGE_MIME.has(mimeType)) kind = 'IMAGE';
  else if (VIDEO_MIME.has(mimeType)) kind = 'VIDEO';
  else throw new AppError(415, `Unsupported file type: ${mimeType || 'unknown'}`);

  if (data.length === 0) throw new AppError(400, 'Empty file');
  const max = kind === 'IMAGE' ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES;
  if (data.length > max) {
    throw new AppError(413, `File too large (max ${Math.round(max / 1024 / 1024)}MB)`);
  }

  const storageKey = `${randomUUID()}.${EXT_BY_MIME[mimeType] ?? 'bin'}`;
  await mkdir(env.UPLOAD_DIR, { recursive: true });
  await writeFile(join(env.UPLOAD_DIR, storageKey), data);

  return runScoped(auth, (tx) =>
    tx.upload.create({
      data: {
        orgId: auth.orgId,
        buyerId: auth.userId,
        kind,
        filename: file.filename,
        mimeType,
        sizeBytes: data.length,
        storageKey,
      },
      select: { id: true, filename: true, kind: true, mimeType: true, sizeBytes: true },
    }),
  );
}
