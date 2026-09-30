import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { env } from '@knn/config';
import { prisma, withSystem } from '@knn/db';
import { closeQueues } from '@knn/queue';
import { ROLES, USER_STATUS } from '@knn/shared';
import { hashPassword } from '../../lib/password.js';
import { buildApp } from '../../app.js';

const suffix = Date.now().toString(36);
const PW = 'upload-pw-123';
const emailA = `up-a-${suffix}@a.com`;
const emailB = `up-b-${suffix}@a.com`;

let app: FastifyInstance;
const orgIds: string[] = [];
const tokens = { a: '', b: '' };

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]);

function multipart(filename: string, mime: string, data: Buffer): { body: Buffer; contentType: string } {
  const boundary = '----knnuploadtest';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

const auth = (t: string): Record<string, string> => ({ authorization: `Bearer ${t}` });

async function upload(token: string, filename: string, mime: string, data: Buffer): Promise<string> {
  const { body, contentType } = multipart(filename, mime, data);
  const res = await app.inject({ method: 'POST', url: '/api/uploads', headers: { ...auth(token), 'content-type': contentType }, payload: body });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ upload: { id: string } }>().upload.id;
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  const pw = await hashPassword(PW);
  await withSystem(async (tx) => {
    for (const [tag, email] of [['a', emailA], ['b', emailB]] as const) {
      const org = await tx.organization.create({ data: { name: `Upload Co ${tag}`, slug: `upload-${tag}-${suffix}` } });
      orgIds.push(org.id);
      await tx.user.create({ data: { orgId: org.id, email, name: `Buyer ${tag}`, passwordHash: pw, role: ROLES.MEDIA_BUYER, status: USER_STATUS.ACTIVE } });
    }
  });
  for (const [k, email] of [['a', emailA], ['b', emailB]] as const) {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: PW } });
    tokens[k] = res.json<{ accessToken: string }>().accessToken;
  }
});

afterAll(async () => {
  const keys = await withSystem((tx) => tx.upload.findMany({ where: { orgId: { in: orgIds } }, select: { storageKey: true } }));
  await withSystem((tx) => tx.organization.deleteMany({ where: { id: { in: orgIds } } }));
  await Promise.all(keys.map((k) => rm(join(env.UPLOAD_DIR, k.storageKey), { force: true })));
  await app.close();
  await closeQueues();
  await prisma.$disconnect();
});

describe('GET /api/uploads/:id/content (creative thumbnails)', () => {
  it('serves the image back to its own company, privately cached and never sniffed', async () => {
    const id = await upload(tokens.a, 'creative.png', 'image/png', PNG);
    const res = await app.inject({ method: 'GET', url: `/api/uploads/${id}/content`, headers: auth(tokens.a) });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cache-control']).toBe('private, max-age=3600');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.rawPayload.equals(PNG)).toBe(true);
  });

  it("is a 404 for another company's upload", async () => {
    const id = await upload(tokens.a, 'mine.png', 'image/png', PNG);
    const res = await app.inject({ method: 'GET', url: `/api/uploads/${id}/content`, headers: auth(tokens.b) });
    expect(res.statusCode).toBe(404);
  });

  it('needs a login', async () => {
    const id = await upload(tokens.a, 'x.png', 'image/png', PNG);
    const res = await app.inject({ method: 'GET', url: `/api/uploads/${id}/content` });
    expect(res.statusCode).toBe(401);
  });

  it('answers a malformed id with 400 and an unknown one with 404', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/uploads/not-a-uuid/content', headers: auth(tokens.a) })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/uploads/00000000-0000-4000-8000-000000000000/content', headers: auth(tokens.a) })).statusCode).toBe(404);
  });

  it('never serves a video (only images are needed, and a video is large)', async () => {
    const id = await upload(tokens.a, 'clip.mp4', 'video/mp4', Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]));
    const res = await app.inject({ method: 'GET', url: `/api/uploads/${id}/content`, headers: auth(tokens.a) });
    expect(res.statusCode).toBe(404);
  });

  it('is a 404 when the file is gone from disk', async () => {
    const id = await upload(tokens.a, 'gone.png', 'image/png', PNG);
    const row = await withSystem((tx) => tx.upload.findUniqueOrThrow({ where: { id }, select: { storageKey: true } }));
    await rm(join(env.UPLOAD_DIR, row.storageKey), { force: true });
    const res = await app.inject({ method: 'GET', url: `/api/uploads/${id}/content`, headers: auth(tokens.a) });
    expect(res.statusCode).toBe(404);
  });
});
