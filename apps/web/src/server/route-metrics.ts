import { recordHttpRequest, metricsClock } from '@agile-tools/shared';

type RouteHandler<Args extends unknown[]> = (...args: Args) => Promise<Response>;

export function withHttpMetrics<Args extends unknown[]>(
  method: string,
  route: string,
  handler: RouteHandler<Args>,
): RouteHandler<Args> {
  return async (...args: Args) => {
    const startedAt = metricsClock.now();
    try {
      const response = await handler(...args);
      recordHttpRequest({
        method,
        route,
        statusCode: response.status,
        durationSeconds: metricsClock.durationSecondsSince(startedAt),
      });
      return response;
    } catch (error) {
      recordHttpRequest({
        method,
        route,
        statusCode: 500,
        durationSeconds: metricsClock.durationSecondsSince(startedAt),
      });
      throw error;
    }
  };
}