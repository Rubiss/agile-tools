// @vitest-environment jsdom

import React from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgingScatterPlot, AgingScatterTooltipCard } from './aging-scatter-plot';
import type { FlowAnalyticsViewModel } from '@/server/views/flow-analytics';

const { responsiveScatterPlotMock } = vi.hoisted(() => ({
  responsiveScatterPlotMock: vi.fn(),
}));

vi.mock('@nivo/scatterplot', async () => {
  const ReactModule = await import('react');
  return {
    ResponsiveScatterPlot: (props: Record<string, unknown>) => {
      responsiveScatterPlotMock(props);
      return ReactModule.createElement('div', { 'data-testid': 'nivo-scatterplot' });
    },
  };
});

beforeEach(() => {
  responsiveScatterPlotMock.mockClear();
});

describe('AgingScatterTooltipCard', () => {
  it('lets the summary column grow to fill the header row', () => {
    render(
      <AgingScatterTooltipCard
        datum={{
          x: 8.25,
          y: 0,
          workItemId: 'work-item-1',
          issueKey: 'AGILE-101',
          summary: 'Normal work item',
          issueType: 'Story',
          currentStatus: 'In Progress',
          currentColumn: 'Doing',
          assigneeName: 'Riley Chen',
          onHoldNow: false,
          agingZone: 'watch',
        }}
        ageDays={8.25}
      />,
    );

    const summary = screen.getByText('Normal work item');
    const card = summary.parentElement?.parentElement?.parentElement?.parentElement;

    expect(card).toHaveStyle({
      width: '19.5rem',
      maxWidth: 'calc(100vw - 2rem)',
    });
    expect(summary.parentElement).toHaveStyle({
      minWidth: '0px',
      flex: '1 1 auto',
    });
    expect(summary).toHaveStyle({
      overflowWrap: 'break-word',
    });
  });
});

describe('AgingScatterPlot', () => {
  it('disables mesh hit testing so empty chart areas do not hover the nearest dot', () => {
    const viewModel: FlowAnalyticsViewModel = {
      series: [
        {
          id: 'normal',
          data: [
            {
              x: 8.25,
              y: 0,
              workItemId: 'work-item-1',
              issueKey: 'AGILE-101',
              summary: 'Normal work item',
              issueType: 'Story',
              currentStatus: 'In Progress',
              currentColumn: 'Doing',
              assigneeName: 'Riley Chen',
              onHoldNow: false,
              agingZone: 'normal',
            },
          ],
        },
        { id: 'watch', data: [] },
        { id: 'aging', data: [] },
      ],
      columnSeries: [
        { id: 'normal', data: [] },
        { id: 'watch', data: [] },
        { id: 'aging', data: [] },
      ],
      agingModel: {
        metricBasis: 'cycle_time',
        p50: 10,
        p70: 15,
        p85: 20,
        sampleSize: 25,
      },
      columnAgingModels: [],
      columnNames: [],
      sampleSize: 1,
      dataVersion: 'sync-1',
      syncedAt: new Date('2026-05-30T12:00:00Z').toISOString(),
    };

    render(<AgingScatterPlot viewModel={viewModel} />);

    expect(screen.getByTestId('nivo-scatterplot')).toBeInTheDocument();
    expect(responsiveScatterPlotMock).toHaveBeenCalledTimes(1);
    const props = responsiveScatterPlotMock.mock.calls[0]?.[0] as {
      useMesh?: boolean;
      layers?: unknown[];
    };
    expect(props.useMesh).toBe(false);
    expect(props.layers).toContain('nodes');
    expect(props.layers).not.toContain('mesh');
  });
});
