import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import pino from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { paginationSchema } from '@jce/shared';
import { createApp } from '../../backend/src/app.js';
import { validateQuery } from '../../backend/src/middleware/validation.js';

let frontendDir: string;
beforeAll(async () => {
  frontendDir = await mkdtemp(path.join(tmpdir(), 'jce-shell-'));
  await writeFile(
    path.join(frontendDir, 'index.html'),
    '<html>JCE application shell</html>',
  );
});
afterAll(async () => {
  await rm(frontendDir, { recursive: true, force: true });
});
const logger = pino({ level: 'silent' });
describe('HTTP boundaries', () => {
  it('serves SPA navigation but never masks missing APIs or assets', async () => {
    const app = createApp({ ready: async () => true, logger, frontendDir });
    expect(
      (await request(app).get('/workstation').set('Accept', 'text/html')).text,
    ).toContain('JCE application shell');
    for (const route of [
      '/api',
      '/api/v1/missing',
      '/health/missing',
      '/assets/missing.js',
    ]) {
      const response = await request(app).get(route).set('Accept', 'text/html');
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
      expect(response.body.error.requestId).toBe(
        response.headers['x-request-id'],
      );
    }
  });
  it('keeps liveness separate from readiness and hides infrastructure failures', async () => {
    const app = createApp({
      ready: async () => {
        throw new Error('password=hidden');
      },
      logger,
      frontendDir,
    });
    expect((await request(app).get('/health/live')).status).toBe(200);
    const response = await request(app).get('/health/ready');
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ status: 'not_ready' });
    expect(response.headers['cache-control']).toBe('no-store');
    expect((await request(app).get('/api/v1/version')).body.version).toBe(
      '0.1.0',
    );
    expect((await request(app).get('/api/v1/openapi.json')).body.openapi).toBe(
      '3.1.0',
    );
  });
  it('rejects malformed and oversized JSON with consistent errors', async () => {
    const app = createApp({ ready: async () => true, logger, frontendDir });
    const malformed = await request(app)
      .post('/api/v1/unknown')
      .set('Content-Type', 'application/json')
      .send('{password:secret');
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe('INVALID_REQUEST');
    expect(malformed.text).not.toContain('secret');
    const oversized = await request(app)
      .post('/api/v1/unknown')
      .send({ value: 'x'.repeat(70000) });
    expect(oversized.status).toBe(413);
    expect(oversized.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });
  it('validates pagination before passing typed values to a route', async () => {
    const app = express();
    app.get('/list', validateQuery(paginationSchema), (_req, res) =>
      res.json(res.locals['query']),
    );
    expect((await request(app).get('/list?limit=101')).status).toBe(400);
    expect((await request(app).get('/list?limit=10&page=2')).body).toEqual({
      limit: 10,
      page: 2,
    });
  });
  it('does not log query strings, credentials, bodies or caller request IDs', async () => {
    const lines: string[] = [];
    const log = pino(
      { level: 'info' },
      {
        write: (line: string) => {
          lines.push(line);
        },
      },
    );
    const app = createApp({
      ready: async () => true,
      logger: log,
      frontendDir,
    });
    const response = await request(app)
      .get('/api/v1/version?token=secret')
      .set('Authorization', 'Bearer secret')
      .set('X-Request-ID', 'attacker');
    expect(response.headers['x-request-id']).not.toBe('attacker');
    expect(lines.join('')).not.toMatch(/secret|attacker|Bearer/);
    expect(lines.join('')).toContain(response.headers['x-request-id']);
  });
});
