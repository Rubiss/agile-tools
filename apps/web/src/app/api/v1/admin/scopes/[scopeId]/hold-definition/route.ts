import { type NextRequest } from 'next/server';
import { getPrismaClient, getActiveHoldDefinition, upsertHoldDefinition } from '@agile-tools/db';
import { logger } from '@agile-tools/shared';
import { HoldDefinitionRequestSchema } from '@agile-tools/shared/contracts/api';
import type { HoldDefinitionResponse } from '@agile-tools/shared/contracts/api';
import { requireAdminContext } from '@/server/auth';
import { ResponseError } from '@/server/errors';
import { assertTrustedMutationRequest, enforceRateLimit } from '@/server/request-security';
import { requireScope } from '../../_lib';
import { withHttpMetrics } from '@/server/route-metrics';

async function handleGET(
  _req: NextRequest,
  { params }: { params: Promise<{ scopeId: string }> },
): Promise<Response> {
  try {
    const ctx = await requireAdminContext();
    const { scopeId } = await params;

    await requireScope(ctx.workspaceId, scopeId);

    const prisma = getPrismaClient();
    const definition = await getActiveHoldDefinition(prisma, scopeId);

    if (!definition) {
      return Response.json(
        { code: 'NOT_FOUND', message: 'No hold definition configured for this scope.' },
        { status: 404 },
      );
    }

    return Response.json(mapHoldDefinition(scopeId, definition));
  } catch (err) {
    if (err instanceof ResponseError) return err.response;
    logger.error('Failed to get hold definition', {
      error: err instanceof Error ? err.message : String(err),
    });
    return Response.json(
      { code: 'INTERNAL_ERROR', message: 'An internal error occurred.' },
      { status: 500 },
    );
  }
}

async function handlePUT(
  req: NextRequest,
  { params }: { params: Promise<{ scopeId: string }> },
): Promise<Response> {
  try {
    const ctx = await requireAdminContext();
    assertTrustedMutationRequest(req);
    enforceRateLimit(req, {
      bucket: 'admin-hold-definition:update',
      identifier: `${ctx.workspaceId}:${ctx.userId}:${(await params).scopeId}`,
      max: 30,
      windowMs: 5 * 60_000,
    });
    const { scopeId } = await params;

    await requireScope(ctx.workspaceId, scopeId);

    const body: unknown = await req.json().catch(() => null);
    const parsed = HoldDefinitionRequestSchema.safeParse(body);
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

    const { holdStatusIds, blockedFieldId, blockedTruthyValues } = parsed.data;

    const prisma = getPrismaClient();
    let definition;
    try {
      const input = {
        holdStatusIds,
        ...(blockedFieldId !== undefined && { blockedFieldId }),
        ...(blockedTruthyValues !== undefined && { blockedTruthyValues }),
      };
      definition = await upsertHoldDefinition(prisma, scopeId, input, ctx.userId);
    } catch (err) {
      if (err instanceof Error && err.message.includes('blockedTruthyValues')) {
        return Response.json({ code: 'INVALID_REQUEST', message: err.message }, { status: 400 });
      }
      throw err;
    }

    return Response.json(mapHoldDefinition(scopeId, definition));
  } catch (err) {
    if (err instanceof ResponseError) return err.response;
    logger.error('Failed to save hold definition', {
      error: err instanceof Error ? err.message : String(err),
    });
    return Response.json(
      { code: 'INTERNAL_ERROR', message: 'An internal error occurred.' },
      { status: 500 },
    );
  }
}

export const GET = withHttpMetrics('GET', '/api/v1/admin/scopes/[scopeId]/hold-definition', handleGET);
export const PUT = withHttpMetrics('PUT', '/api/v1/admin/scopes/[scopeId]/hold-definition', handlePUT);

function mapHoldDefinition(
  scopeId: string,
  definition: {
    holdStatusIds: string[];
    blockedFieldId: string | null;
    blockedTruthyValues: string[];
    effectiveFrom: Date;
  },
): HoldDefinitionResponse {
  return {
    scopeId,
    holdStatusIds: definition.holdStatusIds,
    ...(definition.blockedFieldId != null && { blockedFieldId: definition.blockedFieldId }),
    ...(definition.blockedTruthyValues.length > 0 && {
      blockedTruthyValues: definition.blockedTruthyValues,
    }),
    effectiveFrom: definition.effectiveFrom.toISOString(),
  };
}
