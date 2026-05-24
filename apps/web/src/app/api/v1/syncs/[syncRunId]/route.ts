import { type NextRequest } from 'next/server';
import { getPrismaClient, getSyncRun } from '@agile-tools/db';
import { logger } from '@agile-tools/shared';
import { requireWorkspaceContext } from '@/server/auth';
import { ResponseError } from '@/server/errors';
import { mapSyncRun } from '../../admin/scopes/_lib';
import { withHttpMetrics } from '@/server/route-metrics';

async function handleGET(
  _req: NextRequest,
  { params }: { params: Promise<{ syncRunId: string }> },
): Promise<Response> {
  try {
    const ctx = await requireWorkspaceContext();
    const { syncRunId } = await params;

    const prisma = getPrismaClient();
    const run = await getSyncRun(prisma, ctx.workspaceId, syncRunId);

    if (!run) {
      return Response.json(
        { code: 'NOT_FOUND', message: 'Sync run not found.' },
        { status: 404 },
      );
    }

    return Response.json(mapSyncRun(run));
  } catch (err) {
    if (err instanceof ResponseError) return err.response;
    logger.error('Failed to fetch sync run', {
      error: err instanceof Error ? err.message : String(err),
    });
    return Response.json(
      { code: 'INTERNAL_ERROR', message: 'An internal error occurred.' },
      { status: 500 },
    );
  }
}

export const GET = withHttpMetrics('GET', '/api/v1/syncs/[syncRunId]', handleGET);
