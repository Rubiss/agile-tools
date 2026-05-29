// @vitest-environment jsdom

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ForecastResults } from './forecast-results';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ForecastResults', () => {
  it('opens the calculation notebook drawer for the current run', async () => {
    const user = userEvent.setup();

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        jsonResponse({
          scopeId: '11111111-1111-1111-1111-111111111111',
          dataVersion: 'sync-1',
          syncedAt: '2026-04-21T00:00:00.000Z',
          sampleMode: 'rolling',
          historicalWindowDays: 60,
          sampleStartDate: '2026-02-20',
          sampleEndDate: '2026-04-21',
          sampleSize: 4,
          warnings: [],
          days: [
            { day: '2026-04-18', completedStoryCount: 0, complete: true },
            { day: '2026-04-19', completedStoryCount: 1, complete: true },
            { day: '2026-04-20', completedStoryCount: 3, complete: true },
          ],
        }),
      ),
    );

    render(
      <ForecastResults
        scopeId="scope-1"
        request={{
          type: 'when',
          remainingStoryCount: 10,
          sampleMode: 'rolling',
          historicalWindowDays: 60,
          confidenceLevels: [85, 95],
          iterations: 10000,
        }}
        response={{
          scopeId: '11111111-1111-1111-1111-111111111111',
          dataVersion: 'sync-1',
          type: 'when',
          sampleMode: 'rolling',
          historicalWindowDays: 60,
          sampleStartDate: '2026-02-20',
          sampleEndDate: '2026-04-21',
          sampleSize: 4,
          iterations: 10000,
          warnings: [],
          results: [{ confidenceLevel: 85, completionDate: '2026-06-01' }],
        }}
      />,
    );

    await user.click(
      screen.getByRole('button', { name: /how this forecast was calculated/i }),
    );

    expect(
      await screen.findByRole('dialog', { name: /how this forecast was calculated/i }),
    ).toBeVisible();
  });
});
