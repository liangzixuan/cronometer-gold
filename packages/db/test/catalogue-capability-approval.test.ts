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
  type CatalogueApprovalRole,
  type SubmitCatalogueApprovalInput,
  submitCatalogueApproval,
} from "../src/catalogue-capability-approval.js";
import type { Database } from "../src/types.js";

const INPUT: SubmitCatalogueApprovalInput = {
  batchId: "12345678-1234-4234-8234-123456789abc",
  approvalRole: "data",
  rightsManifestSha256: "a".repeat(64),
  validationDigest: "b".repeat(64),
  principalId: "review_data_fixture",
  approvalReference: "urn:test:review:decision-1",
};
const PRINCIPAL = {
  databasePrincipal: INPUT.principalId,
  effectivePrincipal: INPUT.principalId,
  canLogin: true,
  privileged: false,
  ownerMember: false,
  capabilities: ["nutrition_catalogue_approve_data"],
};
function fixture(responses: unknown[]) {
  const queries: CompiledQuery[] = [];
  class Driver extends DummyDriver {
    override async acquireConnection(): Promise<DatabaseConnection> {
      return {
        async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
          queries.push(query);
          if (responses.length === 0) throw new Error("Unexpected database call");
          let value = responses.shift();
          if (typeof value === "function") value = await value();
          if (value instanceof Error) throw value;
          return { rows: (value === undefined ? [] : [{ result: value }]) as R[] };
        },
        streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
          throw new Error("No stream");
        },
      };
    }
  }
  const database = new Kysely<Database>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new Driver(),
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { database, queries };
}

describe("restricted catalogue reviewer consumer", () => {
  it.each(["data", "quality", "rights"] as CatalogueApprovalRole[])(
    "submits only the explicit %s decision with parameterized public authority",
    async (approvalRole) => {
      const f = fixture([
        { ...PRINCIPAL, capabilities: [`nutrition_catalogue_approve_${approvalRole}`] },
        true,
      ]);
      await expect(
        submitCatalogueApproval(f.database, { ...INPUT, approvalRole }),
      ).resolves.toEqual({ approvalRole, wasAlreadyApproved: false });
      expect(f.queries).toHaveLength(2);
      expect(f.queries[0]?.sql).toContain("'public.food_import_batch'::pg_catalog.regclass");
      expect(f.queries[1]?.sql).toContain("public.catalogue_record_import_approval(");
      expect(f.queries[1]?.parameters).toEqual([
        INPUT.batchId,
        approvalRole,
        INPUT.validationDigest,
        INPUT.rightsManifestSha256,
        INPUT.principalId,
        INPUT.approvalReference,
      ]);
      expect(f.queries.map((query) => query.sql).join("\n")).not.toMatch(
        /for update|from food_import|insert into|set role|catalogue_promote/iu,
      );
    },
  );
  it("reports exact SQL replay separately from a new approval", async () => {
    const f = fixture([PRINCIPAL, false]);
    await expect(submitCatalogueApproval(f.database, INPUT)).resolves.toEqual({
      approvalRole: "data",
      wasAlreadyApproved: true,
    });
  });
  it("does not retry an uncertain receipt automatically and preserves exact parameters for explicit replay", async () => {
    const f = fixture([PRINCIPAL, new Error("lost response"), PRINCIPAL, false]);
    await expect(submitCatalogueApproval(f.database, INPUT)).rejects.toThrow("lost response");
    expect(f.queries).toHaveLength(2);
    await expect(submitCatalogueApproval(f.database, INPUT)).resolves.toMatchObject({
      wasAlreadyApproved: true,
    });
    expect(f.queries[1]?.parameters).toEqual(f.queries[3]?.parameters);
  });
  it("keeps the reviewed inputs when the caller changes its object during authority discovery", async () => {
    const input = { ...INPUT };
    const f = fixture([
      () => {
        input.validationDigest = "c".repeat(64);
        input.approvalReference = "changed";
        return PRINCIPAL;
      },
      true,
    ]);
    await submitCatalogueApproval(f.database, input);
    expect(f.queries[1]?.parameters).toEqual([
      INPUT.batchId,
      INPUT.approvalRole,
      INPUT.validationDigest,
      INPUT.rightsManifestSha256,
      INPUT.principalId,
      INPUT.approvalReference,
    ]);
  });
  it.each([
    { batchId: "12345678-1234-4234-8234-123456789ABC" },
    { batchId: "bad" },
    { approvalRole: "owner" },
    { rightsManifestSha256: "A".repeat(64) },
    { validationDigest: "bad" },
    { principalId: "Other" },
    { principalId: "x".repeat(64) },
    { approvalReference: "" },
    { approvalReference: " white " },
    { approvalReference: "line\nbreak" },
    { approvalReference: "nul\u0000byte" },
    { approvalReference: "a".repeat(2049) },
    { approvalReference: "é".repeat(1025) },
    { unexpected: true },
  ])("rejects malformed explicit inputs before opening authority reads: %o", async (patch) => {
    const f = fixture([]);
    await expect(
      submitCatalogueApproval(f.database, { ...INPUT, ...patch } as SubmitCatalogueApprovalInput),
    ).rejects.toThrow();
    expect(f.queries).toHaveLength(0);
  });
  it.each([
    { databasePrincipal: "someone_else" },
    { effectivePrincipal: "set_role" },
    { canLogin: false },
    { privileged: true },
    { ownerMember: true },
    { capabilities: [] },
    { capabilities: ["nutrition_catalogue_approve_quality"] },
    { capabilities: ["nutrition_catalogue_approve_data", "nutrition_catalogue_stage"] },
    { capabilities: ["nutrition_catalogue_approve_data", "nutrition_catalogue_approve_rights"] },
    { unexpected: true },
    { ownerMember: null },
  ])("rejects unsafe or mismatched authority before submission: %o", async (patch) => {
    const f = fixture([{ ...PRINCIPAL, ...patch }]);
    await expect(submitCatalogueApproval(f.database, INPUT)).rejects.toThrow();
    expect(f.queries).toHaveLength(1);
  });
  it.each([undefined, null, {}, [], true])(
    "rejects malformed principal response %o",
    async (response) => {
      const f = fixture([response]);
      await expect(submitCatalogueApproval(f.database, INPUT)).rejects.toThrow();
      expect(f.queries).toHaveLength(1);
    },
  );
  it.each([undefined, null, {}, "true", 1])(
    "does not claim success from malformed approval receipt %o",
    async (response) => {
      const f = fixture([PRINCIPAL, response]);
      await expect(submitCatalogueApproval(f.database, INPUT)).rejects.toThrow(
        "retain the exact request",
      );
      expect(f.queries).toHaveLength(2);
    },
  );
  it("preserves the SQL divergent-replay rejection", async () => {
    const f = fixture([PRINCIPAL, new Error("different immutable approval")]);
    await expect(submitCatalogueApproval(f.database, INPUT)).rejects.toThrow(
      "different immutable approval",
    );
    expect(f.queries).toHaveLength(2);
  });
});
