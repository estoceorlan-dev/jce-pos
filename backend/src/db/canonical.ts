import { createHash } from 'node:crypto';

export type Json =
  null | boolean | string | number | Json[] | { [key: string]: Json };
export function canonicalJson(value: unknown): string {
  const seen = new Set<object>();
  function encode(item: unknown, depth: number): string {
    if (depth > 30) throw new Error('JSON nesting limit exceeded.');
    if (item === null || typeof item === 'string' || typeof item === 'boolean')
      return JSON.stringify(item);
    if (typeof item === 'number' && Number.isSafeInteger(item))
      return JSON.stringify(item);
    if (typeof item !== 'object' || item === null || seen.has(item))
      throw new Error('Use finite JSON values; decimals must be strings.');
    seen.add(item);
    let result: string;
    if (Array.isArray(item)) {
      // Reject holes rather than silently hashing them like null/undefined.
      result =
        '[' +
        Array.from({ length: item.length }, (_, i) =>
          encode(item[i], depth + 1),
        ).join(',') +
        ']';
    } else {
      if (
        Object.getPrototypeOf(item) !== Object.prototype &&
        Object.getPrototypeOf(item) !== null
      )
        throw new Error('Only plain JSON objects are allowed.');
      result =
        '{' +
        Object.keys(item)
          .sort()
          .map(
            (key) =>
              JSON.stringify(key) +
              ':' +
              encode((item as Record<string, unknown>)[key], depth + 1),
          )
          .join(',') +
        '}';
    }
    seen.delete(item);
    return result;
  }
  const result = encode(value, 0);
  if (Buffer.byteLength(result, 'utf8') > 60000)
    throw new Error('JSON payload exceeds 60000 bytes.');
  return result;
}
export function checksum(value: unknown) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
