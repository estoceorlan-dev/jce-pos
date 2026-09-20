import pg from 'pg';
export function createPool(connectionString: string) {
  return new pg.Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 30000,
    statement_timeout: 3000,
    application_name: 'jce-pos',
  });
}
