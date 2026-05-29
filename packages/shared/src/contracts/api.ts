import { z } from 'zod';

import { TimeZoneIdentifierSchema } from '../timezones.js';
import { ResolvedSampleWindowFields } from '../sample-window.js';

// ─── Shared Primitives ───────────────────────────────────────────────────────

export const WarningSchema = z.object({
  code: z.string(),
  message: z.string(),
});
export type Warning = z.infer<typeof WarningSchema>;

export const ProblemSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.array(z.string()).optional(),
});
export type Problem = z.infer<typeof ProblemSchema>;

export const NamedValueSchema = z.object({
  id: z.string(),
  name: z.string(),
});
export type NamedValue = z.infer<typeof NamedValueSchema>;

// ─── Connections ─────────────────────────────────────────────────────────────

export const ConnectionHealthStatusSchema = z.enum([
  'draft',
  'validating',
  'healthy',
  'unhealthy',
  'stale',
  'disabled',
]);
export type ConnectionHealthStatus = z.infer<typeof ConnectionHealthStatusSchema>;

export const JiraConnectionSchema = z.object({
  id: z.string().uuid(),
  baseUrl: z.string().url(),
  displayName: z.string().optional(),
  healthStatus: ConnectionHealthStatusSchema,
  lastValidatedAt: z.string().datetime().optional(),
  lastHealthyAt: z.string().datetime().optional(),
  lastErrorCode: z.string().optional(),
});
export type JiraConnection = z.infer<typeof JiraConnectionSchema>;

export const CreateJiraConnectionRequestSchema = z.object({
  baseUrl: z.string().url(),
  /** Raw PAT — write-only; never returned in responses. */
  pat: z.string().min(1),
  displayName: z.string().optional(),
});
export type CreateJiraConnectionRequest = z.infer<typeof CreateJiraConnectionRequestSchema>;

export const UpdateJiraConnectionRequestSchema = z.object({
  baseUrl: z.string().url(),
  /** Raw PAT replacement — optional so display-name-only edits do not force rotation. */
  pat: z.string().min(1).optional(),
  displayName: z.string().optional(),
});
export type UpdateJiraConnectionRequest = z.infer<typeof UpdateJiraConnectionRequestSchema>;

export const JiraConnectionValidationSchema = z.object({
  connectionId: z.string().uuid(),
  healthStatus: z.enum(['healthy', 'unhealthy', 'stale']),
  validatedAt: z.string().datetime(),
  warnings: z.array(WarningSchema),
});
export type JiraConnectionValidation = z.infer<typeof JiraConnectionValidationSchema>;

export const BoardColumnSchema = z.object({
  name: z.string(),
  statusIds: z.array(z.string()),
});
export type BoardColumn = z.infer<typeof BoardColumnSchema>;

export const BoardSummarySchema = z.object({
  boardId: z.number().int(),
  boardName: z.string(),
  projectKeys: z.array(z.string()).optional(),
});
export type BoardSummary = z.infer<typeof BoardSummarySchema>;

export const BoardDiscoveryDetailSchema = z.object({
  boardId: z.number().int(),
  boardName: z.string(),
  columns: z.array(BoardColumnSchema),
  statuses: z.array(NamedValueSchema),
  completionStatuses: z.array(NamedValueSchema).optional(),
  issueTypes: z.array(NamedValueSchema),
  blockedFields: z.array(NamedValueSchema).optional(),
});
export type BoardDiscoveryDetail = z.infer<typeof BoardDiscoveryDetailSchema>;

// ─── Scopes ───────────────────────────────────────────────────────────────────

export const FlowScopeStatusSchema = z.enum(['active', 'paused', 'needs_attention']);
export type FlowScopeStatus = z.infer<typeof FlowScopeStatusSchema>;

export const FlowScopeSchema = z.object({
  id: z.string().uuid(),
  connectionId: z.string().uuid(),
  boardId: z.number().int(),
  boardName: z.string().optional(),
  timezone: z.string(),
  includedIssueTypeIds: z.array(z.string()),
  includedIssueTypes: z.array(NamedValueSchema).optional(),
  startStatusIds: z.array(z.string()),
  doneStatusIds: z.array(z.string()),
  syncIntervalMinutes: z.number().int(),
  status: FlowScopeStatusSchema,
});
export type FlowScope = z.infer<typeof FlowScopeSchema>;

export const CreateFlowScopeRequestSchema = z.object({
  connectionId: z.string().uuid(),
  boardId: z.number().int(),
  timezone: TimeZoneIdentifierSchema,
  includedIssueTypeIds: z.array(z.string()).min(1),
  startStatusIds: z.array(z.string()).min(1),
  doneStatusIds: z.array(z.string()).min(1),
  syncIntervalMinutes: z.number().int().min(5).max(15),
});
export type CreateFlowScopeRequest = z.infer<typeof CreateFlowScopeRequestSchema>;

export const UpdateFlowScopeRequestSchema = CreateFlowScopeRequestSchema;
export type UpdateFlowScopeRequest = z.infer<typeof UpdateFlowScopeRequestSchema>;

export const HoldDefinitionRequestSchema = z.object({
  holdStatusIds: z.array(z.string()).min(1),
  blockedFieldId: z.string().optional(),
  blockedTruthyValues: z.array(z.string()).optional(),
});
export type HoldDefinitionRequest = z.infer<typeof HoldDefinitionRequestSchema>;

export const HoldDefinitionResponseSchema = z.object({
  scopeId: z.string().uuid(),
  holdStatusIds: z.array(z.string()),
  blockedFieldId: z.string().optional(),
  blockedTruthyValues: z.array(z.string()).optional(),
  effectiveFrom: z.string().datetime().optional(),
});
export type HoldDefinitionResponse = z.infer<typeof HoldDefinitionResponseSchema>;

// ─── Sync Runs ────────────────────────────────────────────────────────────────

export const SyncRunSchema = z.object({
  id: z.string().uuid(),
  scopeId: z.string().uuid(),
  trigger: z.enum(['scheduled', 'manual']),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'canceled']),
  requestedBy: z.string().optional(),
  startedAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional(),
  dataVersion: z.string().optional(),
  errorCode: z.string().optional(),
  errorSummary: z.string().optional(),
});
export type SyncRun = z.infer<typeof SyncRunSchema>;

// ─── Scope Summary ────────────────────────────────────────────────────────────

export const ScopeSummarySchema = z.object({
  scope: FlowScopeSchema,
  connectionHealth: ConnectionHealthStatusSchema,
  lastSync: SyncRunSchema.optional(),
  filterOptions: z
    .object({
      issueTypes: z.array(NamedValueSchema).optional(),
      statuses: z.array(NamedValueSchema).optional(),
      historicalWindows: z.array(z.number().int()).optional(),
    })
    .optional(),
  warnings: z.array(WarningSchema),
});
export type ScopeSummary = z.infer<typeof ScopeSummarySchema>;

// ─── Flow Analytics ───────────────────────────────────────────────────────────

export const AgingZoneSchema = z.enum(['normal', 'watch', 'aging']);
export type AgingZone = z.infer<typeof AgingZoneSchema>;

export const AgingModelSchema = z.object({
  metricBasis: z.literal('cycle_time'),
  p50: z.number(),
  p70: z.number(),
  p85: z.number(),
  sampleSize: z.number().int(),
  lowConfidenceReason: z.string().optional(),
});
export type AgingModel = z.infer<typeof AgingModelSchema>;

export const FlowPointSchema = z.object({
  workItemId: z.string().uuid(),
  issueKey: z.string(),
  summary: z.string(),
  issueType: z.string().optional(),
  currentStatus: z.string(),
  currentColumn: z.string().optional(),
  assigneeName: z.string().optional(),
  ageDays: z.number(),
  totalHoldHours: z.number().optional(),
  onHoldNow: z.boolean(),
  holdReason: z.string().optional(),
  agingZone: AgingZoneSchema,
  jiraUrl: z.string().url().optional(),
});
export type FlowPoint = z.infer<typeof FlowPointSchema>;

export const FlowAnalyticsResponseSchema = z.object({
  scopeId: z.string().uuid(),
  dataVersion: z.string(),
  syncedAt: z.string().datetime(),
  historicalWindowDays: z.number().int(),
  sampleSize: z.number().int(),
  warnings: z.array(WarningSchema),
  agingModel: AgingModelSchema,
  points: z.array(FlowPointSchema),
});
export type FlowAnalyticsResponse = z.infer<typeof FlowAnalyticsResponseSchema>;

// ─── Work Item Detail ─────────────────────────────────────────────────────────

export const HoldPeriodResponseSchema = z.object({
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().optional(),
  source: z.enum(['status', 'blocked_field']),
  sourceValue: z.string().optional(),
});
export type HoldPeriodResponse = z.infer<typeof HoldPeriodResponseSchema>;

export const LifecycleEventResponseSchema = z.object({
  eventType: z.string(),
  fromStatus: z.string().optional(),
  toStatus: z.string().optional(),
  changedAt: z.string().datetime(),
});
export type LifecycleEventResponse = z.infer<typeof LifecycleEventResponseSchema>;

export const WorkItemDetailSchema = z.object({
  workItemId: z.string().uuid(),
  issueKey: z.string(),
  summary: z.string(),
  currentStatus: z.string(),
  assigneeName: z.string().optional(),
  ageDays: z.number(),
  jiraUrl: z.string().url(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  holdPeriods: z.array(HoldPeriodResponseSchema),
  lifecycleEvents: z.array(LifecycleEventResponseSchema),
  warnings: z.array(WarningSchema),
});
export type WorkItemDetail = z.infer<typeof WorkItemDetailSchema>;

// ─── Throughput ───────────────────────────────────────────────────────────────

export const ThroughputDaySchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  completedStoryCount: z.number().int(),
  complete: z.boolean().optional(),
});
export type ThroughputDay = z.infer<typeof ThroughputDaySchema>;

export const ThroughputResponseSchema = z.object({
  scopeId: z.string().uuid(),
  dataVersion: z.string(),
  syncedAt: z.string().datetime(),
  ...ResolvedSampleWindowFields,
  sampleSize: z.number().int(),
  warnings: z.array(WarningSchema),
  days: z.array(ThroughputDaySchema),
});
export type ThroughputResponse = z.infer<typeof ThroughputResponseSchema>;

// ─── dataVersion Snapshot ─────────────────────────────────────────────────────

/** Returned alongside analytics payloads so clients can pin to a consistent snapshot. */
export interface DataVersionSnapshot {
  dataVersion: string;
  syncedAt: string;
  scopeId: string;
}
