import { describe, expect, it } from 'vitest';
import { collectPrometheusMetrics } from '@agile-tools/shared';

import { withHttpMetrics } from './route-metrics';

describe('withHttpMetrics', () => {
  it('records successful handler status and duration metrics', async () => {
    const handler = withHttpMetrics('GET', '/api/unit', () =>
      Promise.resolve(new Response(null, { status: 204 })),
    );

    const response = await handler();
    const { body } = await collectPrometheusMetrics();

    expect(response.status).toBe(204);
    expect(body).toContain('agile_tools_http_requests_total');
    expect(body).toContain('route="/api/unit"');
    expect(body).toContain('status_code="204"');
  });

  it('records thrown handlers as 500s before rethrowing', async () => {
    const handler = withHttpMetrics('POST', '/api/unit-error', () => Promise.reject(new Error('boom')));

    await expect(handler()).rejects.toThrow('boom');
    const { body } = await collectPrometheusMetrics();

    expect(body).toContain('route="/api/unit-error"');
    expect(body).toContain('status_code="500"');
    expect(body).toContain('outcome="server_error"');
  });
});