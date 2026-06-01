import { type NextRequest } from 'next/server';
import {
  countWorkingDaysBetweenDates,
  DEFAULT_SAMPLE_WINDOW_DAYS,
  InvalidTimeZoneError,
  logger,
  metricsClock,
  resolveSampleWindow,
  SampleWindowValidationError,
} from '@agile-tools/shared';
import {
  formatDateInTimezone,
  getFlowScope,
  getLastSucceededSyncRun,
  getPrismaClient,
  getSyncRunByDataVersion,
  listEpicForecastTargets,
  queryDailyThroughput,
  upsertEpicForecastTarget,
} from '@agile-tools/db';
import { DEFAULT_MONTE_CARLO_ITERATIONS, runEpicForecast } from '@agile-tools/analytics';
import {
  EpicForecastRequestSchema,
  UpsertEpicForecastTargetRequestSchema,
  type EpicForecastResponse,
  type EpicForecastTarget,
} from '@agile-tools/shared/contracts/epic-forecast';
import type { Warning } from '@agile-tools/shared/contracts/api';
import { requireWorkspaceContext } from '@/server/auth';
import { ResponseError } from '@/server/errors';
import { assertTrustedMutationRequest, enforceRateLimit } from '@/server/request-security';
import { getCompletedStoryCount, getForecastSampleDays } from '@/server/views/throughput-sample';
import { withHttpMetrics } from '@/server/route-metrics';
import { buildInvalidScopeTimezoneProblem } from '../../_problems';

interface ProblemResponse {
  code: string;
  message: string;
  details?: string[];
}

function serializeTarget(target: {
  id: string;
  scopeId: string;
  jiraIssueKey: string;
  summary: string;
  dueDate: string;
  remainingStoryCount: number;
  storyCountSource: string;
  epicLinkStoryCount: number | null;
  jiraStoryCount: number | null;
  manualStoryCount: number | null;
  status: string;
  closedAt: Date | null;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}): EpicForecastTarget {
  return {
    id: target.id,
    scopeId: target.scopeId,
    jiraIssueKey: target.jiraIssueKey,
    summary: target.summary,
    dueDate: target.dueDate,
    remainingStoryCount: target.remainingStoryCount,
    storyCountSource:
      target.storyCountSource === 'epic_link' || target.storyCountSource === 'jira_field'
        ? target.storyCountSource
        : 'manual',
    epicLinkStoryCount: target.epicLinkStoryCount,
    jiraStoryCount: target.jiraStoryCount,
    manualStoryCount: target.manualStoryCount,
    status: target.status === 'closed' ? 'closed' : 'active',
    closedAt: target.closedAt?.toISOString() ?? null,
    sortOrder: target.sortOrder,
    createdAt: target.createdAt.toISOString(),
    updatedAt: target.updatedAt.toISOString(),
  };
}

function parseEpicForecastQuery(req: NextRequest): unknown {
  const params = req.nextUrl.searchParams;
  const historicalWindowParam = params.get('historicalWindowDays');
  const iterationsParam = params.get('iterations');
  return {
    sampleMode: params.get('sampleMode') ?? undefined,
    historicalWindowDays:
      historicalWindowParam === null ? undefined : Number(historicalWindowParam),
    sampleStartDate: params.get('sampleStartDate') ?? undefined,
    sampleEndDate: params.get('sampleEndDate') ?? undefined,
    iterations: iterationsParam === null ? undefined : Number(iterationsParam),
    dataVersion: params.get('dataVersion') ?? undefined,
  };
}

async function resolveDataVersion(
  db: ReturnType<typeof getPrismaClient>,
  workspaceId: string,
  scopeId: string,
  requestedDataVersion?: string,
): Promise<{ dataVersion?: string; syncedAt?: Date } | ProblemResponse> {
  const lastSucceeded = await getLastSucceededSyncRun(db, workspaceId, scopeId);

  if (requestedDataVersion) {
    if (lastSucceeded?.dataVersion === requestedDataVersion && lastSucceeded.finishedAt) {
      return { dataVersion: lastSucceeded.dataVersion, syncedAt: lastSucceeded.finishedAt };
    }

    const syncRun = await getSyncRunByDataVersion(
      db,
      workspaceId,
      scopeId,
      requestedDataVersion,
    );
    if (!syncRun?.dataVersion || !syncRun.finishedAt) {
      return {
        code: 'NOT_FOUND',
        message: 'The requested dataVersion does not exist or has not yet succeeded.',
      };
    }

    return {
      dataVersion: lastSucceeded?.dataVersion ?? syncRun.dataVersion,
      syncedAt: lastSucceeded?.finishedAt ?? syncRun.finishedAt,
    };
  }

  if (lastSucceeded?.dataVersion && lastSucceeded.finishedAt) {
    return { dataVersion: lastSucceeded.dataVersion, syncedAt: lastSucceeded.finishedAt };
  }
  return {};
}

async function handleGET(
  req: NextRequest,
  { params }: { params: Promise<{ scopeId: string }> },
): Promise<Response> {
  try {
    const ctx = await requireWorkspaceContext();
    const { scopeId } = await params;
    const db = getPrismaClient();
    const scope = await getFlowScope(db, ctx.workspaceId, scopeId);
    if (!scope) {
      return Response.json({ code: 'NOT_FOUND', message: 'Flow scope not found.' }, { status: 404 });
    }

    const parsed = EpicForecastRequestSchema.safeParse(parseEpicForecastQuery(req));
    if (!parsed.success) {
      return Response.json(
        {
          code: 'INVALID_REQUEST',
          message: 'Invalid query parameters.',
          details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        },
        { status: 400 },
      );
    }

    const request = parsed.data;
    const iterations = request.iterations ?? DEFAULT_MONTE_CARLO_ITERATIONS;
    const dataVersionResult = await resolveDataVersion(
      db,
      ctx.workspaceId,
      scopeId,
      request.dataVersion,
    );
    if ('code' in dataVersionResult) {
      return Response.json(dataVersionResult, { status: 404 });
    }

    const targets = await listEpicForecastTargets(db, scopeId);
    const serializedTargets = targets.map(serializeTarget);
    const activeTargets = serializedTargets.filter((target) => target.status === 'active');
    const sampleWindow = resolveSampleWindow(
      {
        sampleMode: request.sampleMode,
        historicalWindowDays: request.historicalWindowDays ?? DEFAULT_SAMPLE_WINDOW_DAYS,
        sampleStartDate: request.sampleStartDate,
        sampleEndDate: request.sampleEndDate,
      },
      {
        timezone: scope.timezone,
        ...(dataVersionResult.syncedAt ? { anchorDate: dataVersionResult.syncedAt } : {}),
      },
    );

    if (!dataVersionResult.dataVersion || !dataVersionResult.syncedAt) {
      return Response.json({
        scopeId,
        dataVersion: '',
        ...sampleWindow,
        sampleSize: 0,
        iterations,
        warnings: [{ code: 'NO_DATA', message: 'No synchronized data available yet.' }] satisfies Warning[],
      targets: serializedTargets,
      results: [],
      } satisfies EpicForecastResponse);
    }

    const allDays = await queryDailyThroughput(db, scopeId, scope.timezone, {
      sampleStartDate: sampleWindow.sampleStartDate,
      sampleEndDate: sampleWindow.sampleEndDate,
      anchorDate: dataVersionResult.syncedAt,
      dataVersion: dataVersionResult.dataVersion,
    });
    const completeDays = getForecastSampleDays(allDays);
    const historicalDailyThroughput = completeDays.map((day) => day.completedStoryCount);
    const sampleSize = getCompletedStoryCount(completeDays);
    const todayLocal = formatDateInTimezone(new Date(), scope.timezone);
    const simulation = runEpicForecast({
      historicalDailyThroughput,
      sampleSize,
      iterations,
      targets: activeTargets.map((target) => ({
        id: target.id,
        jiraIssueKey: target.jiraIssueKey,
        summary: target.summary,
        dueDate: target.dueDate,
        remainingStoryCount: target.remainingStoryCount,
        targetDays: Math.max(0, countWorkingDaysBetweenDates(todayLocal, target.dueDate)),
      })),
    });

    return Response.json({
      scopeId,
      dataVersion: dataVersionResult.dataVersion,
      ...sampleWindow,
      sampleSize,
      iterations,
      warnings: simulation.warnings,
      targets: serializedTargets,
      results: simulation.results,
    } satisfies EpicForecastResponse);
  } catch (err) {
    if (err instanceof ResponseError) {
      return err.response;
    }
    if (err instanceof SampleWindowValidationError) {
      return Response.json(
        { code: 'INVALID_REQUEST', message: 'Invalid forecast sample window.', details: err.details },
        { status: 400 },
      );
    }
    if (err instanceof InvalidTimeZoneError) {
      return Response.json(buildInvalidScopeTimezoneProblem(err.timezone), { status: 409 });
    }
    logger.error('Failed to load epic forecast', {
      error: err instanceof Error ? err.message : String(err),
    });
    return Response.json(
      { code: 'INTERNAL_ERROR', message: 'An internal error occurred.' },
      { status: 500 },
    );
  }
}

async function handlePOST(
  req: NextRequest,
  { params }: { params: Promise<{ scopeId: string }> },
): Promise<Response> {
  try {
    const startedAt = metricsClock.now();
    const ctx = await requireWorkspaceContext();
    assertTrustedMutationRequest(req);
    const { scopeId } = await params;
    enforceRateLimit(req, {
      bucket: 'scope-epic-forecasts:write',
      identifier: `${ctx.workspaceId}:${ctx.userId}:${scopeId}`,
      max: 60,
      windowMs: 5 * 60_000,
    });

    const db = getPrismaClient();
    const scope = await getFlowScope(db, ctx.workspaceId, scopeId);
    if (!scope) {
      return Response.json({ code: 'NOT_FOUND', message: 'Flow scope not found.' }, { status: 404 });
    }

    const body: unknown = await req.json().catch(() => null);
    const parsed = UpsertEpicForecastTargetRequestSchema.safeParse(body);
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

    const targetInput = {
      scopeId,
      jiraIssueKey: parsed.data.jiraIssueKey.toUpperCase(),
      summary: parsed.data.summary,
      dueDate: parsed.data.dueDate,
      remainingStoryCount: parsed.data.remainingStoryCount,
      ...(parsed.data.storyCountSource !== undefined ? { storyCountSource: parsed.data.storyCountSource } : {}),
      ...(parsed.data.epicLinkStoryCount !== undefined ? { epicLinkStoryCount: parsed.data.epicLinkStoryCount } : {}),
      ...(parsed.data.jiraStoryCount !== undefined ? { jiraStoryCount: parsed.data.jiraStoryCount } : {}),
      ...(parsed.data.manualStoryCount !== undefined ? { manualStoryCount: parsed.data.manualStoryCount } : {}),
      ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
      ...(parsed.data.closedAt !== undefined ? { closedAt: parsed.data.closedAt ? new Date(parsed.data.closedAt) : null } : {}),
      ...(parsed.data.sortOrder !== undefined ? { sortOrder: parsed.data.sortOrder } : {}),
    };
    const target = await upsertEpicForecastTarget(db, targetInput);
    logger.info('Epic forecast target saved', {
      scopeId,
      targetId: target.id,
      durationSeconds: metricsClock.durationSecondsSince(startedAt),
    });
    return Response.json(serializeTarget(target), { status: 201 });
  } catch (err) {
    if (err instanceof ResponseError) {
      return err.response;
    }
    logger.error('Failed to save epic forecast target', {
      error: err instanceof Error ? err.message : String(err),
    });
    return Response.json(
      { code: 'INTERNAL_ERROR', message: 'An internal error occurred.' },
      { status: 500 },
    );
  }
}

export const GET = withHttpMetrics('GET', '/api/v1/scopes/[scopeId]/epic-forecasts', handleGET);
export const POST = withHttpMetrics('POST', '/api/v1/scopes/[scopeId]/epic-forecasts', handlePOST);
