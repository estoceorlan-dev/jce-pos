import { describe, it, expect } from 'vitest';
import {
  csvCell,
  parseCatalogCsv,
} from '../../backend/src/management/catalog.js';
import { readConfig } from '../../backend/src/config.js';
describe('management boundaries', () => {
  it('escapes formula prefixes, controls and quotes without changing ordinary decimal text', () => {
    for (const value of [
      '=1+1',
      ' +SUM(A1:A2)',
      '@command',
      '-1+2',
      '\tcommand',
      '\rdata',
      '  \u0001=NOW()',
    ])
      expect(csvCell(value)).toMatch(/^"'/);
    expect(csvCell('12.50')).toBe('"12.50"');
    expect(csvCell('A "quote"')).toBe('"A ""quote"""');
  });
  it('rejects malformed, duplicate/unknown headers and oversized CSV batches', () => {
    const header =
      'sku,product_name,variant_name,unit,conversion,fractional,minimum_stock,barcode,price\n';
    expect(() => parseCatalogCsv('sku,sku\nA,B')).toThrow();
    expect(() => parseCatalogCsv(header + '"broken')).toThrow();
    expect(() =>
      parseCatalogCsv(
        header +
          Array(501).fill('A,Product,Variant,Piece,1,false,0,,1').join('\n'),
      ),
    ).toThrow();
    expect(
      parseCatalogCsv(header + 'A,Product,Variant,Piece,-1,false,0,,1').errors,
    ).toHaveLength(1);
  });
  it('refuses insecure production, LAN development, and URL path origins', () => {
    const env = {
      DATABASE_URL: 'postgresql://runtime:placeholder@localhost/test',
      APP_ORIGIN: 'http://127.0.0.1:3000',
      ALLOW_INSECURE_LOOPBACK: 'true',
    };
    expect(readConfig(env).ALLOW_INSECURE_LOOPBACK).toBe('true');
    for (const override of [
      { NODE_ENV: 'production' },
      { HOST: '0.0.0.0' },
      { APP_ORIGIN: 'http://pos.lan' },
      { APP_ORIGIN: 'http://127.0.0.1:3000/path' },
      { ALLOW_INSECURE_LOOPBACK: 'false' },
    ])
      expect(() => readConfig({ ...env, ...override })).toThrow();
    expect(
      readConfig({
        ...env,
        NODE_ENV: 'production',
        ALLOW_INSECURE_LOOPBACK: 'false',
        APP_ORIGIN: 'https://pos.lan',
      }).APP_ORIGIN,
    ).toBe('https://pos.lan');
  });
});
