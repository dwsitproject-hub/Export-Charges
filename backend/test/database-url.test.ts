import { describe, expect, it } from 'vitest';
import { databaseUrl, describeDatabase } from '../src/db/database-url';

describe('database connection settings', () => {
  const fields = { DB_HOST: 'pgm-x.pgsql.ap-southeast-5.rds.aliyuncs.com', DB_NAME: 'ecr', DB_USER: 'ecr_app' };

  it('takes a password with any characters from the separate fields', () => {
    const url = databaseUrl({ ...fields, DB_PASSWORD: 'p/a?s#s@w%rd :x' });
    expect(url).toBe('postgres://ecr_app:p%2Fa%3Fs%23s%40w%25rd%20%3Ax@pgm-x.pgsql.ap-southeast-5.rds.aliyuncs.com:5432/ecr');
    expect(decodeURIComponent(new URL(url).password)).toBe('p/a?s#s@w%rd :x');
    expect(databaseUrl({ ...fields, DB_PASSWORD: 'x', DB_PORT: '3433', DB_SSLMODE: 'require' })).toMatch(/:3433\/ecr\?sslmode=require$/);
    expect(describeDatabase(url)).toBe('pgm-x.pgsql.ap-southeast-5.rds.aliyuncs.com:5432/ecr as ecr_app');
  });

  it('prefers DATABASE_URL and explains one that is not a valid URL', () => {
    expect(databaseUrl({ DATABASE_URL: 'postgres://a:b@h:5432/d', ...fields, DB_PASSWORD: 'x' })).toBe('postgres://a:b@h:5432/d');
    expect(() => databaseUrl({ DATABASE_URL: 'postgres://ecr:ab/c#d@host:5432/ecr' })).toThrow(/URL-encode special characters in the password/);
    expect(() => databaseUrl({ DB_HOST: 'h' })).toThrow('DB_NAME, DB_USER, DB_PASSWORD not set (needed with DB_HOST)');
    expect(() => databaseUrl({})).toThrow(/^Set DATABASE_URL, or DB_HOST/);
  });
});
