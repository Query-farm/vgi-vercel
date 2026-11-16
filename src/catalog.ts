/**
 * Assemble the `vercel` catalog: schema `main` (the Vercel tables and table functions),
 * schema `unified` (deployments as cross-orchestrator runs) and the `vercel` secret type.
 */

import { type CatalogDescriptor, field, schema, utf8, type VgiFunction } from "@query-farm/vgi";
import {
  CATALOG_COMMENT,
  CATALOG_NAME,
  CATALOG_TAGS,
  SCHEMA_COMMENT,
  SCHEMA_TAGS,
  SOURCE_URL,
  UNIFIED_COMMENT,
  UNIFIED_TAGS,
} from "./meta.ts";
import { SECRET_TYPE } from "./vercel/client.ts";
import { FUNCTIONS, MAIN_TABLES, UNIFIED_TABLES } from "./vercel/resources.ts";

export { FUNCTIONS };

const doc = (text: string) => new Map([["vgi_doc", text]]);

/** CREATE SECRET (TYPE vercel, TOKEN '…' [, TEAM_ID 'team_…' | TEAM_SLUG '…'] [, BASE_URL '…']). */
export const VERCEL_SECRET_TYPE = {
  name: SECRET_TYPE,
  description: "Vercel access token, optionally scoped to a team",
  schema: schema(
    [
      field(
        "token",
        utf8(),
        true,
        new Map([
          ["redact", "true"],
          ["vgi_doc", "Vercel access token (Account Settings > Tokens). Read-only use; sent as a Bearer token."],
        ]),
      ),
      field("team_id", utf8(), true, doc("Team id (team_…) to read instead of the personal account; adds teamId=.")),
      field("team_slug", utf8(), true, doc("Team slug, as an alternative to TEAM_ID; adds slug=.")),
      field(
        "base_url",
        utf8(),
        true,
        doc("API base URL (default https://api.vercel.com); http:// is accepted only for 127.0.0.1/localhost."),
      ),
    ],
    new Map([["vgi_doc_url", "https://vercel.com/docs/rest-api#authentication"]]),
  ),
};

interface Example {
  description: string;
  sql: string;
}

/** Publish each function's examples as `vgi.example_queries`; return them all for the schema. */
function stampExampleQueries(functions: VgiFunction[]): Example[] {
  const all: Example[] = [];
  for (const fn of functions) {
    const ex = (fn.meta.examples ?? []).map((e) => ({ description: e.description, sql: e.sql }));
    fn.meta.tags = { ...fn.meta.tags, "vgi.example_queries": JSON.stringify(ex) };
    all.push(...ex);
  }
  return all;
}

const tableExamples = (tables: { tags?: Record<string, string> }[]) =>
  tables.flatMap((t) => JSON.parse(t.tags?.["vgi.example_queries"] ?? "[]") as Example[]);

const MAIN_EXAMPLES = [...stampExampleQueries(FUNCTIONS), ...tableExamples(MAIN_TABLES)];

export const CATALOG: CatalogDescriptor = {
  name: CATALOG_NAME,
  comment: CATALOG_COMMENT,
  sourceUrl: SOURCE_URL,
  tags: CATALOG_TAGS,
  secretTypes: [VERCEL_SECRET_TYPE],
  schemas: [
    {
      path: ["main"],
      comment: SCHEMA_COMMENT,
      functions: FUNCTIONS,
      tables: MAIN_TABLES,
      tags: { ...SCHEMA_TAGS, "vgi.example_queries": JSON.stringify(MAIN_EXAMPLES.slice(0, 12)) },
    },
    {
      path: ["unified"],
      comment: UNIFIED_COMMENT,
      functions: [],
      tables: UNIFIED_TABLES,
      tags: { ...UNIFIED_TAGS, "vgi.example_queries": JSON.stringify(tableExamples(UNIFIED_TABLES)) },
    },
  ],
};
