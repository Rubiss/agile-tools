import { type NextRequest } from 'next/server';
import { logger } from '@agile-tools/shared';
import { getBoardDetail } from '@agile-tools/jira-client';
import { requireAdminContext } from '@/server/auth';
import { ResponseError } from '@/server/errors';
import { requireJiraConnection, createClientForConnection, normalizeJiraError } from '../../../../_lib';
import { withHttpMetrics } from '@/server/route-metrics';

async function handleGET(
  _req: NextRequest,
  { params }: { params: Promise<{ connectionId: string; boardId: string }> },
): Promise<Response> {
  const { connectionId, boardId: boardIdStr } = await params;

  const boardId = Number(boardIdStr);
  if (!Number.isSafeInteger(boardId) || boardId <= 0) {
    return Response.json(
      { code: 'INVALID_PARAM', message: 'boardId must be a positive integer.' },
      { status: 400 },
    );
  }

  try {
    const ctx = await requireAdminContext();
    const conn = await requireJiraConnection(ctx.workspaceId, connectionId);
    const client = createClientForConnection(conn);

    try {
      const detail = await getBoardDetail(client, boardId);
      return Response.json(detail);
    } catch (jiraErr) {
      const clientErr = normalizeJiraError(jiraErr);
      if (clientErr?.code === 'not_found') {
        return Response.json(
          { code: 'NOT_FOUND', message: `Board ${boardId} not found.` },
          { status: 404 },
        );
      }
      if (clientErr) {
        const status =
          clientErr.statusCode >= 400 && clientErr.statusCode < 500 ? clientErr.statusCode : 502;
        return Response.json({ code: clientErr.code, message: clientErr.message }, { status });
      }
      throw jiraErr;
    }
  } catch (err) {
    if (err instanceof ResponseError) return err.response;
    logger.error('Failed to discover board detail', {
      connectionId,
      boardId,
      error: err instanceof Error ? err.message : String(err),
    });
    return Response.json(
      { code: 'INTERNAL_ERROR', message: 'An internal error occurred.' },
      { status: 500 },
    );
  }
}

export const GET = withHttpMetrics('GET', '/api/v1/admin/jira-connections/[connectionId]/discovery/boards/[boardId]', handleGET);
