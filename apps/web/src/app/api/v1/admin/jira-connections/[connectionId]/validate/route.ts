import { type NextRequest } from 'next/server';
import { getPrismaClient, updateConnectionHealth } from '@agile-tools/db';
import { logger } from '@agile-tools/shared';
import { requireAdminContext } from '@/server/auth';
import { ResponseError } from '@/server/errors';
import { assertTrustedMutationRequest, enforceRateLimit } from '@/server/request-security';
import { requireJiraConnection, createClientForConnection, normalizeJiraError } from '../../_lib';
import { withHttpMetrics } from '@/server/route-metrics';

async function handlePOST(
  req: NextRequest,
  { params }: { params: Promise<{ connectionId: string }> },
): Promise<Response> {
  const { connectionId } = await params;

  try {
    const ctx = await requireAdminContext();
    assertTrustedMutationRequest(req);
    enforceRateLimit(req, {
      bucket: 'admin-jira-connections:validate',
      identifier: `${ctx.workspaceId}:${ctx.userId}:${connectionId}`,
      max: 12,
      windowMs: 5 * 60_000,
    });
    const conn = await requireJiraConnection(ctx.workspaceId, connectionId);
    const prisma = getPrismaClient();

    // Transition to `validating` before the external call so callers can
    // observe the in-progress state if they poll health concurrently.
    await updateConnectionHealth(prisma, ctx.workspaceId, connectionId, {
      healthStatus: 'validating',
    });

    const client = createClientForConnection(conn);
    const validatedAt = new Date();

    try {
      await client.validateConnection();

      await updateConnectionHealth(prisma, ctx.workspaceId, connectionId, {
        healthStatus: 'healthy',
        lastValidatedAt: validatedAt,
        lastHealthyAt: validatedAt,
        lastErrorCode: null,
      });

      return Response.json({
        connectionId,
        healthStatus: 'healthy',
        validatedAt: validatedAt.toISOString(),
        warnings: [],
      });
    } catch (jiraErr) {
      const clientErr = normalizeJiraError(jiraErr);
      const errorCode = clientErr?.code ?? 'connection_failed';
      const errorMessage = clientErr?.message ?? 'Failed to connect to Jira.';

      await updateConnectionHealth(prisma, ctx.workspaceId, connectionId, {
        healthStatus: 'unhealthy',
        lastValidatedAt: validatedAt,
        lastErrorCode: errorCode,
      });

      return Response.json({
        connectionId,
        healthStatus: 'unhealthy',
        validatedAt: validatedAt.toISOString(),
        warnings: [{ code: errorCode, message: errorMessage }],
      });
    }
  } catch (err) {
    if (err instanceof ResponseError) return err.response;
    logger.error('Failed to validate Jira connection', {
      connectionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return Response.json(
      { code: 'INTERNAL_ERROR', message: 'An internal error occurred.' },
      { status: 500 },
    );
  }
}

export const POST = withHttpMetrics('POST', '/api/v1/admin/jira-connections/[connectionId]/validate', handlePOST);
