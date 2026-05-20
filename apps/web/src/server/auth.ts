import { cookies } from 'next/headers';
import type { NextRequest, NextResponse } from 'next/server';
import { logger } from '@agile-tools/shared';
import { ResponseError } from './errors';
import {
  parseWorkspaceContextCookie,
  serializeWorkspaceContext,
  type WorkspaceContext,
  type WorkspaceRole,
} from './session-cookie';

// Session cookie name — must match the value set by the auth middleware.
export const SESSION_COOKIE_NAME = 'agile_session';

const SESSION_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 14;

export { serializeWorkspaceContext, type WorkspaceContext, type WorkspaceRole };

/**
 * Parse the opaque session cookie and return the workspace context, or null
 * when the request is unauthenticated.
 *
 * In production the session value is a signed JWT or opaque token issued by
 * the workspace auth middleware. For v1 the implementation reads from a signed
 * cookie; swap the body for your actual session provider without changing the
 * contract.
 */
export async function getWorkspaceContext(): Promise<WorkspaceContext | null> {
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get(SESSION_COOKIE_NAME);
  if (sessionCookie?.value) {
    try {
      const parsed = parseWorkspaceContextCookie(sessionCookie.value);
      if (parsed) return parsed;
    } catch (err) {
      logger.warn('Failed to parse session cookie', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return getReadonlyWorkspaceFallback();
}

/**
 * Optional, env-gated read-only workspace fallback for pilot or standalone
 * deployments that do not yet have an upstream workspace auth/session
 * provider. When enabled, requests without a valid `agile_session` cookie
 * resolve to a `member`-scoped context for a configured workspace so that
 * normal users can view read-only product pages.
 *
 * This is intentionally member-scoped: `requireAdminContext()` continues to
 * reject the fallback because it always returns role `member`. A valid signed
 * session cookie still takes precedence over the fallback.
 *
 * Enable with:
 *   ALLOW_READONLY_WORKSPACE_FALLBACK=true
 *   READONLY_WORKSPACE_ID=<workspace uuid>
 *   READONLY_WORKSPACE_USER_ID=<optional stable user id>
 */
function getReadonlyWorkspaceFallback(): WorkspaceContext | null {
  if (process.env['ALLOW_READONLY_WORKSPACE_FALLBACK'] !== 'true') return null;

  const workspaceId = process.env['READONLY_WORKSPACE_ID'];
  if (!workspaceId) return null;

  return {
    workspaceId,
    userId: process.env['READONLY_WORKSPACE_USER_ID'] ?? 'readonly-public',
    role: 'member',
  };
}

/**
 * Return the workspace context or throw a Response with 401 status.
 * Use this in API route handlers that require authentication.
 */
export async function requireWorkspaceContext(): Promise<WorkspaceContext> {
  const ctx = await getWorkspaceContext();
  if (!ctx) {
    throw new ResponseError(
      Response.json({ code: 'UNAUTHENTICATED', message: 'Authentication required.' }, { status: 401 }),
    );
  }
  return ctx;
}

/**
 * Return the workspace context or throw a Response with 403 status.
 * Use this in API route handlers that require administrator access.
 */
export async function requireAdminContext(): Promise<WorkspaceContext> {
  const ctx = await requireWorkspaceContext();
  if (ctx.role !== 'admin') {
    throw new ResponseError(
      Response.json({ code: 'FORBIDDEN', message: 'Administrator access required.' }, { status: 403 }),
    );
  }
  return ctx;
}

export function setWorkspaceSessionCookie(
  response: NextResponse,
  request: NextRequest,
  context: WorkspaceContext,
): void {
  response.cookies.set({
    name: SESSION_COOKIE_NAME,
    value: serializeWorkspaceContext(context),
    httpOnly: true,
    sameSite: 'lax',
    secure: shouldUseSecureSessionCookie(request),
    path: '/',
    maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
  });
}

function shouldUseSecureSessionCookie(request: NextRequest): boolean {
  const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const protocol = forwardedProto ?? request.nextUrl.protocol.replace(/:$/, '');

  return protocol === 'https';
}
