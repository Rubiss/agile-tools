import { type NextRequest } from 'next/server';
import { getFlowScope, getPrismaClient } from '@agile-tools/db';
import { JiraClientError } from '@agile-tools/jira-client';
import { logger } from '@agile-tools/shared';
import { requireWorkspaceContext } from '@/server/auth';
import { ResponseError } from '@/server/errors';
import { assertTrustedMutationRequest, enforceRateLimit } from '@/server/request-security';
import { createClientForConnection, requireJiraConnection } from '../../../../admin/jira-connections/_lib';
import { withHttpMetrics } from '@/server/route-metrics';

interface JiraEpicIssue {
  key: string;
  fields: {
    summary?: string;
    duedate?: string | null;
    status?: { name?: string };
  };
}

interface JiraSearchTotalResponse {
  total: number;
}

function buildJiraIssueUrl(baseUrl: string, issueKey: string): string {
  return `${baseUrl.replace(/\/$/, '')}/browse/${encodeURIComponent(issueKey)}`;
}

function normalizeIssueKey(value: string | null): string | null {
  const normalized = value?.trim().toUpperCase();
  return normalized ? normalized : null;
}

async function handleGET(
  req: NextRequest,
  { params }: { params: Promise<{ scopeId: string }> },
): Promise<Response> {
  try {
    const ctx = await requireWorkspaceContext();
    assertTrustedMutationRequest(req);
    const { scopeId } = await params;
    const issueKey = normalizeIssueKey(req.nextUrl.searchParams.get('issueKey'));
    if (!issueKey) {
      return Response.json(
        { code: 'INVALID_REQUEST', message: 'issueKey is required.' },
        { status: 400 },
      );
    }

    enforceRateLimit(req, {
      bucket: 'scope-epic-forecasts:lookup',
      identifier: `${ctx.workspaceId}:${ctx.userId}:${scopeId}`,
      max: 30,
      windowMs: 5 * 60_000,
    });

    const db = getPrismaClient();
    const scope = await getFlowScope(db, ctx.workspaceId, scopeId);
    if (!scope) {
      return Response.json({ code: 'NOT_FOUND', message: 'Flow scope not found.' }, { status: 404 });
    }

    const connection = await requireJiraConnection(ctx.workspaceId, scope.connectionId);
    const client = createClientForConnection(connection);
    const epic = await client.get<JiraEpicIssue>(`/rest/api/2/issue/${encodeURIComponent(issueKey)}`, {
      params: { fields: 'summary,duedate,status' },
    });
    const children = await client.get<JiraSearchTotalResponse>('/rest/api/2/search', {
      params: {
        jql: `"Epic Link" = "${issueKey}"`,
        maxResults: 0,
        fields: 'summary',
      },
    });

    return Response.json({
      jiraIssueKey: epic.key,
      summary: epic.fields.summary ?? epic.key,
      dueDate: epic.fields.duedate ?? null,
      epicLinkStoryCount: children.total,
      jiraStoryCount: null,
      statusName: epic.fields.status?.name ?? null,
      directUrl: buildJiraIssueUrl(connection.baseUrl, epic.key),
    });
  } catch (err) {
    if (err instanceof ResponseError) {
      return err.response;
    }
    if (err instanceof JiraClientError && err.code === 'not_found') {
      return Response.json(
        { code: 'NOT_FOUND', message: 'Epic was not found in Jira.' },
        { status: 404 },
      );
    }
    logger.error('Failed to look up Jira epic', {
      error: err instanceof Error ? err.message : String(err),
    });
    return Response.json(
      { code: 'INTERNAL_ERROR', message: 'An internal error occurred.' },
      { status: 500 },
    );
  }
}

export const GET = withHttpMetrics(
  'GET',
  '/api/v1/scopes/[scopeId]/epic-forecasts/lookup',
  handleGET,
);
