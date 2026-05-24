import { getPrismaClient } from '@agile-tools/db';
import { NextResponse } from 'next/server';
import { withHttpMetrics } from '@/server/route-metrics';

function createResponse(status: 'ok' | 'degraded', httpStatus: number) {
  return NextResponse.json(
    {
      status,
      timestamp: new Date().toISOString(),
    },
    {
      status: httpStatus,
      headers: {
        'Cache-Control': 'no-store',
      },
    },
  );
}

async function handleGET() {
  try {
    await getPrismaClient().$queryRaw`SELECT 1`;
    return createResponse('ok', 200);
  } catch {
    return createResponse('degraded', 503);
  }
}

export const GET = withHttpMetrics('GET', '/api/healthz', handleGET);