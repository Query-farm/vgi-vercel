/**
 * One factory for every Vercel list endpoint.
 *
 * A spec names the columns (with a JSON extractor each), how arguments and pushed
 * filters become the first request of each phase, and how the next page is found. The
 * factory turns that into a VGI table function (or catalog table) that:
 *
 * - streams one Vercel page per Arrow batch;
 * - keeps its cursor (phase + the next page's query patch, e.g. `until=<ms>`) in
 *   serializable state, so a scan resumes on any process over HTTP and survives
 *   rate-limit pauses;
 * - reads the `vercel` secret on every call and never stores it in state;
 * - pushes filters down (narrowing only) and lets the SDK re-apply them exactly;
 * - fans out over parents (projects, domains) for per-parent endpoints, with the
 *   parent queue and both cursors in state too.
 */

import {
  batchFromColumns,
  bool,
  constraintRecord,
  defineTableFunction,
  field,
  float64,
  formatPushedFilters,
  int32,
  int64,
  list,
  schema,
  struct,
  type TableDescriptor,
  timestampMicros,
  utf8,
  type VgiDataType,
  type VgiFunction,
} from "@query-farm/vgi";
import { log } from "../log.ts";
import { type Category, column, objectTags } from "../meta.ts";
import { configFromSecrets, SECRET_TYPE, teamQuery, type VercelConfig, VercelError, vercelGet } from "./client.ts";
import { type Constraint, constraintsOf, eqValues } from "./pushdown.ts";

// ------------------------------------------------------------------ column helpers

export interface Col {
  name: string;
  type: VgiDataType;
  /** DuckDB spelling for vgi.result_columns_schema. */
  sqlType: string;
  doc: string;
  nullable?: boolean;
  get: (row: Row) => unknown;
}

// biome-ignore lint/suspicious/noExplicitAny: Vercel JSON is untyped.
export type Row = Record<string, any> & { __ctx?: Record<string, string> };

/** Walk a dotted path through untyped JSON. */
export function at(row: unknown, path: string): unknown {
  let cur: unknown = row;
  for (const p of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

export const asStr = (v: unknown): string | null =>
  v == null ? null : typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);
export const asBool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
export const asInt = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null;
export const asBigInt = (v: unknown): bigint | null =>
  typeof v === "number" && Number.isFinite(v) ? BigInt(Math.trunc(v)) : null;
export const asNum = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
/** Vercel timestamps are epoch milliseconds (numbers) or ISO 8601 strings → TIMESTAMPTZ µs. */
export function asTime(v: unknown): bigint | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return BigInt(Math.trunc(v)) * 1000n;
  if (typeof v !== "string" || v === "") return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : BigInt(ms) * 1000n;
}
/** Epoch ms of a Vercel timestamp value, or undefined. */
export function msOf(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  if (typeof v === "string" && v !== "") {
    const ms = Date.parse(v);
    return Number.isNaN(ms) ? undefined : ms;
  }
  return undefined;
}
export const asStrList = (v: unknown): string[] | null =>
  Array.isArray(v) ? v.filter((x) => x != null).map((x) => (typeof x === "string" ? x : JSON.stringify(x))) : null;
export const asJson = (v: unknown): string | null => (v == null ? null : JSON.stringify(v));

const JSON_META: [string, string] = ["ARROW:extension:name", "arrow.json"];

type Getter = string | ((r: Row) => unknown);
const read = (r: Row, g: Getter) => (typeof g === "string" ? at(r, g) : g(r));

function mkCol(
  name: string,
  type: VgiDataType,
  sqlType: string,
  doc: string,
  get: (r: Row) => unknown,
  nullable = true,
): Col {
  return { name, type, sqlType, doc, get, nullable };
}

/** A typed field of a STRUCT column. */
export interface StructField {
  name: string;
  kind: "str" | "bool" | "int";
  get: Getter;
}

export const C = {
  str: (name: string, doc: string, g: Getter, nullable = true) =>
    mkCol(name, utf8(), "VARCHAR", doc, (r) => asStr(read(r, g)), nullable),
  /** A constant column, e.g. platform = 'vercel'. */
  constant: (name: string, doc: string, value: string) => mkCol(name, utf8(), "VARCHAR", doc, () => value, false),
  time: (name: string, doc: string, g: Getter) =>
    mkCol(name, timestampMicros("UTC"), "TIMESTAMP WITH TIME ZONE", doc, (r) => asTime(read(r, g))),
  bool: (name: string, doc: string, g: Getter) => mkCol(name, bool, "BOOLEAN", doc, (r) => asBool(read(r, g))),
  int: (name: string, doc: string, g: Getter) => mkCol(name, int32, "INTEGER", doc, (r) => asInt(read(r, g))),
  bigint: (name: string, doc: string, g: Getter) => mkCol(name, int64(), "BIGINT", doc, (r) => asBigInt(read(r, g))),
  num: (name: string, doc: string, g: Getter) => mkCol(name, float64(), "DOUBLE", doc, (r) => asNum(read(r, g))),
  strList: (name: string, doc: string, g: Getter) =>
    mkCol(name, list(utf8()), "VARCHAR[]", doc, (r) => asStrList(read(r, g))),
  json: (name: string, doc: string, g: Getter) => mkCol(name, utf8(), "JSON", doc, (r) => asJson(read(r, g))),
  ctx: (name: string, doc: string, key: string, nullable = false) =>
    mkCol(name, utf8(), "VARCHAR", doc, (r) => r.__ctx?.[key] ?? null, nullable),
  structList: (name: string, doc: string, fields: StructField[], g: Getter) => {
    const arrow = (k: StructField["kind"]) => (k === "bool" ? bool : k === "int" ? int32 : utf8());
    const sql = (k: StructField["kind"]) => (k === "bool" ? "BOOLEAN" : k === "int" ? "INTEGER" : "VARCHAR");
    const conv = (k: StructField["kind"], v: unknown) => (k === "bool" ? asBool(v) : k === "int" ? asInt(v) : asStr(v));
    return mkCol(
      name,
      list(struct(fields.map((f) => field(f.name, arrow(f.kind))) as never)),
      `STRUCT(${fields.map((f) => `${f.name} ${sql(f.kind)}`).join(", ")})[]`,
      doc,
      (r) => {
        const v = read(r, g);
        if (!Array.isArray(v)) return null;
        return v.map((item) => Object.fromEntries(fields.map((f) => [f.name, conv(f.kind, read(item, f.get))])));
      },
    );
  },
};

// --------------------------------------------------------------------- the factory

/** The first request of one phase of a scan. */
export interface PageRequest {
  path: string;
  query?: Record<string, string | undefined>;
  /** Per-phase values exposed to columns through `C.ctx` (e.g. the project id). */
  ctx?: Record<string, string>;
}

export interface ScanContext<A> {
  args: A;
  constraints: Constraint[];
  /** Wall-clock anchor fixed when the scan started (epoch ms), stable across resumes. */
  anchorMs: number;
  /** The team named in the secret (never the token). */
  team: { teamId?: string; teamSlug?: string };
}

export interface FnExample {
  sql: string;
  description: string;
}

/** What to request after a page: a query patch, plus row ids already emitted at the boundary. */
export interface NextPage {
  patch: Record<string, string>;
  skip?: string[];
}

export interface VercelTableSpec<A> {
  name: string;
  description: string;
  title: string;
  category: Category;
  keywords: string;
  docLlm: string;
  docMd: string;
  /** Catalog schema the table lives in (catalog tables only; default main). */
  schemaName?: string;
  args?: Record<string, VgiDataType>;
  argDocs?: Record<string, string>;
  argDefaults?: Record<string, unknown>;
  argConstraints?: Record<string, Record<string, unknown>>;
  columns: Col[];
  /** Columns that are a primary key (catalog tables). */
  primaryKey?: string[];
  /** Add the secret's teamId / slug to every request (default true). */
  teamScoped?: boolean;
  /** Pull the rows out of a response body. */
  rows: (body: unknown) => Row[];
  /** One request per phase (unused with `fanout`). */
  requests?: (ctx: ScanContext<A>) => PageRequest[];
  /** The next page after `rows` (default: Vercel's `pagination.next` → `until=`). */
  nextPage?: (body: unknown, rows: Row[], req: PageRequest, scan: ScanContext<A>) => NextPage | null;
  /** Row identity, used to drop rows already emitted on the previous page (`NextPage.skip`). */
  rowId?: (row: Row) => string;
  /**
   * Per-parent endpoints (env vars of a project, records of a domain …). A pushed
   * `= / IN` filter on one of `keys` (or the `arg` named argument) selects just those
   * parents, each resolved with `lookup`; otherwise every parent from `parents` is
   * listed (paged) and each one's children are read in turn.
   */
  fanout?: {
    keys: string[];
    arg?: string;
    parents: PageRequest;
    parentRows: (body: unknown) => Row[];
    lookup: (idOrName: string) => PageRequest;
    lookupRow: (body: unknown) => Row | null;
    parentCtx: (row: Row) => Record<string, string> | null;
    child: (parent: Record<string, string>, scan: ScanContext<A>) => PageRequest;
  };
  /** A 404 (or plan-gated 403 when `forbiddenEmpty`) means "nothing here" → zero rows. */
  notFoundEmpty?: boolean;
  forbiddenEmpty?: boolean;
  /** Text appended to doc_md describing what pushes down. */
  pushdown?: string;
  examples: FnExample[];
}

interface ScanState {
  phase: number;
  /** JSON query patch for the next page of the current phase / child; "" = first page. */
  cursor: string;
  /** JSON array of row ids already emitted at the page boundary. */
  skip: string;
  anchorMs: number;
  /** Fan-out: JSON array of pending parent contexts (the head is being read). */
  queue: string;
  /** Fan-out: next-page patch of the parent listing ("" = first page). */
  parentCursor: string;
  parentDone: boolean;
}

/** Vercel's standard paging: `pagination.next` is a timestamp to pass back as `until`. */
export function untilPaging(body: unknown): NextPage | null {
  const p = (body as { pagination?: { next?: unknown; hasNext?: unknown } } | null)?.pagination;
  if (!p || p.hasNext === false) return null;
  return typeof p.next === "number" ? { patch: { until: String(p.next) } } : null;
}

/** The Arrow output schema of a spec (column comments ride along as field metadata). */
function outputSchemaOf<A>(spec: VercelTableSpec<A>) {
  return schema(
    spec.columns.map((c) =>
      c.sqlType === "JSON"
        ? field(c.name, c.type, c.nullable ?? true, new Map([["comment", c.doc], JSON_META]))
        : column(c.name, c.type, c.doc, c.nullable ?? true),
    ),
  );
}

/** Discovery tags shared by a spec's function or table. */
function tagsOf<A>(spec: VercelTableSpec<A>): Record<string, string> {
  return {
    domain: "devops",
    ...objectTags({
      title: spec.title,
      category: spec.category,
      keywords: spec.keywords,
      docLlm: spec.docLlm,
      docMd: spec.docMd + (spec.pushdown ? `\n\n**Pushdown:** ${spec.pushdown}` : ""),
    }),
    "vgi.result_columns_schema": JSON.stringify(
      spec.columns.map((c) => ({ name: c.name, type: c.sqlType, description: c.doc })),
    ),
  };
}

/**
 * A spec with no arguments exposed as a catalog table (`SELECT … FROM vercel.main.deployments`).
 * The scan function keeps every capability (pushdown, paging, secrets) and is table-only.
 */
export function defineVercelCatalogTable(spec: VercelTableSpec<Record<string, never>>): TableDescriptor {
  const fn = defineVercelTable({ ...spec, name: `${spec.name}_scan` });
  const schemaPath = [spec.schemaName ?? "main"];
  const records = spec.columns
    .filter((c) => c.nullable === false)
    .map((c) =>
      constraintRecord({
        schemaPath,
        table: spec.name,
        id: `${c.name}_not_null`,
        kind: "NOT_NULL",
        columns: [[c.name]],
        enforcement: "ENFORCED",
        validation: "ALL_ROWS",
      }),
    );
  if (spec.primaryKey) {
    records.push(
      constraintRecord({
        schemaPath,
        table: spec.name,
        id: "pk",
        kind: "PRIMARY_KEY",
        columns: spec.primaryKey.map((c) => [c]),
        enforcement: "ENFORCED",
        validation: "ALL_ROWS",
      }),
    );
  }
  return {
    name: spec.name,
    comment: spec.description,
    columns: outputSchemaOf(spec),
    function: fn,
    constraints: records,
    tags: { ...tagsOf(spec), "vgi.example_queries": JSON.stringify(spec.examples) },
  };
}

const parse = <T>(s: string, dflt: T): T => (s ? (JSON.parse(s) as T) : dflt);

export function defineVercelTable<A extends Record<string, unknown>>(spec: VercelTableSpec<A>): VgiFunction {
  const outSchema = outputSchemaOf(spec);
  const nextOf = spec.nextPage ?? ((body: unknown) => untilPaging(body));

  return defineTableFunction<A, ScanState>({
    name: spec.name,
    description: spec.description,
    args: spec.args ?? {},
    argDocs: spec.argDocs,
    argDefaults: spec.argDefaults,
    argConstraints: spec.argConstraints as never,
    filterPushdown: true,
    // DuckDB drops pushed predicates from its plan; the SDK re-applies them exactly,
    // so translating a predicate only ever narrows what Vercel returns.
    autoApplyFilters: true,
    onBind: (params) =>
      params.resolvedSecretsProvided
        ? { outputSchema: outSchema }
        : { outputSchema: outSchema, lookupSecretTypes: [SECRET_TYPE] },
    initialState: () => ({
      phase: 0,
      cursor: "",
      skip: "",
      anchorMs: Date.now(),
      queue: "",
      parentCursor: "",
      parentDone: false,
    }),
    process: async (params, state, out) => {
      const cfg = configFromSecrets(params.secrets);
      const scan: ScanContext<A> = {
        args: params.args,
        constraints: constraintsOf(params.pushdownFilters),
        anchorMs: state.anchorMs,
        team: { teamId: cfg.teamId, teamSlug: cfg.teamSlug },
      };
      log.debug(`${spec.name}: pushed filters ${formatPushedFilters(params.pushdownFilters)}`);
      const team = spec.teamScoped === false ? {} : teamQuery(cfg);

      const get = async (req: PageRequest, patch: Record<string, string> = {}): Promise<unknown | null> => {
        try {
          return await vercelGet(cfg, req.path, { ...req.query, ...team, ...patch });
        } catch (err) {
          if (err instanceof VercelError) {
            if (spec.notFoundEmpty && err.status === 404) return null;
            if (spec.forbiddenEmpty && err.status === 403) return null;
          }
          throw err;
        }
      };

      /** Read one page of `req` at the current cursor; advance; emit. True when rows went out. */
      const page = async (req: PageRequest, onDone: () => void): Promise<boolean> => {
        const before = state.cursor;
        const body = await get(req, parse(state.cursor, {}));
        const all = body == null ? [] : spec.rows(body);
        const skip = new Set(parse<string[]>(state.skip, []));
        const rows = spec.rowId && skip.size ? all.filter((r) => !skip.has(spec.rowId?.(r) ?? "")) : all;
        const next = body == null || all.length === 0 ? null : nextOf(body, all, req, scan);
        const nextCursor = next ? JSON.stringify(next.patch) : "";
        if (next && nextCursor !== before) {
          state.cursor = nextCursor;
          state.skip = next.skip?.length ? JSON.stringify(next.skip) : "";
        } else {
          state.cursor = "";
          state.skip = "";
          onDone();
        }
        return emit(rows, req.ctx ?? {});
      };

      const emit = (rows: Row[], ctx: Record<string, string>): boolean => {
        if (rows.length === 0) return false;
        const tagged = rows.map((r) => ({ ...r, __ctx: ctx }));
        const cols: Record<string, unknown[]> = {};
        for (const f of params.outputSchema.fields) {
          const c = spec.columns.find((x) => x.name === f.name);
          cols[f.name] = c ? tagged.map((r) => c.get(r)) : tagged.map(() => null);
        }
        out.emit(batchFromColumns(cols, params.outputSchema));
        return true;
      };

      const fan = spec.fanout;
      // Loop until a page yields rows or the scan ends, so no empty batches go out.
      for (;;) {
        if (fan) {
          let queue = parse<Record<string, string>[]>(state.queue, []);
          if (queue.length === 0) {
            if (state.parentDone) {
              out.finish();
              return;
            }
            queue = await refillParents(cfg, fan, scan, state, get);
            state.queue = JSON.stringify(queue);
            continue;
          }
          const head = queue[0] as Record<string, string>;
          const req = fan.child(head, scan);
          const emitted = await page({ ...req, ctx: { ...head, ...req.ctx } }, () => {
            state.queue = JSON.stringify(queue.slice(1));
          });
          if (emitted) return;
          continue;
        }
        const phases = spec.requests?.(scan) ?? [];
        const phase = phases[state.phase];
        if (!phase) {
          out.finish();
          return;
        }
        if (
          await page(phase, () => {
            state.phase += 1;
          })
        )
          return;
      }
    },
    tags: tagsOf(spec),
    examples: spec.examples,
  });
}

/** Fill the fan-out queue: explicit parents (resolved once) or the next page of the listing. */
async function refillParents<A extends Record<string, unknown>>(
  _cfg: VercelConfig,
  fan: NonNullable<VercelTableSpec<A>["fanout"]>,
  scan: ScanContext<A>,
  state: ScanState,
  get: (req: PageRequest, patch?: Record<string, string>) => Promise<unknown | null>,
): Promise<Record<string, string>[]> {
  const argVal = fan.arg ? scan.args[fan.arg] : undefined;
  let explicit: string[] | undefined = typeof argVal === "string" && argVal ? [argVal] : undefined;
  for (const k of fan.keys) {
    if (explicit) break;
    explicit = eqValues(scan.constraints, k);
  }
  if (explicit) {
    state.parentDone = true;
    const out: Record<string, string>[] = [];
    for (const id of explicit) {
      let body: unknown | null;
      try {
        body = await get(fan.lookup(id));
      } catch (err) {
        if (err instanceof VercelError && err.status === 404) continue;
        throw err;
      }
      const row = body == null ? null : fan.lookupRow(body);
      const ctx = row ? fan.parentCtx(row) : null;
      if (ctx) out.push(ctx);
    }
    return out;
  }
  const body = await get(fan.parents, parse(state.parentCursor, {}));
  const rows = body == null ? [] : fan.parentRows(body);
  const next = body == null || rows.length === 0 ? null : untilPaging(body);
  const nextCursor = next ? JSON.stringify(next.patch) : "";
  if (next && nextCursor !== state.parentCursor) state.parentCursor = nextCursor;
  else state.parentDone = true;
  return rows.map(fan.parentCtx).filter((x): x is Record<string, string> => x != null);
}
