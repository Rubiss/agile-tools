import { type NextRequest } from 'next/server';
import { getFlowScope, getPrismaClient, deleteEpicForecastTarget } from '@agile-tools/db';
import { logger } from '@agile-tools/shared';
import { requireWorkspaceContext } from '@/server/auth';
import { ResponseError } from '@/server/errors';
import { assertTrustedMutationRequest, enforceRateLimit } from '@/server/request-security';
import { withHttpMetrics } from '@/server/route-metrics';

async function handleDELETE(
  req: NextRequest,
  { params }: { params: Promise<{ scopeId: string; targetId: string }> },
): Promise<Response> {
  try {
    const ctx = await requireWorkspaceContext();
    assertTrustedMutationRequest(req);
    const { scopeId, targetId } = await params;
    enforceRateLimit(req, {
      bucket: 'scope-epic-forecasts:write',
      identifier: `${ctx.workspaceId}:${ctx.userId}:${scopeId}`,
      max: 60,
      windowMs: 5 * 60_000,
    });

    const db = getPrismaClient();
    const scope = await getFlowScope(db, ctx.workspaceId, scopeId);
    if (!scope) {
      return Response.json({ code: 'NOT_FOUND', message: 'Flow scope not found.' }, { status: 404 });
    }

    const deleted = await deleteEpicForecastTarget(db, scopeId, targetId);
    if (!deleted) {
      return Response.json(
        { code: 'NOT_FOUND', message: 'Epic forecast target not found.' },
        { status: 404 },
      );
    }
    return new Response(null, { status: 204 });
  } catch (err) {
    if (err instanceof ResponseError) {
      return err.response;
    }
    logger.error('Failed to delete epic forecast target', {
      error: err instanceof Error ? err.message : String(err),
    });
    return Response.json(
      { code: 'INTERNAL_ERROR', message: 'An internal error occurred.' },
      { status: 500 },
    );
  }
}

export const DELETE = withHttpMetrics(
  'DELETE',
  '/api/v1/scopes/[scopeId]/epic-forecasts/[targetId]',
  handleDELETE,
);
