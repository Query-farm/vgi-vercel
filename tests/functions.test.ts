// Unit tests. The SQL-level tests live in test/sql and run through DuckDB against the
// strict replay server in test/mock_api.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Arguments, VgiClient } from "@query-farm/vgi";
import { subprocessConnect } from "@query-farm/vgi-rpc";
import {
  configFromSecrets,
  normalizeBaseUrl,
  resetDelayMs,
  teamQuery,
  type VercelConfig,
  vercelGet,
} from "../src/vercel/client.ts";
import {
  buildSeconds,
  environmentOf,
  gitMeta,
  gitRepoOf,
  RUN_STATUS_OF_STATE,
  rawStatesFor,
  runStatusOf,
  stateOf,
  triggerOf,
} from "../src/vercel/normalize.ts";
import { type Constraint, eqValues, timeBounds } from "../src/vercel/pushdown.ts";
import { deploymentQuery, eventsPaging } from "../src/vercel/resources.ts";
import { asTime, untilPaging } from "../src/vercel/table.ts";

const ROOT = join(import.meta.dir, "..");

test("configFromSecrets: token required, team id xor slug, default base URL", () => {
  expect(() => configFromSecrets({})).toThrow(/no vercel secret/);
  expect(() => configFromSecrets({ s: { type: "vercel" } })).toThrow(/TOKEN is required/);
  expect(() => configFromSecrets({ s: { type: "vercel", token: "t", team_id: "team_a", team_slug: "a" } })).toThrow(
    /not both/,
  );
  const cfg = configFromSecrets({ s: { type: "vercel", token: "t", team_id: "team_a" } });
  expect(cfg).toEqual({ baseUrl: "https://api.vercel.com", token: "t", teamId: "team_a", teamSlug: undefined });
  expect(teamQuery(cfg)).toEqual({ teamId: "team_a" });
  expect(teamQuery({ ...cfg, teamId: undefined, teamSlug: "acme" })).toEqual({ slug: "acme" });
  expect(teamQuery({ ...cfg, teamId: undefined })).toEqual({});
});

test("base_url: https required except for loopback fixtures; trailing slash dropped", () => {
  expect(normalizeBaseUrl("https://api.vercel.com/")).toBe("https://api.vercel.com");
  expect(normalizeBaseUrl("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
  expect(() => normalizeBaseUrl("http://api.vercel.com")).toThrow(/https/);
  expect(() => normalizeBaseUrl("nope")).toThrow(/not a URL/);
});

test("resetDelayMs: Retry-After first, else X-RateLimit-Reset epoch seconds", () => {
  expect(resetDelayMs(new Headers({ "Retry-After": "3" }))).toBe(3000);
  expect(resetDelayMs(new Headers({ "X-RateLimit-Reset": "1010" }), 1_000_000)).toBe(10_250);
  expect(resetDelayMs(new Headers())).toBeUndefined();
});

test("states: raw → normalized → unified run status, and back for pushdown", () => {
  expect(stateOf({ readyState: "INITIALIZING" })).toBe("queued");
  expect(stateOf({ state: "CANCELED" })).toBe("canceled");
  expect(runStatusOf({ readyState: "BUILDING" })).toBe("running");
  expect(runStatusOf({ readyState: "ERROR" })).toBe("failed");
  expect(runStatusOf({ readyState: "SOMETHING_NEW" })).toBe("queued");
  expect(rawStatesFor(["queued", "error"], {})).toEqual(["ERROR", "INITIALIZING", "QUEUED"]);
  expect(rawStatesFor(["success", "cancelled"], RUN_STATUS_OF_STATE)).toEqual(["CANCELED", "READY"]);
  expect(rawStatesFor(["skipped"], RUN_STATUS_OF_STATE)).toBeUndefined();
});

test("git metadata across providers, environment and build time", () => {
  const gl = { meta: { gitlabCommitRef: "trunk", gitlabProjectNamespace: "acme", gitlabProjectName: "api" } };
  expect(gitMeta(gl, "CommitRef")).toBe("trunk");
  expect(gitRepoOf(gl)).toBe("acme/api");
  expect(gitRepoOf({ meta: { githubOrg: "acme", githubRepo: "web" } })).toBe("acme/web");
  expect(environmentOf({ target: "production" })).toBe("production");
  expect(environmentOf({ target: null })).toBe("preview");
  expect(buildSeconds({ buildingAt: 1000, ready: 61_000 })).toBe(60);
  expect(buildSeconds({ buildingAt: 1000 })).toBeNull();
  expect(triggerOf({ source: "git" })).toBe("event");
  expect(triggerOf({ source: "cli" })).toBe("manual");
  expect(triggerOf({ source: "api-trigger-git-deploy" })).toBe("api");
});

test("asTime: epoch ms and ISO strings", () => {
  expect(asTime(1_700_000_000_000)).toBe(1_700_000_000_000_000n);
  expect(asTime("2026-11-01T00:00:00.000Z")).toBe(BigInt(Date.parse("2026-11-01T00:00:00Z")) * 1000n);
  expect(asTime(null)).toBeNull();
  expect(asTime(0)).toBeNull();
});

test("timeBounds widens by 1 ms; eqValues intersects", () => {
  const cs: Constraint[] = [
    { kind: "cmp", column: "t", op: "ge", value: 10_000n },
    { kind: "cmp", column: "t", op: "lt", value: 50_000n },
    { kind: "in", column: "s", values: ["a", "b"] },
    { kind: "cmp", column: "s", op: "eq", value: "b" },
  ];
  expect(timeBounds(cs, "t")).toEqual({ since: 9, until: 51 });
  expect(eqValues(cs, "s")).toEqual(["b"]);
});

test("deploymentQuery: every pushable column", () => {
  const cs: Constraint[] = [
    { kind: "cmp", column: "project", op: "eq", value: "web" },
    { kind: "cmp", column: "environment", op: "eq", value: "preview" },
    { kind: "in", column: "state", values: ["ready", "building"] },
    { kind: "cmp", column: "branch", op: "eq", value: "main" },
  ];
  const q = deploymentQuery(cs, {
    projectId: "project_id",
    project: "project",
    environment: "environment",
    state: "state",
    stateTable: {},
    branch: "branch",
    created: "created_at",
  });
  expect(q).toMatchObject({ app: "web", target: "preview", state: "BUILDING,READY", branch: "main", limit: "100" });
});

test("paging: pagination.next → until; hasNext false stops; events overlap by 1 ms", () => {
  expect(untilPaging({ pagination: { next: 123 } })).toEqual({ patch: { until: "123" } });
  expect(untilPaging({ pagination: { next: null } })).toBeNull();
  expect(untilPaging({ pagination: { next: 5, hasNext: false } })).toBeNull();
  const t = Date.parse("2026-11-01T00:00:00Z");
  const page = [
    { id: "a", createdAt: t + 5 },
    { id: "b", createdAt: t },
    { id: "c", createdAt: t },
  ];
  expect(eventsPaging(3)(null, page)).toEqual({ patch: { until: new Date(t + 1).toISOString() }, skip: ["b", "c"] });
  expect(eventsPaging(10)(null, page)).toBeNull();
});

describe("vercelGet against a local server", () => {
  let server: ReturnType<typeof Bun.serve>;
  let hits: { path: string; auth: string | null }[] = [];
  let mode = "ok";
  let served = 0;
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const u = new URL(req.url);
        hits.push({ path: u.pathname + u.search, auth: req.headers.get("Authorization") });
        served++;
        if (mode === "429-once" && served === 1) {
          return new Response('{"error":{"code":"rate_limited","message":"slow down"}}', {
            status: 429,
            headers: { "Retry-After": "0" },
          });
        }
        if (mode === "404") {
          return new Response('{"error":{"code":"not_found","message":"Project not found"}}', { status: 404 });
        }
        return Response.json({ ok: true });
      },
    });
  });
  afterAll(() => server.stop(true));
  const cfg = (): VercelConfig => ({ baseUrl: `http://127.0.0.1:${server.port}`, token: "tok" });

  test("Bearer header and query encoding (undefined dropped)", async () => {
    hits = [];
    mode = "ok";
    expect(await vercelGet(cfg(), "/v6/deployments", { app: "a b", skip: undefined })).toEqual({ ok: true });
    expect(hits).toEqual([{ path: "/v6/deployments?app=a+b", auth: "Bearer tok" }]);
  });

  test("429 is retried", async () => {
    hits = [];
    served = 0;
    mode = "429-once";
    expect(await vercelGet(cfg(), "/v2/teams")).toEqual({ ok: true });
    expect(hits.length).toBe(2);
  });

  test("4xx is not retried and carries Vercel's error code", async () => {
    hits = [];
    mode = "404";
    await expect(vercelGet(cfg(), "/v9/projects/x")).rejects.toThrow(/HTTP 404: not_found - Project not found/);
    expect(hits.length).toBe(1);
  });
});

describe("the worker subprocess", () => {
  let client: VgiClient;
  beforeAll(() => {
    client = new VgiClient(subprocessConnect([process.execPath, "run", join(ROOT, "src", "worker.ts")]));
  });
  afterAll(() => client?.close());

  // Fixture-backed results are covered end to end through DuckDB in test/sql (all
  // transports); here the worker must fail clearly when no vercel secret is attached.
  test("a scan without a vercel secret explains how to create one", async () => {
    const run = async () => {
      for await (const _ of client.tableFunctionRows({
        functionName: "activity_events",
        arguments: new Arguments([], new Map()),
        int64: "bigint",
      })) {
        // no rows expected
      }
    };
    await expect(run()).rejects.toThrow(/CREATE SECRET \(TYPE vercel/);
  });
});
