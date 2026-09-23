import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  type CompiledQuery,
  type DatabaseConnection,
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type QueryResult,
} from "kysely";
import { describe, expect, it } from "vitest";
import {
  previewBatchValidation,
  reconcileCatalogueBatch,
  stageBatchRecords,
  validateBatch,
} from "../src/catalogue-ingestion.js";
import type { Database } from "../src/types.js";

const directory = fileURLToPath(new URL("../migrations/", import.meta.url));
const fence = readFileSync(
  new URL("../migrations/0030_catalogue_paged_legacy_fences.sql", import.meta.url),
  "utf8",
);
function historicalBodies() {
  const bodies = new Map<string, string>();
  for (const name of readdirSync(directory)
    .filter((name) => /^\d{4}_.*\.sql$/u.test(name) && name < "0027")
    .sort()) {
    const source = readFileSync(directory + "/" + name, "utf8");
    const events = [
      ...[
        ...source.matchAll(
          /^create(?: or replace)? function\s+(\w+)\s*\([\s\S]*?\)\s*returns[\s\S]*?\bas\s+\$\$([\s\S]*?)\$\$;/gmu,
        ),
      ].map((match) => ({
        index: match.index,
        name: match[1] as string,
        body: match[2] as string,
        rename: null as string | null,
      })),
      ...[...source.matchAll(/^alter function\s+(\w+)\s*\([^;]*?\)\s+rename to\s+(\w+);/gmu)].map(
        (match) => ({
          index: match.index,
          name: match[1] as string,
          body: "",
          rename: match[2] as string,
        }),
      ),
    ].sort((a, b) => a.index - b.index);
    for (const event of events) {
      if (event.rename) {
        const body = bodies.get(event.name);
        if (body !== undefined) {
          bodies.set(event.rename, body);
          bodies.delete(event.name);
        }
      } else bodies.set(event.name, event.body);
    }
  }
  return bodies;
}
const entries = [...fence.matchAll(/\('([^']+\([^']*\))','([0-9a-f]{64})',E'([^']+)'\)/gu)].map(
  (match) => ({
    identity: match[1] as string,
    sha256: match[2] as string,
    prelude: (match[3] as string).replaceAll("\\n", "\n"),
  }),
);
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
function fixture() {
  const queries: CompiledQuery[] = [];
  class Driver extends DummyDriver {
    override async acquireConnection(): Promise<DatabaseConnection> {
      return {
        async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
          queries.push(query);
          if (query.sql.includes("catalogue_reject_legacy_batch_v2"))
            throw new Error("V2 preparation requires its versioned consumer");
          throw new Error("Unexpected query before V2 legacy guard");
        },
        streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
          throw new Error("No stream");
        },
      };
    }
  }
  return {
    queries,
    database: new Kysely<Database>({
      dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => new Driver(),
        createIntrospector: (db) => new PostgresIntrospector(db),
        createQueryCompiler: () => new PostgresQueryCompiler(),
      },
    }),
  };
}
describe("V2 legacy consumer fences", () => {
  it("pins every existing target body and inserts only an entry prelude", () => {
    const bodies = historicalBodies();
    expect(entries).toHaveLength(15);
    for (const entry of entries) {
      const name = entry.identity.slice(0, entry.identity.indexOf("("));
      const source = bodies.get(name);
      expect(source, name).toBeDefined();
      if (source === undefined) throw new Error("Missing historical body");
      expect(sha(source), entry.identity).toBe(entry.sha256);
      const location = source.indexOf("\nbegin\n") + 7;
      expect(location, entry.identity).toBeGreaterThan(6);
      const changed = source.slice(0, location) + entry.prelude + source.slice(location);
      expect(changed.replace(entry.prelude, ""), entry.identity).toBe(source);
      expect(entry.prelude, entry.identity).toMatch(
        /^ {2}perform catalogue_reject_legacy_\w+\(p_\w+\);\n$/u,
      );
    }
  });
  it("covers public wrappers, owner aliases, seals and semantic helpers without changing V1 identifiers", () => {
    const names = entries.map((entry) => entry.identity.split("(")[0]);
    for (const name of [
      "catalogue_stage_import_batch",
      "catalogue_stage_import_record_chunk",
      "catalogue_stage_import_parser_report",
      "catalogue_compute_import_staging_seal",
      "catalogue_observe_import_validation",
      "catalogue_validate_import_batch",
      "catalogue_validate_import_batch_v1",
      "catalogue_attest_import_nutrition_semantics",
      "catalogue_compute_record_nutrition_semantics",
      "catalogue_record_import_approval",
      "catalogue_record_import_approval_v1",
      "catalogue_promote_import_batch",
      "catalogue_promote_import_batch_v1",
      "catalogue_rollback_source_release",
      "catalogue_rollback_source_release_v1",
    ])
      expect(names).toContain(name);
    expect(fence).not.toContain("rename to");
    expect(fence).toContain("revoke all on function");
  });
  it.each(["preview", "validate", "stage-records", "reconcile"] as const)(
    "sends the owner %s fence before reading any complete record array",
    async (operation) => {
      const f = fixture();
      const batchId = "12345678-1234-4234-8234-123456789abc";
      const result =
        operation === "preview"
          ? previewBatchValidation(f.database, batchId)
          : operation === "validate"
            ? validateBatch(f.database, batchId)
            : operation === "stage-records"
              ? stageBatchRecords(f.database, batchId, [])
              : reconcileCatalogueBatch(f.database, {
                  batchId,
                  expectedCurrentReleaseId: null,
                  expectedValidationDigest: "a".repeat(64),
                });
      await expect(result).rejects.toThrow("V2 preparation requires its versioned consumer");
      expect(f.queries).toHaveLength(1);
      expect(f.queries[0]?.sql).toContain("catalogue_reject_legacy_batch_v2");
      expect(f.queries[0]?.sql).not.toContain('from "food_import_record"');
    },
  );
});
