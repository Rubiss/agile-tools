// @vitest-environment jsdom

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const { getWorkspaceContextMock, buildScopeSummaryMock, getPrismaClientMock, listSyncRunsMock } = vi.hoisted(() => ({
  getWorkspaceContextMock: vi.fn(),
  buildScopeSummaryMock: vi.fn(),
  getPrismaClientMock: vi.fn(),
  listSyncRunsMock: vi.fn(),
}));

vi.mock('@/server/auth', () => ({
  getWorkspaceContext: getWorkspaceContextMock,
}));

vi.mock('@agile-tools/db', () => ({
  getPrismaClient: getPrismaClientMock,
  listSyncRuns: listSyncRunsMock,
}));

vi.mock('@/server/views/scope-summary', () => ({
  buildScopeSummary: buildScopeSummaryMock,
}));

vi.mock('@/components/admin/trigger-sync-button', () => ({
  TriggerSyncButton: () => null,
}));

vi.mock('@/components/admin/hold-definition-form', () => ({
  HoldDefinitionForm: () => null,
}));

vi.mock('@/components/flow/flow-analytics-section', () => ({
  FlowAnalyticsSection: () => null,
}));

vi.mock('@/components/app/auth-required-panel', () => ({
  AuthRequiredPanel: ({ title }: { title: string }) => React.createElement('div', null, title),
}));

import ScopePage, {
  formatScopeIssueTypes,
  formatScopeTimestamp,
  formatScopeTimestampParts,
} from './page';

beforeEach(() => {
  getWorkspaceContextMock.mockResolvedValue({
    userId: 'user-1',
    workspaceId: 'workspace-1',
    role: 'member',
  });
  getPrismaClientMock.mockReturnValue({});
  listSyncRunsMock.mockResolvedValue([]);
  buildScopeSummaryMock.mockResolvedValue({
    scope: {
      id: 'scope-1',
      connectionId: 'connection-1',
      boardId: 42,
      boardName: 'Platform Board',
      timezone: 'America/New_York',
      includedIssueTypeIds: ['story', 'bug'],
      startStatusIds: ['in-progress'],
      doneStatusIds: ['done'],
      syncIntervalMinutes: 10,
      status: 'active',
    },
    connectionHealth: 'healthy',
    lastSync: {
      id: 'sync-1',
      scopeId: 'scope-1',
      trigger: 'manual',
      status: 'succeeded',
      finishedAt: '2026-04-24T22:00:00.000Z',
      dataVersion: 'sync-1',
    },
    warnings: [],
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('formatScopeIssueTypes', () => {
  it('prefers persisted configured issue type names when available', () => {
    expect(
      formatScopeIssueTypes({
        includedIssueTypeIds: ['story', 'bug'],
        includedIssueTypes: [
          { id: 'story', name: 'Story' },
          { id: 'bug', name: 'Bug' },
        ],
      }),
    ).toBe('Story, Bug');
  });

  it('falls back to filter option names for older rows without persisted names', () => {
    expect(
      formatScopeIssueTypes(
        {
          includedIssueTypeIds: ['story', 'bug'],
        },
        {
          issueTypes: [
            { id: 'story', name: 'Story' },
            { id: 'bug', name: 'Bug' },
          ],
        },
      ),
    ).toBe('Story, Bug');
  });

  it('prefers filter option names over persisted placeholder ids for legacy rows', () => {
    expect(
      formatScopeIssueTypes(
        {
          includedIssueTypeIds: ['story', 'bug'],
          includedIssueTypes: [
            { id: 'story', name: 'story' },
            { id: 'bug', name: 'Bug' },
          ],
        },
        {
          issueTypes: [
            { id: 'story', name: 'Story' },
            { id: 'bug', name: 'Bug' },
          ],
        },
      ),
    ).toBe('Story, Bug');
  });

  it('falls back to raw ids when no names are available', () => {
    expect(
      formatScopeIssueTypes({
        includedIssueTypeIds: ['story', 'bug'],
      }),
    ).toBe('story, bug');
  });
});

describe('formatScopeTimestamp', () => {
  it('formats timestamps in the selected scope timezone instead of the server timezone', () => {
    const parts = formatScopeTimestampParts('2026-04-24T22:00:00.000Z', 'America/New_York');

    expect(parts.find((part) => part.type === 'month')?.value).toBe('Apr');
    expect(parts.find((part) => part.type === 'day')?.value).toBe('24');
    expect(parts.find((part) => part.type === 'year')?.value).toBe('2026');
    expect(parts.find((part) => part.type === 'hour')?.value).toBe('6');
    expect(parts.find((part) => part.type === 'minute')?.value).toBe('00');
  });

  it('falls back to a UTC timestamp and calls out invalid scope timezones', () => {
    expect(formatScopeTimestamp('2026-04-24T22:00:00.000Z', 'ETC')).toContain(
      'invalid scope timezone: ETC',
    );
  });
});

describe('ScopePage', () => {
  it('renders last sync as <time> elements anchored to the ISO timestamp with the scope-zone time in the tooltip and viewer-local text', async () => {
    const isoTimestamp = '2026-04-24T22:00:00.000Z';
    const formattedTimestamp = formatScopeTimestamp(isoTimestamp, 'America/New_York');

    render(await ScopePage({ params: Promise.resolve({ scopeId: 'scope-1' }) }));

    const timestampNodes = Array.from(
      document.querySelectorAll<HTMLTimeElement>(`time[datetime="${isoTimestamp}"]`),
    );

    // One node in the Last Sync stat card and one in the "finished ..." sentence.
    expect(timestampNodes.length).toBeGreaterThanOrEqual(2);
    for (const node of timestampNodes) {
      expect(node.getAttribute('datetime')).toBe(isoTimestamp);
      const title = node.getAttribute('title') ?? '';
      expect(title).toContain('America/New_York');
      expect(title).toContain(formattedTimestamp);
    }

    // After hydration the visible text is the viewer-local relative + absolute
    // format, not the raw scope-zone string, which now lives in the tooltip.
    await waitFor(() => {
      const text = timestampNodes[0]!.textContent ?? '';
      expect(text).toMatch(/ago|in \d|now|second|minute|hour|day|month|year/i);
      expect(text).not.toBe(formattedTimestamp);
    });

    // The "finished" prefix still wraps the timestamp.
    expect(screen.getByText(/finished/i)).toBeVisible();
  });

  it('keeps showing the last finished sync timestamp while a newer sync is running', async () => {
    const isoTimestamp = '2026-04-24T22:00:00.000Z';
    listSyncRunsMock.mockResolvedValue([
      {
        id: 'sync-2',
        scopeId: 'scope-1',
        trigger: 'manual',
        status: 'running',
      },
    ]);

    render(await ScopePage({ params: Promise.resolve({ scopeId: 'scope-1' }) }));

    const timestampNodes = Array.from(
      document.querySelectorAll<HTMLTimeElement>(`time[datetime="${isoTimestamp}"]`),
    );
    expect(timestampNodes.length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/last finished/i)).toBeVisible();
    expect(screen.getByText('running')).toBeVisible();
    expect(screen.queryByText('No sync yet')).not.toBeInTheDocument();
  });

  it('shows active sync status without inventing a finished timestamp for the first run', async () => {
    buildScopeSummaryMock.mockResolvedValue({
      scope: {
        id: 'scope-1',
        connectionId: 'connection-1',
        boardId: 42,
        boardName: 'Platform Board',
        timezone: 'America/New_York',
        includedIssueTypeIds: ['story', 'bug'],
        startStatusIds: ['in-progress'],
        doneStatusIds: ['done'],
        syncIntervalMinutes: 10,
        status: 'active',
      },
      connectionHealth: 'healthy',
      warnings: [],
    });
    listSyncRunsMock.mockResolvedValue([
      {
        id: 'sync-1',
        scopeId: 'scope-1',
        trigger: 'manual',
        status: 'queued',
      },
    ]);

    render(await ScopePage({ params: Promise.resolve({ scopeId: 'scope-1' }) }));

    expect(await screen.findByText('No sync yet')).toBeVisible();
    expect(screen.getByText('queued')).toBeVisible();
    expect(screen.queryByText(/finished\s+/i)).not.toBeInTheDocument();
  });

  it('does not show the previous sync error while a newer sync is running', async () => {
    buildScopeSummaryMock.mockResolvedValue({
      scope: {
        id: 'scope-1',
        connectionId: 'connection-1',
        boardId: 42,
        boardName: 'Platform Board',
        timezone: 'America/New_York',
        includedIssueTypeIds: ['story', 'bug'],
        startStatusIds: ['in-progress'],
        doneStatusIds: ['done'],
        syncIntervalMinutes: 10,
        status: 'active',
      },
      connectionHealth: 'healthy',
      lastSync: {
        id: 'sync-1',
        scopeId: 'scope-1',
        trigger: 'manual',
        status: 'failed',
        finishedAt: '2026-04-24T22:00:00.000Z',
        errorCode: 'SYNC_TIMEOUT',
        errorSummary: 'The previous sync timed out.',
      },
      warnings: [],
    });
    listSyncRunsMock.mockResolvedValue([
      {
        id: 'sync-2',
        scopeId: 'scope-1',
        trigger: 'manual',
        status: 'running',
      },
    ]);

    render(await ScopePage({ params: Promise.resolve({ scopeId: 'scope-1' }) }));

    expect(await screen.findByText('running')).toBeVisible();
    expect(screen.queryByText(/Error:\s+SYNC_TIMEOUT/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/The previous sync timed out\./i)).not.toBeInTheDocument();
  });
});
