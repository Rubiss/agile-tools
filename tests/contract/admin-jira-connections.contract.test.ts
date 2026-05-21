/**
 * Contract tests for admin Jira connection routes.
 *
 * These tests call Next.js route handlers directly (not over HTTP) to verify
 * that every response conforms to the shapes defined in
 * `@agile-tools/shared/contracts/api`. They use:
 *
 *  - MSW (node) to intercept outbound Jira HTTP calls
 *  - Testcontainers Postgres for a real, isolated database
 *  - vi.mock for Next.js server-only modules (next/headers, @/server/queue)
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { NextRequest } from 'next/server';
import { resetConfig, encryptSecret } from '@agile-tools/shared';
import { getPrismaClient, disconnectPrisma } from '@agile-tools/db';
import {
  JiraConnectionSchema,
  JiraConnectionValidationSchema,
  BoardDiscoveryDetailSchema,
  ProblemSchema,
} from '@agile-tools/shared/contracts/api';
import { startPostgres, stopPostgres } from '../integration/support/postgres';
import { jiraHandlers, jiraUnauthorisedHandlers } from '../msw/jira-handlers';
import { serializeWorkspaceContext } from '../../apps/web/src/server/session-cookie';

// ─── Mock Next.js server-only modules ─────────────────────────────────────────

// vi.mock calls are automatically hoisted before all imports by Vitest.
vi.mock('next/headers', () => ({
  cookies: vi.fn(),
}));

vi.mock('@/server/queue', () => ({
  enqueueScopeSyncJob: vi.fn().mockResolvedValue('test-job-id'),
}));

// ─── Lazy imports after mocks are hoisted ─────────────────────────────────────

// These must be imported after vi.mock so they receive the mocked modules.
const { cookies } = await import('next/headers');
const { POST: createConnection } = await import(
  '../../apps/web/src/app/api/v1/admin/jira-connections/route'
);
const { PUT: updateConnection } = await import(
  '../../apps/web/src/app/api/v1/admin/jira-connections/[connectionId]/route'
);
const { POST: validateConnection } = await import(
  '../../apps/web/src/app/api/v1/admin/jira-connections/[connectionId]/validate/route'
);
const { GET: listBoards } = await import(
  '../../apps/web/src/app/api/v1/admin/jira-connections/[connectionId]/discovery/boards/route'
);
const { GET: getBoardDetail } = await import(
  '../../apps/web/src/app/api/v1/admin/jira-connections/[connectionId]/discovery/boards/[boardId]/route'
);

// ─── Constants ────────────────────────────────────────────────────────────────

const JIRA_BASE = 'https://jira.example.internal';
const TEST_ENCRYPTION_KEY = 'test-encryption-key-32-chars-ok!';
const TEST_SESSION_SECRET = 'contract-session-secret-1234567890';
const TEST_PAT = 'test-jira-pat';

// ─── MSW Server ───────────────────────────────────────────────────────────────

const mswServer = setupServer(...jiraHandlers);

// ─── Test State ───────────────────────────────────────────────────────────────

let workspaceId: string;
let connectionId: string;
let adminCookieValue: string;
let memberCookieValue: string;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeCookieStore(cookieValue: string | null) {
  return {
    get: (name: string) => {
      if (name === 'agile_session' && cookieValue !== null) {
        return { value: cookieValue };
      }
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

// ─── Setup ───────────────────────────────────────────────────────────────────

beforeAll(async () => {
  // Start isolated Postgres and set env vars before any DB/config access.
  const pg = await startPostgres();
  process.env['DATABASE_URL'] = pg.connectionUrl;
  process.env['ENCRYPTION_KEY'] = TEST_ENCRYPTION_KEY;
  process.env['SESSION_SECRET'] = TEST_SESSION_SECRET;
  process.env['NODE_ENV'] = 'test';
  resetConfig();
  await disconnectPrisma();

  // Start MSW to intercept outbound Jira HTTP calls.
  mswServer.listen({ onUnhandledRequest: 'error' });

  // Seed a Workspace row (required FK for JiraConnection).
  const db = getPrismaClient();
  const workspace = await db.workspace.create({
    data: { name: 'Contract Test Workspace', defaultTimezone: 'UTC' },
  });
  workspaceId = workspace.id;

  // Seed a JiraConnection fixture for tests that need an existing connection.
  const encryptedSecretRef = encryptSecret(TEST_PAT, TEST_ENCRYPTION_KEY);
  const conn = await db.jiraConnection.create({
    data: {
      workspaceId,
      baseUrl: JIRA_BASE,
      displayName: 'Test Jira',
      authType: 'pat',
      encryptedSecretRef,
    },
  });
  connectionId = conn.id;

  // Build session cookie payloads.
  adminCookieValue = serializeWorkspaceContext({ userId: 'u-1', workspaceId, role: 'admin' });
  memberCookieValue = serializeWorkspaceContext({ userId: 'u-2', workspaceId, role: 'member' });
});

afterAll(async () => {
  mswServer.close();
  await disconnectPrisma();
  await stopPostgres();
});

beforeEach(() => {
  // Default to admin session; individual tests override for auth edge cases.
  vi.mocked(cookies).mockReturnValue(makeCookieStore(adminCookieValue));
  mswServer.resetHandlers();
});

// ─── POST /v1/admin/jira-connections ─────────────────────────────────────────

describe('POST /v1/admin/jira-connections', () => {
  it('returns 201 with a JiraConnection shape on valid input', async () => {
    const req = makeRequest('http://localhost/api/v1/admin/jira-connections', 'POST', {
      baseUrl: JIRA_BASE,
      pat: TEST_PAT,
      displayName: 'New Connection',
    });
    const res = await createConnection(req);
    expect(res.status).toBe(201);
    const body: unknown = await res.json();
    const parsed = JiraConnectionSchema.safeParse(body);
    expect(parsed.success, JSON.stringify(parsed.error)).toBe(true);
  });

  it('returns 400 when required fields are missing', async () => {
    const req = makeRequest('http://localhost/api/v1/admin/jira-connections', 'POST', {
      displayName: 'No URL or PAT',
    });
    const res = await createConnection(req);
    expect(res.status).toBe(400);
    const body: unknown = await res.json();
    expect(ProblemSchema.safeParse(body).success).toBe(true);
  });

  it('returns 401 when no session cookie is present', async () => {
    vi.mocked(cookies).mockReturnValue(makeCookieStore(null));
    const req = makeRequest('http://localhost/api/v1/admin/jira-connections', 'POST', {
      baseUrl: JIRA_BASE,
      pat: TEST_PAT,
    });
    const res = await createConnection(req);
    expect(res.status).toBe(401);
  });

  it('returns 403 when the user is a member (not admin)', async () => {
    vi.mocked(cookies).mockReturnValue(makeCookieStore(memberCookieValue));
    const req = makeRequest('http://localhost/api/v1/admin/jira-connections', 'POST', {
      baseUrl: JIRA_BASE,
      pat: TEST_PAT,
    });
    const res = await createConnection(req);
    expect(res.status).toBe(403);
  });
});

// ─── PUT /v1/admin/jira-connections/:id ────────────────────────────────────────

describe('PUT /v1/admin/jira-connections/:id', () => {
  it('returns 200 with a JiraConnection shape and resets validation state after base URL or PAT changes', async () => {
    const db = getPrismaClient();
    await db.jiraConnection.update({
      where: { id: connectionId },
      data: {
        healthStatus: 'healthy',
        lastValidatedAt: new Date('2026-04-19T12:00:00Z'),
        lastHealthyAt: new Date('2026-04-19T12:00:00Z'),
        lastErrorCode: 'JIRA_AUTH_ERROR',
      },
    });

    const req = makeRequest(`http://localhost/api/v1/admin/jira-connections/${connectionId}`, 'PUT', {
      baseUrl: 'https://jira.updated.internal/',
      displayName: 'Updated Jira',
      pat: 'rotated-pat',
    });
    const res = await updateConnection(req, {
      params: Promise.resolve({ connectionId }),
    });
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    const parsed = JiraConnectionSchema.safeParse(body);
    expect(parsed.success, JSON.stringify(parsed.error)).toBe(true);
    expect(parsed.data?.baseUrl).toBe('https://jira.updated.internal');
    expect(parsed.data?.displayName).toBe('Updated Jira');
    expect(parsed.data?.healthStatus).toBe('draft');
    expect(parsed.data?.lastValidatedAt).toBeUndefined();
    expect(parsed.data?.lastErrorCode).toBeUndefined();
  });

  it('returns 200 and preserves healthy state when only the display name changes', async () => {
    const db = getPrismaClient();
    await db.jiraConnection.update({
      where: { id: connectionId },
      data: {
        baseUrl: JIRA_BASE,
        displayName: 'Test Jira',
        healthStatus: 'healthy',
        lastValidatedAt: new Date('2026-04-19T12:00:00Z'),
        lastHealthyAt: new Date('2026-04-19T12:00:00Z'),
        lastErrorCode: null,
      },
    });

    const req = makeRequest(`http://localhost/api/v1/admin/jira-connections/${connectionId}`, 'PUT', {
      baseUrl: JIRA_BASE,
      displayName: 'Renamed Jira',
    });
    const res = await updateConnection(req, {
      params: Promise.resolve({ connectionId }),
    });
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    const parsed = JiraConnectionSchema.safeParse(body);
    expect(parsed.success, JSON.stringify(parsed.error)).toBe(true);
    expect(parsed.data?.displayName).toBe('Renamed Jira');
    expect(parsed.data?.healthStatus).toBe('healthy');
  });

  it('preserves the existing display name when it is omitted from the update payload', async () => {
    const db = getPrismaClient();
    await db.jiraConnection.update({
      where: { id: connectionId },
      data: {
        baseUrl: JIRA_BASE,
        displayName: 'Preserved Jira',
        healthStatus: 'healthy',
        lastValidatedAt: new Date('2026-04-19T12:00:00Z'),
        lastHealthyAt: new Date('2026-04-19T12:00:00Z'),
        lastErrorCode: null,
      },
    });

    const req = makeRequest(`http://localhost/api/v1/admin/jira-connections/${connectionId}`, 'PUT', {
      baseUrl: JIRA_BASE,
      pat: 'rotated-pat',
    });
    const res = await updateConnection(req, {
      params: Promise.resolve({ connectionId }),
    });
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    const parsed = JiraConnectionSchema.safeParse(body);
    expect(parsed.success, JSON.stringify(parsed.error)).toBe(true);
    expect(parsed.data?.displayName).toBe('Preserved Jira');
    expect(parsed.data?.healthStatus).toBe('draft');
  });

  it('returns 404 when the connection does not exist', async () => {
    const missingId = '00000000-0000-0000-0000-000000000000';
    const req = makeRequest(`http://localhost/api/v1/admin/jira-connections/${missingId}`, 'PUT', {
      baseUrl: JIRA_BASE,
      displayName: 'Missing Jira',
    });
    const res = await updateConnection(req, {
      params: Promise.resolve({ connectionId: missingId }),
    });
    expect(res.status).toBe(404);
  });
});

// ─── POST /v1/admin/jira-connections/:id/validate ────────────────────────────

describe('POST /v1/admin/jira-connections/:id/validate', () => {
  it('returns 200 with healthy validation when Jira responds normally', async () => {
    const req = makeRequest(
      `http://localhost/api/v1/admin/jira-connections/${connectionId}/validate`,
      'POST',
    );
    const res = await validateConnection(req, {
      params: Promise.resolve({ connectionId }),
    });
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    const parsed = JiraConnectionValidationSchema.safeParse(body);
    expect(parsed.success, JSON.stringify(parsed.error)).toBe(true);
    expect(parsed.data?.healthStatus).toBe('healthy');
    expect(parsed.data?.connectionId).toBe(connectionId);
  });

  it('returns 200 with unhealthy validation when Jira returns 401', async () => {
    mswServer.use(...jiraUnauthorisedHandlers);
    const req = makeRequest(
      `http://localhost/api/v1/admin/jira-connections/${connectionId}/validate`,
      'POST',
    );
    const res = await validateConnection(req, {
      params: Promise.resolve({ connectionId }),
    });
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    const parsed = JiraConnectionValidationSchema.safeParse(body);
    expect(parsed.success, JSON.stringify(parsed.error)).toBe(true);
    expect(parsed.data?.healthStatus).toBe('unhealthy');
    expect(parsed.data?.warnings.length).toBeGreaterThan(0);
  });

  it('returns 404 when the connection does not exist', async () => {
    const missingId = '00000000-0000-0000-0000-000000000000';
    const req = makeRequest(
      `http://localhost/api/v1/admin/jira-connections/${missingId}/validate`,
      'POST',
    );
    const res = await validateConnection(req, {
      params: Promise.resolve({ connectionId: missingId }),
    });
    expect(res.status).toBe(404);
  });
});

// ─── GET /v1/admin/jira-connections/:id/discovery/boards ─────────────────────

describe('GET /v1/admin/jira-connections/:id/discovery/boards', () => {
  it('returns 200 with a boards array', async () => {
    const req = makeRequest(
      `http://localhost/api/v1/admin/jira-connections/${connectionId}/discovery/boards`,
    );
    const res = await listBoards(req, {
      params: Promise.resolve({ connectionId }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { boards: unknown[] };
    expect(Array.isArray(body.boards)).toBe(true);
    expect(body.boards.length).toBeGreaterThan(0);
  });

  it('returns 404 when the connection does not exist', async () => {
    const missingId = '00000000-0000-0000-0000-000000000000';
    const req = makeRequest(
      `http://localhost/api/v1/admin/jira-connections/${missingId}/discovery/boards`,
    );
    const res = await listBoards(req, { params: Promise.resolve({ connectionId: missingId }) });
    expect(res.status).toBe(404);
  });
});

// ─── GET /v1/admin/jira-connections/:id/discovery/boards/:boardId ─────────────

describe('GET /v1/admin/jira-connections/:id/discovery/boards/:boardId', () => {
  it('returns 200 with BoardDiscoveryDetail shape for a valid board', async () => {
    const req = makeRequest(
      `http://localhost/api/v1/admin/jira-connections/${connectionId}/discovery/boards/1`,
    );
    const res = await getBoardDetail(req, {
      params: Promise.resolve({ connectionId, boardId: '1' }),
    });
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    const parsed = BoardDiscoveryDetailSchema.safeParse(body);
    expect(parsed.success, JSON.stringify(parsed.error)).toBe(true);
    expect(parsed.data?.boardId).toBe(1);
    expect(parsed.data?.completionStatuses?.some((status) => status.id === '4')).toBe(true);
  });

  it('returns 400 when boardId is not a positive integer', async () => {
    const req = makeRequest(
      `http://localhost/api/v1/admin/jira-connections/${connectionId}/discovery/boards/abc`,
    );
    const res = await getBoardDetail(req, {
      params: Promise.resolve({ connectionId, boardId: 'abc' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 404 when the board is not found in Jira', async () => {
    mswServer.use(
      http.get(`${JIRA_BASE}/rest/agile/1.0/board/:boardId/configuration`, () =>
        HttpResponse.json({ message: 'Board not found' }, { status: 404 }),
      ),
    );
    const req = makeRequest(
      `http://localhost/api/v1/admin/jira-connections/${connectionId}/discovery/boards/999`,
    );
    const res = await getBoardDetail(req, {
      params: Promise.resolve({ connectionId, boardId: '999' }),
    });
    expect(res.status).toBe(404);
  });
});
