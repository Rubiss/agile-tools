import { type NextRequest } from 'next/server';
import {
  InvalidTimeZoneError,
  logger,
  metricsClock,
  recordThroughputRead,
  resolveSampleWindow,
  SampleWindowRequestSchema,
  SampleWindowValidationError,
} from '@agile-tools/shared';
import {
  getPrismaClient,
  getFlowScope,
  getLastSucceededSyncRun,
  getSyncRunByDataVersion,
  queryDailyThroughput,
} from '@agile-tools/db';
import type { ThroughputResponse, Warning } from '@agile-tools/shared/contracts/api';
import { requireWorkspaceContext } from '@/server/auth';
import { ResponseError } from '@/server/errors';
import { getForecastSampleSize } from '@/server/views/throughput-sample';
import { buildInvalidScopeTimezoneProblem } from '../../_problems';
import { withHttpMetrics } from '@/server/route-metrics';

function parseSampleWindowParams(url: URL): unknown {
  const historicalWindowParam = url.searchParams.get('historicalWindowDays');
  return {
    sampleMode: url.searchParams.get('sampleMode') ?? undefined,
    historicalWindowDays:
      historicalWindowParam === null ? undefined : Number(historicalWindowParam),
    sampleStartDate: url.searchParams.get('sampleStartDate') ?? undefined,
    sampleEndDate: url.searchParams.get('sampleEndDate') ?? undefined,
  };
}

function invalidSampleWindowResponse(details: string[]): Response {
  return Response.json(
    {
      code: 'INVALID_REQUEST',
      message: 'Invalid throughput sample window.',
      details,
    },
    { status: 400 },
  );
}

async function handleGET(
  req: NextRequest,
  { params }: { params: Promise<{ scopeId: string }> },
): Promise<Response> {
  const metricStartedAt = metricsClock.now();
  let metricResult = 'error';
  let metricDayCount: number | undefined;
  let metricSampleSize: number | undefined;
  let requestedScopeId: string | undefined;

  try {
    const ctx = await requireWorkspaceContext();
    const { scopeId } = await params;
    requestedScopeId = scopeId;
    const db = getPrismaClient();

    const scope = await getFlowScope(db, ctx.workspaceId, scopeId);
    if (!scope) {
      metricResult = 'not_found';
      return Response.json(
        { code: 'NOT_FOUND', message: 'Flow scope not found.' },
        { status: 404 },
      );
    }

    const url = new URL(req.url);
    const parsedSampleWindow = SampleWindowRequestSchema.safeParse(parseSampleWindowParams(url));
    if (!parsedSampleWindow.success) {
      metricResult = 'invalid_request';
      return invalidSampleWindowResponse(
        parsedSampleWindow.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
      );
    }
    const requestedDataVersion = url.searchParams.get('dataVersion') ?? undefined;

    // Resolve the effective data snapshot and its syncedAt timestamp.
    let effectiveDataVersion: string | undefined;
    let syncedAt: Date | undefined;

    if (requestedDataVersion) {
      const syncRun = await getSyncRunByDataVersion(
        db,
        ctx.workspaceId,
        scopeId,
        requestedDataVersion,
      );
      if (syncRun?.dataVersion && syncRun.finishedAt) {
        effectiveDataVersion = syncRun.dataVersion;
        syncedAt = syncRun.finishedAt;
      }
    }

    if (!effectiveDataVersion) {
      const lastSucceeded = await getLastSucceededSyncRun(db, ctx.workspaceId, scopeId);
      effectiveDataVersion = lastSucceeded?.dataVersion ?? undefined;
      syncedAt = lastSucceeded?.finishedAt ?? undefined;
    }

    let sampleWindow;
    try {
      sampleWindow = resolveSampleWindow(parsedSampleWindow.data, {
        timezone: scope.timezone,
        ...(syncedAt ? { anchorDate: syncedAt } : {}),
      });
    } catch (err) {
      if (err instanceof SampleWindowValidationError) {
        metricResult = 'invalid_request';
        return invalidSampleWindowResponse(err.details);
      }
      throw err;
    }

    if (!effectiveDataVersion || !syncedAt) {
      metricResult = 'no_data';
      metricDayCount = 0;
      metricSampleSize = 0;
      return Response.json({
        scopeId,
        dataVersion: '',
        syncedAt: new Date(0).toISOString(),
        ...sampleWindow,
        sampleSize: 0,
        warnings: [
          { code: 'NO_DATA', message: 'No synchronized data available yet.' },
        ] satisfies Warning[],
        days: [],
      } satisfies ThroughputResponse);
    }

    const days = await queryDailyThroughput(db, scopeId, scope.timezone, {
      sampleStartDate: sampleWindow.sampleStartDate,
      sampleEndDate: sampleWindow.sampleEndDate,
      anchorDate: syncedAt,
      dataVersion: effectiveDataVersion,
    });

    const sampleSize = getForecastSampleSize(days);
    metricResult = 'success';
    metricDayCount = days.length;
    metricSampleSize = sampleSize;

    return Response.json({
      scopeId,
      dataVersion: effectiveDataVersion,
      syncedAt: syncedAt.toISOString(),
      ...sampleWindow,
      sampleSize,
      warnings: [] satisfies Warning[],
      days,
    } satisfies ThroughputResponse);
  } catch (err) {
    if (err instanceof ResponseError) {
      metricResult = 'response_error';
      return err.response;
    }
    if (err instanceof InvalidTimeZoneError) {
      metricResult = 'invalid_timezone';
      logger.warn('Throughput request blocked by invalid scope timezone', {
        scopeId: requestedScopeId,
        timezone: err.timezone,
      });
      return Response.json(buildInvalidScopeTimezoneProblem(err.timezone), {
        status: 409,
      });
    }
    logger.error('Failed to fetch throughput', {
      error: err instanceof Error ? err.message : String(err),
    });
    return Response.json(
      { code: 'INTERNAL_ERROR', message: 'An internal error occurred.' },
      { status: 500 },
    );
  } finally {
    recordThroughputRead({
      result: metricResult,
      durationSeconds: metricsClock.durationSecondsSince(metricStartedAt),
      ...(metricDayCount !== undefined ? { dayCount: metricDayCount } : {}),
      ...(metricSampleSize !== undefined ? { sampleSize: metricSampleSize } : {}),
    });
  }
}

export const GET = withHttpMetrics('GET', '/api/v1/scopes/[scopeId]/throughput', handleGET);
