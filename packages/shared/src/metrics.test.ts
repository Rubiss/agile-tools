import { afterAll, describe, expect, it } from 'vitest';

import {
  collectPrometheusMetrics,
  initializeMetrics,
  recordFlowRead,
  recordForecastRun,
  recordHttpRequest,
  recordJiraRequest,
  recordSyncRun,
  recordWorkerJob,
  startMetricsServer,
  stopMetricsServer,
} from './metrics.js';

describe('metrics', () => {
  afterAll(async () => {
    await stopMetricsServer();
  });

  it('serializes low-cardinality application metrics as Prometheus text', async () => {
    initializeMetrics({ serviceName: 'agile-tools-test', runtime: 'test' });

    recordHttpRequest({
      method: 'GET',
      route: '/api/test',
      scheme: 'https',
      statusCode: 500,
      durationSeconds: 0.25,
    });
    recordForecastRun({
      type: 'when',
      result: 'computed',
      durationSeconds: 1.2,
      iterations: 1000,
      sampleSize: 42,
    });
    recordFlowRead({ result: 'success', durationSeconds: 0.05, itemCount: 7 });
    recordJiraRequest({
      method: 'GET',
      url: new URL('https://jira.example.internal/rest/agile/1.0/board/123/issue'),
      operation: 'board_issues',
      result: 'success',
      statusCode: 200,
      durationSeconds: 0.1,
    });
    recordJiraRequest({
      method: 'GET',
      url: new URL('https://jira.example.internal/rest/agile/1.0/board/123/issue'),
      operation: 'board_issues',
      result: 'network_error',
      durationSeconds: 0.1,
    });

    const { body } = await collectPrometheusMetrics();

    expect(body).toContain('service_name="agile-tools-test"');
    expect(body).toContain('http_server_request_duration');
    expect(body).toContain('http_route="/api/test"');
    expect(body).toContain('http_response_status_code="500"');
    expect(body).toContain('url_scheme="https"');
    expect(body).toContain('error_type="500"');
    expect(body).toContain('le="0.005"');
    expect(body).not.toContain('agile_tools_http_requests_total');
    expect(body).toContain('agile_tools_forecast_runs_total');
    expect(body).toContain('agile_tools_forecast_duration_seconds');
    expect(body).toContain('agile_tools_flow_items_returned');
    expect(body).toContain('http_client_request_duration');
    expect(body).toContain('server_address="jira.example.internal"');
    expect(body).toContain('server_port="443"');
    expect(body).toContain('agile_tools_jira_operation="board_issues"');
    expect(body).toContain('agile_tools_jira_result="network_error"');
    expect(body).toContain('error_type="_OTHER"');
    expect(body).not.toContain('agile_tools_jira_requests_total');
    expect(body).not.toContain('agile_tools_jira_request_duration_seconds');
  });

  it('uses minute-scale buckets for worker job and sync run durations', async () => {
    initializeMetrics({ serviceName: 'agile-tools-test', runtime: 'test' });

    recordWorkerJob({
      queue: 'sync',
      trigger: 'scheduled',
      result: 'succeeded',
      durationSeconds: 420,
    });
    recordSyncRun({
      trigger: 'scheduled',
      result: 'succeeded',
      durationSeconds: 420,
    });

    const { body } = await collectPrometheusMetrics();
    const workerJobBuckets = bucketLinesFor(body, 'agile_tools_worker_job_duration_seconds_bucket');
    const syncRunBuckets = bucketLinesFor(body, 'agile_tools_sync_run_duration_seconds_bucket');

    for (const buckets of [workerJobBuckets, syncRunBuckets]) {
      expect(buckets).toEqual(expect.arrayContaining(['5', '10', '30', '60', '120', '300', '600', '900', '+Inf']));
      expect(buckets).not.toContain('0');
      expect(buckets).not.toContain('500');
      expect(buckets).not.toContain('750');
      expect(buckets).not.toContain('1000');
    }
  });

  it('serves metrics over HTTP on the requested port', async () => {
    await stopMetricsServer();
    initializeMetrics({ serviceName: 'agile-tools-test', runtime: 'test' });
    const { port } = await startMetricsServer({
      serviceName: 'agile-tools-test',
      runtime: 'test',
      host: '127.0.0.1',
      port: 0,
    });

    const response = await fetch(`http://127.0.0.1:${port}/metrics`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/plain; version=0.0.4; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(body).toContain('agile_tools_metrics_scrapes_total');
  });

  it('does not trust Host when parsing metrics requests', async () => {
    await stopMetricsServer();
    const { port } = await startMetricsServer({
      serviceName: 'agile-tools-test',
      runtime: 'test',
      host: '127.0.0.1',
      port: 0,
    });

    const response = await fetch(`http://127.0.0.1:${port}/metrics`, {
      headers: { Host: 'bad host' },
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('agile_tools_metrics_scrapes_total');
  });
});

function bucketLinesFor(body: string, metricName: string): string[] {
  return body
    .split('\n')
    .filter((line) => line.startsWith(metricName))
    .map((line) => /le="([^"]+)"/.exec(line)?.[1])
    .filter((bucket): bucket is string => bucket !== undefined);
}