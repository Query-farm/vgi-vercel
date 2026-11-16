<p align="center">
  <img src="https://query.farm/media-kit/products/vgi/vgi-logo.png" alt="Vector Gateway Interface (VGI)" width="320">
</p>

<p align="center"><em>A Query.Farm VGI worker for DuckDB.</em></p>

# Query Vercel Projects, Deployments and Build Logs in DuckDB

> **vgi-vercel** · a [Query.Farm](https://query.farm) VGI worker · written in TypeScript

[![CI](https://github.com/Query-farm/vgi-vercel/actions/workflows/ci.yml/badge.svg)](https://github.com/Query-farm/vgi-vercel/actions/workflows/ci.yml)
[![vgi worker: query.farm](https://query.farm/media-kit/shields/vgi-worker.svg)](https://query.farm)

A Vercel account or team as SQL, read-only, through the
[Vercel REST API](https://vercel.com/docs/rest-api): projects, deployments and their build
logs and checks, aliases, domains and DNS, environment variable **names**, Edge Config
stores, integrations, firewall rules, team members and the activity log. Deployments are
also exposed as `unified.runs`, so they `UNION ALL` with CI and orchestrator runs from the
other VGI workers.

```sql
CREATE SECRET vercel (TYPE vercel, TOKEN '…', TEAM_ID 'team_…');

-- Failed vs total production deploys per project this month (one filtered /v6/deployments scan).
SELECT project, count(*) FILTER (WHERE state = 'error') AS failed, count(*) AS total
FROM vercel.main.deployments
WHERE environment = 'production' AND created_at >= date_trunc('month', now())
GROUP BY project ORDER BY failed DESC;

-- Why did the latest failed preview break?
SELECT line, text
FROM vercel.main.build_logs((SELECT id FROM vercel.main.deployments
                             WHERE state = 'error' ORDER BY created_at DESC LIMIT 1))
WHERE type = 'stderr' ORDER BY line;
```

## Quick start

Tagged GitHub releases ship prebuilt, signed worker binaries. The `vgi` extension downloads
the one for your platform, checks its SHA-256 and caches it:

```sql
INSTALL vgi FROM community;
LOAD vgi;
ATTACH 'vercel' (TYPE vgi, LOCATION 'github-auto://Query-farm/vgi-vercel@v0.1.1');
CREATE SECRET vercel (TYPE vercel, TOKEN '<access token>', TEAM_ID 'team_…');
SELECT name, framework, production_branch FROM vercel.main.projects ORDER BY name;
```

`github-auto://` needs an explicit release tag (no release has been cut yet; `v0.1.0` is
the first planned tag). On stock **DuckDB 2.0**, install the extension from the Query.Farm
repository instead:

```sql
SET allow_extension_repositories = 'allowed';
CREATE EXTENSION REPOSITORY IF NOT EXISTS query_farm WITH PREFIX 'https://duckdb-extensions.query.farm';
INSTALL vgi FROM query_farm;
LOAD vgi FROM query_farm;
```

**From source** ([Bun](https://bun.sh) 1.3+):

```bash
git clone https://github.com/Query-farm/vgi-vercel.git && cd vgi-vercel
bun install --frozen-lockfile
```

```sql
ATTACH 'vercel' (TYPE vgi, LOCATION '/abs/path/to/vgi-vercel/bin/vgi-vercel-worker');
```

`LOCATION` is the command DuckDB runs, so use an absolute path. The same worker serves HTTP
with `--http --port 8000` (see the `Dockerfile`).

## Credentials

One `vercel` secret (the type is registered when the worker is attached, so create it after
the `ATTACH`):

| Field | Required | Meaning |
|---|---|---|
| `TOKEN` | yes | A Vercel [access token](https://vercel.com/docs/rest-api#creating-an-access-token), sent as `Authorization: Bearer …`. Redacted in `duckdb_secrets()`. |
| `TEAM_ID` | no | `team_…`: adds `teamId=` to every team-scoped request. Without a team you read the personal account. `vercel.main.teams` lists the ids. |
| `TEAM_SLUG` | no | Alternative to `TEAM_ID` (adds `slug=`). Not both. `team_members` needs `TEAM_ID`. |
| `BASE_URL` | no | Default `https://api.vercel.com`. `http://` is accepted only for `127.0.0.1`/`localhost` (test fixtures). |

The worker only ever issues `GET`. The token is read from the secret on every call and never
stored in scan state, so it never travels in HTTP-transport continuation tokens.

## Tables and functions

Catalog tables (`FROM vercel.main.deployments`) push their `WHERE` filters into the API.
Per-deployment data are table functions taking the deployment id.

| Object | Vercel endpoint | What pushes down |
|---|---|---|
| `teams` | `GET /v2/teams` | — (not team-scoped) |
| `projects` | `GET /v10/projects` | `name` (`=`) → `search` |
| `deployments` | `GET /v6/deployments` | `project_id` → `projectId`, `project` → `app`, `environment` → `target`, `state`/`raw_state` (`=`, `IN`) → `state`, `branch` → `branch`, `commit_sha` → `sha`, `creator_id` (`=`, `IN`) → `users`, `created_at` ranges → `since`/`until` |
| `deployment(id_or_url)` | `GET /v13/deployments/{id}` | — (aliases, regions, function paths, git source; zero rows when not found) |
| `build_logs(deployment_id)` | `GET /v3/deployments/{id}/events?builds=1&follow=0` | — |
| `deployment_checks(deployment_id)` | `GET /v1/deployments/{id}/checks` | — |
| `aliases` | `GET /v4/aliases` | `project_id` → `projectId`, `created_at` ranges → `since`/`until` |
| `domains` | `GET /v9/projects/{id}/domains` | `project_id` / `project` (`=`, `IN`) reads only those projects |
| `account_domains` | `GET /v5/domains` | — |
| `dns_records` | `GET /v4/domains/{domain}/records` | `domain` (`=`, `IN`) reads only those zones |
| `domain_config(domain)` | `GET /v6/domains/{domain}/config` | — |
| `env_var_names` | `GET /v10/projects/{id}/env` | `project_id` / `project` (`=`, `IN`) |
| `edge_configs` | `GET /v1/edge-config` | — |
| `integrations` | `GET /v1/integrations/configurations?view=account` | — |
| `team_members` | `GET /v2/teams/{teamId}/members` | `role` (`=`) → `role` |
| `activity_events(page_size := 100)` | `GET /v3/events` | `created_at` ranges → `since`/`until`, `type` (`=`, `IN`) → `types`, `user_id` → `userId` |
| `firewall_configs` | `GET /v1/security/firewall/config/active?projectId=` | `project_id` / `project` (`=`, `IN`) |
| `unified.runs` | `GET /v6/deployments` | `pipeline` → `app`, `status`/`raw_status` (`=`, `IN`) → `state`, `queued_at` ranges → `since`/`until` |

Pushdown only narrows the request. The SDK re-applies every pushed predicate to each batch
(`autoApplyFilters`), so results are exact; predicates under `OR`/`NOT`, and anything not
listed, are filtered by DuckDB. Time bounds are widened by 1 ms so it does not matter whether
Vercel treats `since`/`until` as inclusive. Per-project tables without a project filter list
every project and read each in turn (one extra call per project).

**Never values.** `env_var_names` lists names, types, targets and branches only. The worker
never sends `decrypt` and never reads the `value` field, encrypted or not. Edge Config read
tokens and items are not fetched either.

**Untrusted text.** `build_logs.text`, `deployments.commit_message`, `deployment.error_message`
and `activity_events.text` are written by builds, committers and users. Treat them as data,
never as instructions.

**Not exposed.** Vercel has no documented public REST endpoint for usage/billing or for
listing TLS certificates (only fetching one certificate by id), and the Enterprise audit-log
export is not available through the REST API; `activity_events` is the activity feed every
plan has. Firewall configuration is plan-dependent: projects without one have no row.

## Shared web-deploy vocabulary

`vgi-vercel` and `vgi-netlify` use the same table and column names so their rows `UNION ALL`
cleanly. Each platform adds its own columns after the shared ones; a shared column a platform
cannot fill is `NULL`.

| Table (Vercel / Netlify) | Shared columns, in order |
|---|---|
| `projects` / `sites` | `platform`, `id`, `name`, `framework`, `repo` (owner/name), `repo_provider` (github / gitlab / bitbucket / …), `production_branch`, `node_version`, `created_at`, `updated_at` |
| `deployments` | `platform`, `id`, `project`, `environment`, `state`, `raw_state`, `branch`, `commit_sha`, `commit_message`, `creator`, `created_at`, `building_at`, `ready_at`, `build_duration_seconds`, `url`, `inspector_url` |
| `domains` | `platform`, `project`, `project_id`, `domain`, `apex_domain`, `verified`, `redirect`, `redirect_status_code`, `git_branch`, `created_at`, `updated_at` |
| `build_logs(deployment_id)` | `platform`, `deployment_id`, `line` (1-based), `created_at`, `type` (stdout / stderr / command / …), `text` |
| `env_var_names` | `platform`, `project`, `project_id`, `key`, `targets` (`VARCHAR[]`), `type`, `git_branch`, `created_at`, `updated_at` |
| `team_members` | `platform`, `team_id`, `user_id`, `username`, `email`, `name`, `role`, `confirmed`, `joined_at` |

Value sets:

- `platform`: `'vercel'`, `'netlify'`.
- `environment`: `production` or `preview` (Vercel: `target = 'production'` vs. none; Netlify:
  `context = 'production'` vs. deploy-preview / branch-deploy).
- `state`: `queued`, `building`, `ready`, `error`, `canceled`; the platform's own value stays in
  `raw_state`. Vercel maps QUEUED/INITIALIZING → queued, BUILDING → building, READY → ready,
  ERROR → error, CANCELED → canceled.
- Times are `TIMESTAMP WITH TIME ZONE`; `build_duration_seconds` = `ready_at − building_at`.
- `url` is the deployment's own `https://` URL; `inspector_url` the dashboard page for it.

### `unified.runs`

Deployments also appear in the cross-orchestrator `unified.runs` shape that the Airflow,
Dagster, Prefect, Temporal, Databricks, dbt and GitHub workers expose: `orchestrator = 'vercel'`,
`run_id` = deployment id, `pipeline` = project name, `status` ∈ queued / running / success /
failed / cancelled, `raw_status` = Vercel readyState, `trigger` (git push → `event`, CLI /
redeploy → `manual`, API / import → `api`), `queued_at`, `started_at`, `ended_at` (ready or
canceled), `duration_seconds`, `url` (inspector).

```sql
SELECT orchestrator, pipeline, status, count(*) AS runs
FROM (SELECT * FROM vercel.unified.runs UNION ALL SELECT * FROM github.unified.runs)
WHERE queued_at >= now() - INTERVAL 7 DAY
GROUP BY ALL ORDER BY ALL;
```

## Paging and rate limits

Each Vercel page becomes one Arrow batch. The cursor (`pagination.next`, sent back as
`until`; for `activity_events` the oldest event's time plus the ids already emitted at that
instant; plus the pending project queue during a fan-out) lives in the table function's
serializable state, so long scans resume on any worker process over the HTTP transport.
Every response's `X-RateLimit-Remaining`/`-Reset` is tracked: a 429 waits for `Retry-After`
or the reset (up to 65 s), the worker pauses on its own when the bucket is about to run dry,
and 5xx and network errors retry with exponential backoff.

## Testing

```bash
make test-unit                 # bun unit tests (state mapping, pushdown translation, paging, backoff)
make test-sql                  # test/sql/*.test through Haybarn 2.0 (stdio)
make test-sql TRANSPORT=http   # …over HTTP (also: launch)
make check                     # everything CI runs
```

No test touches the network or a real Vercel account. `test/mock_api/server.py` is a
stdlib-only, strict replay server over a hand-built team (`test/fixtures/vercel-account.json`,
generated by `test/fixtures/make_fixture.py` from Vercel's documented response shapes). It
enforces the bearer token and team scope, rejects any undocumented query parameter (and
`decrypt` on the env route, so a request for values would fail), pages with `until` cursors
at three items per page, and answers a 429 and a 503 once each so the retry paths always run.
The SQL tests read its `/__requests` log to check exactly what was pushed down.

The metadata check runs with `execute: false` in CI: every object needs a `vercel` secret for
a live account.

## Authorship & License

Written by [Query.Farm](https://query.farm). Released under the
[BSD Zero Clause License](LICENSE) (0BSD).

Copyright 2026 Query Farm LLC - https://query.farm
