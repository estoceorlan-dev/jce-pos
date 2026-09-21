import { z } from 'zod';

const databaseUrl = z
  .string()
  .url()
  .refine((value) => {
    try {
      return ['postgres:', 'postgresql:'].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  });
const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: databaseUrl,
  APP_ORIGIN: z.string().url().default('https://localhost'),
  ALLOW_INSECURE_LOOPBACK: z.enum(['true', 'false']).default('false'),
  STORAGE_MONITOR_PATH: z.string().min(1).optional(),
  STORAGE_MIN_FREE_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(5 * 1024 ** 3),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'silent'])
    .default('info'),
});
export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    // Report keys only: malformed database URLs may contain credentials.
    throw new Error(
      `Invalid configuration: ${[...new Set(result.error.issues.map((issue) => issue.path.join('.')))].join(', ')}. Check .env.example.`,
    );
  }
  const data = result.data;
  const origin = new URL(data.APP_ORIGIN);
  if (origin.origin !== data.APP_ORIGIN || origin.username || origin.password)
    throw new Error('APP_ORIGIN must contain only scheme, host and port.');
  if (data.ALLOW_INSECURE_LOOPBACK === 'true') {
    if (
      data.NODE_ENV === 'production' ||
      !['127.0.0.1', 'localhost', '::1'].includes(data.HOST) ||
      origin.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)
    )
      throw new Error(
        'Insecure mode is restricted to explicit development/test loopback.',
      );
  } else if (origin.protocol !== 'https:')
    throw new Error('APP_ORIGIN requires HTTPS.');
  return data;
}
