import type { JiraConnection as ApiConnection } from '@agile-tools/shared/contracts/api';
import { getPrismaClient, getJiraConnection } from '@agile-tools/db';
import { decryptSecret, getConfig } from '@agile-tools/shared';
import {
  createJiraClient,
  inferChangelogFetchStrategyFromServerInfo,
  JiraClientError,
  normalizeChangelogFetchStrategy,
  type JiraClient,
} from '@agile-tools/jira-client';
import { ResponseError } from '@/server/errors';

/** The Prisma JiraConnection record shape, inferred from the repository. */
type DbConnection = NonNullable<Awaited<ReturnType<typeof getJiraConnection>>>;

/**
 * Map a Prisma JiraConnection record to the API response shape.
 * Strips internal fields and converts Date values to ISO strings.
 */
export function mapConnection(conn: DbConnection): ApiConnection {
  return {
    id: conn.id,
    baseUrl: conn.baseUrl,
    ...(conn.displayName != null && { displayName: conn.displayName }),
    healthStatus: conn.healthStatus,
    ...(conn.lastValidatedAt != null && { lastValidatedAt: conn.lastValidatedAt.toISOString() }),
    ...(conn.lastHealthyAt != null && { lastHealthyAt: conn.lastHealthyAt.toISOString() }),
    ...(conn.lastErrorCode != null && { lastErrorCode: conn.lastErrorCode }),
  };
}

/**
 * Load a Jira connection scoped to the workspace, throwing a 404 Response if
 * the record does not exist.
 */
export async function requireJiraConnection(
  workspaceId: string,
  connectionId: string,
): Promise<DbConnection> {
  const prisma = getPrismaClient();
  const conn = await getJiraConnection(prisma, workspaceId, connectionId);
  if (!conn) {
    throw new ResponseError(
      Response.json(
        { code: 'NOT_FOUND', message: 'Jira connection not found.' },
        { status: 404 },
      ),
    );
  }
  return conn;
}

/**
 * Decrypt the stored PAT and return a ready JiraClient for the connection.
 */
export function createClientForConnection(conn: {
  baseUrl: string;
  encryptedSecretRef: string;
  jiraVersion?: string | null;
  jiraDeploymentType?: string | null;
  changelogStrategy?: string | null;
}): JiraClient {
  const { ENCRYPTION_KEY } = getConfig();
  const pat = decryptSecret(conn.encryptedSecretRef, ENCRYPTION_KEY);
  const changelogFetchStrategy =
    normalizeChangelogFetchStrategy(conn.changelogStrategy) ??
    (conn.jiraVersion && conn.jiraDeploymentType
      ? inferChangelogFetchStrategyFromServerInfo({
          version: conn.jiraVersion,
          deploymentType: conn.jiraDeploymentType,
        })
      : undefined);

  return createJiraClient(conn.baseUrl, pat, {
    ...(changelogFetchStrategy !== undefined ? { changelogFetchStrategy } : {}),
  });
}

/**
 * Extract a JiraClientError from an unknown thrown value.
 * Handles the case where p-retry's AbortError exposes the original error via
 * `originalError`, but in practice p-retry already unwraps AbortError before
 * rejecting — this is defensive.
 */
export function normalizeJiraError(err: unknown): JiraClientError | null {
  if (err instanceof JiraClientError) return err;
  if (err instanceof Error && 'originalError' in err) {
    const orig = (err as { originalError?: unknown }).originalError;
    if (orig instanceof JiraClientError) return orig;
  }
  return null;
}

