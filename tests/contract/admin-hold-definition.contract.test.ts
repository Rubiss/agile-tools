import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { resetConfig, encryptSecret } from '@agile-tools/shared';
import { getPrismaClient, disconnectPrisma } from '@agile-tools/db';
import {
  HoldDefinitionResponseSchema,
  ProblemSchema,
} from '@agile-tools/shared/contracts/api';
import { startPostgres, stopPostgres } from '../integration/support/postgres';
import { serializeWorkspaceContext } from '../../apps/web/src/server/session-cookie';

vi.mock('next/headers', () => ({
  cookies: vi.fn(),
}));

const { cookies } = await import('next/headers');
const { GET: getHoldDefinition, PUT: putHoldDefinition } = await import(
  '../../apps/web/src/app/api/v1/admin/scopes/[scopeId]/hold-definition/route'
);

const TEST_ENCRYPTION_KEY = 'test-encryption-key-32-chars-ok!';
const TEST_SESSION_SECRET = 'contract-session-secret-1234567890';

let workspaceId: string;
let scopeId: string;
let adminCookieValue: string;

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
      Referer: 'http://localhost/scopes',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

beforeAll(async () => {
  const pg = await startPostgres();
  process.env['DATABASE_URL'] = pg.connectionUrl;
  process.env['ENCRYPTION_KEY'] = TEST_ENCRYPTION_KEY;
  process.env['SESSION_SECRET'] = TEST_SESSION_SECRET;
  process.env['NODE_ENV'] = 'test';
  resetConfig();
  await disconnectPrisma();

  const db = getPrismaClient();
  const workspace = await db.workspace.create({
    data: { name: 'Hold Definition Contract Workspace', defaultTimezone: 'UTC' },
  });
  workspaceId = workspace.id;

  const connection = await db.jiraConnection.create({
    data: {
      workspaceId,
      baseUrl: 'https://jira.example.internal',
      authType: 'pat',
      encryptedSecretRef: encryptSecret('test-pat', TEST_ENCRYPTION_KEY),
    },
  });

  const scope = await db.flowScope.create({
    data: {
      workspaceId,
      connectionId: connection.id,
      boardId: '12',
      boardName: 'Hold Definition Board',
      timezone: 'UTC',
      includedIssueTypeIds: ['story'],
      startStatusIds: ['10'],
      doneStatusIds: ['30'],
      syncIntervalMinutes: 10,
    },
  });
  scopeId = scope.id;

  adminCookieValue = serializeWorkspaceContext({ userId: 'u-1', workspaceId, role: 'admin' });
});

beforeEach(async () => {
  vi.mocked(cookies).mockReturnValue(makeCookieStore(adminCookieValue));
  await getPrismaClient().holdDefinition.deleteMany({ where: { scopeId } });
});

afterAll(async () => {
  await disconnectPrisma();
  await stopPostgres();
});

describe('GET /v1/admin/scopes/:id/hold-definition', () => {
  it('returns 404 when no hold definition exists', async () => {
    const req = makeRequest(`http://localhost/api/v1/admin/scopes/${scopeId}/hold-definition`);
    const res = await getHoldDefinition(req, { params: Promise.resolve({ scopeId }) });

    expect(res.status).toBe(404);
    expect(ProblemSchema.safeParse(await res.json()).success).toBe(true);
  });

  it('returns 200 with the configured hold definition', async () => {
    const db = getPrismaClient();
    await db.holdDefinition.create({
      data: {
        scopeId,
        holdStatusIds: ['20'],
        blockedFieldId: null,
        blockedTruthyValues: [],
        updatedBy: 'test-user',
        effectiveFrom: new Date('2026-04-19T12:00:00Z'),
      },
    });

    const req = makeRequest(`http://localhost/api/v1/admin/scopes/${scopeId}/hold-definition`);
    const res = await getHoldDefinition(req, { params: Promise.resolve({ scopeId }) });

    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(HoldDefinitionResponseSchema.safeParse(body).success).toBe(true);
  });
});

describe('PUT /v1/admin/scopes/:id/hold-definition', () => {
  it('returns 200 with the updated hold definition shape on valid input', async () => {
    const req = makeRequest(
      `http://localhost/api/v1/admin/scopes/${scopeId}/hold-definition`,
      'PUT',
      { holdStatusIds: ['20', '25'] },
    );
    const res = await putHoldDefinition(req, { params: Promise.resolve({ scopeId }) });

    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    const parsed = HoldDefinitionResponseSchema.safeParse(body);
    expect(parsed.success, JSON.stringify(parsed.error)).toBe(true);
    expect(parsed.data?.holdStatusIds).toEqual(['20', '25']);
  });

  it('returns 400 when the request body is invalid', async () => {
    const req = makeRequest(
      `http://localhost/api/v1/admin/scopes/${scopeId}/hold-definition`,
      'PUT',
      { holdStatusIds: [] },
    );
    const res = await putHoldDefinition(req, { params: Promise.resolve({ scopeId }) });

    expect(res.status).toBe(400);
    expect(ProblemSchema.safeParse(await res.json()).success).toBe(true);
  });

  it('returns 401 when the session is missing', async () => {
    vi.mocked(cookies).mockReturnValue(makeCookieStore(null));
    const req = makeRequest(
      `http://localhost/api/v1/admin/scopes/${scopeId}/hold-definition`,
      'PUT',
      { holdStatusIds: ['20'] },
    );
    const res = await putHoldDefinition(req, { params: Promise.resolve({ scopeId }) });

    expect(res.status).toBe(401);
    expect(ProblemSchema.safeParse(await res.json()).success).toBe(true);
  });
});