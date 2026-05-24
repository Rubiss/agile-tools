import { Prisma, PrismaClient } from '@prisma/client';
import { recordDatabaseQuery, resolveDatabaseUrlFromEnv } from '@agile-tools/shared';

let _client: PrismaClient | undefined;

function queryOperation(query: string): string {
  return query.match(/^\s*(\w+)/)?.[1]?.toUpperCase() ?? 'UNKNOWN';
}

export function getPrismaClient(): PrismaClient {
  if (!_client) {
    // Resolve any DATABASE_URL_ENV_VAR indirection into process.env.DATABASE_URL
    // before Prisma reads `env("DATABASE_URL")` from the schema at client
    // construction time. Avoid calling the full getConfig() here so that
    // contexts which only need database access (e.g. some tests) don't have to
    // satisfy unrelated config like ENCRYPTION_KEY.
    resolveDatabaseUrlFromEnv();
    const client = new PrismaClient({
      log: [
        { emit: 'event', level: 'query' },
        { emit: 'stdout', level: 'warn' },
        { emit: 'stdout', level: 'error' },
      ],
    });
    client.$on('query', (event: Prisma.QueryEvent) => {
      recordDatabaseQuery({
        operation: queryOperation(event.query),
        durationSeconds: event.duration / 1000,
      });
    });
    _client = client;
  }
  return _client;
}

export async function disconnectPrisma(): Promise<void> {
  if (_client) {
    await _client.$disconnect();
    _client = undefined;
  }
}
