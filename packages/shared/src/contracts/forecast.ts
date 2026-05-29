import { z } from 'zod';
import { WarningSchema } from './api.js';
import {
  LocalDateSchema,
  ResolvedSampleWindowFields,
  SampleWindowRequestFields,
  validateSampleWindowRequestShape,
} from '../sample-window.js';

// ─── Request ──────────────────────────────────────────────────────────────────

const baseFields = {
  ...SampleWindowRequestFields,
  confidenceLevels: z.array(z.number().int().min(1).max(99)).min(1),
  /** Monte Carlo trial count; defaults to 10 000 when omitted. */
  iterations: z.number().int().min(1000).max(50000).optional(),
  /** Pin to a specific data snapshot; omit to use the latest. */
  dataVersion: z.string().optional(),
};

export const WhenForecastRequestSchema = z.object({
  type: z.literal('when'),
  remainingStoryCount: z.number().int().min(1),
  ...baseFields,
});
export type WhenForecastRequest = z.infer<typeof WhenForecastRequestSchema>;

export const HowManyForecastRequestSchema = z.object({
  type: z.literal('how_many'),
  targetDate: LocalDateSchema,
  ...baseFields,
});
export type HowManyForecastRequest = z.infer<typeof HowManyForecastRequestSchema>;

export const ForecastRequestSchema = z.discriminatedUnion('type', [
  WhenForecastRequestSchema,
  HowManyForecastRequestSchema,
]).superRefine(validateSampleWindowRequestShape);
export type ForecastRequest = z.infer<typeof ForecastRequestSchema>;

// ─── Result ───────────────────────────────────────────────────────────────────

export const ForecastResultSchema = z.object({
  confidenceLevel: z.number().int(),
  /** ISO date string (YYYY-MM-DD) — present for 'when' forecasts. */
  completionDate: z.string().optional(),
  /** Story count — present for 'how_many' forecasts. */
  completedStoryCount: z.number().int().optional(),
});
export type ForecastResult = z.infer<typeof ForecastResultSchema>;

// ─── Response ────────────────────────────────────────────────────────────────

export const ForecastResponseSchema = z.object({
  scopeId: z.string().uuid(),
  dataVersion: z.string(),
  type: z.enum(['when', 'how_many']),
  ...ResolvedSampleWindowFields,
  sampleSize: z.number().int(),
  iterations: z.number().int(),
  warnings: z.array(WarningSchema),
  results: z.array(ForecastResultSchema),
});
export type ForecastResponse = z.infer<typeof ForecastResponseSchema>;

// ─── Internal payload stored in ForecastResultCache ──────────────────────────

export interface ForecastCachePayload {
  results: ForecastResult[];
  warnings: Array<{ code: string; message: string }>;
}
