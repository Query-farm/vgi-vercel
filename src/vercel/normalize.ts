/**
 * The shared "web deploy platform" vocabulary (see README): Vercel's raw values mapped
 * onto the states, environments and run statuses that vgi-netlify (and the
 * orchestrator workers' `unified.runs`) use too.
 */

import type { Row } from "./table.ts";

export const PLATFORM = "vercel";

/** Vercel readyState → normalized deployment state. */
export const STATE_OF_RAW: Record<string, string> = {
  QUEUED: "queued",
  INITIALIZING: "queued",
  BUILDING: "building",
  READY: "ready",
  ERROR: "error",
  CANCELED: "canceled",
};

/** Normalized deployment state → unified.runs status. */
export const RUN_STATUS_OF_STATE: Record<string, string> = {
  queued: "queued",
  building: "running",
  ready: "success",
  error: "failed",
  canceled: "cancelled",
};

export const rawStateOf = (d: Row): string | null =>
  typeof d.readyState === "string" ? d.readyState : typeof d.state === "string" ? d.state : null;

export function stateOf(d: Row): string | null {
  const raw = rawStateOf(d);
  return raw ? (STATE_OF_RAW[raw.toUpperCase()] ?? null) : null;
}

export function runStatusOf(d: Row): string {
  const s = stateOf(d);
  // Every row needs a status; an unknown future state is closest to "queued".
  return (s && RUN_STATUS_OF_STATE[s]) ?? "queued";
}

/** Raw Vercel states that a set of normalized states covers (undefined = cannot push). */
export function rawStatesFor(values: string[], table: Record<string, string>): string[] | undefined {
  const out = new Set<string>();
  for (const v of values) {
    const raws = Object.entries(STATE_OF_RAW)
      .filter(([, s]) => s === v || table[s] === v)
      .map(([raw]) => raw);
    for (const r of raws) out.add(r);
  }
  return out.size ? [...out].sort() : undefined;
}

/** production when target is production, otherwise preview (Vercel's null target). */
export function environmentOf(d: Row): string {
  return d.target === "production" ? "production" : "preview";
}

const PROVIDERS = ["github", "gitlab", "bitbucket"] as const;

/** The git provider whose metadata keys a deployment carries (github / gitlab / bitbucket). */
export function gitProviderOf(d: Row): string | null {
  const meta = (d.meta ?? {}) as Record<string, unknown>;
  for (const p of PROVIDERS) if (typeof meta[`${p}CommitSha`] === "string") return p;
  if (typeof d.gitSource?.type === "string") return d.gitSource.type;
  return null;
}

/** A git metadata value (`CommitRef`, `CommitSha`, `CommitMessage`, `CommitAuthorName` …) for any provider. */
export function gitMeta(d: Row, key: string): string | null {
  const meta = (d.meta ?? {}) as Record<string, unknown>;
  for (const p of PROVIDERS) {
    const v = meta[`${p}${key}`];
    if (typeof v === "string" && v !== "") return v;
  }
  return null;
}

/** owner/name of the deployment's repository. */
export function gitRepoOf(d: Row): string | null {
  const m = (d.meta ?? {}) as Record<string, unknown>;
  const pairs: [unknown, unknown][] = [
    [m.githubOrg ?? m.githubCommitOrg, m.githubRepo ?? m.githubCommitRepo],
    [m.gitlabProjectNamespace, m.gitlabProjectName],
    [m.bitbucketRepoOwner, m.bitbucketRepoName],
  ];
  for (const [o, n] of pairs) if (typeof o === "string" && typeof n === "string") return `${o}/${n}`;
  return null;
}

export const createdMs = (d: Row): number | null =>
  typeof d.createdAt === "number" ? d.createdAt : typeof d.created === "number" ? d.created : null;

/** Seconds between buildingAt and ready, when both are known. */
export function buildSeconds(d: Row): number | null {
  const ready = typeof d.ready === "number" ? d.ready : null;
  const b = typeof d.buildingAt === "number" ? d.buildingAt : null;
  return ready != null && b != null && ready >= b ? (ready - b) / 1000 : null;
}

export const httpsUrl = (host: unknown): string | null =>
  typeof host === "string" && host !== "" ? (/^https?:\/\//.test(host) ? host : `https://${host}`) : null;

/** Vercel deployment `source` → unified.runs trigger. */
export function triggerOf(d: Row): string | null {
  const s = typeof d.source === "string" ? d.source : null;
  if (!s) return null;
  if (s === "git") return "event";
  if (s.startsWith("api") || s === "import" || s === "import/repo" || s === "clone/repo") return "api";
  if (s === "cli" || s === "redeploy" || s === "v0-web") return "manual";
  return "other";
}
