import { describe, expect, it } from 'vitest';
import { collectPrometheusMetrics } from '@agile-tools/shared';

import { withHttpMetrics } from './route-metrics';

describe('withHttpMetrics', () => {
  it('records successful handler status and duration metrics', async () => {
    const handler = withHttpMetrics('GET', '/api/unit', (request: Request) =>
      Promise.resolve(new Response(request.url, { status: 200 })),
    );

    const response = await handler(new Request('https://example.test/api/unit'));
    const { body } = await collectPrometheusMetrics();

    expect(response.status).toBe(200);
    expect(body).toContain('http_server_request_duration');
    expect(body).toContain('http_route="/api/unit"');
    expect(body).toContain('http_response_status_code="200"');
    expect(body).toContain('url_scheme="https"');
    expect(body).not.toContain('error_type=');
  });

  it('records thrown handlers as 500s before rethrowing', async () => {
    const handler = withHttpMetrics('POST', '/api/unit-error', (request: Request) =>
      Promise.reject(new Error(request.url.includes('unit-error') ? 'boom' : 'unexpected')),
    );

    await expect(handler(new Request('https://example.test/api/unit-error'))).rejects.toThrow('boom');
    const { body } = await collectPrometheusMetrics();

    expect(body).toContain('http_route="/api/unit-error"');
    expect(body).toContain('http_response_status_code="500"');
    expect(body).toContain('url_scheme="https"');
    expect(body).toContain('error_type="exception"');
  });
});