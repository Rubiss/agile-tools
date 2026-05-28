# Plan: Issue #108 - Configurable Historical Throughput Sample for Forecasting

## Problem

Issue #108 asks to let users specify the time range of historical throughput used during forecasting. The current implementation already has partial support:

- Forecast POST requests accept `historicalWindowDays` from 30 to 730 days.
- Forecast sampling already uses that window in `queryDailyThroughput`.
- Forecast cache keys already include `historicalWindowDays`.
- The forecast form exposes fixed presets, but the forecast page's preview chart and "Window" stat load `/throughput` once with the default 90-day window and do not react to the selected forecast window.

The clarified requirement is broader: support preset windows, custom rolling last-N-day windows, and explicit start/end date ranges.

## User Decisions

- Supported range models: presets, custom rolling day count, and explicit start/end date range.
- Default window: keep current default behavior, interpreted as rolling 90 days.
- Selection persistence: reflect selected sample settings in the forecast page URL query string.
- Invalid throughput query params: return 400 instead of silently falling back to 90.
- Snapshot behavior: once a throughput `dataVersion` is loaded, keep it pinned when changing the selected sample so the chart and forecast use the same sync snapshot.
- Implementation branch: create an `anvil/issue-108` style branch before making code changes.

## Anvil Pushback Incorporated

This is not a small UI tweak. Explicit date ranges change the public API shape, cache identity, response display, and DB cache persistence. The plan must treat this as a Large task with contract updates, a Prisma migration, component and route tests, integration coverage, and e2e validation.

## Proposed Domain Model

Introduce a shared forecast sample window model instead of relying only on `historicalWindowDays`.

Suggested request shape:

- Rolling sample:
  - `sampleMode: "rolling"`
  - `historicalWindowDays: number` bounded 30 to 730
- Explicit range sample:
  - `sampleMode: "range"`
  - `sampleStartDate: "YYYY-MM-DD"`
  - `sampleEndDate: "YYYY-MM-DD"`

Recommended semantics:

- Dates are local dates interpreted in the scope timezone.
- Ranges are inclusive on both ends.
- `sampleStartDate <= sampleEndDate`.
- `sampleEndDate` must not be in the future relative to the scope timezone.
- Range span should use the same safety bound as rolling windows: 30 to 730 calendar days unless deliberately relaxed later.
- Preserve existing requests without `sampleMode` as rolling `historicalWindowDays` for backward compatibility if feasible.

Internally, resolve both modes to a normalized `ResolvedSampleWindow`:

- `mode: "rolling" | "range"`
- `startDate`
- `endDate`
- optional `historicalWindowDays` for rolling display/backward compatibility

For rolling windows, anchor the resolved range to the pinned sync snapshot date (`syncedAt` in the scope timezone) rather than raw `Date.now()` where possible. This avoids cache drift around day boundaries and keeps throughput previews and forecasts reproducible for the same `dataVersion`.

## Current Code Touchpoints

- `packages/shared/src/contracts/forecast.ts`
  - Expand forecast request/response schemas to represent both rolling and range samples.
- `packages/shared/src/contracts/api.ts`
  - Expand `ThroughputResponse` to return the selected sample window, not only `historicalWindowDays`.
- `specs/001-kanban-flow-forecasting/contracts/kanban-flow-api.openapi.yaml`
  - Update throughput query params, forecast request, and forecast/throughput response schemas.
- `packages/db/src/projections/throughput-projection.ts`
  - Extend `queryDailyThroughput` beyond `{ windowDays }` to accept an explicit date range and an anchor/reference date.
  - Ensure historical ranges do not append today's current working-day bucket.
  - Ensure weekend rebucketing is clamped to the selected range so completions outside the range are not pulled in.
- `packages/db/src/repositories/forecast-result-cache.ts`
  - Replace hash input `historicalWindowDays` with a tagged sample definition.
  - Include resolved start/end dates in the hash so rolling and explicit range requests cannot collide accidentally.
- `packages/db/prisma/schema.prisma`
  - Migrate `ForecastResultCache` away from a required `historicalWindowDays`-only cache record.
  - Add sample mode and start/end fields, make legacy day count nullable or keep it only for rolling rows.
  - Decide whether existing cache rows are backfilled as rolling windows or invalidated/dropped.
- `apps/web/src/app/api/v1/scopes/[scopeId]/throughput/route.ts`
  - Parse rolling or range query params.
  - Return 400 for invalid combinations or invalid values.
  - Return the normalized sample window in the response.
- `apps/web/src/app/api/v1/scopes/[scopeId]/forecasts/route.ts`
  - Validate and normalize the sample window after resolving scope timezone and dataVersion.
  - Use the same normalized sample for throughput query, cache key, cache storage, and response shaping.
- `apps/web/src/server/views/forecast-response.ts`
  - Shape sample window metadata into forecast responses.
- `apps/web/src/components/forecast/forecast-form.tsx`
  - Support preset choices, custom rolling day count, and start/end date inputs.
  - Become controlled by the forecast page or receive explicit value/change props.
- `apps/web/src/app/scopes/[scopeId]/forecast/page.tsx`
  - Parse selected sample from URL query.
  - Refetch throughput when sample params change.
  - Include `dataVersion` in refetches after a snapshot is loaded.
  - Submit the same selected sample in forecast POSTs.
- `apps/web/src/components/forecast/throughput-chart.tsx`
  - Render rolling and range labels.
- `apps/web/src/components/forecast/forecast-results.tsx`
  - Replace "Window: N days" with a label that handles both rolling and explicit ranges.
- `apps/web/src/components/forecast/forecast-calculation-drawer.tsx`
  - Fetch explanation throughput with the response's sample definition, not only `historicalWindowDays`.
- `apps/web/src/server/dev-demo.ts`
  - Update seeded/demo forecast data if response shape changes.

## Proposed Implementation Todos

1. Create a feature branch before edits.
2. Add shared sample-window types, validators, formatting helpers, and normalization helpers.
3. Update OpenAPI and typed contracts for throughput and forecast requests/responses.
4. Add a Prisma migration for `ForecastResultCache` sample metadata and decide cache backfill vs invalidation.
5. Update forecast cache hashing/storage to use normalized tagged sample definitions.
6. Extend `queryDailyThroughput` to support explicit start/end ranges and pinned rolling-window anchors.
7. Update throughput GET parsing/validation to support rolling/range URL params and return 400 on invalid input.
8. Update forecast POST normalization, sampling, caching, and response shaping.
9. Update forecast page URL state, throughput refetching, and dataVersion pinning.
10. Update form, chart, results, and calculation drawer UI labels/interactions.
11. Add tests for sample-window schema validation, cache hash uniqueness/stability, date-range projection semantics, route validation, UI URL state, and forecast payloads.
12. Add/update e2e coverage for selecting presets, entering custom rolling days, entering date ranges, and seeing the matching throughput/forecast window.
13. Run targeted validation, then full validation appropriate for this Large change.

## Validation Plan

Baseline before implementation:

- Check git state and create the feature branch.
- Capture baseline diagnostics/build/test state for touched surfaces.

Targeted after-change checks:

- `packages/shared/src/contracts/forecast.test.ts`
- `apps/web/src/components/forecast/forecast-form.test.tsx`
- `apps/web/src/components/forecast/forecast-results.test.tsx`
- `apps/web/src/components/forecast/forecast-calculation-drawer.test.tsx`
- `apps/web/src/app/scopes/[scopeId]/forecast/page.test.tsx`
- `apps/web/src/app/api/v1/scopes/[scopeId]/throughput/route` tests, added if missing.
- `apps/web/src/app/api/v1/scopes/[scopeId]/forecasts/route.test.ts`
- `tests/integration/forecasting.integration.test.ts`
- `tests/e2e/forecasting.spec.ts`

Full validation:

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`

## Constitution Check

- I. Modular Monolith First: PASS. This stays within the existing web/shared/db workspace boundaries.
- II. Projection-Backed Analytics: PASS. Forecasting continues to read local projections only; no live Jira request path is introduced.
- III. Contract and Schema Discipline: PASS if OpenAPI, Zod schemas, Prisma migration, and compatibility behavior are updated together.
- IV. Test Coverage by Risk: PASS if contract, projection, cache, route, UI, integration, and e2e tests are added/updated.
- V. Operational Safety: PASS. No secrets, destructive user action, auth boundary, or sync concurrency behavior changes are expected; cache migration behavior must be explicit.

## Risks and Edge Cases

- Existing `ForecastResultCache.historicalWindowDays Int NOT NULL` cannot represent explicit ranges. Migration is required.
- Rolling-window cache entries can become stale around day boundaries unless the rolling window is resolved against a stable anchor and hashed with that anchor/resolved range.
- Explicit ranges ending before today should mark all returned throughput days complete and must not append the current working-day bucket.
- Weekend completions rebucketed to a prior Friday must not pull completions from outside the user-selected start date into the selected sample.
- Empty but valid ranges should return a clear warning/empty forecast result rather than crashing. Invalid ranges should return 400.
- URL query shape must reject ambiguous combinations, such as both `historicalWindowDays` and `sampleStartDate/sampleEndDate` without an unambiguous `sampleMode`.
- Existing clients may still send only `historicalWindowDays`; preserving rolling-mode compatibility reduces breakage.
