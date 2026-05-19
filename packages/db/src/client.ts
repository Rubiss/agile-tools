import { PrismaClient } from '@prisma/client';
import { getConfig } from '@agile-tools/shared';

let _client: PrismaClient | undefined;

export function getPrismaClient(): PrismaClient {
  if (!_client) {
    // Ensure shared config has resolved DATABASE_URL (including any
    // DATABASE_URL_ENV_VAR indirection) into process.env before Prisma reads
    // `env("DATABASE_URL")` from the schema during client construction.
    getConfig();
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
