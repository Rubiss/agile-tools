import { z } from 'zod';
import { formatDateInTimezone, isValidLocalDate } from './working-days.js';

export const DEFAULT_SAMPLE_WINDOW_DAYS = 90;
export const MIN_SAMPLE_WINDOW_DAYS = 30;
export const MAX_SAMPLE_WINDOW_DAYS = 730;

export class SampleWindowValidationError extends Error {
  constructor(
    message: string,
    public readonly details: string[] = [message],
  ) {
    super(message);
    this.name = 'SampleWindowValidationError';
  }
}

export const SampleModeSchema = z.enum(['rolling', 'range']);
export type SampleMode = z.infer<typeof SampleModeSchema>;

export const HistoricalWindowDaysSchema = z
  .number()
  .int()
  .min(MIN_SAMPLE_WINDOW_DAYS)
  .max(MAX_SAMPLE_WINDOW_DAYS);

export const LocalDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => isValidLocalDate(value), {
    message: 'Must be a real calendar date in YYYY-MM-DD format.',
  });

export const SampleWindowRequestFields = {
  sampleMode: SampleModeSchema.optional(),
  historicalWindowDays: HistoricalWindowDaysSchema.optional(),
  sampleStartDate: LocalDateSchema.optional(),
  sampleEndDate: LocalDateSchema.optional(),
};

export const ResolvedSampleWindowFields = {
  sampleMode: SampleModeSchema,
  historicalWindowDays: HistoricalWindowDaysSchema.optional(),
  sampleStartDate: LocalDateSchema,
  sampleEndDate: LocalDateSchema,
};

interface SampleWindowLike {
  sampleMode?: SampleMode | undefined;
  historicalWindowDays?: number | undefined;
  sampleStartDate?: string | undefined;
  sampleEndDate?: string | undefined;
}

export type RollingSampleWindow = {
  sampleMode: 'rolling';
  historicalWindowDays: number;
};

export type RangeSampleWindow = {
  sampleMode: 'range';
  sampleStartDate: string;
  sampleEndDate: string;
};

export type NormalizedSampleWindow = RollingSampleWindow | RangeSampleWindow;

export type ResolvedSampleWindow =
  | (RollingSampleWindow & { sampleStartDate: string; sampleEndDate: string })
  | RangeSampleWindow;

function formatUtcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function parseLocalDate(day: string): { year: number; month: number; date: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) {
    throw new RangeError(`Invalid local date: ${day}`);
  }

  return {
    year: Number(match[1]),
    month: Number(match[2]),
    date: Number(match[3]),
  };
}

export function addLocalDateDays(day: string, delta: number): string {
  const { year, month, date } = parseLocalDate(day);
  return formatUtcDate(new Date(Date.UTC(year, month - 1, date + delta)));
}

export function differenceInLocalCalendarDays(startDay: string, endDay: string): number {
  const start = parseLocalDate(startDay);
  const end = parseLocalDate(endDay);
  return Math.round(
    (Date.UTC(end.year, end.month - 1, end.date) -
      Date.UTC(start.year, start.month - 1, start.date)) /
      (1000 * 60 * 60 * 24),
  );
}

function sampleWindowShapeErrors(value: SampleWindowLike): string[] {
  const errors: string[] = [];
  const hasStart = value.sampleStartDate !== undefined;
  const hasEnd = value.sampleEndDate !== undefined;
  const hasRangeDate = hasStart || hasEnd;
  const hasHistoricalWindow = value.historicalWindowDays !== undefined;

  if (
    hasHistoricalWindow &&
    (!Number.isInteger(value.historicalWindowDays) ||
      value.historicalWindowDays! < MIN_SAMPLE_WINDOW_DAYS ||
      value.historicalWindowDays! > MAX_SAMPLE_WINDOW_DAYS)
  ) {
    errors.push(
      `historicalWindowDays must be an integer between ${MIN_SAMPLE_WINDOW_DAYS} and ${MAX_SAMPLE_WINDOW_DAYS}.`,
    );
  }

  if (value.sampleMode === 'range') {
    if (hasHistoricalWindow) {
      errors.push('historicalWindowDays is not allowed when sampleMode is range.');
    }
    if (!hasStart) {
      errors.push('sampleStartDate is required when sampleMode is range.');
    }
    if (!hasEnd) {
      errors.push('sampleEndDate is required when sampleMode is range.');
    }
  } else {
    if (hasRangeDate) {
      errors.push('sampleMode must be range when sampleStartDate or sampleEndDate is provided.');
    }
  }

  if (value.sampleMode === 'rolling' && hasRangeDate) {
    errors.push('sampleStartDate and sampleEndDate are not allowed when sampleMode is rolling.');
  }

  if (hasStart && hasEnd && value.sampleStartDate! > value.sampleEndDate!) {
    errors.push('sampleStartDate must be on or before sampleEndDate.');
  }

  if (hasStart && hasEnd && value.sampleStartDate! <= value.sampleEndDate!) {
    const spanDays = differenceInLocalCalendarDays(value.sampleStartDate!, value.sampleEndDate!) + 1;
    if (spanDays < MIN_SAMPLE_WINDOW_DAYS || spanDays > MAX_SAMPLE_WINDOW_DAYS) {
      errors.push(
        `Sample date range must span ${MIN_SAMPLE_WINDOW_DAYS}-${MAX_SAMPLE_WINDOW_DAYS} calendar days.`,
      );
    }
  }

  return errors;
}

export function validateSampleWindowRequestShape(
  value: SampleWindowLike,
  ctx: z.RefinementCtx,
): void {
  for (const message of sampleWindowShapeErrors(value)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  }
}

export const SampleWindowRequestSchema = z
  .object(SampleWindowRequestFields)
  .superRefine(validateSampleWindowRequestShape);

export const ResolvedSampleWindowSchema = z.object(ResolvedSampleWindowFields);

export function normalizeSampleWindow(value: SampleWindowLike): NormalizedSampleWindow {
  const errors = sampleWindowShapeErrors(value);
  if (errors.length > 0) {
    throw new SampleWindowValidationError('Invalid sample window.', errors);
  }

  if (value.sampleMode === 'range') {
    return {
      sampleMode: 'range',
      sampleStartDate: value.sampleStartDate!,
      sampleEndDate: value.sampleEndDate!,
    };
  }

  return {
    sampleMode: 'rolling',
    historicalWindowDays: value.historicalWindowDays ?? DEFAULT_SAMPLE_WINDOW_DAYS,
  };
}

export function resolveSampleWindow(
  value: SampleWindowLike,
  options: { timezone: string; anchorDate?: Date; now?: Date },
): ResolvedSampleWindow {
  const normalized = normalizeSampleWindow(value);

  if (normalized.sampleMode === 'rolling') {
    const anchor = options.anchorDate ?? options.now ?? new Date();
    const sampleEndDate = formatDateInTimezone(anchor, options.timezone);
    return {
      ...normalized,
      sampleStartDate: addLocalDateDays(sampleEndDate, -normalized.historicalWindowDays),
      sampleEndDate,
    };
  }

  const today = formatDateInTimezone(options.now ?? new Date(), options.timezone);
  if (normalized.sampleEndDate > today) {
    throw new SampleWindowValidationError('Invalid sample window.', [
      `sampleEndDate must not be in the future (scope timezone today is ${today}).`,
    ]);
  }

  return normalized;
}

export function formatSampleWindowLabel(sample: SampleWindowLike): string {
  const normalized =
    sample.sampleMode === 'range'
      ? ({
          sampleMode: 'range',
          sampleStartDate: sample.sampleStartDate!,
          sampleEndDate: sample.sampleEndDate!,
        } satisfies RangeSampleWindow)
      : ({
          sampleMode: 'rolling',
          historicalWindowDays: sample.historicalWindowDays ?? DEFAULT_SAMPLE_WINDOW_DAYS,
        } satisfies RollingSampleWindow);
  return normalized.sampleMode === 'rolling'
    ? `last ${normalized.historicalWindowDays} days`
    : `${normalized.sampleStartDate} to ${normalized.sampleEndDate}`;
}

export function appendSampleWindowSearchParams(
  params: URLSearchParams,
  sample: SampleWindowLike,
): void {
  const normalized =
    sample.sampleMode === 'range'
      ? ({
          sampleMode: 'range',
          sampleStartDate: sample.sampleStartDate!,
          sampleEndDate: sample.sampleEndDate!,
        } satisfies RangeSampleWindow)
      : ({
          sampleMode: 'rolling',
          historicalWindowDays: sample.historicalWindowDays ?? DEFAULT_SAMPLE_WINDOW_DAYS,
        } satisfies RollingSampleWindow);
  params.set('sampleMode', normalized.sampleMode);
  params.delete('historicalWindowDays');
  params.delete('sampleStartDate');
  params.delete('sampleEndDate');

  if (normalized.sampleMode === 'rolling') {
    params.set('historicalWindowDays', String(normalized.historicalWindowDays));
  } else {
    params.set('sampleStartDate', normalized.sampleStartDate);
    params.set('sampleEndDate', normalized.sampleEndDate);
  }
}

export function sampleWindowRequestFields(sample: SampleWindowLike): NormalizedSampleWindow {
  return normalizeSampleWindow(sample);
}
