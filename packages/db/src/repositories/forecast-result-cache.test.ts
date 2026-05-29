import { describe, expect, it } from 'vitest';

import { computeForecastRequestHash } from './forecast-result-cache.js';

describe('computeForecastRequestHash', () => {
  it('includes resolved sample windows in cache identity', () => {
    const base = {
      type: 'when' as const,
      iterations: 1000,
      confidenceLevels: [85, 50],
      remainingStoryCount: 10,
    };

    const rollingHash = computeForecastRequestHash({
      ...base,
      sampleWindow: {
        sampleMode: 'rolling',
        historicalWindowDays: 90,
        sampleStartDate: '2026-01-21',
        sampleEndDate: '2026-04-21',
      },
    });
    const rangeHash = computeForecastRequestHash({
      ...base,
      sampleWindow: {
        sampleMode: 'range',
        sampleStartDate: '2026-01-21',
        sampleEndDate: '2026-04-21',
      },
    });

    expect(rollingHash).not.toBe(rangeHash);
  });
});
