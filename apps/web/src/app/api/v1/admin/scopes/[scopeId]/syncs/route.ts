import { type NextRequest } from 'next/server';
import { getPrismaClient, listSyncRuns } from '@agile-tools/db';
import { logger, recordManualSyncEnqueue } from '@agile-tools/shared';
import { requireAdminContext } from '@/server/auth';
import { ResponseError } from '@/server/errors';
import { assertTrustedMutationRequest, enforceRateLimit } from '@/server/request-security';
import { requireScope, mapSyncRun, queueManualScopeSync } from '../../_lib';
import { withHttpMetrics } from '@/server/route-metrics';

async function handlePOST(
  _req: NextRequest,
  { params }: { params: Promise<{ scopeId: string }> },
): Promise<Response> {
  let enqueueResult = 'error';
  try {
    const ctx = await requireAdminContext();
    assertTrustedMutationRequest(_req);
    enforceRateLimit(_req, {
      bucket: 'admin-syncs:trigger',
      identifier: `${ctx.workspaceId}:${ctx.userId}:${(await params).scopeId}`,
      max: 10,
      windowMs: 5 * 60_000,
    });
    const { scopeId } = await params;

    await requireScope(ctx.workspaceId, scopeId);

    const queueResult = await queueManualScopeSync(ctx.workspaceId, scopeId, ctx.userId);
    if (queueResult.status === 'active') {
      enqueueResult = 'active';
      return Response.json(
        {
          code: 'SYNC_IN_PROGRESS',
          message: 'A sync is already queued or running for this scope.',
          syncRunId: queueResult.syncRun.id,
        },
        { status: 409 },
      );
    }
    if (queueResult.status === 'failed') {
      enqueueResult = 'failed';
      return Response.json(
        { code: 'SYNC_ENQUEUE_FAILED', message: queueResult.message },
        { status: 503 },
      );
    }

    enqueueResult = 'queued';
    return Response.json(mapSyncRun(queueResult.syncRun), { status: 202 });
  } catch (err) {
    if (err instanceof ResponseError) {
      enqueueResult = 'response_error';
      return err.response;
    }
    logger.error('Failed to trigger manual sync', {
      error: err instanceof Error ? err.message : String(err),
    });
    return Response.json(
      { code: 'INTERNAL_ERROR', message: 'An internal error occurred.' },
      { status: 500 },
    );
  } finally {
    recordManualSyncEnqueue(enqueueResult);
  }
}

async function handleGET(
  _req: NextRequest,
  { params }: { params: Promise<{ scopeId: string }> },
): Promise<Response> {
  try {
    const ctx = await requireAdminContext();
    const { scopeId } = await params;

    await requireScope(ctx.workspaceId, scopeId);

    const prisma = getPrismaClient();
    const runs = await listSyncRuns(prisma, ctx.workspaceId, scopeId);

    return Response.json({ syncs: runs.map(mapSyncRun) });
  } catch (err) {
    if (err instanceof ResponseError) return err.response;
    logger.error('Failed to list sync runs', {
      error: err instanceof Error ? err.message : String(err),
    });
    return Response.json(
      { code: 'INTERNAL_ERROR', message: 'An internal error occurred.' },
      { status: 500 },
    );
  }
}

export const POST = withHttpMetrics('POST', '/api/v1/admin/scopes/[scopeId]/syncs', handlePOST);
export const GET = withHttpMetrics('GET', '/api/v1/admin/scopes/[scopeId]/syncs', handleGET);
