import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  jiraClientStub,
  loggerMock,
  getConfigMock,
  decryptSecretMock,
  createJiraClientMock,
  getBoardDetailWithFilterIdMock,
  streamBoardIssuesMock,
  streamJqlIssuesMock,
  fetchIssueChangelogMock,
  detectBoardDriftMock,
  applyBoardDriftHandlingMock,
  updateConnectionHealthAfterSyncMock,
  normalizeJiraIssueMock,
  rebuildScopeProjectionsMock,
  MockJiraClientError,
} = vi.hoisted(() => {
  class MockJiraClientError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
      this.name = 'JiraClientError';
    }
  }

  const jiraClientStub = { name: 'jira-client' };
  const loggerMock = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };

  return {
    jiraClientStub,
    loggerMock,
    getConfigMock: vi.fn(() => ({ ENCRYPTION_KEY: 'test-encryption-key' })),
    decryptSecretMock: vi.fn(() => 'pat-123'),
    createJiraClientMock: vi.fn(() => jiraClientStub),
    getBoardDetailWithFilterIdMock: vi.fn(),
    streamBoardIssuesMock: vi.fn(),
    streamJqlIssuesMock: vi.fn(),
    fetchIssueChangelogMock: vi.fn(),
    detectBoardDriftMock: vi.fn(),
    applyBoardDriftHandlingMock: vi.fn(),
    updateConnectionHealthAfterSyncMock: vi.fn(),
    normalizeJiraIssueMock: vi.fn(),
    rebuildScopeProjectionsMock: vi.fn(),
    MockJiraClientError,
  };
});

vi.mock('@agile-tools/db', () => ({
  DEFAULT_COMPLETED_WINDOW_DAYS: 90,
}));

vi.mock('@agile-tools/shared', () => ({
  getConfig: getConfigMock,
  decryptSecret: decryptSecretMock,
  logger: loggerMock,
}));

vi.mock('@agile-tools/jira-client', () => ({
  JiraClientError: MockJiraClientError,
  createJiraClient: createJiraClientMock,
  getBoardDetailWithFilterId: getBoardDetailWithFilterIdMock,
  streamBoardIssues: streamBoardIssuesMock,
  streamJqlIssues: streamJqlIssuesMock,
  fetchIssueChangelog: fetchIssueChangelogMock,
}));

vi.mock('./detect-board-drift.js', () => ({
  detectBoardDrift: detectBoardDriftMock,
  applyBoardDriftHandling: applyBoardDriftHandlingMock,
}));

vi.mock('./update-connection-health.js', () => ({
  updateConnectionHealthAfterSync: updateConnectionHealthAfterSyncMock,
}));

vi.mock('./normalize-jira-issues.js', () => ({
  normalizeJiraIssue: normalizeJiraIssueMock,
}));

vi.mock('../projections/rebuild-scope-summary.js', () => ({
  rebuildScopeProjections: rebuildScopeProjectionsMock,
}));

import { runScopeSync } from './run-scope-sync.js';

function makeIssue(params: {
  id: string;
  key: string;
  projectId: string;
  statusId: string;
  statusName: string;
}): {
  id: string;
  key: string;
  fields: {
    summary: string;
    issuetype: { id: string; name: string };
    project: { id: string; key: string };
    status: { id: string; name: string };
    created: string;
  };
} {
  return {
    id: params.id,
    key: params.key,
    fields: {
      summary: `Issue ${params.key}`,
      issuetype: { id: 'story', name: 'Story' },
      project: { id: params.projectId, key: 'PROJ' },
      status: { id: params.statusId, name: params.statusName },
      created: '2025-01-01T00:00:00.000Z',
    },
  };
}

function* issueStream<T>(...issues: T[]): Generator<T> {
  for (const issue of issues) {
    yield issue;
  }
}

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function* pausingIssueStream<T>(
  issues: T[],
  pauseAfter: number,
  onPaused: () => void,
  resume: Promise<void>,
): AsyncGenerator<T> {
  for (const [index, issue] of issues.entries()) {
    yield issue;
    if (index + 1 === pauseAfter) {
      onPaused();
      await resume;
    }
  }
}

function createDb(options?: { doneStatusIds?: string[] }) {
  const syncRun = { id: 'run-1', scopeId: 'scope-1', status: 'queued' };
  const scope = {
    id: 'scope-1',
    workspaceId: 'workspace-1',
    connectionId: 'connection-1',
    boardId: '42',
    status: 'active',
    startStatusIds: ['10'],
    doneStatusIds: options?.doneStatusIds ?? ['30', '40'],
    includedIssueTypeIds: ['story'],
  };
  const connection = {
    id: 'connection-1',
    workspaceId: 'workspace-1',
    baseUrl: 'https://jira.example.internal',
    encryptedSecretRef: 'encrypted-secret',
  };
  const workItemUpsert = vi.fn((args: { where: { scopeId_jiraIssueId: { jiraIssueId: string } } }) =>
    Promise.resolve({
      id: `work-item-${args.where.scopeId_jiraIssueId.jiraIssueId}`,
    }),
  );
  const workItemLifecycleCreateMany = vi.fn().mockResolvedValue(undefined);
  const transactionClient = {
    $executeRaw: vi.fn().mockResolvedValue(0),
    $queryRaw: vi.fn().mockResolvedValue([{ id: syncRun.id }]),
    workItem: {
      upsert: workItemUpsert,
    },
    workItemLifecycleEvent: {
      createMany: workItemLifecycleCreateMany,
    },
    syncRun: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };

  const db = {
    syncRun: {
      findUnique: vi.fn().mockResolvedValue(syncRun),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn().mockResolvedValue(undefined),
    },
    flowScope: {
      findUnique: vi.fn().mockResolvedValue(scope),
    },
    jiraConnection: {
      findFirst: vi.fn().mockResolvedValue(connection),
    },
    boardSnapshot: {
      create: vi.fn().mockResolvedValue({ id: 'snapshot-1' }),
      update: vi.fn().mockResolvedValue(undefined),
    },
    workItem: {
      upsert: workItemUpsert,
    },
    workItemLifecycleEvent: {
      createMany: workItemLifecycleCreateMany,
    },
    $transaction: vi.fn(async (callback: (tx: typeof transactionClient) => Promise<unknown>) =>
      callback(transactionClient),
    ),
  };

  return db;
}

describe('runScopeSync', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    getConfigMock.mockReturnValue({ ENCRYPTION_KEY: 'test-encryption-key' });
    decryptSecretMock.mockReturnValue('pat-123');
    createJiraClientMock.mockReturnValue(jiraClientStub);
    getBoardDetailWithFilterIdMock.mockResolvedValue({
      detail: {
        boardId: 42,
        boardName: 'Payments Board',
        columns: [{ name: 'Doing', statusIds: ['10'] }],
        statuses: [{ id: '10', name: 'In Progress' }],
        completionStatuses: [
          { id: '30', name: 'Closed' },
          { id: '40', name: 'Resolved' },
        ],
        issueTypes: [{ id: 'story', name: 'Story' }],
      },
      filterId: null,
    });
    detectBoardDriftMock.mockReturnValue(null);
    applyBoardDriftHandlingMock.mockResolvedValue(undefined);
    fetchIssueChangelogMock.mockResolvedValue([]);
    updateConnectionHealthAfterSyncMock.mockResolvedValue(undefined);
    rebuildScopeProjectionsMock.mockResolvedValue(undefined);
    normalizeJiraIssueMock.mockImplementation(
      (issue: {
        id: string;
        key: string;
        fields: {
          summary: string;
          issuetype: { id: string; name: string };
          project: { id: string };
          status: { id: string; name: string };
          created: string;
        };
      }) => ({
        jiraIssueId: issue.id,
        issueKey: issue.key,
        summary: issue.fields.summary,
        issueTypeId: issue.fields.issuetype.id,
        issueTypeName: issue.fields.issuetype.name,
        projectId: issue.fields.project.id,
        currentStatusId: issue.fields.status.id,
        currentStatusName: issue.fields.status.name,
        currentColumn: issue.fields.status.id === '10' ? 'Doing' : null,
        assigneeName: issue.key === 'PROJ-2' ? 'Morgan Lee' : 'Riley Chen',
        createdAt: new Date(issue.fields.created),
        startedAt: null,
        completedAt: issue.fields.status.id === '10' ? null : new Date('2025-01-02T00:00:00.000Z'),
        reopenedCount: 0,
        directUrl: `https://jira.example.internal/browse/${issue.key}`,
        excludedReason: null,
        lifecycleEvents: [],
      }),
    );
  });

  it('backfills completed issues using the board filter JQL', async () => {
    const db = createDb();
    const boardIssue = makeIssue({
      id: 'ISSUE-1',
      key: 'PROJ-1',
      projectId: 'proj-board',
      statusId: '10',
      statusName: 'In Progress',
    });
    const completedIssue = makeIssue({
      id: 'ISSUE-2',
      key: 'PROJ-2',
      projectId: 'proj-offboard',
      statusId: '30',
      statusName: 'Closed',
    });

    streamBoardIssuesMock.mockReturnValue(issueStream(boardIssue));
    getBoardDetailWithFilterIdMock.mockResolvedValue({
      detail: {
        boardId: 42,
        boardName: 'Payments Board',
        columns: [{ name: 'Doing', statusIds: ['10'] }],
        statuses: [{ id: '10', name: 'In Progress' }],
        completionStatuses: [
          { id: '30', name: 'Closed' },
          { id: '40', name: 'Resolved' },
        ],
        issueTypes: [{ id: 'story', name: 'Story' }],
      },
      filterId: '1001',
    });
    streamJqlIssuesMock.mockReturnValue(issueStream(completedIssue));

    await runScopeSync(db as unknown as Parameters<typeof runScopeSync>[0], 'run-1');

    expect(getBoardDetailWithFilterIdMock).toHaveBeenCalledWith(jiraClientStub, 42);
    expect(streamJqlIssuesMock).toHaveBeenCalledWith(
      jiraClientStub,
      'filter = 1001 AND status in ("30", "40") AND updated >= -90d',
      { fields: 'summary,status,issuetype,project,created,assignee' },
    );
    expect(db.workItem.upsert).toHaveBeenCalledTimes(2);
    expect(db.workItem.upsert).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        create: expect.objectContaining({
          currentStatusId: '30',
          currentStatusName: 'Closed',
          assigneeName: 'Morgan Lee',
        }),
        update: expect.objectContaining({
          currentStatusId: '30',
          currentStatusName: 'Closed',
          assigneeName: 'Morgan Lee',
        }),
      }),
    );
    expect(db.boardSnapshot.update).toHaveBeenCalledWith({
      where: { id: 'snapshot-1' },
      data: {
        projectRefs: [{ id: 'proj-board' }, { id: 'proj-offboard' }],
      },
    });
    expect(loggerMock.info).toHaveBeenCalledWith('Completed-issue sync pass finished', {
      syncRunId: 'run-1',
      scopeId: 'scope-1',
    });
  });

  it('skips the completed-issue pass when the board exposes no saved filter', async () => {
    const db = createDb();
    const boardIssue = makeIssue({
      id: 'ISSUE-1',
      key: 'PROJ-1',
      projectId: 'proj-board',
      statusId: '10',
      statusName: 'In Progress',
    });

    streamBoardIssuesMock.mockReturnValue(issueStream(boardIssue));

    await runScopeSync(db as unknown as Parameters<typeof runScopeSync>[0], 'run-1');

    expect(streamJqlIssuesMock).not.toHaveBeenCalled();
    expect(db.workItem.upsert).toHaveBeenCalledTimes(1);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      'Board has no saved filter; skipping completed-issue sync pass',
      { syncRunId: 'run-1', boardId: 42 },
    );
  });

  it('skips completed issues already seen during the board pass', async () => {
    const db = createDb();
    const completedIssue = makeIssue({
      id: 'ISSUE-2',
      key: 'PROJ-2',
      projectId: 'proj-offboard',
      statusId: '30',
      statusName: 'Closed',
    });

    getBoardDetailWithFilterIdMock.mockResolvedValue({
      detail: {
        boardId: 42,
        boardName: 'Payments Board',
        columns: [{ name: 'Done', statusIds: ['30'] }],
        statuses: [{ id: '30', name: 'Closed' }],
        completionStatuses: [
          { id: '30', name: 'Closed' },
          { id: '40', name: 'Resolved' },
        ],
        issueTypes: [{ id: 'story', name: 'Story' }],
      },
      filterId: '1001',
    });
    streamBoardIssuesMock.mockReturnValue(issueStream(completedIssue));
    streamJqlIssuesMock.mockReturnValue(issueStream(completedIssue));

    await runScopeSync(db as unknown as Parameters<typeof runScopeSync>[0], 'run-1');

    expect(streamJqlIssuesMock).toHaveBeenCalledWith(
      jiraClientStub,
      'filter = 1001 AND status in ("30", "40") AND updated >= -90d',
      { fields: 'summary,status,issuetype,project,created,assignee' },
    );
    expect(fetchIssueChangelogMock).toHaveBeenCalledTimes(1);
    expect(db.workItem.upsert).toHaveBeenCalledTimes(1);
  });

  it('skips the completed-issue pass when the scope has no done statuses', async () => {
    const db = createDb({ doneStatusIds: [] });
    const boardIssue = makeIssue({
      id: 'ISSUE-1',
      key: 'PROJ-1',
      projectId: 'proj-board',
      statusId: '10',
      statusName: 'In Progress',
    });

    streamBoardIssuesMock.mockReturnValue(issueStream(boardIssue));

    await runScopeSync(db as unknown as Parameters<typeof runScopeSync>[0], 'run-1');

    expect(streamJqlIssuesMock).not.toHaveBeenCalled();
    expect(db.workItem.upsert).toHaveBeenCalledTimes(1);
  });

  it('does not publish work items until the Jira issue stream is complete', async () => {
    const db = createDb({ doneStatusIds: [] });
    const paused = createDeferred();
    const resume = createDeferred();
    const issues = Array.from({ length: 11 }, (_, index) =>
      makeIssue({
        id: `ISSUE-${index + 1}`,
        key: `PROJ-${index + 1}`,
        projectId: 'proj-board',
        statusId: '10',
        statusName: 'In Progress',
      }),
    );

    streamBoardIssuesMock.mockReturnValue(
      pausingIssueStream(issues, 10, paused.resolve, resume.promise),
    );

    const syncPromise = runScopeSync(db as unknown as Parameters<typeof runScopeSync>[0], 'run-1');
    await paused.promise;

    expect(normalizeJiraIssueMock).toHaveBeenCalledTimes(10);
    expect(db.workItem.upsert).not.toHaveBeenCalled();

    resume.resolve();
    await syncPromise;

    expect(db.workItem.upsert).toHaveBeenCalledTimes(11);
  });

  it('does not update connection health when the run has already been superseded', async () => {
    const db = createDb();
    db.syncRun.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    getBoardDetailWithFilterIdMock.mockRejectedValueOnce(
      new MockJiraClientError('unauthorized', 'token expired'),
    );

    await expect(
      runScopeSync(db as unknown as Parameters<typeof runScopeSync>[0], 'run-1'),
    ).resolves.toBeUndefined();

    expect(updateConnectionHealthAfterSyncMock).not.toHaveBeenCalled();
    expect(loggerMock.warn).toHaveBeenCalledWith(
      'SyncRun left running state before terminal update; skipping',
      expect.objectContaining({
        syncRunId: 'run-1',
        nextStatus: 'failed',
      }),
    );
  });
});
