# Changelog

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

Targets: @query-farm/vgi 0.50 · VGI protocol 3.3 · Haybarn 2.0.0rc11 · vgi-lint-check 2.x (unpinned)
