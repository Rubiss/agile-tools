import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { getConfig, resetConfig, resolveDatabaseUrlFromEnv } from './config.js';

const ORIGINAL_ENV = { ...process.env };

describe('getConfig', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    resetConfig();
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
    resetConfig();
  });

  it('returns defaults for optional values', () => {
    process.env['DATABASE_URL'] = 'postgresql://localhost:5432/agile_tools';
    process.env['ENCRYPTION_KEY'] = '12345678901234567890123456789012';
    delete process.env['LOG_LEVEL'];
    delete process.env['PORT'];
    delete process.env['DEFAULT_SYNC_INTERVAL_MINUTES'];
    delete process.env['SYNC_PUBLISH_TRANSACTION_TIMEOUT_MS'];
    delete process.env['SYNC_PUBLISH_TRANSACTION_MAX_WAIT_MS'];

    const config = getConfig();

    expect(config.NODE_ENV).toBe('test');
    expect(config.LOG_LEVEL).toBe('info');
    expect(config.PORT).toBe(3000);
    expect(config.DEFAULT_SYNC_INTERVAL_MINUTES).toBe(10);
    expect(config.SYNC_PUBLISH_TRANSACTION_TIMEOUT_MS).toBe(10 * 60 * 1000);
    expect(config.SYNC_PUBLISH_TRANSACTION_MAX_WAIT_MS).toBe(30_000);
  });

  it('caches the parsed result until resetConfig is called', () => {
    process.env['DATABASE_URL'] = 'postgresql://localhost:5432/one';
    process.env['ENCRYPTION_KEY'] = '12345678901234567890123456789012';

    const first = getConfig();

    process.env['DATABASE_URL'] = 'postgresql://localhost:5432/two';

    const second = getConfig();

    expect(second).toBe(first);
    expect(second.DATABASE_URL).toBe('postgresql://localhost:5432/one');

    resetConfig();

    const third = getConfig();
    expect(third.DATABASE_URL).toBe('postgresql://localhost:5432/two');
  });

  it('throws a readable error when required values are missing or invalid', () => {
    delete process.env['DATABASE_URL'];
    process.env['ENCRYPTION_KEY'] = 'too-short';

    expect(() => getConfig()).toThrowError(/DATABASE_URL|ENCRYPTION_KEY/);
  });

  it('resolves DATABASE_URL from the variable named by DATABASE_URL_ENV_VAR', () => {
    delete process.env['DATABASE_URL'];
    process.env['ENCRYPTION_KEY'] = '12345678901234567890123456789012';
    process.env['DATABASE_URL_ENV_VAR'] = 'XYZ_POSTGRESQL_URI';
    process.env['XYZ_POSTGRESQL_URI'] = 'postgresql://injected-host:5432/agile_tools';

    const config = getConfig();

    expect(config.DATABASE_URL).toBe('postgresql://injected-host:5432/agile_tools');
    // Side effect: DATABASE_URL is exported into process.env so libraries that
    // read it directly (e.g. Prisma) see the resolved value.
    expect(process.env['DATABASE_URL']).toBe('postgresql://injected-host:5432/agile_tools');
  });

  it('throws a clear error when DATABASE_URL_ENV_VAR points to a missing variable', () => {
    delete process.env['DATABASE_URL'];
    process.env['ENCRYPTION_KEY'] = '12345678901234567890123456789012';
    process.env['DATABASE_URL_ENV_VAR'] = 'MISSING_POSTGRESQL_URI';
    delete process.env['MISSING_POSTGRESQL_URI'];

    expect(() => getConfig()).toThrowError(
      /DATABASE_URL_ENV_VAR.*MISSING_POSTGRESQL_URI.*not set or is empty/,
    );
  });

  it('throws a clear error when DATABASE_URL_ENV_VAR points to an empty variable', () => {
    delete process.env['DATABASE_URL'];
    process.env['ENCRYPTION_KEY'] = '12345678901234567890123456789012';
    process.env['DATABASE_URL_ENV_VAR'] = 'EMPTY_POSTGRESQL_URI';
    process.env['EMPTY_POSTGRESQL_URI'] = '';

    expect(() => getConfig()).toThrowError(
      /DATABASE_URL_ENV_VAR.*EMPTY_POSTGRESQL_URI.*not set or is empty/,
    );
  });

  it('throws a clear error when DATABASE_URL_ENV_VAR is not a valid identifier', () => {
    delete process.env['DATABASE_URL'];
    process.env['ENCRYPTION_KEY'] = '12345678901234567890123456789012';
    process.env['DATABASE_URL_ENV_VAR'] = 'BAD-NAME$(whoami)';

    expect(() => getConfig()).toThrowError(
      /DATABASE_URL_ENV_VAR.*is not a valid environment variable name/,
    );
  });

  it('treats an empty DATABASE_URL_ENV_VAR as unset and falls back to DATABASE_URL', () => {
    process.env['DATABASE_URL'] = 'postgresql://localhost:5432/agile_tools';
    process.env['ENCRYPTION_KEY'] = '12345678901234567890123456789012';
    process.env['DATABASE_URL_ENV_VAR'] = '';

    const config = getConfig();

    expect(config.DATABASE_URL).toBe('postgresql://localhost:5432/agile_tools');
  });

  it('treats DATABASE_URL_ENV_VAR=DATABASE_URL as a no-op', () => {
    process.env['DATABASE_URL'] = 'postgresql://localhost:5432/agile_tools';
    process.env['ENCRYPTION_KEY'] = '12345678901234567890123456789012';
    process.env['DATABASE_URL_ENV_VAR'] = 'DATABASE_URL';

    const config = getConfig();

    expect(config.DATABASE_URL).toBe('postgresql://localhost:5432/agile_tools');
  });
});

describe('resolveDatabaseUrlFromEnv', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    resetConfig();
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
    resetConfig();
  });

  it('resolves DATABASE_URL from the configured source variable without requiring unrelated config like ENCRYPTION_KEY', () => {
    // DB-only consumers (e.g. getPrismaClient) need to run the indirection
    // without triggering full configSchema validation. ENCRYPTION_KEY is
    // intentionally absent here.
    delete process.env['DATABASE_URL'];
    delete process.env['ENCRYPTION_KEY'];
    process.env['DATABASE_URL_ENV_VAR'] = 'XYZ_POSTGRESQL_URI';
    process.env['XYZ_POSTGRESQL_URI'] = 'postgresql://injected-host:5432/agile_tools';

    expect(() => resolveDatabaseUrlFromEnv()).not.toThrow();
    expect(process.env['DATABASE_URL']).toBe('postgresql://injected-host:5432/agile_tools');
  });

  it('is a no-op when DATABASE_URL_ENV_VAR is unset', () => {
    process.env['DATABASE_URL'] = 'postgresql://localhost:5432/agile_tools';
    delete process.env['DATABASE_URL_ENV_VAR'];

    resolveDatabaseUrlFromEnv();

    expect(process.env['DATABASE_URL']).toBe('postgresql://localhost:5432/agile_tools');
  });

  it('is a no-op when DATABASE_URL_ENV_VAR is empty', () => {
    process.env['DATABASE_URL'] = 'postgresql://localhost:5432/agile_tools';
    process.env['DATABASE_URL_ENV_VAR'] = '';

    resolveDatabaseUrlFromEnv();

    expect(process.env['DATABASE_URL']).toBe('postgresql://localhost:5432/agile_tools');
  });

  it('is a no-op when DATABASE_URL_ENV_VAR=DATABASE_URL', () => {
    process.env['DATABASE_URL'] = 'postgresql://localhost:5432/agile_tools';
    process.env['DATABASE_URL_ENV_VAR'] = 'DATABASE_URL';

    resolveDatabaseUrlFromEnv();

    expect(process.env['DATABASE_URL']).toBe('postgresql://localhost:5432/agile_tools');
  });

  it('throws when DATABASE_URL_ENV_VAR is not a valid identifier', () => {
    process.env['DATABASE_URL_ENV_VAR'] = 'BAD-NAME$(whoami)';

    expect(() => resolveDatabaseUrlFromEnv()).toThrowError(
      /DATABASE_URL_ENV_VAR.*is not a valid environment variable name/,
    );
  });

  it('throws when DATABASE_URL_ENV_VAR points to a missing variable', () => {
    process.env['DATABASE_URL_ENV_VAR'] = 'MISSING_POSTGRESQL_URI';
    delete process.env['MISSING_POSTGRESQL_URI'];

    expect(() => resolveDatabaseUrlFromEnv()).toThrowError(
      /DATABASE_URL_ENV_VAR.*MISSING_POSTGRESQL_URI.*not set or is empty/,
    );
  });

  it('throws when DATABASE_URL_ENV_VAR points to an empty variable', () => {
    process.env['DATABASE_URL_ENV_VAR'] = 'EMPTY_POSTGRESQL_URI';
    process.env['EMPTY_POSTGRESQL_URI'] = '';

    expect(() => resolveDatabaseUrlFromEnv()).toThrowError(
      /DATABASE_URL_ENV_VAR.*EMPTY_POSTGRESQL_URI.*not set or is empty/,
    );
  });
});