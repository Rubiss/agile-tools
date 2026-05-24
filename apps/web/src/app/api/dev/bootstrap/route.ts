import { type NextRequest } from 'next/server';

import { handleLocalBootstrapRequest } from '@/server/local-bootstrap-handler';
import { withHttpMetrics } from '@/server/route-metrics';

async function handlePOST(request: NextRequest): Promise<Response> {
  return handleLocalBootstrapRequest(request, 'demo');
}

export const POST = withHttpMetrics('POST', '/api/dev/bootstrap', handlePOST);