export function readDatabaseUrl(key: string): string {
  const value = process.env[key];
  try {
    if (
      !value ||
      !['postgres:', 'postgresql:'].includes(new URL(value).protocol)
    )
      throw new Error();
    return value;
  } catch {
    throw new Error(`Invalid or missing ${key}.`);
  }
}
