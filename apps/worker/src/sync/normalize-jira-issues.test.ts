import { describe, expect, it } from 'vitest';
import { normalizeJiraIssue, type NormalizeContext } from './normalize-jira-issues.js';
import type { ChangelogHistory, RawJiraIssue } from '@agile-tools/jira-client';

const BASE_CONTEXT: NormalizeContext = {
  scopeId: 'scope-1',
  syncRunId: 'run-1',
  startStatusIds: new Set(['10']),
  doneStatusIds: new Set(['30']),
  inScopeStatusIds: new Set(['10', '20', '30']),
  includedIssueTypeIds: new Set(['story']),
  statusIdsByColumn: {
    '5': 'Backlog',
    '10': 'In Progress',
    '20': 'Review',
    '30': 'Done',
  },
  jiraBaseUrl: 'https://jira.example.internal',
};

function makeIssue(status: { id: string; name: string }): RawJiraIssue {
  return {
    id: 'ISSUE-10001',
    key: 'PROJ-1',
    fields: {
      summary: 'Test issue',
      issuetype: { id: 'story', name: 'Story' },
      project: { id: 'proj-1', key: 'PROJ' },
      status,
      created: '2025-01-01T00:00:00.000Z',
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

function statusChange(from: string, to: string): ChangelogHistory['items'][number] {
  return { field: 'status', from, to } as ChangelogHistory['items'][number];
}

describe('normalizeJiraIssue', () => {
  it('does not mark issues currently before the start status as started', () => {
    const result = normalizeJiraIssue(
      makeIssue({ id: '5', name: 'Backlog' }),
      [
        makeHistory('h1', '2025-01-02T09:00:00.000Z', [statusChange('5', '10')]),
        makeHistory('h2', '2025-01-03T09:00:00.000Z', [statusChange('10', '5')]),
      ],
      BASE_CONTEXT,
    );

    expect(result.startedAt).toBeNull();
  });

  it('keeps startedAt for issues currently after the start status', () => {
    const result = normalizeJiraIssue(
      makeIssue({ id: '20', name: 'Review' }),
      [
        makeHistory('h1', '2025-01-02T09:00:00.000Z', [statusChange('5', '10')]),
        makeHistory('h2', '2025-01-03T09:00:00.000Z', [statusChange('10', '20')]),
      ],
      BASE_CONTEXT,
    );

    expect(result.startedAt).toEqual(new Date('2025-01-02T09:00:00.000Z'));
  });
});
