import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import type { Logger } from 'pino';
import { APP_VERSION, SCHEMA_VERSION } from '@jce/shared';
import { openapi } from './openapi.js';
import type pg from 'pg';
import { ZodError } from 'zod';
import { managementRouter } from './management/router.js';
import { HttpError } from './management/common.js';
import type { AuthOptions } from './auth/service.js';

export const defaultFrontend = fileURLToPath(
  new URL('../../frontend/dist', import.meta.url),
);
export function createApp({
  ready,
  logger,
  frontendDir = defaultFrontend,
  database,
}: {
  ready: () => Promise<boolean>;
  logger: Logger;
  frontendDir?: string;
  database?: { pool: pg.Pool; auth: AuthOptions };
}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
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
      strictTransportSecurity:
        database && !database.auth.insecureLoopback
          ? { maxAge: 31536000 }
          : false,
      contentSecurityPolicy: {
        directives: {
          upgradeInsecureRequests:
            database && !database.auth.insecureLoopback ? [] : null,
        },
      },
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
  if (database)
    app.use('/api/v1', managementRouter(database.pool, database.auth));
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
    if (error instanceof HttpError) {
      if (error.status === 429) res.setHeader('Retry-After', '900');
      res.status(error.status).json({
        error: {
          code: error.code,
          message: error.message,
          requestId: res.locals['requestId'],
        },
      });
      return;
    }
    if (error instanceof ZodError) {
      res.status(400).json({
        error: {
          code: 'INVALID_REQUEST',
          message: 'Check the supplied fields.',
          fields: [...new Set(error.issues.map((i) => i.path.join('.')))],
          requestId: res.locals['requestId'],
        },
      });
      return;
    }
    const known = error as { status?: number; code?: string; type?: string };
    if (
      ['23505', '23503', '23514', '22003', 'IDEMPOTENCY_CONFLICT'].includes(
        known.code ?? '',
      )
    ) {
      res.status(409).json({
        error: {
          code: 'CONFLICT',
          message:
            'Duplicate, referenced, or protected record. Reload and check your changes.',
          requestId: res.locals['requestId'],
        },
      });
      return;
    }
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
