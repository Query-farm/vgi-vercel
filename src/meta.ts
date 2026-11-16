/**
 * Discovery metadata: the one file to edit when you rename or extend the worker.
 *
 * DuckDB, coding agents and the `vgi-lint` metadata checker all read these
 * tags. Keep every object documented and `make lint-explain` stays at 100.
 *
 * - Catalog-level tags (title, license, author, links, long description) live in
 *   `CATALOG_TAGS` below.
 * - Every function carries `objectTags(...)`: a title, a category from
 *   `SCHEMA_CATEGORIES`, search keywords, and LLM- and human-facing docs.
 */

import { field, type VgiDataType, type VgiField } from "@query-farm/vgi";

export const CATALOG_NAME = "vercel";
export const VERSION = "0.1.0";

export const SOURCE_URL = "https://github.com/Query-farm/vgi-vercel";

/**
 * Categories group functions in docs and agent tools. Every object's
 * `vgi.category` must name one of its schema's categories.
 */
export const SCHEMA_CATEGORIES = [
  { name: "projects", title: "Projects", description: "Vercel projects: framework, git link, build settings." },
  {
    name: "deployments",
    title: "Deployments",
    description: "Deployments, their detail, build logs and integration checks.",
  },
  { name: "domains", title: "Domains and DNS", description: "Project domains, account domains, DNS records, aliases." },
  {
    name: "config",
    title: "Configuration",
    description: "Environment variable names, Edge Config stores, integrations and firewall rules.",
  },
  { name: "team", title: "Team and Activity", description: "Teams, team members and the activity log." },
] as const;

export const UNIFIED_CATEGORIES = [
  {
    name: "runs",
    title: "Unified Runs",
    description: "Deployments in the cross-orchestrator unified.runs shape.",
  },
] as const;

export type Category = (typeof SCHEMA_CATEGORIES)[number]["name"] | (typeof UNIFIED_CATEGORIES)[number]["name"];

/** Turn `"a, b, c"` into the JSON array string `vgi.keywords` requires. */
export function keywordsArray(keywords: string): string {
  return JSON.stringify(
    keywords
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean),
  );
}

/** Build the standard per-object discovery tags. */
export function objectTags(opts: {
  title: string;
  category: Category;
  keywords: string;
  docLlm: string;
  docMd: string;
}): Record<string, string> {
  return {
    "vgi.title": opts.title,
    "vgi.category": opts.category,
    "vgi.keywords": keywordsArray(opts.keywords),
    "vgi.doc_llm": opts.docLlm,
    "vgi.doc_md": opts.docMd,
  };
}

/** Build an Arrow field whose `comment` shows up in DuckDB's `DESCRIBE` and agent tools. */
export function column(name: string, type: VgiDataType, comment: string, nullable = true): VgiField {
  return field(name, type, nullable, new Map([["comment", comment]]));
}

const SOURCES_MD =
  "### Sources and references\n\n" +
  "- [Vercel REST API](https://vercel.com/docs/rest-api) — the endpoints this worker reads\n" +
  "- [Deployments: list](https://vercel.com/docs/rest-api/reference/endpoints/deployments/list-deployments) and [events](https://vercel.com/docs/rest-api/reference/endpoints/deployments/get-deployment-events)\n" +
  "- [Pagination](https://vercel.com/docs/rest-api#pagination) and [rate limits](https://vercel.com/docs/rest-api#rate-limits)\n" +
  "- [Access tokens](https://vercel.com/docs/rest-api#creating-an-access-token) and [team scoping](https://vercel.com/docs/rest-api#accessing-resources-owned-by-a-team)";

export const CATALOG_COMMENT =
  "Vercel projects, deployments, build logs, domains, env var names, integrations, firewall rules and team members as SQL, read-only from the Vercel REST API.";

export const CATALOG_DOC_LLM =
  "Read-only SQL access to a Vercel account or team through the Vercel REST API. Reach for it to answer " +
  "deployment questions (which deploys failed, how long builds take, what is in production, which branch " +
  "or commit a URL serves), read a failed build's log, audit domains / DNS / certificates challenges, " +
  "inventory environment variable NAMES (values are never read), review installed integrations and " +
  "firewall rules, and list team members and the activity log. Every object needs a `vercel` DuckDB " +
  "secret with TOKEN, plus TEAM_ID (team_…) or TEAM_SLUG to read a team instead of the personal account. " +
  "Tables in `main` use a shared web-deploy vocabulary (platform, project, environment, state normalized " +
  "to queued/building/ready/error/canceled, raw_state, branch, commit_sha …) that the Netlify worker also " +
  "uses, so rows UNION across platforms; `unified.runs` exposes deployments in the cross-orchestrator " +
  "runs shape (orchestrator = 'vercel'). WHERE filters on project, environment, state, branch, commit and " +
  "created_at push down into the API, so filter early. Upstream docs: https://vercel.com/docs/rest-api ; " +
  "rate limits https://vercel.com/docs/limits#rate-limits .";

export const CATALOG_DOC_MD =
  "# Vercel\n\n" +
  "Query a Vercel account or team from DuckDB: projects, deployments (with build logs and checks), " +
  "aliases, domains and DNS, environment variable names, Edge Config stores, integrations, firewall " +
  "configs, team members and activity. Read-only.\n\n" +
  "Create a `vercel` secret with a `TOKEN` (and `TEAM_ID` for a team). Filters on project, environment, " +
  "state, branch, commit and time push down to the API; `until` cursor paging and Vercel's rate-limit " +
  "headers are handled for you. `unified.runs` lets deployments `UNION ALL` with CI and orchestrator " +
  "runs from other VGI workers.\n\n" +
  SOURCES_MD;

export const SCHEMA_COMMENT =
  "Read-only Vercel REST API collections: projects, deployments, domains, configuration and team data.";

export const SCHEMA_DOC_LLM =
  "Vercel REST API collections as SQL. Most are catalog tables (for example vercel.main.deployments) whose " +
  "WHERE filters push down; per-project tables (domains, env_var_names, firewall_configs) read one project " +
  "when filtered on project_id or project and otherwise every project, one call each. Per-deployment " +
  "data are table functions taking the deployment id: deployment(), build_logs(), deployment_checks(). " +
  "Shared web-deploy vocabulary: platform = 'vercel', deployments.state in queued/building/ready/error/" +
  "canceled, environment production/preview. All objects need a `vercel` secret.";

export const SCHEMA_DOC_MD =
  "## main\n\n" +
  "Vercel projects, deployments, domains, configuration and team data. Catalog tables push WHERE filters " +
  "into the API; per-deployment detail, logs and checks are table functions taking a deployment id.\n\n" +
  "All objects need a `vercel` secret.";

export const UNIFIED_COMMENT =
  "Vercel deployments in the cross-orchestrator runs shape, for UNION ALL with CI and orchestrator workers.";

export const UNIFIED_DOC_LLM =
  "Cross-orchestrator views. `runs` has exactly the columns every orchestration / CI worker exposes in " +
  "its own unified.runs (orchestrator, run_id, pipeline, status, raw_status, trigger, queued_at, " +
  "started_at, ended_at, duration_seconds, url), so vercel.unified.runs can be UNION ALLed with " +
  "github.unified.runs, airflow.unified.runs and the rest. Here each run is a Vercel deployment and " +
  "pipeline is the project name; status maps READY to success, ERROR to failed, CANCELED to cancelled, " +
  "BUILDING to running and QUEUED / INITIALIZING to queued.";

export const UNIFIED_DOC_MD =
  "## unified\n\nVercel deployments in the shared `unified.runs` shape, for `UNION ALL` with the runs of " +
  "other orchestrator and CI workers (Airflow, Dagster, Prefect, Temporal, Databricks, dbt, GitHub).\n\n" +
  "Each row is one deployment: `pipeline` is the project, `status` is one of queued, running, success, " +
  "failed or cancelled, and `raw_status` keeps Vercel's readyState.";

export const AGENT_TEST_TASKS = [
  { name: "project_frameworks", prompt: "Which framework does each Vercel project use?" },
  { name: "production_branches", prompt: "What is the production branch and linked repository of each project?" },
  { name: "failed_deploys", prompt: "List the ids of Vercel deployments that failed (errored), with their project." },
  { name: "prod_deploys_web", prompt: "How many production deployments does the web project have?" },
  { name: "avg_build_time", prompt: "What is the average build duration in seconds of ready deployments per project?" },
  { name: "deploy_branch", prompt: "Which git branch and commit SHA was deployment dpl_web2 built from?" },
  { name: "failed_build_log", prompt: "What error did the build log of deployment dpl_web4 print to stderr?" },
  { name: "deployment_aliases", prompt: "Which aliases point at deployment dpl_web3?" },
  { name: "failed_checks", prompt: "Which checks on deployment dpl_web3 did not succeed?" },
  { name: "unverified_domains", prompt: "Which project domains are not verified yet?" },
  { name: "dns_mx", prompt: "What MX records does acme.com have on Vercel DNS?" },
  {
    name: "plain_prod_env",
    prompt: "Which environment variables of the web project are plain text and exposed to production?",
  },
  { name: "team_owners", prompt: "Who are the owners of the Vercel team?" },
  { name: "integration_scopes", prompt: "Which integrations are installed and what scopes do they have?" },
  { name: "firewall_enabled", prompt: "Which projects have the Vercel firewall enabled?" },
  { name: "runs_by_status", prompt: "Using the unified runs view, how many Vercel runs are there per status?" },
  { name: "team_ids", prompt: "Which Vercel teams can this token access, and what are their ids?" },
  { name: "expiring_domains", prompt: "When do the domains bought through Vercel expire, and do they auto-renew?" },
  { name: "alias_targets", prompt: "Which deployment does the alias web.acme.com point to?" },
  { name: "domain_misconfigured", prompt: "Is the DNS for api.acme.io correctly configured for Vercel?" },
  { name: "edge_config_sizes", prompt: "How many items does each Edge Config store hold?" },
  { name: "env_changes", prompt: "Who changed environment variables, according to the activity log, and when?" },
];

/** Bind-only probes: each binds the function and shows its columns without fetching (LIMIT 0). */
export const EXECUTABLE_EXAMPLES = [
  {
    name: "deployments_columns",
    description: "The deployments columns (binds only; create a vercel secret and drop LIMIT 0 for rows)",
    sql: "SELECT id, project, environment, state, branch, created_at FROM vercel.main.deployments LIMIT 0",
  },
  {
    name: "runs_columns",
    description: "The unified.runs columns (binds only; create a vercel secret and drop LIMIT 0 for rows)",
    sql: "SELECT orchestrator, run_id, pipeline, status, duration_seconds FROM vercel.unified.runs LIMIT 0",
  },
];

export const CATALOG_TAGS: Record<string, string> = {
  "vgi.title": "Vercel Platform",
  "vgi.subtitle": "Vercel projects, deployments, build logs, domains and team data as SQL tables.",
  "vgi.doc_llm": CATALOG_DOC_LLM,
  "vgi.doc_md": CATALOG_DOC_MD,
  "vgi.source_url": SOURCE_URL,
  "vgi.icon_url": "https://query.farm/media-kit/products/vgi/vgi-logo.png",
  "vgi.license": "0BSD",
  "vgi.author": "Query Farm LLC",
  "vgi.copyright": "Copyright 2026 Query Farm LLC - https://query.farm",
  "vgi.keywords": keywordsArray(
    "vercel, deployments, builds, build logs, preview, production, hosting, frontend cloud, domains, dns, env vars, ci/cd",
  ),
  "vgi.support_contact": `${SOURCE_URL}/issues`,
  "vgi.support_policy_url": `${SOURCE_URL}#support`,
  // Public analyst tasks for `vgi-lint simulate`; private graders live in vgi-agent-tests.yaml.
  "vgi.agent_test_tasks": JSON.stringify(AGENT_TEST_TASKS),
  "vgi.executable_examples": JSON.stringify(EXECUTABLE_EXAMPLES),
};

export const SCHEMA_TAGS: Record<string, string> = {
  "vgi.title": "Vercel REST API",
  domain: "devops",
  "vgi.keywords": keywordsArray("vercel, projects, deployments, build logs, domains, dns, env vars, team"),
  "vgi.doc_llm": SCHEMA_DOC_LLM,
  "vgi.doc_md": SCHEMA_DOC_MD,
  "vgi.categories": JSON.stringify(SCHEMA_CATEGORIES),
};

export const UNIFIED_TAGS: Record<string, string> = {
  "vgi.title": "Unified Runs",
  domain: "devops",
  "vgi.keywords": keywordsArray("unified, runs, orchestrator, ci, deployments, union"),
  "vgi.doc_llm": UNIFIED_DOC_LLM,
  "vgi.doc_md": UNIFIED_DOC_MD,
  "vgi.categories": JSON.stringify(UNIFIED_CATEGORIES),
};
