import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function isLoopbackBypassEnabled(): boolean {
  return process.env['ALLOW_LOOPBACK_HTTP_BYPASS'] === 'true';
}

export function proxy(request: NextRequest): Response {
  if (process.env['NODE_ENV'] !== 'production') {
    return NextResponse.next();
  }

  if (request.nextUrl.pathname === '/metrics' || request.nextUrl.pathname === '/metrics/') {
    return NextResponse.next();
  }

  if (isLoopbackBypassEnabled() && isLoopbackHost(request.nextUrl.hostname)) {
    return NextResponse.next();
  }

  const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const isHttps = forwardedProto ? forwardedProto === 'https' : request.nextUrl.protocol === 'https:';
  if (isHttps) {
    return NextResponse.next();
  }

  const redirectUrl = new URL(request.url);
  redirectUrl.protocol = 'https:';

  const forwardedHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim();
  if (forwardedHost) {
    redirectUrl.host = forwardedHost;
  }

  return NextResponse.redirect(redirectUrl, 308);
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)',
  ],
};