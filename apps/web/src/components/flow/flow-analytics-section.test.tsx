// @vitest-environment jsdom

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FlowAnalyticsSection } from './flow-analytics-section';

const { agingThresholdDrawerMock } = vi.hoisted(() => ({
  agingThresholdDrawerMock: vi.fn(() => null),
}));

vi.mock('./aging-scatter-plot', () => ({
  AgingScatterPlot: () => <div>Global chart</div>,
}));

vi.mock('./column-aging-scatter-plot', () => ({
  ColumnAgingScatterPlot: () => <div>Column chart</div>,
}));

vi.mock('./work-item-detail-drawer', () => ({
  WorkItemDetailDrawer: () => null,
}));

vi.mock('./aging-threshold-drawer', () => ({
  AgingThresholdDrawer: agingThresholdDrawerMock,
}));

const STORAGE_PREFIX = 'agile-tools:flow-filters:v1:';
const VIEW_STORAGE_PREFIX = 'agile-tools:flow-chart-view:v1:';
const TEST_SCOPE_ID = '11111111-1111-4111-8111-111111111111';

function emptyFlowResponse() {
  return jsonResponse({
    scopeId: TEST_SCOPE_ID,
    dataVersion: 'sync-1',
    syncedAt: new Date('2026-04-19T12:00:00Z').toISOString(),
    historicalWindowDays: 90,
    sampleSize: 0,
    warnings: [],
    agingModel: {
      metricBasis: 'cycle_time',
      p50: 0,
      p70: 0,
      p85: 0,
      sampleSize: 0,
      lowConfidenceReason: 'No completed stories in history.',
    },
    points: [],
  });
}

function columnFlowResponse() {
  return jsonResponse({
    scopeId: TEST_SCOPE_ID,
    dataVersion: 'sync-1',
    syncedAt: new Date('2026-04-19T12:00:00Z').toISOString(),
    historicalWindowDays: 90,
    sampleSize: 2,
    warnings: [],
    agingModel: {
      metricBasis: 'cycle_time',
      p50: 7,
      p70: 10,
      p85: 14,
      sampleSize: 40,
    },
    columnAgingModels: [
      {
        columnName: 'Selected for Development',
        statusIds: ['selected'],
        metricBasis: 'column_working_days',
        p50: 2,
        p70: 3,
        p85: 5,
        sampleSize: 40,
      },
      {
        columnName: 'In Progress',
        statusIds: ['progress'],
        metricBasis: 'column_working_days',
        p50: 4,
        p70: 6,
        p85: 9,
        sampleSize: 20,
        lowConfidenceReason: 'Only 20 completed samples.',
      },
    ],
    points: [
      {
        workItemId: '11111111-1111-4111-8111-111111111111',
        issueKey: 'AGILE-101',
        summary: 'Selected story',
        currentStatus: 'Selected for Development',
        currentColumn: 'Selected for Development',
        ageDays: 4,
        agingZone: 'normal',
        currentColumnAgeDays: 2,
        currentColumnAgingZone: 'normal',
        onHoldNow: false,
        columnDurations: [],
      },
      {
        workItemId: '22222222-2222-4222-8222-222222222222',
        issueKey: 'AGILE-102',
        summary: 'In progress story',
        currentStatus: 'In Progress',
        currentColumn: 'In Progress',
        ageDays: 8,
        agingZone: 'watch',
        currentColumnAgeDays: 5,
        currentColumnAgingZone: 'watch',
        onHoldNow: false,
        columnDurations: [],
      },
    ],
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  agingThresholdDrawerMock.mockClear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  try {
    window.localStorage.clear();
  } catch {
    // ignore
  }
});

describe('FlowAnalyticsSection', () => {
  it('expands a grouped status selection into all matching status ids', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        scopeId: '11111111-1111-4111-8111-111111111111',
        dataVersion: 'sync-1',
        syncedAt: new Date('2026-04-19T12:00:00Z').toISOString(),
        historicalWindowDays: 90,
        sampleSize: 0,
        warnings: [],
        agingModel: {
          metricBasis: 'cycle_time',
          p50: 0,
          p70: 0,
          p85: 0,
          sampleSize: 0,
          lowConfidenceReason: 'No completed stories in history.',
        },
        points: [],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(
      <FlowAnalyticsSection
        scopeId="11111111-1111-4111-8111-111111111111"
        filterOptions={{
          historicalWindows: [30, 60, 90, 180],
          statuses: [
            { id: '10', name: 'Backlog' },
            { id: '11', name: 'Backlog' },
            { id: '20', name: 'In Progress' },
          ],
        }}
      />,
    );

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    await user.click(screen.getByRole('checkbox', { name: /filter by status backlog/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    const requestUrl = String(fetchMock.mock.calls[1]?.[0]);
    expect(requestUrl).toContain('historicalWindowDays=90');
    expect(requestUrl).toContain('statusIds=10');
    expect(requestUrl).toContain('statusIds=11');
    expect(requestUrl).not.toContain('statusIds=20');
  });

  describe('filter persistence (per-scope localStorage)', () => {
    const filterOptions = {
      historicalWindows: [30, 60, 90, 180],
      issueTypes: [
        { id: 'story', name: 'Story' },
        { id: 'bug', name: 'Bug' },
      ],
      statuses: [
        { id: '10', name: 'Backlog' },
        { id: '20', name: 'In Progress' },
      ],
    };

    it('rehydrates persisted filters and uses them on the first fetch', async () => {
      window.localStorage.setItem(
        `${STORAGE_PREFIX}${TEST_SCOPE_ID}`,
        JSON.stringify({
          historicalWindowDays: 30,
          issueTypeIds: ['story'],
          statusIds: ['10'],
          agingOnly: true,
          onHoldOnly: false,
        }),
      );

      const fetchMock = vi.fn().mockResolvedValue(emptyFlowResponse());
      vi.stubGlobal('fetch', fetchMock);

      render(<FlowAnalyticsSection scopeId={TEST_SCOPE_ID} filterOptions={filterOptions} />);

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });

      const url = String(fetchMock.mock.calls[0]?.[0]);
      expect(url).toContain('historicalWindowDays=30');
      expect(url).toContain('issueTypeIds=story');
      expect(url).toContain('statusIds=10');
      expect(url).toContain('agingOnly=true');
    });

    it('discards persisted filters when every stored id has dropped from current options', async () => {
      window.localStorage.setItem(
        `${STORAGE_PREFIX}${TEST_SCOPE_ID}`,
        JSON.stringify({
          historicalWindowDays: 90,
          issueTypeIds: ['removed-type'],
          statusIds: [],
          agingOnly: false,
          onHoldOnly: false,
        }),
      );

      const fetchMock = vi.fn().mockResolvedValue(emptyFlowResponse());
      vi.stubGlobal('fetch', fetchMock);

      render(<FlowAnalyticsSection scopeId={TEST_SCOPE_ID} filterOptions={filterOptions} />);

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });

      // Falls back to defaults — stale issueTypeIds must NOT leak into the request.
      const url = String(fetchMock.mock.calls[0]?.[0]);
      expect(url).not.toContain('issueTypeIds=removed-type');
      // Stale entry should be removed from storage so it cannot be replayed later.
      expect(window.localStorage.getItem(`${STORAGE_PREFIX}${TEST_SCOPE_ID}`)).toBeNull();
    });

    it('rejects poisoned historicalWindowDays values and falls back to defaults', async () => {
      window.localStorage.setItem(
        `${STORAGE_PREFIX}${TEST_SCOPE_ID}`,
        JSON.stringify({
          historicalWindowDays: -1,
          issueTypeIds: [],
          statusIds: [],
          agingOnly: false,
          onHoldOnly: false,
        }),
      );

      const fetchMock = vi.fn().mockResolvedValue(emptyFlowResponse());
      vi.stubGlobal('fetch', fetchMock);

      render(<FlowAnalyticsSection scopeId={TEST_SCOPE_ID} filterOptions={filterOptions} />);

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });

      const url = String(fetchMock.mock.calls[0]?.[0]);
      expect(url).not.toContain('historicalWindowDays=-1');
      expect(url).toContain('historicalWindowDays=90');
    });

    it('survives invalid JSON in storage without throwing and uses defaults', async () => {
      window.localStorage.setItem(`${STORAGE_PREFIX}${TEST_SCOPE_ID}`, 'not-json');

      const fetchMock = vi.fn().mockResolvedValue(emptyFlowResponse());
      vi.stubGlobal('fetch', fetchMock);

      expect(() =>
        render(<FlowAnalyticsSection scopeId={TEST_SCOPE_ID} filterOptions={filterOptions} />),
      ).not.toThrow();

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });
      const url = String(fetchMock.mock.calls[0]?.[0]);
      expect(url).toContain('historicalWindowDays=90');
    });

    it('persists filter changes back to localStorage under the scope-specific key', async () => {
      const user = userEvent.setup();
      const fetchMock = vi.fn().mockResolvedValue(emptyFlowResponse());
      vi.stubGlobal('fetch', fetchMock);

      render(<FlowAnalyticsSection scopeId={TEST_SCOPE_ID} filterOptions={filterOptions} />);

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });

      await user.click(screen.getByRole('checkbox', { name: /aging only/i }));

      await waitFor(() => {
        const stored = window.localStorage.getItem(`${STORAGE_PREFIX}${TEST_SCOPE_ID}`);
        expect(stored).not.toBeNull();
        const parsed = JSON.parse(stored as string);
        expect(parsed.agingOnly).toBe(true);
      });
    });

    describe('chart view persistence', () => {
      const filterOptions = {
        historicalWindows: [30, 60, 90, 180],
        issueTypes: [],
        statuses: [],
      };

      it('persists the selected column-aging view under the scope-specific key', async () => {
        const user = userEvent.setup();
        const fetchMock = vi.fn().mockResolvedValue(emptyFlowResponse());
        vi.stubGlobal('fetch', fetchMock);

        render(<FlowAnalyticsSection scopeId={TEST_SCOPE_ID} filterOptions={filterOptions} />);

        expect(await screen.findByText('Global chart')).toBeVisible();

        await user.click(screen.getByRole('button', { name: /column aging/i }));

        expect(await screen.findByText('Column chart')).toBeVisible();
        expect(window.localStorage.getItem(`${VIEW_STORAGE_PREFIX}${TEST_SCOPE_ID}`)).toBe('column');
      });

      it('rehydrates the previously selected chart view', async () => {
        window.localStorage.setItem(`${VIEW_STORAGE_PREFIX}${TEST_SCOPE_ID}`, 'column');
        const fetchMock = vi.fn().mockResolvedValue(emptyFlowResponse());
        vi.stubGlobal('fetch', fetchMock);

        render(<FlowAnalyticsSection scopeId={TEST_SCOPE_ID} filterOptions={filterOptions} />);

        expect(await screen.findByText('Column chart')).toBeVisible();
      });

      it('uses column-specific threshold summary and drawer props in column view', async () => {
        const user = userEvent.setup();
        const fetchMock = vi.fn().mockResolvedValue(columnFlowResponse());
        vi.stubGlobal('fetch', fetchMock);

        render(<FlowAnalyticsSection scopeId={TEST_SCOPE_ID} filterOptions={filterOptions} />);

        await screen.findByText('Global chart');

        await user.click(screen.getByRole('button', { name: /column aging/i }));

        expect(await screen.findByText('Column chart')).toBeVisible();
        expect(screen.getByText(/^Column thresholds:/i)).toBeInTheDocument();
        expect(screen.getByText(/p50 \/ p70 \/ p85 are calculated per column/i)).toBeInTheDocument();
        expect(agingThresholdDrawerMock).toHaveBeenLastCalledWith(
          expect.objectContaining({
            mode: 'column',
            columnAgingModels: expect.arrayContaining([
              expect.objectContaining({ columnName: 'Selected for Development' }),
              expect.objectContaining({ columnName: 'In Progress' }),
            ]),
            visibleColumnNames: ['Selected for Development', 'In Progress'],
          }),
          undefined,
        );
      });
    });
  });
});
