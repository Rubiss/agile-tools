// @vitest-environment jsdom

import React from 'react';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WorkItemDetailDrawer } from './work-item-detail-drawer';

const TEST_SCOPE_ID = '11111111-1111-4111-8111-111111111111';
const TEST_WORK_ITEM_ID = '22222222-2222-4222-8222-222222222222';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('WorkItemDetailDrawer', () => {
  it('shows all per-column durations returned by the item detail API', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        workItemId: TEST_WORK_ITEM_ID,
        issueKey: 'FLOW-123',
        summary: 'Improve flow analytics',
        currentStatus: 'In Progress',
        ageDays: 7,
        jiraUrl: 'https://jira.example.test/browse/FLOW-123',
        columnDurations: [
          {
            columnName: 'To Do',
            statusIds: ['todo'],
            workingDays: 1,
            holdWorkingDays: 0,
            visitCount: 1,
            current: false,
          },
          {
            columnName: 'In Progress',
            statusIds: ['dev', 'review'],
            workingDays: 2.5,
            holdWorkingDays: 0.5,
            visitCount: 2,
            current: true,
          },
        ],
        holdPeriods: [],
        lifecycleEvents: [],
        warnings: [],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(
      <WorkItemDetailDrawer
        scopeId={TEST_SCOPE_ID}
        workItemId={TEST_WORK_ITEM_ID}
        issueKey="FLOW-123"
        onClose={vi.fn()}
      />,
    );

    expect(await screen.findByText('Column Durations')).toBeVisible();
    expect(screen.getByText('To Do')).toBeVisible();
    expect(screen.getByText('1.0d')).toBeVisible();
    expect(screen.getAllByText('In Progress')).toHaveLength(2);
    expect(screen.getByText('2.5d')).toBeVisible();
    expect(screen.getByText(/2 visits/)).toHaveTextContent('0.5d on hold');
    expect(screen.getByText(/2 visits/)).toHaveTextContent('current');
  });
});
