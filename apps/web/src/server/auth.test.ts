import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetConfig } from '@agile-tools/shared';

vi.mock('next/headers', () => ({
  cookies: vi.fn(),
}));

const { cookies } = await import('next/headers');
const { getWorkspaceContext, requireAdminContext, requireWorkspaceContext, SESSION_COOKIE_NAME } =
  await import('./auth');
const { serializeWorkspaceContext } = await import('./session-cookie');
const { ResponseError } = await import('./errors');

const ORIGINAL_ENV = { ...process.env };

afterAll(() => {
  process.env = ORIGINAL_ENV;
  resetConfig();
  vi.mocked(cookies).mockReset();
});

function makeCookieStore(cookieValue: string | null) {
  return {
    get: (name: string) =>
      name === SESSION_COOKIE_NAME && cookieValue !== null ? { name, value: cookieValue } : undefined,
  };
}

describe('getWorkspaceContext', () => {
  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://localhost:5432/agile_tools',
      ENCRYPTION_KEY: '12345678901234567890123456789012',
      SESSION_SECRET: 'session-secret-for-tests-1234567890',
    };
    resetConfig();
    vi.mocked(cookies).mockReset();
  });

  it('returns null when there is no session cookie and the fallback is disabled', async () => {
    vi.mocked(cookies).mockReturnValue(makeCookieStore(null) as never);

    expect(await getWorkspaceContext()).toBeNull();
  });

  it('returns null when the fallback is enabled but READONLY_WORKSPACE_ID is missing', async () => {
    process.env['ALLOW_READONLY_WORKSPACE_FALLBACK'] = 'true';
    vi.mocked(cookies).mockReturnValue(makeCookieStore(null) as never);

    expect(await getWorkspaceContext()).toBeNull();
  });

  it('returns a member-scoped fallback context when the fallback is fully configured', async () => {
    process.env['ALLOW_READONLY_WORKSPACE_FALLBACK'] = 'true';
    process.env['READONLY_WORKSPACE_ID'] = 'workspace-uuid';
    vi.mocked(cookies).mockReturnValue(makeCookieStore(null) as never);

    expect(await getWorkspaceContext()).toEqual({
      workspaceId: 'workspace-uuid',
      userId: 'readonly-public',
      role: 'member',
    });
  });

  it('uses READONLY_WORKSPACE_USER_ID when provided', async () => {
    process.env['ALLOW_READONLY_WORKSPACE_FALLBACK'] = 'true';
    process.env['READONLY_WORKSPACE_ID'] = 'workspace-uuid';
    process.env['READONLY_WORKSPACE_USER_ID'] = 'pilot-user-1';
    vi.mocked(cookies).mockReturnValue(makeCookieStore(null) as never);

    expect(await getWorkspaceContext()).toMatchObject({
      workspaceId: 'workspace-uuid',
      userId: 'pilot-user-1',
      role: 'member',
    });
  });

  it('prefers a valid signed session cookie over the fallback', async () => {
    process.env['ALLOW_READONLY_WORKSPACE_FALLBACK'] = 'true';
    process.env['READONLY_WORKSPACE_ID'] = 'workspace-uuid';

    const signed = serializeWorkspaceContext({
      userId: 'real-user',
      workspaceId: 'real-workspace',
      role: 'admin',
    });
    vi.mocked(cookies).mockReturnValue(makeCookieStore(signed) as never);

    expect(await getWorkspaceContext()).toEqual({
      userId: 'real-user',
      workspaceId: 'real-workspace',
      role: 'admin',
    });
  });

  it('falls back to the read-only context when the session cookie is unparseable', async () => {
    process.env = { ...process.env, NODE_ENV: 'production' };
    resetConfig();
    process.env['ALLOW_READONLY_WORKSPACE_FALLBACK'] = 'true';
    process.env['READONLY_WORKSPACE_ID'] = 'workspace-uuid';

    vi.mocked(cookies).mockReturnValue(makeCookieStore('not-a-real-cookie') as never);

    expect(await getWorkspaceContext()).toEqual({
      workspaceId: 'workspace-uuid',
      userId: 'readonly-public',
      role: 'member',
    });
  });
});

describe('requireAdminContext', () => {
  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://localhost:5432/agile_tools',
      ENCRYPTION_KEY: '12345678901234567890123456789012',
      SESSION_SECRET: 'session-secret-for-tests-1234567890',
    };
    resetConfig();
    vi.mocked(cookies).mockReset();
  });

  it('rejects the read-only fallback context because it is member-scoped', async () => {
    process.env['ALLOW_READONLY_WORKSPACE_FALLBACK'] = 'true';
    process.env['READONLY_WORKSPACE_ID'] = 'workspace-uuid';
    vi.mocked(cookies).mockReturnValue(makeCookieStore(null) as never);

    await expect(requireAdminContext()).rejects.toBeInstanceOf(ResponseError);
  });

  it('allows a signed admin cookie even when the fallback is enabled', async () => {
    process.env['ALLOW_READONLY_WORKSPACE_FALLBACK'] = 'true';
    process.env['READONLY_WORKSPACE_ID'] = 'workspace-uuid';
    const signed = serializeWorkspaceContext({
      userId: 'admin-user',
      workspaceId: 'admin-workspace',
      role: 'admin',
    });
    vi.mocked(cookies).mockReturnValue(makeCookieStore(signed) as never);

    await expect(requireAdminContext()).resolves.toMatchObject({ role: 'admin' });
  });
});

describe('requireWorkspaceContext', () => {
  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://localhost:5432/agile_tools',
      ENCRYPTION_KEY: '12345678901234567890123456789012',
      SESSION_SECRET: 'session-secret-for-tests-1234567890',
    };
    resetConfig();
    vi.mocked(cookies).mockReset();
  });

  it('resolves with the fallback member context when enabled', async () => {
    process.env['ALLOW_READONLY_WORKSPACE_FALLBACK'] = 'true';
    process.env['READONLY_WORKSPACE_ID'] = 'workspace-uuid';
    vi.mocked(cookies).mockReturnValue(makeCookieStore(null) as never);

    await expect(requireWorkspaceContext()).resolves.toMatchObject({ role: 'member' });
  });

  it('throws when the fallback is disabled and there is no cookie', async () => {
    vi.mocked(cookies).mockReturnValue(makeCookieStore(null) as never);

    await expect(requireWorkspaceContext()).rejects.toBeInstanceOf(ResponseError);
  });
});
