import { PrismaClient } from '@prisma/client';
import { resolveDatabaseUrlFromEnv } from '@agile-tools/shared';

let _client: PrismaClient | undefined;

export function getPrismaClient(): PrismaClient {
  if (!_client) {
    // Resolve any DATABASE_URL_ENV_VAR indirection into process.env.DATABASE_URL
    // before Prisma reads `env("DATABASE_URL")` from the schema at client
    // construction time. Avoid calling the full getConfig() here so that
    // contexts which only need database access (e.g. some tests) don't have to
    // satisfy unrelated config like ENCRYPTION_KEY.
    resolveDatabaseUrlFromEnv();
    _client = new PrismaClient({
      log:
        process.env['NODE_ENV'] === 'development'
          ? ['query', 'warn', 'error']
          : ['warn', 'error'],
    });
  }
  return _client;
}

export async function disconnectPrisma(): Promise<void> {
  if (_client) {
    await _client.$disconnect();
    _client = undefined;
  }
}
