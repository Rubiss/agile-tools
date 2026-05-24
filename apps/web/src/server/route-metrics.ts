import { recordHttpRequest, metricsClock } from '@agile-tools/shared';

type RouteHandler<Args extends unknown[]> = (...args: Args) => Promise<Response>;

function headerValue(input: unknown, name: string): string | undefined {
  const headers = typeof input === 'object' && input !== null
    ? (input as { headers?: { get?: (headerName: string) => string | null } }).headers
    : undefined;
  const value = headers?.get?.(name);
  return value === null ? undefined : value;
}

function normalizeScheme(value: string | undefined): string | undefined {
  const scheme = value?.split(',')[0]?.trim().replace(/:$/, '').toLowerCase();
  return scheme === 'http' || scheme === 'https' ? scheme : undefined;
}

function requestScheme(input: unknown): string {
  const forwardedProto = normalizeScheme(headerValue(input, 'x-forwarded-proto'));
  if (forwardedProto !== undefined) return forwardedProto;

  const nextUrlProtocol = typeof input === 'object' && input !== null
    ? (input as { nextUrl?: { protocol?: string } }).nextUrl?.protocol
    : undefined;
  const nextUrlScheme = normalizeScheme(nextUrlProtocol);
  if (nextUrlScheme !== undefined) return nextUrlScheme;

  const requestUrl = typeof input === 'object' && input !== null
    ? (input as { url?: string }).url
    : undefined;
  if (requestUrl !== undefined) {
    try {
      const urlScheme = normalizeScheme(new URL(requestUrl).protocol);
      if (urlScheme !== undefined) return urlScheme;
    } catch {
      return 'http';
    }
  }

  return 'http';
}

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
        scheme: requestScheme(args[0]),
        statusCode: response.status,
        durationSeconds: metricsClock.durationSecondsSince(startedAt),
      });
      return response;
    } catch (error) {
      recordHttpRequest({
        method,
        route,
        scheme: requestScheme(args[0]),
        statusCode: 500,
        durationSeconds: metricsClock.durationSecondsSince(startedAt),
        errorType: 'exception',
      });
      throw error;
    }
  };
}