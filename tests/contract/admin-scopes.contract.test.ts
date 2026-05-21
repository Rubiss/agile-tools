/**
 * Contract tests for admin scope and sync routes.
 *
 * Validates that every response shape matches the contracts defined in
 * `@agile-tools/shared/contracts/api`. Uses MSW for outbound Jira calls and
 * Testcontainers Postgres for a real isolated database.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { NextRequest } from 'next/server';
import { resetConfig, encryptSecret } from '@agile-tools/shared';
import {
  getPrismaClient,
  disconnectPrisma,
  STALE_ACTIVE_SYNC_RUN_TIMEOUT_MS,
} from '@agile-tools/db';
import {
  FlowScopeSchema,
  SyncRunSchema,
  ProblemSchema,
} from '@agile-tools/shared/contracts/api';
import { startPostgres, stopPostgres } from '../integration/support/postgres';
import { jiraHandlers } from '../msw/jira-handlers';
import { serializeWorkspaceContext } from '../../apps/web/src/server/session-cookie';

// ─── Mock Next.js server-only modules ─────────────────────────────────────────

vi.mock('next/headers', () => ({
  cookies: vi.fn(),
}));

vi.mock('@/server/queue', () => ({
  enqueueScopeSyncJob: vi.fn().mockResolvedValue('test-job-id'),
}));

// ─── Lazy imports after mocks ─────────────────────────────────────────────────

const { cookies } = await import('next/headers');
const { enqueueScopeSyncJob } = await import('@/server/queue');
const { POST: createScope } = await import(
  '../../apps/web/src/app/api/v1/admin/scopes/route'
);
const { PUT: updateScope } = await import(
  '../../apps/web/src/app/api/v1/admin/scopes/[scopeId]/route'
);
const { POST: triggerSync, GET: listSyncs } = await import(
  '../../apps/web/src/app/api/v1/admin/scopes/[scopeId]/syncs/route'
);
const { DELETE: deleteScope } = await import(
  '../../apps/web/src/app/api/v1/admin/scopes/[scopeId]/route'
);

// ─── Constants ────────────────────────────────────────────────────────────────

const JIRA_BASE = 'https://jira.example.internal';
const TEST_ENCRYPTION_KEY = 'test-encryption-key-32-chars-ok!';
const TEST_SESSION_SECRET = 'contract-session-secret-1234567890';
const TEST_PAT = 'test-jira-pat';

const SCOPE_PAYLOAD = {
  boardId: 1,
  timezone: 'UTC',
  includedIssueTypeIds: ['it-1'],
  startStatusIds: ['1'],
  doneStatusIds: ['3'],
  syncIntervalMinutes: 10,
};

const mswServer = setupServer(...jiraHandlers);

// ─── Test State ───────────────────────────────────────────────────────────────

let workspaceId: string;
let connectionId: string;
let scopeId: string;
let adminCookieValue: string;

function staleActiveSyncTimestamp() {
  return new Date(Date.now() - STALE_ACTIVE_SYNC_RUN_TIMEOUT_MS - 1_000);
}

async function markSyncRunAsStaleRunning(syncRunId: string) {
  const staleAt = staleActiveSyncTimestamp();
  const db = getPrismaClient();
  await db.$executeRaw`
    UPDATE "SyncRun"
    SET "startedAt" = ${staleAt}, "updatedAt" = ${staleAt}
    WHERE id = ${syncRunId}
  `;
}

function makeCookieStore(cookieValue: string | null) {
  return {
    get: (name: string) => {
      if (name === 'agile_session' && cookieValue !== null) return { value: cookieValue };
      return undefined;
    },
  };
}

function makeRequest(url: string, method = 'GET', body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    headers: {
      Origin: 'http://localhost',
      Referer: 'http://localhost/admin/jira',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  const pg = await startPostgres();
  process.env['DATABASE_URL'] = pg.connectionUrl;
  process.env['ENCRYPTION_KEY'] = TEST_ENCRYPTION_KEY;
  process.env['SESSION_SECRET'] = TEST_SESSION_SECRET;
  process.env['NODE_ENV'] = 'test';
  resetConfig();
  await disconnectPrisma();

  mswServer.listen({ onUnhandledRequest: 'error' });

  const db = getPrismaClient();
  const workspace = await db.workspace.create({
    data: { name: 'Scope Contract Workspace', defaultTimezone: 'UTC' },
  });
  workspaceId = workspace.id;

  const encryptedSecretRef = encryptSecret(TEST_PAT, TEST_ENCRYPTION_KEY);
  const conn = await db.jiraConnection.create({
    data: { workspaceId, baseUrl: JIRA_BASE, authType: 'pat', encryptedSecretRef },
  });
  connectionId = conn.id;

  // Create a fixture scope for update / sync list tests.
  const scope = await db.flowScope.create({
    data: {
      workspaceId,
      connectionId,
      boardId: '1',
      boardName: 'Team Kanban',
      timezone: 'UTC',
      includedIssueTypeIds: ['it-1'],
      includedIssueTypeNames: ['Story'],
      startStatusIds: ['1'],
      doneStatusIds: ['3'],
      syncIntervalMinutes: 10,
    },
  });
  scopeId = scope.id;

  adminCookieValue = serializeWorkspaceContext({ userId: 'u-1', workspaceId, role: 'admin' });
});

afterAll(async () => {
  mswServer.close();
  await disconnectPrisma();
  await stopPostgres();
});

beforeEach(async () => {
  vi.mocked(cookies).mockReturnValue(makeCookieStore(adminCookieValue));
  vi.mocked(enqueueScopeSyncJob).mockResolvedValue('test-job-id');
  mswServer.resetHandlers();
  const db = getPrismaClient();
  await db.syncRun.deleteMany({ where: { scopeId } });
  await db.flowScope.update({
    where: { id: scopeId },
    data: {
      connectionId,
      boardId: '1',
      boardName: 'Team Kanban',
      timezone: 'UTC',
      includedIssueTypeIds: ['it-1'],
      includedIssueTypeNames: ['Story'],
      startStatusIds: ['1'],
      doneStatusIds: ['3'],
      syncIntervalMinutes: 10,
      status: 'active',
    },
  });
});

// ─── POST /v1/admin/scopes ────────────────────────────────────────────────────

describe('POST /v1/admin/scopes', () => {
  it('returns 201 with a FlowScope shape on valid input', async () => {
    const req = makeRequest('http://localhost/api/v1/admin/scopes', 'POST', {
      connectionId,
      ...SCOPE_PAYLOAD,
    });
    const res = await createScope(req);
    expect(res.status).toBe(201);
    const body: unknown = await res.json();
    const parsed = FlowScopeSchema.safeParse(body);
    expect(parsed.success, JSON.stringify(parsed.error)).toBe(true);
    expect(parsed.data?.boardId).toBe(1);
    expect(parsed.data?.connectionId).toBe(connectionId);
    expect(parsed.data?.includedIssueTypes).toEqual([{ id: 'it-1', name: 'Story' }]);
  });

  it('returns 400 when required fields are missing', async () => {
    const req = makeRequest('http://localhost/api/v1/admin/scopes', 'POST', {
      connectionId,
      boardId: 1,
    });
    const res = await createScope(req);
    expect(res.status).toBe(400);
    expect(ProblemSchema.safeParse(await res.json()).success).toBe(true);
  });

  it('returns 400 when startStatusIds and doneStatusIds overlap', async () => {
    const req = makeRequest('http://localhost/api/v1/admin/scopes', 'POST', {
      connectionId,
      ...SCOPE_PAYLOAD,
      startStatusIds: ['1', '2'],
      doneStatusIds: ['2', '3'],
    });
    const res = await createScope(req);
    expect(res.status).toBe(400);
  });

  it('returns 400 when the timezone identifier is invalid', async () => {
    const req = makeRequest('http://localhost/api/v1/admin/scopes', 'POST', {
      connectionId,
      ...SCOPE_PAYLOAD,
      timezone: 'ETC',
    });
    const res = await createScope(req);
    expect(res.status).toBe(400);

    const body = ProblemSchema.parse(await res.json());
    expect(body.message).toContain('timezone');
    expect(body.message).toContain('valid time zone identifier');
  });

  it('returns 404 when the connection does not exist', async () => {
    const missingId = '00000000-0000-0000-0000-000000000000';
    const req = makeRequest('http://localhost/api/v1/admin/scopes', 'POST', {
      connectionId: missingId,
      ...SCOPE_PAYLOAD,
    });
    const res = await createScope(req);
    expect(res.status).toBe(404);
  });

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(cookies).mockReturnValue(makeCookieStore(null));
    const req = makeRequest('http://localhost/api/v1/admin/scopes', 'POST', {
      connectionId,
      ...SCOPE_PAYLOAD,
    });
    const res = await createScope(req);
    expect(res.status).toBe(401);
  });
});

// ─── PUT /v1/admin/scopes/:id ─────────────────────────────────────────────────

describe('PUT /v1/admin/scopes/:id', () => {
  it('returns 200 with updated FlowScope when input is valid', async () => {
    const req = makeRequest(`http://localhost/api/v1/admin/scopes/${scopeId}`, 'PUT', {
      connectionId,
      ...SCOPE_PAYLOAD,
      syncIntervalMinutes: 15,
    });
    const res = await updateScope(req, { params: Promise.resolve({ scopeId }) });
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    const parsed = FlowScopeSchema.safeParse(body);
    expect(parsed.success, JSON.stringify(parsed.error)).toBe(true);
    expect(parsed.data?.syncIntervalMinutes).toBe(15);
    expect(parsed.data?.includedIssueTypes).toEqual([{ id: 'it-1', name: 'Story' }]);
    const db = getPrismaClient();
    const syncRuns = await db.syncRun.findMany({ where: { scopeId } });
    expect(syncRuns).toHaveLength(0);
  });

  it('reorders included issue type names to match the submitted id order', async () => {
    const db = getPrismaClient();
    await db.flowScope.update({
      where: { id: scopeId },
      data: {
        includedIssueTypeIds: ['it-1', 'it-2'],
        includedIssueTypeNames: ['Story', 'Bug'],
      },
    });

    const req = makeRequest(`http://localhost/api/v1/admin/scopes/${scopeId}`, 'PUT', {
      connectionId,
      ...SCOPE_PAYLOAD,
      includedIssueTypeIds: ['it-2', 'it-1'],
    });
    const res = await updateScope(req, { params: Promise.resolve({ scopeId }) });
    expect(res.status).toBe(200);

    const body = FlowScopeSchema.parse(await res.json());
    expect(body.includedIssueTypes).toEqual([
      { id: 'it-2', name: 'Bug' },
      { id: 'it-1', name: 'Story' },
    ]);

    const updatedScope = await db.flowScope.findUniqueOrThrow({ where: { id: scopeId } });
    expect(updatedScope.includedIssueTypeNames).toEqual(['Bug', 'Story']);

    const syncRuns = await db.syncRun.findMany({ where: { scopeId } });
    expect(syncRuns).toHaveLength(0);
  });

  it('returns 404 when the scope does not exist', async () => {
    const missingId = '00000000-0000-0000-0000-000000000000';
    const req = makeRequest(`http://localhost/api/v1/admin/scopes/${missingId}`, 'PUT', {
      connectionId,
      ...SCOPE_PAYLOAD,
    });
    const res = await updateScope(req, { params: Promise.resolve({ scopeId: missingId }) });
    expect(res.status).toBe(404);
  });

  it('queues a sync when board or flow boundaries change', async () => {
    const req = makeRequest(`http://localhost/api/v1/admin/scopes/${scopeId}`, 'PUT', {
      connectionId,
      ...SCOPE_PAYLOAD,
      startStatusIds: ['2'],
    });
    const res = await updateScope(req, { params: Promise.resolve({ scopeId }) });
    expect(res.status).toBe(200);

    const db = getPrismaClient();
    const syncRuns = await db.syncRun.findMany({ where: { scopeId } });
    expect(syncRuns).toHaveLength(1);
    expect(syncRuns[0]?.status).toBe('queued');
    expect(syncRuns[0]?.trigger).toBe('manual');
  });

  it('returns 409 when a sync is already active for boundary-changing updates', async () => {
    const db = getPrismaClient();
    await db.syncRun.create({
      data: {
        scopeId,
        trigger: 'manual',
        status: 'queued',
      },
    });

    const req = makeRequest(`http://localhost/api/v1/admin/scopes/${scopeId}`, 'PUT', {
      connectionId,
      ...SCOPE_PAYLOAD,
      doneStatusIds: ['4'],
    });
    const res = await updateScope(req, { params: Promise.resolve({ scopeId }) });
    expect(res.status).toBe(409);
  });

  it('returns 409 before board preflight when an active sync already exists', async () => {
    mswServer.use(
      http.get(`${JIRA_BASE}/rest/agile/1.0/board/:boardId/project`, () =>
        HttpResponse.json({ message: 'jira unavailable' }, { status: 503 }),
      ),
    );

    const db = getPrismaClient();
    await db.syncRun.create({
      data: {
        scopeId,
        trigger: 'manual',
        status: 'queued',
      },
    });

    const req = makeRequest(`http://localhost/api/v1/admin/scopes/${scopeId}`, 'PUT', {
      connectionId,
      ...SCOPE_PAYLOAD,
      boardId: 2,
    });
    const res = await updateScope(req, { params: Promise.resolve({ scopeId }) });
    expect(res.status).toBe(409);
  });

  it('fails a stale active sync before queueing a boundary-changing update', async () => {
    const db = getPrismaClient();
    const staleRun = await db.syncRun.create({
      data: {
        scopeId,
        trigger: 'manual',
        status: 'running',
      },
    });
    await markSyncRunAsStaleRunning(staleRun.id);

    const req = makeRequest(`http://localhost/api/v1/admin/scopes/${scopeId}`, 'PUT', {
      connectionId,
      ...SCOPE_PAYLOAD,
      doneStatusIds: ['4'],
    });
    const res = await updateScope(req, { params: Promise.resolve({ scopeId }) });
    expect(res.status).toBe(200);

    const syncRuns = await db.syncRun.findMany({
      where: { scopeId },
      orderBy: { createdAt: 'asc' },
    });
    expect(syncRuns).toHaveLength(2);
    expect(syncRuns[0]?.status).toBe('failed');
    expect(syncRuns[0]?.errorCode).toBe('SYNC_STALE_TIMEOUT');
    expect(syncRuns[1]?.status).toBe('queued');
  });

  it('updates flow boundaries without Jira availability when the board stays the same', async () => {
    mswServer.use(
      http.get(`${JIRA_BASE}/rest/agile/1.0/board/:boardId/project`, () =>
        HttpResponse.json({ message: 'jira unavailable' }, { status: 503 }),
      ),
    );

    const req = makeRequest(`http://localhost/api/v1/admin/scopes/${scopeId}`, 'PUT', {
      connectionId,
      ...SCOPE_PAYLOAD,
      doneStatusIds: ['4'],
    });
    const res = await updateScope(req, { params: Promise.resolve({ scopeId }) });
    expect(res.status).toBe(200);

    const body = FlowScopeSchema.parse(await res.json());
    expect(body.doneStatusIds).toEqual(['4']);

    const db = getPrismaClient();
    const syncRuns = await db.syncRun.findMany({ where: { scopeId } });
    expect(syncRuns).toHaveLength(1);
    expect(syncRuns[0]?.status).toBe('queued');
  });

  it('rolls back boundary changes when the follow-up sync cannot be enqueued', async () => {
    vi.mocked(enqueueScopeSyncJob).mockImplementationOnce(async () => {
      const db = getPrismaClient();
      await db.flowScope.update({
        where: { id: scopeId },
        data: { syncIntervalMinutes: 30 },
      });

      return null;
    });

    const req = makeRequest(`http://localhost/api/v1/admin/scopes/${scopeId}`, 'PUT', {
      connectionId,
      ...SCOPE_PAYLOAD,
      startStatusIds: ['2'],
    });
    const res = await updateScope(req, { params: Promise.resolve({ scopeId }) });
    expect(res.status).toBe(503);

    const db = getPrismaClient();
    const scope = await db.flowScope.findUnique({ where: { id: scopeId } });
    expect(scope?.startStatusIds).toEqual(['1']);
    expect(scope?.syncIntervalMinutes).toBe(30);

    const syncRuns = await db.syncRun.findMany({ where: { scopeId } });
    expect(syncRuns).toHaveLength(1);
    expect(syncRuns[0]?.status).toBe('canceled');
    expect(syncRuns[0]?.errorCode).toBe('SYNC_ENQUEUE_FAILED');
  });

  it('skips rollback when a concurrent update reorders issue types before enqueue failure handling', async () => {
    const db = getPrismaClient();
    await db.flowScope.update({
      where: { id: scopeId },
      data: {
        includedIssueTypeIds: ['it-1', 'it-2'],
        includedIssueTypeNames: ['Story', 'Bug'],
      },
    });

    vi.mocked(enqueueScopeSyncJob).mockImplementationOnce(async () => {
      await db.flowScope.update({
        where: { id: scopeId },
        data: {
          includedIssueTypeIds: ['it-2', 'it-1'],
          includedIssueTypeNames: ['Bug', 'Story'],
        },
      });

      return null;
    });

    const req = makeRequest(`http://localhost/api/v1/admin/scopes/${scopeId}`, 'PUT', {
      connectionId,
      ...SCOPE_PAYLOAD,
      includedIssueTypeIds: ['it-1', 'it-2'],
      startStatusIds: ['2'],
    });
    const res = await updateScope(req, { params: Promise.resolve({ scopeId }) });
    expect(res.status).toBe(503);

    const body = ProblemSchema.parse(await res.json());
    expect(body.message).toContain('manual review');

    const scope = await db.flowScope.findUniqueOrThrow({ where: { id: scopeId } });
    expect(scope.startStatusIds).toEqual(['2']);
    expect(scope.includedIssueTypeIds).toEqual(['it-2', 'it-1']);
    expect(scope.includedIssueTypeNames).toEqual(['Bug', 'Story']);

    const syncRuns = await db.syncRun.findMany({ where: { scopeId } });
    expect(syncRuns).toHaveLength(1);
    expect(syncRuns[0]?.status).toBe('canceled');
    expect(syncRuns[0]?.errorCode).toBe('SYNC_ENQUEUE_FAILED');
  });
});

// ─── POST /v1/admin/scopes/:id/syncs ─────────────────────────────────────────

describe('POST /v1/admin/scopes/:id/syncs', () => {
  it('returns 202 with a SyncRun shape when sync is queued', async () => {
    const req = makeRequest(
      `http://localhost/api/v1/admin/scopes/${scopeId}/syncs`,
      'POST',
    );
    const res = await triggerSync(req, { params: Promise.resolve({ scopeId }) });
    expect(res.status).toBe(202);
    const body: unknown = await res.json();
    const parsed = SyncRunSchema.safeParse(body);
    expect(parsed.success, JSON.stringify(parsed.error)).toBe(true);
    expect(parsed.data?.trigger).toBe('manual');
    expect(parsed.data?.status).toBe('queued');
  });

  it('returns 409 when a sync is already active for this scope', async () => {
    await triggerSync(
      makeRequest(`http://localhost/api/v1/admin/scopes/${scopeId}/syncs`, 'POST'),
      { params: Promise.resolve({ scopeId }) },
    );
    const req = makeRequest(
      `http://localhost/api/v1/admin/scopes/${scopeId}/syncs`,
      'POST',
    );
    const res = await triggerSync(req, { params: Promise.resolve({ scopeId }) });
    expect(res.status).toBe(409);
  });

  it('fails a stale running sync before queueing a fresh manual sync', async () => {
    const db = getPrismaClient();
    const staleRun = await db.syncRun.create({
      data: {
        scopeId,
        trigger: 'manual',
        status: 'running',
      },
    });
    await markSyncRunAsStaleRunning(staleRun.id);

    const res = await triggerSync(
      makeRequest(`http://localhost/api/v1/admin/scopes/${scopeId}/syncs`, 'POST'),
      { params: Promise.resolve({ scopeId }) },
    );
    expect(res.status).toBe(202);

    const syncRuns = await db.syncRun.findMany({
      where: { scopeId },
      orderBy: { createdAt: 'asc' },
    });
    expect(syncRuns).toHaveLength(2);
    expect(syncRuns[0]?.status).toBe('failed');
    expect(syncRuns[0]?.errorCode).toBe('SYNC_STALE_TIMEOUT');
    expect(syncRuns[1]?.status).toBe('queued');
  });

  it('returns 503 and cancels the sync run when queue insertion fails', async () => {
    vi.mocked(enqueueScopeSyncJob).mockResolvedValueOnce(null);

    const req = makeRequest(
      `http://localhost/api/v1/admin/scopes/${scopeId}/syncs`,
      'POST',
    );
    const res = await triggerSync(req, { params: Promise.resolve({ scopeId }) });
    expect(res.status).toBe(503);

    const db = getPrismaClient();
    const syncRuns = await db.syncRun.findMany({ where: { scopeId } });
    expect(syncRuns).toHaveLength(1);
    expect(syncRuns[0]?.status).toBe('canceled');
    expect(syncRuns[0]?.errorCode).toBe('SYNC_ENQUEUE_DEDUPED');
  });

  it('returns 404 when the scope does not exist', async () => {
    const missingId = '00000000-0000-0000-0000-000000000000';
    const req = makeRequest(
      `http://localhost/api/v1/admin/scopes/${missingId}/syncs`,
      'POST',
    );
    const res = await triggerSync(req, { params: Promise.resolve({ scopeId: missingId }) });
    expect(res.status).toBe(404);
  });
});

// ─── GET /v1/admin/scopes/:id/syncs ──────────────────────────────────────────

describe('GET /v1/admin/scopes/:id/syncs', () => {
  it('returns 200 with an array of SyncRun records', async () => {
    const req = makeRequest(
      `http://localhost/api/v1/admin/scopes/${scopeId}/syncs`,
    );
    const res = await listSyncs(req, { params: Promise.resolve({ scopeId }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { syncs: unknown[] };
    expect(Array.isArray(body.syncs)).toBe(true);
    // Verify each run parses as a SyncRun.
    for (const run of body.syncs) {
      expect(SyncRunSchema.safeParse(run).success).toBe(true);
    }
  });

  it('returns 404 when the scope does not exist', async () => {
    const missingId = '00000000-0000-0000-0000-000000000000';
    const req = makeRequest(
      `http://localhost/api/v1/admin/scopes/${missingId}/syncs`,
    );
    const res = await listSyncs(req, { params: Promise.resolve({ scopeId: missingId }) });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /v1/admin/scopes/:id', () => {
  it('deletes the scope when the only active sync is stale', async () => {
    const db = getPrismaClient();
    const scopeToDelete = await db.flowScope.create({
      data: {
        workspaceId,
        connectionId,
        boardId: '99',
        boardName: 'Delete Me',
        timezone: 'UTC',
        includedIssueTypeIds: ['it-1'],
        includedIssueTypeNames: ['Story'],
        startStatusIds: ['1'],
        doneStatusIds: ['3'],
        syncIntervalMinutes: 10,
      },
    });

    const staleRun = await db.syncRun.create({
      data: {
        scopeId: scopeToDelete.id,
        trigger: 'manual',
        status: 'running',
      },
    });
    await markSyncRunAsStaleRunning(staleRun.id);

    const req = makeRequest(`http://localhost/api/v1/admin/scopes/${scopeToDelete.id}`, 'DELETE');
    const res = await deleteScope(req, { params: Promise.resolve({ scopeId: scopeToDelete.id }) });
    expect(res.status).toBe(204);
    expect(await db.flowScope.findUnique({ where: { id: scopeToDelete.id } })).toBeNull();
  });
});
