import { type NextRequest } from 'next/server';
import { logger } from '@agile-tools/shared';
import { listBoards } from '@agile-tools/jira-client';
import { requireAdminContext } from '@/server/auth';
import { ResponseError } from '@/server/errors';
import { requireJiraConnection, createClientForConnection, normalizeJiraError } from '../../../_lib';
import { withHttpMetrics } from '@/server/route-metrics';

async function handleGET(
  _req: NextRequest,
  { params }: { params: Promise<{ connectionId: string }> },
): Promise<Response> {
  const { connectionId } = await params;

  try {
    const ctx = await requireAdminContext();
    const conn = await requireJiraConnection(ctx.workspaceId, connectionId);
    const client = createClientForConnection(conn);
    const boards = await listBoards(client);
    return Response.json({ boards });
  } catch (err) {
    if (err instanceof ResponseError) return err.response;
    const jiraErr = normalizeJiraError(err);
    if (jiraErr) {
      const status =
        jiraErr.statusCode >= 400 && jiraErr.statusCode < 500 ? jiraErr.statusCode : 502;
      return Response.json({ code: jiraErr.code, message: jiraErr.message }, { status });
    }
    logger.error('Failed to discover boards', {
      connectionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return Response.json(
      { code: 'INTERNAL_ERROR', message: 'An internal error occurred.' },
      { status: 500 },
    );
  }
}

export const GET = withHttpMetrics('GET', '/api/v1/admin/jira-connections/[connectionId]/discovery/boards', handleGET);
