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
  MIGRATION_DATABASE_URL: databaseUrl.optional(),
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
  return result.data;
}
