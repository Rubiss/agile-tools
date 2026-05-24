import { afterAll, describe, expect, it } from 'vitest';

import {
  collectPrometheusMetrics,
  initializeMetrics,
  recordFlowRead,
  recordForecastRun,
  recordHttpRequest,
  recordJiraRequest,
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