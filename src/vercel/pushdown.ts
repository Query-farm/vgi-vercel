/**
 * Turn DuckDB's pushed-down WHERE predicates into Vercel query parameters.
 *
 * Every scan sets `autoApplyFilters: true`, so the SDK re-applies each pushed
 * predicate to every batch exactly. Translation therefore only has to NARROW the
 * upstream request without ever dropping a matching row: anything we cannot express
 * is simply not sent. Only top-level conjuncts are translated (a predicate under
 * OR / NOT is left to the SDK), so a generated parameter is always implied by the SQL.
 */

import type { PushdownFilters } from "@query-farm/vgi";

type Expr = PushdownFilters["filters"][number];

/** One translatable constraint on a column. */
export type Constraint =
  | { kind: "cmp"; column: string; op: "eq" | "gt" | "ge" | "lt" | "le"; value: unknown }
  | { kind: "in"; column: string; values: unknown[] };

const FLIP: Record<string, "eq" | "gt" | "ge" | "lt" | "le"> = { eq: "eq", gt: "lt", ge: "le", lt: "gt", le: "ge" };

function unwrap(e: Expr): Expr {
  return e.node === "cast" ? unwrap(e.expression) : e;
}

function one(e: Expr, out: Constraint[]): void {
  if (e.node === "column_ref") {
    out.push({ kind: "cmp", column: e.columnName, op: "eq", value: true });
    return;
  }
  if (e.node === "and") {
    for (const c of e.children) one(c, out);
    return;
  }
  if (e.node === "comparison" && e.op in FLIP) {
    const [l, r] = [unwrap(e.left), unwrap(e.right)];
    if (l.node === "column_ref" && r.node === "literal" && r.value != null) {
      out.push({ kind: "cmp", column: l.columnName, op: e.op as "eq", value: r.value });
    } else if (r.node === "column_ref" && l.node === "literal" && l.value != null) {
      out.push({ kind: "cmp", column: r.columnName, op: FLIP[e.op] ?? "eq", value: l.value });
    }
    return;
  }
  if (e.node === "in" && !e.negated && e.set.kind === "literal") {
    const col = unwrap(e.expression);
    const values = e.set.values.filter((v) => v != null);
    if (col.node === "column_ref" && values.length > 0 && values.length === e.set.values.length) {
      out.push({ kind: "in", column: col.columnName, values });
    }
  }
}

/** The top-level, translatable constraints of a scan's pushed filters. */
export function constraintsOf(filters: PushdownFilters | undefined): Constraint[] {
  const out: Constraint[] = [];
  for (const f of filters?.filters ?? []) one(f, out);
  return out;
}

/** A pushed literal for a TIMESTAMPTZ column as epoch milliseconds (µs bigint, ms number, Date, ISO). */
export function toEpochMs(v: unknown): number | undefined {
  if (typeof v === "bigint") return Number(v / 1000n);
  if (typeof v === "number") return v;
  if (v instanceof Date) return v.getTime();
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? undefined : t;
  }
  return undefined;
}

/**
 * The tightest bounds the constraints put on a time column, widened by 1 ms on each
 * side so it does not matter whether Vercel treats `since` / `until` as inclusive.
 */
export function timeBounds(constraints: Constraint[], column: string): { since?: number; until?: number } {
  let since: number | undefined;
  let until: number | undefined;
  for (const c of constraints) {
    if (c.column !== column || c.kind !== "cmp") continue;
    const ms = toEpochMs(c.value);
    if (ms === undefined) continue;
    if (c.op === "gt" || c.op === "ge" || c.op === "eq") {
      const lo = Math.floor(ms) - 1;
      since = since === undefined ? lo : Math.max(since, lo);
    }
    if (c.op === "lt" || c.op === "le" || c.op === "eq") {
      const hi = Math.ceil(ms) + 1;
      until = until === undefined ? hi : Math.min(until, hi);
    }
  }
  return { since, until };
}

/** Equality / IN values pushed for a column (as strings), or undefined if unconstrained. */
export function eqValues(constraints: Constraint[], column: string): string[] | undefined {
  let set: string[] | undefined;
  for (const c of constraints) {
    if (c.column !== column) continue;
    let vs: string[] | undefined;
    if (c.kind === "cmp" && c.op === "eq" && typeof c.value === "string") vs = [c.value];
    else if (c.kind === "in" && c.values.every((v) => typeof v === "string")) vs = c.values as string[];
    if (!vs) continue;
    set = set ? set.filter((v) => vs.includes(v)) : [...new Set(vs)];
  }
  return set;
}

/** The single pushed equality value of a column, if exactly one is implied. */
export function eqValue(constraints: Constraint[], column: string): string | undefined {
  const vs = eqValues(constraints, column);
  return vs && vs.length === 1 ? vs[0] : undefined;
}
