# @agile-tools/web

## Purpose

`@agile-tools/web` is the Next.js 16 App Router application for the product.
It owns the browser UI, server-rendered pages, route handlers, and the thin
server-side orchestration needed to read projections and enqueue user-driven
actions.

This app should serve from local PostgreSQL-backed read models. It should not
depend on live Jira calls on normal request paths for flow analytics or
forecasting.

## Architecture

### Main areas

- `src/app/`
  App Router pages and route handlers.
- `src/components/`
  Client and shared UI components used by the routed pages.
- `src/server/`
  Server-only helpers for auth, queue access, demo bootstrap behavior, error
  shaping, and view assembly.

### Important patterns

- Server components assemble page data from `@agile-tools/db` and server view
  helpers.
- Client components handle interactive filters, forms, charts, and optimistic
  refreshes.
- Route handlers under `src/app/api/` expose the contract consumed by the UI.
- Manual sync requests are published to pg-boss from the web process.
- Local development includes built-in bootstrap actions that seed a demo
  workspace or a local admin workspace and set the session cookie.

### Key dependencies

- `@agile-tools/db` for repositories and projections.
- `@agile-tools/analytics` for forecasting and aging logic.
- `@agile-tools/shared` for config, contracts, logging, and secrets helpers.
- `pg-boss` for publishing manual sync work.
- `@nivo/line` and `@nivo/scatterplot` for throughput and aging visualizations.

## Development

### Common commands

```bash
pnpm --filter @agile-tools/web dev
pnpm --filter @agile-tools/web build
pnpm --filter @agile-tools/web typecheck
pnpm --filter @agile-tools/web lint
```

### Local runtime assumptions

- The app expects the root `.env` file to exist.
- PostgreSQL must be running before pages that hit projections or queue-backed
  actions will work.
- In development, the landing page and auth-required panels expose the demo
  bootstrap flow for a seeded sample workspace.
- In production builds, including the published GHCR runtime image, the demo
  bootstrap stays disabled.
- Production-image local hosting can enable a loopback-only local admin
  bootstrap flow with `ALLOW_LOCAL_BOOTSTRAP=true`.
- Pilot or standalone deployments without an upstream workspace auth provider
  can opt into a read-only workspace fallback so non-admin users can view
  product pages for a configured workspace. Set
  `ALLOW_READONLY_WORKSPACE_FALLBACK=true` and `READONLY_WORKSPACE_ID=<workspace uuid>`
  (optionally `READONLY_WORKSPACE_USER_ID=<stable id>`). When no valid
  `agile_session` cookie is present, requests resolve to a `member`-scoped
  context for that workspace. Admin APIs and admin-only UI affordances stay
  hidden — `requireAdminContext()` keeps rejecting member contexts. This is a
  pilot/deployment fallback, not a replacement for a real workspace auth
  provider.

## Development Considerations

- Keep server-only logic in `src/server/` so client bundles do not pull in
  secrets, Prisma, or queue code.
- Prefer assembling UI payloads in view helpers rather than repeating query and
  mapping logic inside page files.
- Keep auth handling consistent with `src/server/auth.ts`; the current local
  flow uses a base64-encoded session cookie for workspace context.
- Keep production local bootstrap behavior loopback-scoped so it does not turn
  into a generic authentication bypass outside local hosting.
- Queue publishers must ensure the target pg-boss queue exists before sending
  jobs.
- If a page needs live Jira behavior, treat that as an explicit exception. The
  main product design is projection-backed reads.

## When To Change This App

- Add or adjust UI routes.
- Add route handlers consumed by the browser.
- Change page composition or visual presentation.
- Add server-side orchestration that belongs next to the request boundary.

## When Not To Change This App

- Do not place long-running sync or projection rebuild work here.
- Do not move core analytics math here.
- Do not embed raw Prisma access in many components when a repository or view
  helper can own it instead.
