# Data Model: Kanban Flow Forecasting

## Overview

The feature stores Jira source facts, local derived analytics, and forecast cache entries separately so the UI can read from consistent local projections instead of recalculating from Jira on every request.

## Core Entities

### Workspace

- **Purpose**: Internal tenant boundary for one organization using the tool.
- **Key Fields**:
  - `id`: UUID
  - `name`: Display name
  - `defaultTimezone`: IANA timezone used as the default for new scopes
- **Validation Rules**:
  - `name` is required and unique within the deployment.
  - `defaultTimezone` must be a valid IANA timezone.
- **Relationships**:
  - Has many `JiraConnection` records.
  - Has many `FlowScope` records.

### JiraConnection

- **Purpose**: Administrator-managed connection to a self-hosted Jira instance.
- **Key Fields**:
  - `id`: UUID
  - `workspaceId`: FK to `Workspace`
  - `baseUrl`: Jira base URL
  - `authType`: Fixed value `pat`
  - `encryptedSecretRef`: Secret reference, never the raw PAT
  - `healthStatus`: `draft | validating | healthy | unhealthy | stale | disabled`
  - `lastValidatedAt`: Timestamp of the most recent successful validation attempt
  - `lastHealthyAt`: Timestamp of the most recent healthy state
  - `lastErrorCode`: Last normalized validation or sync error code
- **Validation Rules**:
  - `baseUrl` must be HTTPS unless the deployment explicitly allows internal HTTP.
  - PAT secrets are write-only and must never be returned by any API response.
  - Only one active validation or sync run may mutate health state at a time.
- **Relationships**:
  - Belongs to one `Workspace`.
  - Has many `FlowScope` records.
  - Has many `SyncRun` records through scopes.
- **State Transitions**:
  - `draft -> validating`
  - `validating -> healthy | unhealthy`
  - `healthy -> stale | unhealthy | disabled`
  - `stale -> healthy | unhealthy | disabled`

### FlowScope

- **Purpose**: The explicit Jira board and flow boundaries used for kanban analytics.
- **Key Fields**:
  - `id`: UUID
  - `workspaceId`: FK to `Workspace`
  - `connectionId`: FK to `JiraConnection`
  - `boardId`: Jira board identifier
  - `boardName`: Snapshot of the selected board name
  - `timezone`: IANA timezone used for bucketing daily throughput
  - `includedIssueTypeIds`: Allowed issue types for flow analysis
  - `startStatusIds`: Statuses that mark work as active
  - `doneStatusIds`: Statuses that mark work as complete
  - `syncIntervalMinutes`: Schedule cadence for recurring refresh
  - `status`: `active | paused | needs_attention`
- **Validation Rules**:
  - `includedIssueTypeIds` must be non-empty.
  - `startStatusIds` and `doneStatusIds` must be non-empty and disjoint.
  - `syncIntervalMinutes` must remain inside the supported v1 range.
- **Relationships**:
  - Belongs to one `Workspace` and one `JiraConnection`.
  - Has one active `HoldDefinition`.
  - Has many `BoardSnapshot`, `WorkItem`, `SyncRun`, `AgingThresholdModel`, and `ForecastResultCache` records.

### BoardSnapshot

- **Purpose**: Versioned capture of Jira board configuration used to detect drift.
- **Key Fields**:
  - `id`: UUID
  - `scopeId`: FK to `FlowScope`
  - `fetchedAt`: Timestamp
  - `columns`: Serialized column definitions
  - `statusIdsByColumn`: Mapping of columns to Jira status IDs
  - `projectRefs`: Referenced Jira projects
  - `filterId`: Backing Jira filter identifier when available
- **Validation Rules**:
  - A snapshot is immutable once stored.
  - Every snapshot must reference the source `scopeId` and `fetchedAt`.

### HoldDefinition

- **Purpose**: Explicit rule for determining when a work item is on hold.
- **Key Fields**:
  - `id`: UUID
  - `scopeId`: FK to `FlowScope`
  - `holdStatusIds`: Set of Jira status IDs mapped as hold states
  - `blockedFieldId`: Optional Jira field identifier for blocked state
  - `blockedTruthyValues`: Allowed values that should be treated as blocked
  - `effectiveFrom`: Timestamp when the definition became active
  - `updatedBy`: Actor reference
- **Validation Rules**:
  - `holdStatusIds` must contain one or more Jira status IDs.
  - `blockedTruthyValues` may only be set when `blockedFieldId` is configured.
- **Relationships**:
  - Belongs to one `FlowScope`.
  - Is referenced by `HoldPeriod` derivation and `FlowView` responses.

### SyncRun

- **Purpose**: Tracks scheduled and manual refresh execution for a scope.
- **Key Fields**:
  - `id`: UUID
  - `scopeId`: FK to `FlowScope`
  - `trigger`: `scheduled | manual`
  - `status`: `queued | running | succeeded | failed | canceled`
  - `requestedBy`: Optional actor reference for manual refresh
  - `startedAt`: Timestamp
  - `finishedAt`: Timestamp
  - `dataVersion`: Published data version when successful
  - `errorCode`: Normalized failure code
  - `errorSummary`: Safe operator-facing message
- **Validation Rules**:
  - Only one `running` sync may exist per scope at a time.
  - A sync may publish a `dataVersion` only after projection rebuild succeeds.
- **Relationships**:
  - Belongs to one `FlowScope`.
  - Owns `SyncWorkItemStage` rows while the sync is running.
  - Produces updated `WorkItem`, projection, and model records.
- **State Transitions**:
  - `queued -> running`
  - `running -> succeeded | failed | canceled`

### SyncWorkItemStage

- **Purpose**: Bounded staging area for normalized Jira issues collected during a running sync before they are published to `WorkItem`.
- **Key Fields**:
  - `id`: Internal UUID
  - `syncRunId`: FK to `SyncRun`
  - `scopeId`: Scope being synchronized
  - Work-item snapshot fields: Jira issue identifiers, issue type/status names, timestamps, assignee, Jira URL, exclusion reason
  - `lifecycleEvents`: Serialized normalized lifecycle events for final publication
  - `stagedAt`: Timestamp when the row was staged
- **Validation Rules**:
  - `jiraIssueId` must be unique within a sync run.
  - Staged rows are not read by analytics APIs and must not change the published `dataVersion`.
  - On successful completion, staged rows are copied to `WorkItem` and removed in the same transaction that publishes the sync run.
- **Relationships**:
  - Belongs to one `SyncRun`.

### WorkItem

- **Purpose**: Normalized Jira issue used in flow analytics.
- **Key Fields**:
  - `id`: Internal UUID
  - `scopeId`: FK to `FlowScope`
  - `jiraIssueId`: Stable Jira source identifier
  - `issueKey`: Human-readable Jira key
  - `summary`: Latest summary
  - `issueTypeId`: Jira issue type
  - `projectId`: Jira project identifier
  - `currentStatusId`: Current Jira status
  - `currentColumn`: Derived board column
  - `createdAt`: Jira creation timestamp
  - `startedAt`: First entry into configured active statuses
  - `completedAt`: Final completion timestamp when applicable
  - `reopenedCount`: Number of reopen transitions observed
  - `directUrl`: Jira deep link
  - `excludedReason`: Optional reason the item is excluded from flow calculations
- **Validation Rules**:
  - `jiraIssueId` must be unique within a scope and remain stable even if `issueKey` changes.
  - `completedAt` must be null until the item reaches a configured done status.
  - `excludedReason` is required whenever the item is excluded from calculations.
- **Relationships**:
  - Belongs to one `FlowScope`.
  - Has many `WorkItemLifecycleEvent` and `HoldPeriod` records.

### WorkItemLifecycleEvent

- **Purpose**: Append-only history of changes needed for cycle-time and hold derivation.
- **Key Fields**:
  - `id`: UUID
  - `workItemId`: FK to `WorkItem`
  - `rawChangelogId`: Stable Jira changelog reference when available
  - `eventType`: `status_change | field_change | reopened | completed`
  - `fromStatusId`: Optional source status
  - `toStatusId`: Optional destination status
  - `changedFieldId`: Optional Jira field identifier
  - `changedAt`: Event timestamp
- **Validation Rules**:
  - Events are immutable once persisted.
  - `(workItemId, rawChangelogId)` must be unique when Jira supplies a changelog identifier.
- **Relationships**:
  - Belongs to one `WorkItem`.

### HoldPeriod

- **Purpose**: Derived intervals where a work item is considered on hold.
- **Key Fields**:
  - `id`: UUID
  - `workItemId`: FK to `WorkItem`
  - `startedAt`: Start timestamp
  - `endedAt`: Optional end timestamp for open hold periods
  - `source`: `status | blocked_field`
  - `sourceValue`: Status ID or blocked-field value that caused the hold
- **Validation Rules**:
  - `endedAt` must be null or greater than `startedAt`.
  - Hold periods for the same source may not overlap.
- **Relationships**:
  - Belongs to one `WorkItem`.

### AgingThresholdModel

- **Purpose**: Percentile-based aging thresholds derived from local history.
- **Key Fields**:
  - `id`: UUID
  - `scopeId`: FK to `FlowScope`
  - `historicalWindowDays`: Window used to sample completed stories
  - `sampleSize`: Number of completed stories used to derive thresholds
  - `metricBasis`: `cycle_time`
  - `p50`: Numeric threshold
  - `p70`: Numeric threshold
  - `p85`: Numeric threshold
  - `calculatedAt`: Timestamp
  - `dataVersion`: Published data version
  - `lowConfidenceReason`: Optional warning when sample size is too small
- **Validation Rules**:
  - Percentiles must be monotonic: `p50 <= p70 <= p85`.
  - `lowConfidenceReason` is required when `sampleSize` falls below the configured confidence threshold.
- **Relationships**:
  - Belongs to one `FlowScope`.

### ForecastResultCache

- **Purpose**: Stores deterministic forecast responses for a given request and `dataVersion` so repeated requests can return the same result without recomputation.
- **Key Fields**:
  - `id`: UUID
  - `scopeId`: FK to `FlowScope`
  - `requestHash`: Stable hash of forecast inputs
  - `historicalWindowDays`: Sampling window
  - `iterations`: Monte Carlo trial count
  - `confidenceLevels`: Requested confidence levels
  - `sampleSize`: Completed stories used as samples
  - `dataVersion`: Source data snapshot
  - `warnings`: Serialized warnings
  - `resultPayload`: Serialized forecast ranges
  - `createdAt`: Timestamp
  - `expiresAt`: Optional timestamp
- **Validation Rules**:
  - `requestHash` plus `dataVersion` must be unique within a scope.
  - Forecasts operate on story counts only.
  - `sampleSize` below the sufficiency threshold must yield warnings or unavailable results.
- **Relationships**:
  - Belongs to one `FlowScope`.

## Derived Read Models

### Current Work Item Projection

- One row per in-scope active work item.
- Includes current status, current column, age in working days, accumulated hold duration, `onHoldNow`, and current aging zone.
- Optimized for scatter plot and filter requests.

### Work Item Detail Projection

- Timeline-ready representation of one work item with lifecycle events, stage durations, hold periods, and Jira deep link.
- Optimized for drill-down panels or detail pages.

### Completed Story Projection

- One row per distinct completed story, with final completion date, cycle time in working days, hold time, reopen count, and exclusion flags.
- Serves as the base dataset for percentile aging thresholds and Monte Carlo forecast sampling.

### Daily Throughput Projection

- One row per scope and working day, with completed story count, timezone-adjusted bucket date, completeness flags, and trailing-window statistics. Weekend completions are re-bucketed to the previous working day.
- Optimized for throughput charts and forecast sampling.

### Forecast Result Cache

- Keyed by scope, request hash, and `dataVersion`.
- Allows repeated forecast requests to return a stable response without recomputation when source data has not changed.

## Relationship Summary

- A `Workspace` owns many `JiraConnection` and `FlowScope` records.
- A `JiraConnection` can back many `FlowScope` records but each `FlowScope` uses exactly one connection.
- A `FlowScope` owns its board snapshots, hold definition, sync runs, work items, aging models, and forecast cache entries.
- `WorkItem` records own their lifecycle events and derived hold periods.
- Read models are rebuilt only after a successful `SyncRun` publishes a new `dataVersion`.
