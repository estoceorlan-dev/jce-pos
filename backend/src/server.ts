import { existsSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { createApp, defaultFrontend } from './app.js';
import { readConfig } from './config.js';
import { createPool } from './db/pool.js';
import { isReady } from './db/migrations.js';

try {
  const config = readConfig();
  if (
    config.NODE_ENV === 'production' &&
    !existsSync(path.join(defaultFrontend, 'index.html'))
  )
    throw new Error('Frontend assets missing. Run npm run build:server.');
  const logger = pino({ level: config.LOG_LEVEL });
  const pool = createPool(config.DATABASE_URL);
  pool.on('error', () =>
    logger.error(
      { code: 'DATABASE_CONNECTION_ERROR' },
      'database connection interrupted',
    ),
  );
  const app = createApp({ ready: () => isReady(pool), logger });
  const server = app.listen(config.PORT, config.HOST, () =>
    logger.info({ port: config.PORT }, 'JCE POS listening'),
  );
  server.on('error', () => {
    logger.fatal('Server could not listen. Check host and port.');
    void pool.end();
    process.exitCode = 1;
  });
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    logger.info('Shutting down');
    const deadline = setTimeout(() => process.exit(1), 10000).unref();
    server.close(() => {
      void pool.end().then(() => {
        clearTimeout(deadline);
      });
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Startup failed.');
  process.exitCode = 1;
}
