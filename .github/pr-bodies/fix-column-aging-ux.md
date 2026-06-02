## Summary

- restore a real hover popup for the column aging chart
- limit column aging to the configured in-scope board span
- make hidden-column mode reclaim horizontal space and spread dense Jira dots apart
- add screenshot evidence under `docs/evidence/column-aging/`

## Verification

- `pnpm vitest run apps/web/src/app/api/v1/scopes/[scopeId]/flow/column-aging-scope.test.ts apps/web/src/components/flow/column-aging-scatter-plot.test.tsx apps/web/src/components/flow/flow-analytics-section.test.tsx apps/web/src/components/flow/aging-scatter-plot.test.tsx`

## Evidence

Only in-scope columns are shown: `Selected`, `In Progress`, `Review`, `Done`.

![Only in-scope columns](../../docs/evidence/column-aging/column-aging-in-scope-columns.png)

Hover popup is working on a Jira dot and shows the work item details.

![Hover popup](../../docs/evidence/column-aging/column-aging-hover-popup.png)

When empty columns are hidden, the remaining columns expand across the available width and the clustered Jira dots have more separation.

![Hide empty columns](../../docs/evidence/column-aging/column-aging-hide-empty.png)

Measured proof from `docs/evidence/column-aging/column-aging-metrics.json`:

- full visible labels: `Selected`, `In Progress`, `Review`, `Done`
- hide-empty visible labels: `Selected`, `In Progress`
- same-width chart area: `1146px`
- dot spread before hide-empty: `283`
- dot spread after hide-empty: `548`
