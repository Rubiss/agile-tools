/**
 * Integration and unit tests for the sync pipeline.
 *
 * Two sections:
 * 1. Pure unit tests for `normalizeJiraIssue` — no DB needed.
 * 2. DB integration tests for `queryCurrentWorkItems` and
 *    `queryScopeFilterOptions` using a real Testcontainers Postgres.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { resetConfig } from '@agile-tools/shared';
import {
  getPrismaClient,
  disconnectPrisma,
  queryCurrentWorkItems,
  queryScopeFilterOptions,
} from '@agile-tools/db';
import { normalizeJiraIssue } from '../../apps/worker/src/sync/normalize-jira-issues';
import type { NormalizeContext } from '../../apps/worker/src/sync/normalize-jira-issues';
import type { RawJiraIssue, ChangelogHistory } from '@agile-tools/jira-client';
import { startPostgres, stopPostgres } from './support/postgres';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const BASE_CONTEXT: NormalizeContext = {
  scopeId: 'scope-1',
  syncRunId: 'run-1',
  startStatusIds: new Set(['10']),
  doneStatusIds: new Set(['30']),
  includedIssueTypeIds: new Set(['story']),
  statusIdsByColumn: {
    '10': 'In Progress',
    '20': 'Review',
    '30': 'Done',
  },
  jiraBaseUrl: 'https://jira.example.internal',
};

function makeIssue(overrides?: Partial<RawJiraIssue['fields']>): RawJiraIssue {
  return {
    id: 'ISSUE-10001',
    key: 'PROJ-1',
    fields: {
      summary: 'Test issue',
      issuetype: { id: 'story', name: 'Story' },
      project: { id: 'proj-1', key: 'PROJ' },
      status: { id: '10', name: 'In Progress' },
      created: '2025-01-01T00:00:00.000Z',
      ...overrides,
    },
  };
}

function makeHistory(
  id: string,
  created: string,
  items: ChangelogHistory['items'],
): ChangelogHistory {
  return { id, created, items };
}

// ─── Pure unit tests: normalizeJiraIssue ─────────────────────────────────────

describe('normalizeJiraIssue — pure unit', () => {
  it('maps basic issue fields correctly', () => {
    const result = normalizeJiraIssue(makeIssue(), [], BASE_CONTEXT);

    expect(result.jiraIssueId).toBe('ISSUE-10001');
    expect(result.issueKey).toBe('PROJ-1');
    expect(result.summary).toBe('Test issue');
    expect(result.issueTypeId).toBe('story');
    expect(result.issueTypeName).toBe('Story');
    expect(result.currentStatusId).toBe('10');
    expect(result.currentColumn).toBe('In Progress');
    expect(result.directUrl).toBe('https://jira.example.internal/browse/PROJ-1');
    expect(result.excludedReason).toBeNull();
    expect(result.reopenedCount).toBe(0);
    // No changelog, but currentStatus '10' is a start status, so startedAt
    // falls back to createdAt so the item is treated as in-flow downstream.
    expect(result.startedAt).toEqual(new Date('2025-01-01T00:00:00.000Z'));
    expect(result.completedAt).toBeNull();
  });

  it('leaves startedAt null when item is currently in a non-start status with no changelog', () => {
    const issue = makeIssue({ status: { id: '5', name: 'Backlog' } });
    const result = normalizeJiraIssue(issue, [], BASE_CONTEXT);

    expect(result.startedAt).toBeNull();
  });

  it('sets excludedReason to "issue_type_excluded" when issue type is not in includedIssueTypeIds', () => {
    const issue = makeIssue({ issuetype: { id: 'bug', name: 'Bug' } });
    const result = normalizeJiraIssue(issue, [], BASE_CONTEXT);

    expect(result.excludedReason).toBe('issue_type_excluded');
  });

  it('derives startedAt from the earliest transition into a start status', () => {
    const changelog: ChangelogHistory[] = [
      makeHistory('h1', '2025-01-02T09:00:00.000Z', [
        { field: 'status', from: '5', to: '10' }, // enters "In Progress"
      ]),
      makeHistory('h2', '2025-01-03T09:00:00.000Z', [
        { field: 'status', from: '10', to: '20' },
      ]),
    ];
    const result = normalizeJiraIssue(makeIssue(), changelog, BASE_CONTEXT);

    expect(result.startedAt).toEqual(new Date('2025-01-02T09:00:00.000Z'));
    expect(result.completedAt).toBeNull(); // not in done status currently
  });

  it('derives completedAt when item is currently in a done status', () => {
    const issue = makeIssue({ status: { id: '30', name: 'Done' } });
    const changelog: ChangelogHistory[] = [
      makeHistory('h1', '2025-01-02T09:00:00.000Z', [
        { field: 'status', from: '5', to: '10' },
      ]),
      makeHistory('h2', '2025-01-05T15:00:00.000Z', [
        { field: 'status', from: '10', to: '30' }, // enters done → completed event
      ]),
    ];
    const result = normalizeJiraIssue(issue, changelog, BASE_CONTEXT);

    expect(result.completedAt).toEqual(new Date('2025-01-05T15:00:00.000Z'));
  });

  it('does NOT set completedAt when item leaves done status (reopened)', () => {
    const changelog: ChangelogHistory[] = [
      makeHistory('h1', '2025-01-02T09:00:00.000Z', [
        { field: 'status', from: '5', to: '30' }, // completed
      ]),
      makeHistory('h2', '2025-01-04T10:00:00.000Z', [
        { field: 'status', from: '30', to: '10' }, // reopened
      ]),
    ];
    // Currently in start status (not done), so completedAt should be null.
    const result = normalizeJiraIssue(makeIssue(), changelog, BASE_CONTEXT);

    expect(result.completedAt).toBeNull();
    expect(result.reopenedCount).toBe(1);
  });

  it('counts multiple reopens correctly', () => {
    const changelog: ChangelogHistory[] = [
      makeHistory('h1', '2025-01-01T00:00:00Z', [{ field: 'status', from: '5', to: '30' }]),
      makeHistory('h2', '2025-01-02T00:00:00Z', [{ field: 'status', from: '30', to: '10' }]),
      makeHistory('h3', '2025-01-03T00:00:00Z', [{ field: 'status', from: '10', to: '30' }]),
      makeHistory('h4', '2025-01-04T00:00:00Z', [{ field: 'status', from: '30', to: '10' }]),
    ];
    const result = normalizeJiraIssue(makeIssue(), changelog, BASE_CONTEXT);

    expect(result.reopenedCount).toBe(2);
  });

  it('maps currentColumn to null when status has no column mapping', () => {
    const issue = makeIssue({ status: { id: '99', name: 'Unknown' } });
    const result = normalizeJiraIssue(issue, [], BASE_CONTEXT);

    expect(result.currentColumn).toBeNull();
  });

  it('emits at most one field_change event per changelog entry', () => {
    const changelog: ChangelogHistory[] = [
      makeHistory('h1', '2025-01-02T09:00:00Z', [
        { field: 'labels', fieldId: 'labels' },
        { field: 'priority', fieldId: 'priority' },
      ]),
    ];
    const result = normalizeJiraIssue(makeIssue(), changelog, BASE_CONTEXT);
    const fieldChanges = result.lifecycleEvents.filter((e) => e.eventType === 'field_change');

    expect(fieldChanges.length).toBe(1);
    expect(fieldChanges[0]?.changedFieldId).toBe('labels');
  });

  it('generates directUrl using the Jira base URL and issue key', () => {
    const result = normalizeJiraIssue(makeIssue(), [], BASE_CONTEXT);

    expect(result.directUrl).toBe('https://jira.example.internal/browse/PROJ-1');
  });
});

// ─── DB integration tests: queryCurrentWorkItems / queryScopeFilterOptions ───
//
// Both DB suites share a single Postgres container started here at file scope.

let dbStarted = false;

async function ensureDbStarted() {
  if (dbStarted) return;
  const pg = await startPostgres();
  process.env['DATABASE_URL'] = pg.connectionUrl;
  process.env['ENCRYPTION_KEY'] = 'test-encryption-key-32-chars-ok!';
  dbStarted = true;
}

afterAll(async () => {
  await disconnectPrisma();
  await stopPostgres();
});

describe('queryCurrentWorkItems — DB integration', () => {
  let scopeId: string;
  let syncRunId: string;

  beforeAll(async () => {
    await ensureDbStarted();
    resetConfig();
    await disconnectPrisma();

    const db = getPrismaClient();

    // Create minimum required records for projection queries.
    const workspace = await db.workspace.create({
      data: { name: 'Projection Test Workspace', defaultTimezone: 'UTC' },
    });

    const conn = await db.jiraConnection.create({
      data: {
        workspaceId: workspace.id,
        baseUrl: 'https://jira.example.internal',
        authType: 'pat',
        encryptedSecretRef: 'dummy',
      },
    });

    const scope = await db.flowScope.create({
      data: {
        workspaceId: workspace.id,
        connectionId: conn.id,
        boardId: '1',
        boardName: 'Test Board',
        timezone: 'UTC',
        includedIssueTypeIds: ['story', 'bug'],
        startStatusIds: ['10'],
        doneStatusIds: ['30'],
        syncIntervalMinutes: 10,
      },
    });
    scopeId = scope.id;

    const syncRun = await db.syncRun.create({
      data: {
        scopeId,
        trigger: 'manual',
        status: 'succeeded',
        startedAt: new Date('2025-01-01T00:00:00Z'),
        finishedAt: new Date('2025-01-01T01:00:00Z'),
      },
    });
    syncRunId = syncRun.id;

    // Seed work items.
    await db.workItem.createMany({
      data: [
        {
          scopeId,
          lastSyncRunId: syncRunId,
          jiraIssueId: 'I1',
          issueKey: 'PROJ-1',
          summary: 'In progress item',
          issueTypeId: 'story',
          issueTypeName: 'Story',
          projectId: 'PROJ',
          currentStatusId: '10',
          currentColumn: 'In Progress',
          directUrl: 'https://jira.example.internal/browse/PROJ-1',
          createdAt: new Date('2025-01-10T00:00:00Z'),
          startedAt: new Date('2025-01-10T12:00:00Z'),
        },
        {
          scopeId,
          lastSyncRunId: syncRunId,
          jiraIssueId: 'I2',
          issueKey: 'PROJ-2',
          summary: 'Review item',
          issueTypeId: 'bug',
          issueTypeName: 'Bug',
          projectId: 'PROJ',
          currentStatusId: '20',
          currentColumn: 'Review',
          directUrl: 'https://jira.example.internal/browse/PROJ-2',
          createdAt: new Date('2025-01-11T00:00:00Z'),
        },
        {
          // Completed item — should NOT appear in queryCurrentWorkItems.
          scopeId,
          lastSyncRunId: syncRunId,
          jiraIssueId: 'I3',
          issueKey: 'PROJ-3',
          summary: 'Done item',
          issueTypeId: 'story',
          issueTypeName: 'Story',
          projectId: 'PROJ',
          currentStatusId: '30',
          currentColumn: 'Done',
          directUrl: 'https://jira.example.internal/browse/PROJ-3',
          createdAt: new Date('2025-01-01T00:00:00Z'),
          completedAt: new Date('2025-01-05T00:00:00Z'),
        },
        {
          // Excluded item — should NOT appear in queryCurrentWorkItems.
          scopeId,
          lastSyncRunId: syncRunId,
          jiraIssueId: 'I4',
          issueKey: 'PROJ-4',
          summary: 'Excluded item',
          issueTypeId: 'epic',
          issueTypeName: 'Epic',
          projectId: 'PROJ',
          currentStatusId: '10',
          currentColumn: 'In Progress',
          directUrl: 'https://jira.example.internal/browse/PROJ-4',
          createdAt: new Date('2025-01-01T00:00:00Z'),
          excludedReason: 'issue_type_excluded',
        },
      ],
    });
  });

  afterAll(async () => {
    await disconnectPrisma();
  });

  it('returns only in-flow (started, non-completed, non-excluded) items', async () => {
    const db = getPrismaClient();
    const items = await queryCurrentWorkItems(db, scopeId);

    // PROJ-2 has startedAt=null (pre-start) and is now excluded from the
    // flow chart to match the scope's start/done boundaries used by aging
    // thresholds and forecasts.
    expect(items).toHaveLength(1);
    expect(items[0]!.issueKey).toBe('PROJ-1');
  });

  it('computes positive ageInDays from startedAt for items that have started', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-13T12:00:00Z'));
    try {
      const db = getPrismaClient();
      const items = await queryCurrentWorkItems(db, scopeId, { timezone: 'UTC' });
      const proj1 = items.find((i) => i.issueKey === 'PROJ-1');

      expect(proj1).toBeDefined();
      expect(proj1!.ageInDays).toBeCloseTo(1, 5);
    } finally {
      vi.useRealTimers();
    }
  });

  it('excludes pre-start items (startedAt is null) from results', async () => {
    const db = getPrismaClient();
    const items = await queryCurrentWorkItems(db, scopeId, { timezone: 'UTC' });

    // PROJ-2 is in column "Review" but never transitioned into a configured
    // startStatusId, so its startedAt is null and it must not appear on the
    // flow chart. This mirrors the cycle-time boundary used by analytics.
    expect(items.find((i) => i.issueKey === 'PROJ-2')).toBeUndefined();
  });

  it('maps currentColumn from the work item record', async () => {
    const db = getPrismaClient();
    const items = await queryCurrentWorkItems(db, scopeId);
    const proj1 = items.find((i) => i.issueKey === 'PROJ-1');

    expect(proj1!.currentColumn).toBe('In Progress');
  });

  it('filters by dataVersion (lastSyncRunId) when provided', async () => {
    const db = getPrismaClient();
    // A different sync run ID means no items match.
    const items = await queryCurrentWorkItems(db, scopeId, {
      dataVersion: '00000000-0000-0000-0000-000000000000',
    });
    expect(items).toHaveLength(0);
  });

  it('returns zero hold hours and onHoldNow=false when there are no hold periods', async () => {
    const db = getPrismaClient();
    const items = await queryCurrentWorkItems(db, scopeId);
    for (const item of items) {
      expect(item.totalHoldHours).toBe(0);
      expect(item.onHoldNow).toBe(false);
    }
  });
});

describe('queryScopeFilterOptions — DB integration', () => {
  let scopeId: string;
  let syncRunId: string;

  beforeAll(async () => {
    await ensureDbStarted();
    resetConfig();
    await disconnectPrisma();

    const db = getPrismaClient();

    const workspace = await db.workspace.create({
      data: { name: 'Filter Options Workspace', defaultTimezone: 'UTC' },
    });

    const conn = await db.jiraConnection.create({
      data: {
        workspaceId: workspace.id,
        baseUrl: 'https://jira.example.internal',
        authType: 'pat',
        encryptedSecretRef: 'dummy2',
      },
    });

    const scope = await db.flowScope.create({
      data: {
        workspaceId: workspace.id,
        connectionId: conn.id,
        boardId: '2',
        boardName: 'Filter Test Board',
        timezone: 'UTC',
        includedIssueTypeIds: ['story'],
        startStatusIds: ['10'],
        doneStatusIds: ['30'],
        syncIntervalMinutes: 10,
      },
    });
    scopeId = scope.id;

    const syncRun = await db.syncRun.create({
      data: { scopeId, trigger: 'manual', status: 'succeeded', startedAt: new Date() },
    });
    syncRunId = syncRun.id;

    await db.workItem.createMany({
      data: [
        {
          scopeId,
          lastSyncRunId: syncRunId,
          jiraIssueId: 'F1',
          issueKey: 'FILT-1',
          summary: 'Story in progress',
          issueTypeId: 'story',
          issueTypeName: 'Story',
          projectId: 'FILT',
          currentStatusId: '10',
          currentColumn: 'In Progress',
          directUrl: 'https://jira.example.internal/browse/FILT-1',
          createdAt: new Date(),
          // startedAt set so the in-flow filter (startedAt IS NOT NULL) keeps this item.
          startedAt: new Date(),
        },
        {
          scopeId,
          lastSyncRunId: syncRunId,
          jiraIssueId: 'F2',
          issueKey: 'FILT-2',
          summary: 'Another story in review',
          issueTypeId: 'story',
          issueTypeName: 'Story',
          projectId: 'FILT',
          currentStatusId: '20',
          currentColumn: 'Review',
          directUrl: 'https://jira.example.internal/browse/FILT-2',
          createdAt: new Date(),
        },
        {
          // Pre-start bug: simulates production behavior where an issue type
          // outside the scope's includedIssueTypeIds gets excludedReason set
          // during normalization. Verifies that queryScopeFilterOptions
          // excludes both its status AND its issue type from dropdown options.
          scopeId,
          lastSyncRunId: syncRunId,
          jiraIssueId: 'F3',
          issueKey: 'FILT-3',
          summary: 'Pre-start bug',
          issueTypeId: 'bug',
          issueTypeName: 'Bug',
          projectId: 'FILT',
          currentStatusId: '5',
          currentColumn: 'Backlog',
          directUrl: 'https://jira.example.internal/browse/FILT-3',
          createdAt: new Date(),
          excludedReason: 'issue_type_excluded',
        },
      ],
    });
  });

  afterAll(async () => {
    await disconnectPrisma();
  });

  it('returns distinct issue types present in in-flow work items', async () => {
    const db = getPrismaClient();
    const opts = await queryScopeFilterOptions(db, scopeId);

    // FILT-3 (Bug) is excluded via excludedReason; only Story remains.
    expect(opts.issueTypes).toHaveLength(1);
    expect(opts.issueTypes[0]).toEqual({ id: 'story', name: 'Story' });
  });

  it('returns distinct statuses (with column names) present in in-flow items', async () => {
    const db = getPrismaClient();
    const opts = await queryScopeFilterOptions(db, scopeId);

    // FILT-2 has startedAt=null (pre-start) so its status ("20" / Review)
    // must not appear in the filter dropdown. Only FILT-1's status remains.
    const statusIds = opts.statuses.map((s) => s.id).sort();
    expect(statusIds).toEqual(['10']);
    const inProgress = opts.statuses.find((s) => s.id === '10');
    expect(inProgress?.name).toBe('In Progress');
  });

  it('filters by dataVersion when provided', async () => {
    const db = getPrismaClient();
    const opts = await queryScopeFilterOptions(db, scopeId, {
      dataVersion: '00000000-0000-0000-0000-000000000000',
    });

    expect(opts.issueTypes).toHaveLength(0);
    expect(opts.statuses).toHaveLength(0);
  });
});
