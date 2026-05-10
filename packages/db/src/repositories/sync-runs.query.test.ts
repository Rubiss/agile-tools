import { describe, expect, it, vi } from 'vitest';

import { getLastFinishedSyncRun } from './sync-runs.js';

describe('getLastFinishedSyncRun', () => {
  it('queries only terminal runs and orders them by finishedAt descending', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const client: Parameters<typeof getLastFinishedSyncRun>[0] = {
      syncRun: {
        findFirst,
      },
    };

    await getLastFinishedSyncRun(client, 'workspace-1', 'scope-1');

    expect(findFirst).toHaveBeenCalledWith({
      where: {
        scopeId: 'scope-1',
        scope: { workspaceId: 'workspace-1' },
        status: { in: ['succeeded', 'failed', 'canceled'] },
        finishedAt: { not: null },
      },
      orderBy: { finishedAt: 'desc' },
    });
  });
});
