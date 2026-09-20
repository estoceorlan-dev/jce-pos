import type { z } from 'zod';
export async function getJson<T>(
  path: string,
  schema: z.ZodType<T>,
): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    signal: AbortSignal.timeout(5000),
    headers: { Accept: 'application/json' },
  });
  if (!response.ok)
    throw new Error(
      'The local service is not ready. Check the branch host and try again.',
    );
  return schema.parse(await response.json());
}
