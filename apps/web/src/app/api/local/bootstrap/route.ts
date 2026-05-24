import { type NextRequest } from 'next/server';

import { handleLocalBootstrapRequest } from '@/server/local-bootstrap-handler';
import { withHttpMetrics } from '@/server/route-metrics';

async function handlePOST(request: NextRequest): Promise<Response> {
  return handleLocalBootstrapRequest(request);
}

export const POST = withHttpMetrics('POST', '/api/local/bootstrap', handlePOST);