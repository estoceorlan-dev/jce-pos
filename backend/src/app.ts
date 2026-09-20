import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import type { Logger } from 'pino';
import { APP_VERSION, SCHEMA_VERSION } from '@jce/shared';
import { openapi } from './openapi.js';

export const defaultFrontend = fileURLToPath(
  new URL('../../frontend/dist', import.meta.url),
);
export function createApp({
  ready,
  logger,
  frontendDir = defaultFrontend,
}: {
  ready: () => Promise<boolean>;
  logger: Logger;
  frontendDir?: string;
}) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const requestId = randomUUID();
    res.locals['requestId'] = requestId;
    res.setHeader('X-Request-ID', requestId);
    const started = performance.now();
    res.on('finish', () =>
      logger.info(
        {
          requestId,
          method: req.method,
          status: res.statusCode,
          durationMs: Math.round(performance.now() - started),
        },
        'request completed',
      ),
    );
    // Never log URLs, headers or bodies: they may contain credentials or customer data.
    next();
  });
  app.use(
    helmet({
      strictTransportSecurity: false,
      contentSecurityPolicy: { directives: { upgradeInsecureRequests: null } },
    }),
  );
  app.use(express.json({ limit: '64kb' }));
  app.use(['/api', '/health'], (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.get('/health/live', (_req, res) => {
    res.json({ status: 'alive' });
  });
  app.get('/health/ready', async (_req, res) => {
    let healthy = false;
    try {
      healthy = await ready();
    } catch {
      /* Deliberately opaque public status. */
    }
    res
      .status(healthy ? 200 : 503)
      .json({ status: healthy ? 'ready' : 'not_ready' });
  });
  app.get('/api/v1/version', (_req, res) => {
    res.json({
      version: APP_VERSION,
      apiVersion: 'v1',
      schemaVersion: SCHEMA_VERSION,
    });
  });
  app.get('/api/v1/openapi.json', (_req, res) => {
    res.json(openapi);
  });
  const notFound: express.RequestHandler = (_req, res) => {
    res.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: 'Resource not found.',
        requestId: res.locals['requestId'],
      },
    });
  };
  app.use(['/api', '/health'], notFound);
  app.use(express.static(frontendDir, { index: false }));
  app.get('/{*path}', (req, res, next) => {
    if (
      !req.accepts('html') ||
      path.extname(req.path) ||
      !existsSync(path.join(frontendDir, 'index.html'))
    ) {
      next();
      return;
    }
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(frontendDir, 'index.html'));
  });
  app.use(notFound);
  const onError: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    const known = error as { status?: number; code?: string; type?: string };
    const status =
      known.status === 413 ? 413 : known.status === 400 ? 400 : 500;
    const code =
      status === 413
        ? 'PAYLOAD_TOO_LARGE'
        : status === 400
          ? known.code === 'INVALID_QUERY'
            ? 'INVALID_QUERY'
            : 'INVALID_REQUEST'
          : 'INTERNAL_ERROR';
    const message =
      status === 500
        ? 'An unexpected error occurred.'
        : status === 413
          ? 'Request body exceeds the size limit.'
          : 'Invalid request.';
    if (status === 500)
      logger.error(
        { requestId: res.locals['requestId'], code },
        'request failed',
      );
    res
      .status(status)
      .json({ error: { code, message, requestId: res.locals['requestId'] } });
  };
  app.use(onError);
  return app;
}
