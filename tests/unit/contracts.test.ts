import { describe, expect, it } from 'vitest';
import { canAccess, paginationSchema } from '@jce/shared';
import { readConfig } from '../../backend/src/config.js';

describe('configuration and shared boundaries', () => {
  it('fails clearly without leaking credentials', () => {
    expect(() =>
      readConfig({ DATABASE_URL: 'secret-password', PORT: 'bad' }),
    ).toThrow('Invalid configuration: PORT, DATABASE_URL');
    expect(() => readConfig({ DATABASE_URL: 'https://example.com' })).toThrow(
      'DATABASE_URL',
    );
    expect(() =>
      readConfig({ DATABASE_URL: 'postgres://u:p@localhost/db', PORT: '0' }),
    ).toThrow('PORT');
  });
  it('uses conservative local defaults', () => {
    expect(
      readConfig({ DATABASE_URL: 'postgres://u:p@localhost/db' }),
    ).toMatchObject({ HOST: '127.0.0.1', PORT: 3000, NODE_ENV: 'development' });
  });
  it('bounds pagination and rejects unknown or non-integer inputs', () => {
    expect(paginationSchema.parse({})).toEqual({ page: 1, limit: 25 });
    expect(paginationSchema.parse({ page: '2', limit: '100' })).toEqual({
      page: 2,
      limit: 100,
    });
    for (const query of [
      { page: 0 },
      { limit: 101 },
      { page: 10001 },
      { limit: 1.5 },
      { sort: 'password' },
      { limit: ['1', '2'] },
    ])
      expect(paginationSchema.safeParse(query).success).toBe(false);
  });
  it('navigation defaults to no grants', () => {
    expect(canAccess([], 'checkout.use')).toBe(false);
    expect(canAccess(['catalog.read'], 'checkout.use')).toBe(false);
    expect(canAccess(['catalog.read'], 'catalog.read')).toBe(true);
  });
});
