import { z } from 'zod';
import { WarningSchema } from './api.js';
import {
  LocalDateSchema,
  ResolvedSampleWindowFields,
  SampleWindowRequestFields,
  validateSampleWindowRequestShape,
} from '../sample-window.js';

export const EpicForecastTargetStatusSchema = z.enum(['active', 'closed']);
export type EpicForecastTargetStatus = z.infer<typeof EpicForecastTargetStatusSchema>;

export const EpicStoryCountSourceSchema = z.enum(['manual', 'epic_link', 'jira_field']);
export type EpicStoryCountSource = z.infer<typeof EpicStoryCountSourceSchema>;

export const EpicForecastTargetSchema = z.object({
  id: z.string().uuid(),
  scopeId: z.string().uuid(),
  jiraIssueKey: z.string(),
  summary: z.string(),
  directUrl: z.string().url().nullable(),
  dueDate: LocalDateSchema,
  remainingStoryCount: z.number().int().min(1),
  storyCountSource: EpicStoryCountSourceSchema,
  epicLinkStoryCount: z.number().int().min(0).nullable(),
  jiraStoryCount: z.number().int().min(0).nullable(),
  manualStoryCount: z.number().int().min(1).nullable(),
  status: EpicForecastTargetStatusSchema,
  closedAt: z.string().datetime().nullable(),
  sortOrder: z.number().int(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type EpicForecastTarget = z.infer<typeof EpicForecastTargetSchema>;

export const UpsertEpicForecastTargetRequestSchema = z.object({
  jiraIssueKey: z.string().trim().min(1).max(64),
  summary: z.string().trim().min(1).max(300),
  dueDate: LocalDateSchema,
  remainingStoryCount: z.number().int().min(1).max(10000),
  storyCountSource: EpicStoryCountSourceSchema.optional(),
  epicLinkStoryCount: z.number().int().min(0).max(10000).nullable().optional(),
  jiraStoryCount: z.number().int().min(0).max(10000).nullable().optional(),
  manualStoryCount: z.number().int().min(1).max(10000).nullable().optional(),
  status: EpicForecastTargetStatusSchema.optional(),
  closedAt: z.string().datetime().nullable().optional(),
  sortOrder: z.number().int().optional(),
});
export type UpsertEpicForecastTargetRequest = z.infer<
  typeof UpsertEpicForecastTargetRequestSchema
>;

export const EpicForecastRequestSchema = z
  .object({
    ...SampleWindowRequestFields,
    iterations: z.number().int().min(1000).max(50000).optional(),
    dataVersion: z.string().optional(),
  })
  .superRefine(validateSampleWindowRequestShape);
export type EpicForecastRequest = z.infer<typeof EpicForecastRequestSchema>;

export const EpicForecastResultSchema = z.object({
  targetId: z.string().uuid(),
  jiraIssueKey: z.string(),
  summary: z.string(),
  dueDate: LocalDateSchema,
  remainingStoryCount: z.number().int(),
  cumulativeStoryCount: z.number().int(),
  completionChance: z.number(),
  completionDatePercentiles: z.array(z.object({
    confidenceLevel: z.number().int(),
    completionDate: LocalDateSchema.optional(),
  })),
});
export type EpicForecastResult = z.infer<typeof EpicForecastResultSchema>;

export const EpicForecastResponseSchema = z.object({
  scopeId: z.string().uuid(),
  dataVersion: z.string(),
  ...ResolvedSampleWindowFields,
  sampleSize: z.number().int(),
  iterations: z.number().int(),
  warnings: z.array(WarningSchema),
  targets: z.array(EpicForecastTargetSchema),
  results: z.array(EpicForecastResultSchema),
});
export type EpicForecastResponse = z.infer<typeof EpicForecastResponseSchema>;
