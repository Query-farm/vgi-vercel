# Changelog

## 0.2.0 (2026-11-25)

- VGI protocol 3.4: bump @query-farm/vgi to 0.52.3 and @query-farm/vgi-rpc to 0.30.3. **Requires the
  3.4 vgi extension**: DuckDB 2.0 (`INSTALL vgi FROM query_farm`) or Haybarn 2.0.1+; Haybarn 2.0.0
  still serves the 3.3 extension, which cannot attach this worker.
- The Docker image supports Orchard hosted mode (`VGI_ORCHARD_HOSTED=1`): HTTP only, Orchard Pass
  authentication, large values through the Orchard blob vendor; the HEALTHCHECK uses `HEAD /health`.
- CI and `make` run the SQL tests on haybarn-unittest 2.0.1rc3.

## 0.1.2 (2026-11-16)

- Bump @query-farm/vgi to 0.50.1.
- CI tooling (haybarn-unittest, lint helpers) runs on Python 3.14.

## 0.1.1

- Catalog and schema docs are overviews instead of object lists, and schemas have their own one-line comments (vgi-lint 2.8: VGI173, VGI102).

## 0.1.0

Initial release: read-only Vercel REST API worker.

- `main`: teams, projects, deployments, deployment(), build_logs(), deployment_checks(), aliases,
  domains, account_domains, dns_records, domain_config(), env_var_names (names only, never values),
  edge_configs, integrations, team_members, activity_events(), firewall_configs.
- `unified.runs`: deployments in the cross-orchestrator runs shape.
- Shared "web deploy platform" vocabulary for vgi-netlify to match (see README).
- Pushdown into /v6/deployments (projectId, app, target, state, branch, sha, users, since/until),
  externalized `until` cursors, X-RateLimit-* / Retry-After handling.

Targets: @query-farm/vgi 0.50 · VGI protocol 3.3 · Haybarn 2.0.1rc3 · vgi-lint-check 2.x (unpinned)
