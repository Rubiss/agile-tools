# Agile Tools — Kanban Flow Forecasting

A self-hosted web application for kanban teams. Connects to a self-hosted Jira Data Center instance via a service-account PAT, synchronizes issue data on a local PostgreSQL database, and serves flow visibility, aging analysis, and story-count Monte Carlo forecasts entirely from local read models.

## Features

- **Jira sync** — scheduled and manual synchronization of board issues, lifecycle events, and hold periods, with graceful worker shutdown canceling in-flight syncs and stale queued/running syncs auto-failed after 60 minutes so scopes can recover without manual database cleanup
- **Admin configuration** — create and edit Jira connections plus create, edit, and delete board/flow scope mappings from the admin UI
- **Current flow view** — scatter plot of active work items with percentile-based aging zones and on-hold classification
- **Work-item detail** — per-item lifecycle timeline and hold period breakdown
- **Monte Carlo forecasting** — story-count "when will we finish?" and "how many by a date?" simulations backed by local throughput history

## Prerequisites

| Requirement | Version |
|---|---|
| Node.js | 24 LTS |
| pnpm | 10+ |
| Docker | any recent version |
| Jira Data Center | 8.14+ |

A Jira service-account PAT with read access to the target board, its issues, and changelog history is required. The PAT is entered through the admin UI and stored encrypted — it is never written to environment files.

## Workspace Layout

```
apps/web        # Next.js UI and HTTP API (port 3000 by default)
apps/worker     # Scheduled sync, manual refresh jobs, projection rebuilds
packages/db     # Prisma schema, migrations, and database helpers
packages/analytics
packages/jira-client
packages/shared
```

## Bootstrap

### 1. Install dependencies

```bash
pnpm install
```

### 2. Create local environment files

Copy `.env.example` to `.env` and fill in the values:

```bash
cp .env.example .env
```

Required variables:

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/agile_tools
ENCRYPTION_KEY=<32+ character random key — never reuse across environments>
SESSION_SECRET=<32+ character random key>
DEFAULT_SYNC_INTERVAL_MINUTES=10
LOG_LEVEL=debug
```

Recommended when you run the production web container directly on `http://localhost` without TLS termination:

```bash
ALLOW_LOOPBACK_HTTP_BYPASS=true
ALLOW_LOCAL_BOOTSTRAP=true
```

### 3. Start PostgreSQL

```bash
docker compose up -d postgres
```

### 4. Apply the database schema

```bash
pnpm --filter @agile-tools/db prisma:migrate
```

### 5. Start the web application

```bash
pnpm --filter @agile-tools/web dev
```

### 6. Start the background worker

```bash
pnpm --filter @agile-tools/worker dev
```

Open `http://localhost:3000` and navigate to **Admin → Jira Connections** to configure the first connection.

## Operations

The web runtime exposes public OpenTelemetry metrics in Prometheus text format at `http://localhost:3000/metrics`.
The worker runtime exposes the same scrape format at `http://localhost:9464/metrics` when run from Docker Compose.
Scrape either endpoint from Prometheus, Grafana Alloy, or another compatible collector. If the app is reachable outside a trusted
network, restrict `/metrics` at the reverse proxy or network layer because metric labels can reveal runtime details.

Worker metrics bind to `METRICS_HOST` and `METRICS_PORT`. `METRICS_PORT` takes precedence; if it is unset, the worker
uses `PORT` so Kubernetes-style environments can assign the scrape port with the standard platform variable, then falls
back to `9464`. The Docker Compose files set `WORKER_METRICS_PORT` to publish the worker scrape port on the host.

Metrics include runtime scrape/process data, web request counts and durations by method/static route/status/outcome,
forecast and flow analytics reads, manual sync enqueues, worker job and sync runs, queue depth snapshots, Jira REST
request durations, and Prisma query durations. Labels intentionally avoid workspace IDs, issue keys, user data, raw URLs,
SQL, or JQL.

## Docker Runtime

The repository now ships a single multi-stage Docker image that contains both runtime roles:

- `web` for the Next.js UI and HTTP API
- `worker` for scheduled sync and projection jobs

This is the recommended compromise for this monorepo: build one image artifact, then run separate containers for the web and worker roles. That stays aligned with Docker's one-service-per-container guidance while still keeping artifact management simple.

### Build the image

```bash
docker build -t agile-tools:local .
```

### Use the published GHCR image with consumer Compose

If you are consuming a release image instead of building from source, use [docker-compose.consumer.yml](docker-compose.consumer.yml). It pulls `${AGILE_TOOLS_IMAGE:-ghcr.io/rubiss-projects/agile-tools:latest}` directly from GitHub Container Registry with no local retag step.

```bash
docker compose -f docker-compose.consumer.yml up -d postgres
docker compose -f docker-compose.consumer.yml --profile bootstrap run --rm bootstrap
docker compose -f docker-compose.consumer.yml --profile runtime up -d
```

If you want to pin a specific release instead of following `latest`, set `AGILE_TOOLS_IMAGE` in your shell or `.env`, for example `ghcr.io/rubiss-projects/agile-tools:v0.1.1`.

The published image runs in production mode, so the dev demo bootstrap remains disabled there. For local image hosting, set `ALLOW_LOCAL_BOOTSTRAP=true` and use the built-in local admin bootstrap action from `/` or `/admin/jira`. The bootstrap flow is intended for loopback hosts such as `localhost` and `127.0.0.1`.

### Run the web role from a local build

```bash
docker run --rm -p 3000:3000 --env-file .env \
	-e ALLOW_LOOPBACK_HTTP_BYPASS=true \
	-e ALLOW_LOCAL_BOOTSTRAP=true \
	-e DATABASE_URL=postgresql://postgres:postgres@host.docker.internal:5432/agile_tools \
	agile-tools:local web
```

### Run the worker role from a local build

```bash
docker run --rm --env-file .env \
	-e DATABASE_URL=postgresql://postgres:postgres@host.docker.internal:5432/agile_tools \
	agile-tools:local worker
```

### Bootstrap database and queue state from a local build

```bash
docker run --rm --env-file .env \
	-e DATABASE_URL=postgresql://postgres:postgres@host.docker.internal:5432/agile_tools \
	agile-tools:local bootstrap
```

### Run the full runtime stack with source-build Compose

The root compose file keeps `postgres` as the default local dependency and exposes a one-off bootstrap job plus the application runtime containers behind profiles:

```bash
docker compose up -d postgres
docker compose --profile bootstrap run --rm bootstrap
docker compose --profile runtime up --build -d
```

The `bootstrap` role runs Prisma migrations and pg-boss schema migrations from the same image artifact. The image also supports an `all` command for running both processes in one container, but that is a convenience mode rather than the recommended production shape.

### Managed-service deployments: configurable database URL source

Some managed platforms inject the PostgreSQL connection string under an autogenerated variable name (for example `XYZ_POSTGRESQL_URI`) that the platform controls and the application cannot rename. To support that, the web and worker runtimes read the database URL from a configurable source:

- If `DATABASE_URL_ENV_VAR` is set, the value of the variable it names is used as the database URL (for example `DATABASE_URL_ENV_VAR=XYZ_POSTGRESQL_URI` reads `process.env.XYZ_POSTGRESQL_URI`).
- Otherwise the runtime falls back to `DATABASE_URL`, which is the default for local, dev, and docker-compose setups.

If `DATABASE_URL_ENV_VAR` is set but the referenced variable is missing or empty, the application fails at startup with a clear configuration error. The same resolution is applied by the container entrypoint, so the `bootstrap` role (Prisma migrate and pg-boss migrate) honors `DATABASE_URL_ENV_VAR` as well.

The local compose runtime defaults `ALLOW_LOOPBACK_HTTP_BYPASS=true` for the web container so `http://localhost:3000` works without an extra reverse proxy.
It also defaults `ALLOW_LOCAL_BOOTSTRAP=true`, which enables a loopback-only local admin bootstrap action on the unauthenticated home and admin pages.
If your environment depends on a custom npm registry, proxy, or relaxed TLS setting, the source-build compose path now forwards optional build-time variables such as `NPM_CONFIG_REGISTRY`, `COREPACK_NPM_REGISTRY`, `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, and `NODE_TLS_REJECT_UNAUTHORIZED` from the invoking shell. The build uses the repository's pinned `packageManager` field through Corepack. By default, Corepack uses `NPM_CONFIG_REGISTRY`, but you can set `COREPACK_NPM_REGISTRY` separately when package-manager downloads must come from a different Artifactory remote than normal package installs.

The consumer compose file uses the same service layout and defaults, but it pulls the published image from GHCR instead of building from the local checkout.

Open `http://localhost:3000` and navigate to **Admin → Jira Connections** to configure the first connection.

If you are running the production image locally and do not have an upstream workspace session provider, open `http://localhost:3000/admin/jira` and use **Create local admin session and continue**.

### Optional local Jira stack for manual smoke testing

If you want a real Jira target on the same machine, use [docker-compose.jira.yml](docker-compose.jira.yml). It runs a single-node Jira Data Center instance plus a dedicated PostgreSQL database, isolated from the main Agile Tools stack.

```bash
docker compose -f docker-compose.jira.yml up -d
docker compose -f docker-compose.jira.yml logs -f jira
```

For a full clean rerun that also clears generated Jira seed output and the local Agile Tools admin setup state, use:

```bash
node docker/reset-local-jira-stack.mjs
```

After the Jira setup wizard is complete, you can also run the optional seed job:

```bash
docker compose -f docker-compose.jira.yml --profile bootstrap run --rm jira-bootstrap
```

See [docs/local-jira-testing.md](docs/local-jira-testing.md) for the reset flow, browser-driven first-run wizard guidance, optional bootstrap env variables, and the minimum project, board, PAT, and permission checklist needed to connect Agile Tools to the local Jira instance.

## Releases

The repository includes a tag-driven release workflow that publishes the runtime image to GitHub Container Registry and creates a GitHub Release with generated notes.

### Release source of truth

- Push a semver tag to publish a release: `vX.Y.Z` for stable releases or `vX.Y.Z-rc.1` for prereleases
- Cut release tags from a green commit that is already contained in the default branch history
- The workflow publishes `ghcr.io/<owner>/<repo>` tags for the release version and digest
- Stable releases also receive `latest` and `X.Y`, and stable releases starting at `v1.0.0` also receive the `X` tag
- You can also run the workflow manually from the Actions tab for an existing tag

### Cut a release

```bash
git tag v0.1.0
git push origin v0.1.0
```

For prereleases, use a semver prerelease suffix such as `v0.1.0-rc.1`.

### Required GitHub settings

- The workflow uses the repository `GITHUB_TOKEN` to push to `ghcr.io`, so GitHub Actions package publishing must be allowed for the repository or organization
- If a package with the same `ghcr.io/<owner>/<repo>` name was previously pushed outside Actions and is not linked to this repository, connect it to the repository or recreate it so the workflow token can write to it
- The release workflow publishes a multi-architecture image for `linux/amd64` and `linux/arm64/v8`
- CI validates that each published runtime shape bundles the matching Prisma schema and query engines instead of relying on runtime downloads

## Developer Commands

```bash
# Install all workspace dependencies
pnpm install

# Type-check all packages
pnpm typecheck

# Lint all packages (zero warnings enforced)
pnpm lint

# Run unit tests
pnpm test

# Run contract tests
pnpm test:contract

# Run integration tests (requires Docker for Testcontainers)
pnpm test:integration

# Run end-to-end tests (requires a running web app)
pnpm test:e2e

# Run performance benchmarks (requires Docker for Testcontainers)
pnpm test:perf

# Build all packages
pnpm build
```

## Community

- See [`CONTRIBUTING.md`](CONTRIBUTING.md) for local setup, validation, and pull request expectations.
- See [`SUPPORT.md`](SUPPORT.md) for question routing and support expectations.
- See [`SECURITY.md`](SECURITY.md) for responsible vulnerability reporting.
- See [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) for collaboration standards.

## Operator Workflow

See [`specs/001-kanban-flow-forecasting/quickstart.md`](specs/001-kanban-flow-forecasting/quickstart.md) for the full configuration and validation guide, including instructions for creating a Jira connection, defining a flow scope, triggering the first sync, and verifying all three primary user journeys.

## Architecture

See [`specs/001-kanban-flow-forecasting/plan.md`](specs/001-kanban-flow-forecasting/plan.md) for the technical design, data model, and delivery strategy.
