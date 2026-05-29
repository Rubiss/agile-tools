import { describe, expect, it } from 'vitest';

import { ForecastRequestSchema } from './forecast.js';

describe('ForecastRequestSchema', () => {
  it('accepts a real calendar date for how_many requests', () => {
    const parsed = ForecastRequestSchema.safeParse({
      type: 'how_many',
      targetDate: '2025-02-28',
      sampleMode: 'rolling',
      historicalWindowDays: 90,
      confidenceLevels: [50, 85],
    });

    expect(parsed.success).toBe(true);
  });

  it('rejects impossible calendar dates for how_many requests', () => {
    const parsed = ForecastRequestSchema.safeParse({
      type: 'how_many',
      targetDate: '2025-02-30',
      sampleMode: 'rolling',
      historicalWindowDays: 90,
      confidenceLevels: [50, 85],
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain('real calendar date');
  });

  it('preserves legacy rolling requests that only send historicalWindowDays', () => {
    const parsed = ForecastRequestSchema.safeParse({
      type: 'when',
      remainingStoryCount: 10,
      historicalWindowDays: 90,
      confidenceLevels: [85],
    });

    expect(parsed.success).toBe(true);
  });

  it('accepts explicit date range samples', () => {
    const parsed = ForecastRequestSchema.safeParse({
      type: 'when',
      remainingStoryCount: 10,
      sampleMode: 'range',
      sampleStartDate: '2026-01-01',
      sampleEndDate: '2026-03-31',
      confidenceLevels: [85],
    });

    expect(parsed.success).toBe(true);
  });

  it('rejects ambiguous date ranges without range mode', () => {
    const parsed = ForecastRequestSchema.safeParse({
      type: 'when',
      remainingStoryCount: 10,
      sampleStartDate: '2026-01-01',
      sampleEndDate: '2026-03-31',
      confidenceLevels: [85],
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain('sampleMode must be range');
  });
});
