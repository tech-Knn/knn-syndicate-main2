import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '@knn/db';
import { closeQueues } from '@knn/queue';
import { buildApp } from './app.js';

describe('api app', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await closeQueues();
    await prisma.$disconnect();
  });

  it('GET / returns service info', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: 'knn-api' });
  });

  it('GET /health/live returns ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/live' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('GET /health reports db + redis up', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', checks: { db: 'up', redis: 'up' } });
  });

  it('Bull-Board requires basic auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/queues' });
    expect(res.statusCode).toBe(401);
  });
});
