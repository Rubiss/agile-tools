import { type NextRequest } from 'next/server';
import {
  countWorkingDaysBetweenDates,
  InvalidTimeZoneError,
  logger,
  metricsClock,
  recordForecastRun,
} from '@agile-tools/shared';
import {
  getPrismaClient,
  getFlowScope,
  getLastSucceededSyncRun,
  getSyncRunByDataVersion,
  queryDailyThroughput,
  computeForecastRequestHash,
  lookupForecastCache,
  storeForecastCache,
  formatDateInTimezone,
} from '@agile-tools/db';
import {
  ForecastRequestSchema,
  type ForecastResponse,
  type ForecastCachePayload,
} from '@agile-tools/shared/contracts/forecast';
import type { Warning } from '@agile-tools/shared/contracts/api';
import {
  runWhenForecast,
  runHowManyForecast,
  DEFAULT_MONTE_CARLO_ITERATIONS,
  FORECAST_CACHE_TTL_HOURS,
  type MonteCarloForecastResult,
} from '@agile-tools/analytics';
import { requireWorkspaceContext } from '@/server/auth';
import { ResponseError } from '@/server/errors';
import { assertTrustedMutationRequest, enforceRateLimit } from '@/server/request-security';
import { buildInvalidScopeTimezoneProblem } from '../../_problems';
import { shapeForecastResponse } from '@/server/views/forecast-response';
import { getCompletedStoryCount, getForecastSampleDays } from '@/server/views/throughput-sample';
import { withHttpMetrics } from '@/server/route-metrics';

async function handlePOST(
  req: NextRequest,
  { params }: { params: Promise<{ scopeId: string }> },
): Promise<Response> {
  const metricStartedAt = metricsClock.now();
  let metricType = 'unknown';
  let metricResult = 'error';
  let metricIterations: number | undefined;
  let metricSampleSize: number | undefined;
  let requestedScopeId: string | undefined;

  try {
    const ctx = await requireWorkspaceContext();
    assertTrustedMutationRequest(req);
    enforceRateLimit(req, {
      bucket: 'scope-forecasts:run',
      identifier: `${ctx.workspaceId}:${ctx.userId}:${(await params).scopeId}`,
      max: 30,
      windowMs: 5 * 60_000,
    });
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

    const body: unknown = await req.json().catch(() => null);
    const parsed = ForecastRequestSchema.safeParse(body);
    if (!parsed.success) {
      metricResult = 'invalid_request';
      return Response.json(
        {
          code: 'INVALID_REQUEST',
          message: 'Invalid request body.',
          details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        },
        { status: 400 },
      );
    }

    const request = parsed.data;
    metricType = request.type;
    const iterations = request.iterations ?? DEFAULT_MONTE_CARLO_ITERATIONS;
    metricIterations = iterations;

    // Validate how_many targetDate is in the future relative to the scope timezone.
    if (request.type === 'how_many') {
      const todayLocal = formatDateInTimezone(new Date(), scope.timezone);
      if (request.targetDate <= todayLocal) {
        metricResult = 'invalid_request';
        return Response.json(
          {
            code: 'INVALID_REQUEST',
            message: `targetDate must be a future date (scope timezone today is ${todayLocal}).`,
          },
          { status: 400 },
        );
      }
    }

    // Resolve the effective data snapshot.
    let effectiveDataVersion: string | undefined;
    let syncedAt: Date | undefined;

    if (request.dataVersion) {
      const syncRun = await getSyncRunByDataVersion(
        db,
        ctx.workspaceId,
        scopeId,
        request.dataVersion,
      );
      if (!syncRun?.dataVersion || !syncRun.finishedAt) {
        metricResult = 'not_found';
        return Response.json(
          {
            code: 'NOT_FOUND',
            message: 'The requested dataVersion does not exist or has not yet succeeded.',
          },
          { status: 404 },
        );
      }
      effectiveDataVersion = syncRun.dataVersion;
      syncedAt = syncRun.finishedAt;
    }

    if (!effectiveDataVersion) {
      const lastSucceeded = await getLastSucceededSyncRun(db, ctx.workspaceId, scopeId);
      effectiveDataVersion = lastSucceeded?.dataVersion ?? undefined;
      syncedAt = lastSucceeded?.finishedAt ?? undefined;
    }

    if (!effectiveDataVersion || !syncedAt) {
      metricResult = 'no_data';
      metricSampleSize = 0;
      return Response.json({
        scopeId,
        dataVersion: '',
        type: request.type,
        historicalWindowDays: request.historicalWindowDays,
        sampleSize: 0,
        iterations,
        warnings: [
          { code: 'NO_DATA', message: 'No synchronized data available yet.' },
        ] satisfies Warning[],
        results: [],
      } satisfies ForecastResponse);
    }

    // Check the forecast cache.
    const requestHash = computeForecastRequestHash({
      type: request.type,
      historicalWindowDays: request.historicalWindowDays,
      iterations,
      confidenceLevels: request.confidenceLevels,
      ...(request.type === 'when' && { remainingStoryCount: request.remainingStoryCount }),
      ...(request.type === 'how_many' && { targetDate: request.targetDate }),
    });

    const cached = await lookupForecastCache(db, scopeId, requestHash, effectiveDataVersion);
    if (cached) {
      metricResult = 'cache_hit';
      metricSampleSize = cached.sampleSize;
      return Response.json(
        shapeForecastResponse({
          scopeId,
          request,
          dataVersion: effectiveDataVersion,
          sampleSize: cached.sampleSize,
          iterations,
          monteCarlo: {
            results: cached.payload.results,
            warnings: cached.payload.warnings,
          },
        }) satisfies ForecastResponse,
      );
    }

    // Query daily throughput — use only fully-completed days for Monte Carlo sampling
    // to avoid biasing forecasts with the partial current day.
    const allDays = await queryDailyThroughput(db, scopeId, scope.timezone, {
      windowDays: request.historicalWindowDays,
      dataVersion: effectiveDataVersion,
    });
    const completeDays = getForecastSampleDays(allDays);
    const historicalDailyThroughput = completeDays.map((d) => d.completedStoryCount);
    const sampleSize = getCompletedStoryCount(completeDays);
    metricSampleSize = sampleSize;

    // Run Monte Carlo simulation.
    let monteCarlo: MonteCarloForecastResult;
    if (request.type === 'when') {
      monteCarlo = runWhenForecast({
        historicalDailyThroughput,
        sampleSize,
        remainingStoryCount: request.remainingStoryCount,
        confidenceLevels: request.confidenceLevels,
        iterations,
        timezone: scope.timezone,
      });
    } else {
      // Compute working days from today (scope timezone) to the target date.
      const todayLocal = formatDateInTimezone(new Date(), scope.timezone);
      const targetDays = countWorkingDaysBetweenDates(todayLocal, request.targetDate);

      monteCarlo = runHowManyForecast({
        historicalDailyThroughput,
        sampleSize,
        targetDays,
        confidenceLevels: request.confidenceLevels,
        iterations,
      });
    }

    // Persist result to cache with a TTL so entries are eventually reaped.
    const cacheExpiresAt = new Date(Date.now() + FORECAST_CACHE_TTL_HOURS * 60 * 60 * 1000);
    const cachePayload: ForecastCachePayload = {
      results: monteCarlo.results,
      warnings: monteCarlo.warnings,
    };
    await storeForecastCache(db, {
      scopeId,
      requestHash,
      historicalWindowDays: request.historicalWindowDays,
      iterations,
      confidenceLevels: request.confidenceLevels,
      sampleSize,
      dataVersion: effectiveDataVersion,
      payload: cachePayload,
      expiresAt: cacheExpiresAt,
    });

    // Opportunistically remove expired cache entries for this scope so the
    // ForecastResultCache table does not grow unbounded over time.
    db.forecastResultCache
      .deleteMany({
        where: { scopeId, expiresAt: { lt: new Date() } },
      })
      .catch((err: unknown) => {
        logger.debug('Opportunistic forecast cache cleanup failed (non-fatal)', {
          scopeId,
          error: err instanceof Error ? err.message : String(err),
        });
      });

    metricResult = 'computed';
    return Response.json(
      shapeForecastResponse({
        scopeId,
        request,
        dataVersion: effectiveDataVersion,
        sampleSize,
        iterations,
        monteCarlo,
      }) satisfies ForecastResponse,
    );
  } catch (err) {
    if (err instanceof ResponseError) {
      metricResult = 'response_error';
      return err.response;
    }
    if (err instanceof InvalidTimeZoneError) {
      metricResult = 'invalid_timezone';
      logger.warn('Forecast request blocked by invalid scope timezone', {
        scopeId: requestedScopeId,
        timezone: err.timezone,
      });
      return Response.json(buildInvalidScopeTimezoneProblem(err.timezone), {
        status: 409,
      });
    }
    logger.error('Failed to run forecast', {
      error: err instanceof Error ? err.message : String(err),
    });
    return Response.json(
      { code: 'INTERNAL_ERROR', message: 'An internal error occurred.' },
      { status: 500 },
    );
  } finally {
    recordForecastRun({
      type: metricType,
      result: metricResult,
      durationSeconds: metricsClock.durationSecondsSince(metricStartedAt),
      ...(metricIterations !== undefined ? { iterations: metricIterations } : {}),
      ...(metricSampleSize !== undefined ? { sampleSize: metricSampleSize } : {}),
    });
  }
}

export const POST = withHttpMetrics('POST', '/api/v1/scopes/[scopeId]/forecasts', handlePOST);
