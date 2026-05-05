# Quickstart: Kanban Flow Forecasting

This quickstart describes the intended developer workflow once implementation begins. The repository is still in planning, so the commands below define the target setup and verification flow for the full feature once implementation is complete.

## Prerequisites

- Node.js 24 LTS
- pnpm 10+
- Docker or another local PostgreSQL runtime
- Access to a self-hosted Jira Data Center instance on version 8.14 or later
- A Jira service-account PAT with permission to read the target board, issues, and changelog history

## Planned Workspace Layout

```text
apps/web        # Next.js UI and HTTP API
apps/worker     # Scheduled sync, manual refresh jobs, projection rebuilds
packages/db     # Prisma schema and database helpers
packages/analytics
packages/jira-client
packages/shared
```

## Environment Variables

Create local environment files for the web and worker processes with at least the following variables:

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/agile_tools
ENCRYPTION_KEY=replace-with-local-dev-key
SESSION_SECRET=replace-with-local-dev-session-secret
DEFAULT_SYNC_INTERVAL_MINUTES=10
LOG_LEVEL=debug
```

Jira base URLs and PAT values are entered through the admin UI and stored as encrypted secrets or secret references rather than hard-coded in environment files.

If you are exercising the production image directly on `http://localhost`, also set:

```bash
ALLOW_LOOPBACK_HTTP_BYPASS=true
ALLOW_LOCAL_BOOTSTRAP=true
```

## Bootstrap

1. Install dependencies.

```bash
pnpm install
```

2. Start PostgreSQL.

```bash
docker compose up -d postgres
```

3. Apply the initial schema.

```bash
pnpm --filter @agile-tools/db prisma migrate dev
```

4. Start the web application.

```bash
pnpm --filter @agile-tools/web dev
```

5. Start the background worker.

```bash
pnpm --filter @agile-tools/worker dev
```

## Configure The First Jira Scope

1. Open the admin connection screen in the web app.
2. Create a Jira connection with the self-hosted base URL and service-account PAT.
3. Validate the connection and confirm the instance health is `healthy`.
4. Discover boards and choose the target kanban board.
5. Define the flow scope by selecting included issue types, explicit start and done statuses, and a valid time zone identifier such as `UTC` or `America/New_York`. Done statuses may include terminal workflow states that are not visible as board columns, such as `Closed`.
6. Trigger the first manual sync and wait for projection rebuild to finish.
7. If User Story 2 is implemented, configure the hold definition by mapping one or more hold statuses and, if needed, a blocked field.

## Update Existing Jira Configuration

1. Open **Admin → Jira Connections**.
2. Use **Edit Connection** to change the display name or base URL, or rotate the PAT. If the base URL or PAT changes, validate the connection again before relying on sync health.
3. Use **Edit Flow Scope** to change the connection, board, issue-type mapping, start/done statuses, timezone, or sync cadence. Timezones must remain valid identifiers such as `UTC` or `America/New_York`.
4. Boundary changes to the flow scope automatically queue a follow-up sync. If a sync is already queued or running, wait for it to finish before saving a boundary-changing edit.

## Validate The Primary User Journeys

If validating only the MVP slice, stop after the Connection And Sync journey. The remaining sections describe the full post-MVP validation flow.

### 1. Connection And Sync

- Confirm the scope shows the latest successful sync timestamp.
- Verify that the sync history records a successful manual refresh.
- Confirm that connection health remains `healthy` after validation and sync.
- During a subsequent manual or scheduled sync, refresh the flow view and confirm it continues to show the last successful data version until the new sync completes.

### 2. Scatter Plot For Aging And On-Hold Stories

- Open the flow view after the first sync completes.
- Confirm that active work items appear from local projections rather than live Jira data.
- Apply historical-window, workflow-status, issue-type, `aging only`, and `on hold only` filters.
- Open an item detail view and confirm age is shown in working days, alongside hold periods and lifecycle timeline values.

### 3. Story-Count Monte Carlo Forecasting

- Open the forecast workflow for the configured scope.
- Confirm the completed-story throughput view matches the historical window selected for the forecast, omits weekend buckets, and rolls weekend completions into the previous working day.
- Request a completion-date forecast using a remaining story count.
- Request a completion-volume forecast using a target date.
- Confirm that completion-date forecasts return date ranges, completion-volume forecasts return story-count ranges, and both include sample sizes, historical windows, and warnings when confidence is low.

## Automated Checks

Run the planned validation suite before merging implementation work:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:contract
pnpm test:integration
pnpm test:e2e
pnpm test:perf
```

The contract and integration suites should include Jira API normalization, projection rebuild correctness, and sync concurrency scenarios. The end-to-end suite should cover the three primary user stories from the spec.

## Performance Acceptance Thresholds

Performance benchmarks run via `pnpm test:perf` (Vitest with Testcontainers Postgres).

| Path | p95 target |
|---|---|
| `queryCurrentWorkItems` (flow scatter-plot DB query) | < 500 ms |
| `getWorkItemWithDetail` (item detail DB query) | < 500 ms |
| `runWhenForecast` / `runHowManyForecast` (Monte Carlo simulation, 10k trials) | < 3 000 ms |
| `queryDailyThroughput` (throughput projection DB query) | < 500 ms |

These are query-level guardrails measured against a seeded dataset of 500 active work items with lifecycle and hold-period history. They do not include Next.js route handling or network latency.

Performance validation should confirm that the flow view and item detail read paths stay under the plan target of `p95 < 500 ms` and forecast responses stay under `3 s` on representative historical datasets.
