import { createServer, type Server } from 'node:http';
import { metrics, type Counter, type Histogram, type MetricAttributes } from '@opentelemetry/api';
import { PrometheusExporter, PrometheusSerializer } from '@opentelemetry/exporter-prometheus';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { AggregationType, MeterProvider } from '@opentelemetry/sdk-metrics';
import {
  ATTR_ERROR_TYPE,
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_HTTP_ROUTE,
  ATTR_SERVER_ADDRESS,
  ATTR_SERVER_PORT,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_NAMESPACE,
  ATTR_URL_SCHEME,
  ERROR_TYPE_VALUE_OTHER,
  METRIC_HTTP_CLIENT_REQUEST_DURATION,
  HTTP_REQUEST_METHOD_VALUE_OTHER,
  METRIC_HTTP_SERVER_REQUEST_DURATION,
} from '@opentelemetry/semantic-conventions';

import { logger } from './logging.js';

export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

type RuntimeName = 'web' | 'worker' | 'test' | 'unknown';

export interface InitializeMetricsOptions {
  serviceName: string;
  runtime: RuntimeName;
}

interface QueueStatsSnapshot {
  queueName: string;
  queuedCount: number;
  activeCount: number;
  deferredCount: number;
  totalCount: number;
}

interface MetricsState {
  exporter: PrometheusExporter;
  serializer: PrometheusSerializer;
  meterProvider: MeterProvider;
  scrapeCounter: Counter;
  collectionErrorCounter: Counter;
  httpRequestDuration: Histogram;
  forecastRunsCounter: Counter;
  forecastDuration: Histogram;
  forecastIterations: Histogram;
  forecastSampleSize: Histogram;
  flowReadsCounter: Counter;
  flowReadDuration: Histogram;
  flowItemsReturned: Histogram;
  throughputReadsCounter: Counter;
  throughputReadDuration: Histogram;
  throughputDaysReturned: Histogram;
  throughputSampleSize: Histogram;
  manualSyncEnqueueCounter: Counter;
  workerJobsCounter: Counter;
  workerJobDuration: Histogram;
  syncRunsCounter: Counter;
  syncRunDuration: Histogram;
  syncItemsProcessed: Histogram;
  httpClientRequestDuration: Histogram;
  databaseQueryDuration: Histogram;
  queueStatsProvider?: () => Promise<QueueStatsSnapshot[]>;
  queueStatsRegistered: boolean;
  server?: Server;
}

const metricsGlobal = globalThis as typeof globalThis & {
  __agileToolsOtelMetrics?: MetricsState;
};

const HTTP_REQUEST_DURATION_BOUNDARIES_SECONDS = [
  0.005,
  0.01,
  0.025,
  0.05,
  0.075,
  0.1,
  0.25,
  0.5,
  0.75,
  1,
  2.5,
  5,
  7.5,
  10,
];

const METRIC_DATABASE_QUERY_DURATION = 'agile_tools_db_query_duration_seconds';
const WORKER_OPERATION_DURATION_BOUNDARIES_SECONDS = [5, 10, 30, 60, 120, 300, 600, 900];

const STANDARD_HTTP_METHODS = new Set([
  'CONNECT',
  'DELETE',
  'GET',
  'HEAD',
  'OPTIONS',
  'PATCH',
  'POST',
  'PUT',
  'QUERY',
  'TRACE',
]);

function durationSecondsSince(startedAtMs: number): number {
  return Math.max(0, (Date.now() - startedAtMs) / 1000);
}

function defaultPortForScheme(scheme: string): number | undefined {
  if (scheme === 'http') return 80;
  if (scheme === 'https') return 443;
  return undefined;
}

function serverPort(url: URL): number | undefined {
  if (url.port) return Number(url.port);
  return defaultPortForScheme(url.protocol.replace(/:$/, ''));
}

function normalizeHttpMethod(method: string): string {
  const normalized = method.toUpperCase();
  return STANDARD_HTTP_METHODS.has(normalized) ? normalized : HTTP_REQUEST_METHOD_VALUE_OTHER;
}

function createMetricsState(options: InitializeMetricsOptions): MetricsState {
  const exporter = new PrometheusExporter({
    endpoint: '/metrics',
    preventServerStart: true,
    withoutScopeInfo: true,
  });
  const meterProvider = new MeterProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: options.serviceName,
      [ATTR_SERVICE_NAMESPACE]: 'agile-tools',
      'service.runtime': options.runtime,
    }),
    views: [
      {
        instrumentName: METRIC_HTTP_SERVER_REQUEST_DURATION,
        aggregation: {
          type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
          options: { boundaries: HTTP_REQUEST_DURATION_BOUNDARIES_SECONDS },
        },
      },
      {
        instrumentName: METRIC_HTTP_CLIENT_REQUEST_DURATION,
        aggregation: {
          type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
          options: { boundaries: HTTP_REQUEST_DURATION_BOUNDARIES_SECONDS },
        },
      },
      {
        instrumentName: METRIC_DATABASE_QUERY_DURATION,
        aggregation: {
          type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
          options: { boundaries: HTTP_REQUEST_DURATION_BOUNDARIES_SECONDS },
        },
      },
      {
        instrumentName: 'agile_tools_worker_job_duration_seconds',
        aggregation: {
          type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
          options: { boundaries: WORKER_OPERATION_DURATION_BOUNDARIES_SECONDS },
        },
      },
      {
        instrumentName: 'agile_tools_sync_run_duration_seconds',
        aggregation: {
          type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
          options: { boundaries: WORKER_OPERATION_DURATION_BOUNDARIES_SECONDS },
        },
      },
    ],
    readers: [exporter],
  });
  metrics.setGlobalMeterProvider(meterProvider);

  const serializer = new PrometheusSerializer(undefined, false, undefined, false, true);
  const meter = meterProvider.getMeter('agile-tools');

  const scrapeCounter = meter.createCounter('agile_tools_metrics_scrapes', {
    description: 'Number of Prometheus scrapes served by this process.',
    unit: '1',
  });
  const collectionErrorCounter = meter.createCounter('agile_tools_metrics_collection_errors', {
    description: 'Number of non-fatal OpenTelemetry metric collection errors observed by this process.',
    unit: '1',
  });

  const state: MetricsState = {
    exporter,
    serializer,
    meterProvider,
    scrapeCounter,
    collectionErrorCounter,
    httpRequestDuration: meter.createHistogram(METRIC_HTTP_SERVER_REQUEST_DURATION, {
      description: 'Duration of HTTP server requests.',
      unit: 's',
    }),
    forecastRunsCounter: meter.createCounter('agile_tools_forecast_runs', {
      description: 'Forecast requests by type and result.',
      unit: '1',
    }),
    forecastDuration: meter.createHistogram('agile_tools_forecast_duration_seconds', {
      description: 'Forecast request duration in seconds.',
      unit: 's',
    }),
    forecastIterations: meter.createHistogram('agile_tools_forecast_iterations', {
      description: 'Monte Carlo iteration count requested for forecasts.',
      unit: '1',
    }),
    forecastSampleSize: meter.createHistogram('agile_tools_forecast_sample_size', {
      description: 'Completed-story sample size used by forecast requests.',
      unit: '1',
    }),
    flowReadsCounter: meter.createCounter('agile_tools_flow_reads', {
      description: 'Current flow read requests by result.',
      unit: '1',
    }),
    flowReadDuration: meter.createHistogram('agile_tools_flow_read_duration_seconds', {
      description: 'Current flow read duration in seconds.',
      unit: 's',
    }),
    flowItemsReturned: meter.createHistogram('agile_tools_flow_items_returned', {
      description: 'Work items returned by current flow reads.',
      unit: '1',
    }),
    throughputReadsCounter: meter.createCounter('agile_tools_throughput_reads', {
      description: 'Throughput read requests by result.',
      unit: '1',
    }),
    throughputReadDuration: meter.createHistogram('agile_tools_throughput_read_duration_seconds', {
      description: 'Throughput read duration in seconds.',
      unit: 's',
    }),
    throughputDaysReturned: meter.createHistogram('agile_tools_throughput_days_returned', {
      description: 'Day buckets returned by throughput reads.',
      unit: '1',
    }),
    throughputSampleSize: meter.createHistogram('agile_tools_throughput_sample_size', {
      description: 'Completed-story sample size returned by throughput reads.',
      unit: '1',
    }),
    manualSyncEnqueueCounter: meter.createCounter('agile_tools_manual_sync_enqueues', {
      description: 'Manual sync enqueue attempts by result.',
      unit: '1',
    }),
    workerJobsCounter: meter.createCounter('agile_tools_worker_jobs', {
      description: 'Worker jobs handled by queue and result.',
      unit: '1',
    }),
    workerJobDuration: meter.createHistogram('agile_tools_worker_job_duration_seconds', {
      description: 'Worker job handler duration in seconds.',
      unit: 's',
    }),
    syncRunsCounter: meter.createCounter('agile_tools_sync_runs', {
      description: 'Scope sync runs by trigger and result.',
      unit: '1',
    }),
    syncRunDuration: meter.createHistogram('agile_tools_sync_run_duration_seconds', {
      description: 'Scope sync run duration in seconds.',
      unit: 's',
    }),
    syncItemsProcessed: meter.createHistogram('agile_tools_sync_items_processed', {
      description: 'Distinct Jira issues processed by scope sync runs.',
      unit: '1',
    }),
    httpClientRequestDuration: meter.createHistogram(METRIC_HTTP_CLIENT_REQUEST_DURATION, {
      description: 'Duration of HTTP client requests.',
      unit: 's',
    }),
    databaseQueryDuration: meter.createHistogram(METRIC_DATABASE_QUERY_DURATION, {
      description: 'Prisma database query duration in seconds by SQL operation.',
      unit: 's',
    }),
    queueStatsRegistered: false,
  };

  meter
    .createObservableGauge('agile_tools_process_uptime_seconds', {
      description: 'Process uptime for this runtime.',
      unit: 's',
    })
    .addCallback((observableResult) => {
      observableResult.observe(process.uptime());
    });

  meter
    .createObservableGauge('agile_tools_process_memory_bytes', {
      description: 'Memory usage reported by this process.',
      unit: 'By',
    })
    .addCallback((observableResult) => {
      const memory = process.memoryUsage();
      observableResult.observe(memory.rss, { state: 'rss' });
      observableResult.observe(memory.heapTotal, { state: 'heap_total' });
      observableResult.observe(memory.heapUsed, { state: 'heap_used' });
      observableResult.observe(memory.external, { state: 'external' });
      observableResult.observe(memory.arrayBuffers, { state: 'array_buffers' });
    });

  return state;
}

function getMetricsState(options?: InitializeMetricsOptions): MetricsState {
  metricsGlobal.__agileToolsOtelMetrics ??= createMetricsState(
    options ?? { serviceName: 'agile-tools', runtime: 'unknown' },
  );
  return metricsGlobal.__agileToolsOtelMetrics;
}

export function initializeMetrics(options: InitializeMetricsOptions): void {
  getMetricsState(options);
}

export async function collectPrometheusMetrics(): Promise<{ body: string; errors: unknown[] }> {
  const state = getMetricsState();
  state.scrapeCounter.add(1);

  const { resourceMetrics, errors } = await state.exporter.collect();
  if (errors.length > 0) {
    state.collectionErrorCounter.add(errors.length);
  }

  return {
    body: state.serializer.serialize(resourceMetrics),
    errors,
  };
}

export interface MetricsServerOptions extends InitializeMetricsOptions {
  host: string;
  port: number;
}

export async function startMetricsServer(options: MetricsServerOptions): Promise<{ host: string; port: number }> {
  const state = getMetricsState(options);
  if (state.server) {
    const address = state.server.address();
    return {
      host: typeof address === 'object' && address ? address.address : options.host,
      port: typeof address === 'object' && address ? address.port : options.port,
    };
  }

  const server = createServer((request, response) => {
    let pathname: string;
    try {
      pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    } catch {
      response.writeHead(400).end();
      return;
    }

    if (pathname !== '/metrics') {
      response.writeHead(404).end();
      return;
    }

    collectPrometheusMetrics().then(
      ({ body, errors }) => {
        if (errors.length > 0) {
          logger.warn('OpenTelemetry metric collection returned non-fatal errors', {
            errors: errors.map((error) => (error instanceof Error ? error.message : String(error))),
          });
        }
        response.writeHead(200, {
          'Cache-Control': 'no-store',
          'Content-Type': PROMETHEUS_CONTENT_TYPE,
        });
        response.end(body);
      },
      (error: unknown) => {
        logger.error('Failed to export OpenTelemetry metrics', {
          error: error instanceof Error ? error.message : String(error),
        });
        response.writeHead(500, {
          'Cache-Control': 'no-store',
          'Content-Type': PROMETHEUS_CONTENT_TYPE,
        });
        response.end('# failed to export metrics\n');
      },
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  state.server = server;
  const address = server.address();
  return {
    host: typeof address === 'object' && address ? address.address : options.host,
    port: typeof address === 'object' && address ? address.port : options.port,
  };
}

export async function stopMetricsServer(): Promise<void> {
  const state = metricsGlobal.__agileToolsOtelMetrics;
  if (!state?.server) return;

  const server = state.server;
  delete state.server;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export function observeQueueStats(provider: () => Promise<QueueStatsSnapshot[]>): void {
  const state = getMetricsState();
  state.queueStatsProvider = provider;
  if (state.queueStatsRegistered) return;

  const meter = state.meterProvider.getMeter('agile-tools');
  meter
    .createObservableGauge('agile_tools_queue_jobs', {
      description: 'pg-boss jobs by queue and state.',
      unit: '1',
    })
    .addCallback(async (observableResult) => {
      if (!state.queueStatsProvider) return;
      const snapshots = await state.queueStatsProvider();
      for (const snapshot of snapshots) {
        const queue = snapshot.queueName;
        observableResult.observe(snapshot.queuedCount, { queue, state: 'queued' });
        observableResult.observe(snapshot.activeCount, { queue, state: 'active' });
        observableResult.observe(snapshot.deferredCount, { queue, state: 'deferred' });
        observableResult.observe(snapshot.totalCount, { queue, state: 'total' });
      }
    });
  state.queueStatsRegistered = true;
}

export function recordHttpRequest(input: {
  method: string;
  route: string;
  scheme: string;
  statusCode: number;
  durationSeconds: number;
  errorType?: string;
}): void {
  const state = getMetricsState();
  const attributes: MetricAttributes = {
    [ATTR_HTTP_REQUEST_METHOD]: normalizeHttpMethod(input.method),
    [ATTR_HTTP_ROUTE]: input.route,
    [ATTR_HTTP_RESPONSE_STATUS_CODE]: input.statusCode,
    [ATTR_URL_SCHEME]: input.scheme,
    ...(input.errorType !== undefined
      ? { [ATTR_ERROR_TYPE]: input.errorType }
      : input.statusCode >= 500
        ? { [ATTR_ERROR_TYPE]: String(input.statusCode) }
        : {}),
  };
  state.httpRequestDuration.record(input.durationSeconds, attributes);
}

export function recordForecastRun(input: {
  type: string;
  result: string;
  durationSeconds: number;
  iterations?: number;
  sampleSize?: number;
}): void {
  const state = getMetricsState();
  const attributes = { type: input.type, result: input.result };
  state.forecastRunsCounter.add(1, attributes);
  state.forecastDuration.record(input.durationSeconds, attributes);
  if (input.iterations !== undefined) state.forecastIterations.record(input.iterations, attributes);
  if (input.sampleSize !== undefined) state.forecastSampleSize.record(input.sampleSize, attributes);
}

export function recordFlowRead(input: { result: string; durationSeconds: number; itemCount?: number }): void {
  const state = getMetricsState();
  const attributes = { result: input.result };
  state.flowReadsCounter.add(1, attributes);
  state.flowReadDuration.record(input.durationSeconds, attributes);
  if (input.itemCount !== undefined) state.flowItemsReturned.record(input.itemCount, attributes);
}

export function recordThroughputRead(input: {
  result: string;
  durationSeconds: number;
  dayCount?: number;
  sampleSize?: number;
}): void {
  const state = getMetricsState();
  const attributes = { result: input.result };
  state.throughputReadsCounter.add(1, attributes);
  state.throughputReadDuration.record(input.durationSeconds, attributes);
  if (input.dayCount !== undefined) state.throughputDaysReturned.record(input.dayCount, attributes);
  if (input.sampleSize !== undefined) state.throughputSampleSize.record(input.sampleSize, attributes);
}

export function recordManualSyncEnqueue(result: string): void {
  getMetricsState().manualSyncEnqueueCounter.add(1, { result });
}

export function recordWorkerJob(input: {
  queue: string;
  trigger: string;
  result: string;
  durationSeconds: number;
}): void {
  const state = getMetricsState();
  const attributes = { queue: input.queue, trigger: input.trigger, result: input.result };
  state.workerJobsCounter.add(1, attributes);
  state.workerJobDuration.record(input.durationSeconds, attributes);
}

export function recordSyncRun(input: {
  trigger: string;
  result: string;
  errorCode?: string;
  durationSeconds: number;
  itemCount?: number;
}): void {
  const state = getMetricsState();
  const attributes = {
    trigger: input.trigger,
    result: input.result,
    error_code: input.errorCode ?? 'none',
  };
  state.syncRunsCounter.add(1, attributes);
  state.syncRunDuration.record(input.durationSeconds, attributes);
  if (input.itemCount !== undefined) state.syncItemsProcessed.record(input.itemCount, attributes);
}

export function recordJiraRequest(input: {
  method: string;
  url: URL;
  operation: string;
  result: string;
  statusCode?: number;
  durationSeconds: number;
  errorType?: string;
}): void {
  const state = getMetricsState();
  const port = serverPort(input.url);
  const attributes: MetricAttributes = {
    [ATTR_HTTP_REQUEST_METHOD]: normalizeHttpMethod(input.method),
    [ATTR_SERVER_ADDRESS]: input.url.hostname,
    [ATTR_URL_SCHEME]: input.url.protocol.replace(/:$/, ''),
    'agile_tools.jira.operation': input.operation,
    'agile_tools.jira.result': input.result,
    ...(port !== undefined ? { [ATTR_SERVER_PORT]: port } : {}),
    ...(input.statusCode !== undefined ? { [ATTR_HTTP_RESPONSE_STATUS_CODE]: input.statusCode } : {}),
    ...(input.errorType !== undefined
      ? { [ATTR_ERROR_TYPE]: input.errorType }
      : input.statusCode !== undefined && input.statusCode >= 400
        ? { [ATTR_ERROR_TYPE]: String(input.statusCode) }
        : input.statusCode === undefined && input.result !== 'success'
          ? { [ATTR_ERROR_TYPE]: ERROR_TYPE_VALUE_OTHER }
          : {}),
  };
  state.httpClientRequestDuration.record(input.durationSeconds, attributes);
}

export function recordDatabaseQuery(input: { operation: string; durationSeconds: number }): void {
  getMetricsState().databaseQueryDuration.record(input.durationSeconds, {
    operation: input.operation,
  });
}

export const metricsClock = {
  now: Date.now,
  durationSecondsSince,
};