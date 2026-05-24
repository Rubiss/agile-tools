import { type NextRequest } from 'next/server';
import { logger } from '@agile-tools/shared';
import { requireWorkspaceContext } from '@/server/auth';
import { ResponseError } from '@/server/errors';
import { buildScopeSummary } from '@/server/views/scope-summary';
import { withHttpMetrics } from '@/server/route-metrics';

async function handleGET(
  _req: NextRequest,
  { params }: { params: Promise<{ scopeId: string }> },
): Promise<Response> {
  try {
    const ctx = await requireWorkspaceContext();
    const { scopeId } = await params;

    const summary = await buildScopeSummary(ctx.workspaceId, scopeId);
    if (!summary) {
      return Response.json(
        { code: 'NOT_FOUND', message: 'Flow scope not found.' },
        { status: 404 },
      );
    }

    return Response.json(summary);
  } catch (err) {
    if (err instanceof ResponseError) return err.response;
    logger.error('Failed to fetch scope summary', {
      error: err instanceof Error ? err.message : String(err),
    });
    return Response.json(
      { code: 'INTERNAL_ERROR', message: 'An internal error occurred.' },
      { status: 500 },
    );
  }
}

export const GET = withHttpMetrics('GET', '/api/v1/scopes/[scopeId]', handleGET);
