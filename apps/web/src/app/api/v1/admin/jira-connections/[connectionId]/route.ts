import { type NextRequest } from 'next/server';
import { getPrismaClient, updateJiraConnection } from '@agile-tools/db';
import { encryptSecret, getConfig, logger } from '@agile-tools/shared';
import { UpdateJiraConnectionRequestSchema } from '@agile-tools/shared/contracts/api';
import { requireAdminContext } from '@/server/auth';
import { ResponseError } from '@/server/errors';
import { assertTrustedMutationRequest, enforceRateLimit } from '@/server/request-security';
import { requireJiraConnection, mapConnection } from '../_lib';
import { withHttpMetrics } from '@/server/route-metrics';

async function handlePUT(
  req: NextRequest,
  { params }: { params: Promise<{ connectionId: string }> },
): Promise<Response> {
  try {
    const ctx = await requireAdminContext();
    assertTrustedMutationRequest(req);
    enforceRateLimit(req, {
      bucket: 'admin-jira-connections:update',
      identifier: `${ctx.workspaceId}:${ctx.userId}:${(await params).connectionId}`,
      max: 10,
      windowMs: 5 * 60_000,
    });

    const { connectionId } = await params;
    const existingConnection = await requireJiraConnection(ctx.workspaceId, connectionId);

    const body: unknown = await req.json().catch(() => null);
    const parsed = UpdateJiraConnectionRequestSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json(
        {
          code: 'INVALID_REQUEST',
          message: 'Invalid request body.',
          details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        },
        { status: 400 },
      );
    }

    const normalizedBaseUrl = parsed.data.baseUrl.replace(/\/$/, '');
    const normalizedDisplayName =
      parsed.data.displayName === undefined
        ? undefined
        : parsed.data.displayName.trim() || null;
    const rotatedPat = parsed.data.pat;
    const shouldRotatePat = rotatedPat !== undefined;
    const shouldResetValidation = normalizedBaseUrl !== existingConnection.baseUrl || shouldRotatePat;
    const encryptedSecretRef = rotatedPat !== undefined
      ? encryptSecret(rotatedPat, getConfig().ENCRYPTION_KEY)
      : undefined;

    const prisma = getPrismaClient();
    const updatedConnection = await updateJiraConnection(prisma, ctx.workspaceId, connectionId, {
      baseUrl: normalizedBaseUrl,
      ...(normalizedDisplayName !== undefined && { displayName: normalizedDisplayName }),
      ...(encryptedSecretRef !== undefined && { encryptedSecretRef }),
      resetValidationState: shouldResetValidation,
    });

    if (!updatedConnection) {
      return Response.json(
        { code: 'NOT_FOUND', message: 'Jira connection not found.' },
        { status: 404 },
      );
    }

    return Response.json(mapConnection(updatedConnection));
  } catch (err) {
    if (err instanceof ResponseError) return err.response;
    logger.error('Failed to update Jira connection', {
      error: err instanceof Error ? err.message : String(err),
    });
    return Response.json(
      { code: 'INTERNAL_ERROR', message: 'An internal error occurred.' },
      { status: 500 },
    );
  }
}

export const PUT = withHttpMetrics('PUT', '/api/v1/admin/jira-connections/[connectionId]', handlePUT);
