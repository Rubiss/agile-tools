import { Prisma, type PrismaClient, type SyncRun, type SyncRunTrigger, type SyncRunStatus } from '@prisma/client';

type SyncRunClient = PrismaClient | Prisma.TransactionClient;
type SyncRunFindFirstClient = {
  syncRun: Pick<SyncRunClient['syncRun'], 'findFirst'>;
};

export const STALE_ACTIVE_SYNC_RUN_TIMEOUT_MS = 60 * 60 * 1000;
const ACTIVE_SYNC_RUN_STATUSES: SyncRunStatus[] = ['queued', 'running'];
const STALE_ACTIVE_SYNC_ERROR_CODE = 'SYNC_STALE_TIMEOUT';
const STALE_ACTIVE_SYNC_ERROR_SUMMARY =
  'Auto-failed a stale queued or running sync after it exceeded the 60-minute timeout.';

export interface CreateSyncRunInput {
  scopeId: string;
  trigger: SyncRunTrigger;
  requestedBy?: string;
}

export async function createSyncRun(
  client: SyncRunClient,
  input: CreateSyncRunInput,
): Promise<SyncRun> {
  return client.syncRun.create({
    data: {
      scopeId: input.scopeId,
      trigger: input.trigger,
      ...(input.requestedBy !== undefined && { requestedBy: input.requestedBy }),
    },
  });
}

/**
 * Look up a single sync run by ID, scoped to the workspace via the parent FlowScope relation.
 * Returns null if not found or if the run does not belong to the workspace.
 */
export async function getSyncRun(
  client: SyncRunClient,
  workspaceId: string,
  syncRunId: string,
): Promise<SyncRun | null> {
  return client.syncRun.findFirst({
    where: {
      id: syncRunId,
      scope: { workspaceId },
    },
  });
}

export async function listSyncRuns(
  client: SyncRunClient,
  workspaceId: string,
  scopeId: string,
  limit = 50,
): Promise<SyncRun[]> {
  return client.syncRun.findMany({
    where: {
      scopeId,
      scope: { workspaceId },
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}

export interface UpdateSyncRunInput {
  status?: SyncRunStatus;
  startedAt?: Date;
  finishedAt?: Date;
  dataVersion?: string | null;
  errorCode?: string | null;
  errorSummary?: string | null;
}

/**
 * Update a subset of SyncRun fields. Undefined values are left unchanged;
 * explicit null values clear the column.
 */
export async function updateSyncRun(
  client: SyncRunClient,
  syncRunId: string,
  input: UpdateSyncRunInput,
): Promise<SyncRun> {
  const data: Prisma.SyncRunUpdateInput = {};
  if (input.status !== undefined) data.status = input.status;
  if (input.startedAt !== undefined) data.startedAt = input.startedAt;
  if (input.finishedAt !== undefined) data.finishedAt = input.finishedAt;
  if (input.dataVersion !== undefined) data.dataVersion = input.dataVersion;
  if (input.errorCode !== undefined) data.errorCode = input.errorCode;
  if (input.errorSummary !== undefined) data.errorSummary = input.errorSummary;

  return client.syncRun.update({ where: { id: syncRunId }, data });
}

/**
 * Return the most recent successfully completed sync run that published a
 * dataVersion for a scope, or null if none exists yet.
 * Used to pin analytics projections to a stable snapshot.
 */
export async function getLastSucceededSyncRun(
  client: SyncRunClient,
  workspaceId: string,
  scopeId: string,
): Promise<SyncRun | null> {
  return client.syncRun.findFirst({
    where: {
      scopeId,
      scope: { workspaceId },
      status: 'succeeded',
      dataVersion: { not: null },
    },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Return the most recent terminal sync run for a scope, ordered by when it
 * actually finished instead of when it was created.
 */
export async function getLastFinishedSyncRun(
  client: SyncRunFindFirstClient,
  workspaceId: string,
  scopeId: string,
): Promise<SyncRun | null> {
  return client.syncRun.findFirst({
    where: {
      scopeId,
      scope: { workspaceId },
      status: { in: ['succeeded', 'failed', 'canceled'] },
      finishedAt: { not: null },
    },
    orderBy: { finishedAt: 'desc' },
  });
}

/**
 * Return the succeeded sync run that published a specific dataVersion for a scope.
 * Used to validate client-supplied dataVersion pins and retrieve the correct syncedAt.
 * Returns null if no matching succeeded sync run exists for this scope/workspace.
 */
export async function getSyncRunByDataVersion(
  client: SyncRunClient,
  workspaceId: string,
  scopeId: string,
  dataVersion: string,
): Promise<SyncRun | null> {
  return client.syncRun.findFirst({
    where: {
      scopeId,
      scope: { workspaceId },
      dataVersion,
      status: 'succeeded',
    },
  });
}

/**
 * @deprecated Prefer `resolveActiveSyncRun` after acquiring the per-scope sync
 * lock so stale active runs are recovered before conflict decisions are made.
 */
export async function getActiveSyncRun(
  client: SyncRunClient,
  workspaceId: string,
  scopeId: string,
): Promise<SyncRun | null> {
  return client.syncRun.findFirst({
    where: {
      scopeId,
      scope: { workspaceId },
      status: { in: ACTIVE_SYNC_RUN_STATUSES },
    },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Resolve queued/running sync rows for a scope after the per-scope advisory lock
 * has been acquired. Stale active rows are failed in-place and excluded from the
 * returned result.
 */
export async function resolveActiveSyncRun(
  client: SyncRunClient,
  workspaceId: string,
  scopeId: string,
  now = new Date(),
): Promise<SyncRun | null> {
  const staleCutoff = new Date(now.getTime() - STALE_ACTIVE_SYNC_RUN_TIMEOUT_MS);

  await client.syncRun.updateMany({
    where: {
      scopeId,
      scope: { workspaceId },
      OR: [
        {
          status: 'queued',
          createdAt: { lte: staleCutoff },
        },
        {
          status: 'running',
          updatedAt: { lte: staleCutoff },
        },
      ],
    },
    data: {
      status: 'failed',
      finishedAt: now,
      errorCode: STALE_ACTIVE_SYNC_ERROR_CODE,
      errorSummary: STALE_ACTIVE_SYNC_ERROR_SUMMARY,
    },
  });

  return client.syncRun.findFirst({
    where: {
      scopeId,
      scope: { workspaceId },
      status: { in: ACTIVE_SYNC_RUN_STATUSES },
    },
    orderBy: { createdAt: 'desc' },
  });
}

export async function acquireScopeSyncLock(
  client: Prisma.TransactionClient,
  scopeId: string,
): Promise<void> {
  await client.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${scopeId}, 0))`;
}
