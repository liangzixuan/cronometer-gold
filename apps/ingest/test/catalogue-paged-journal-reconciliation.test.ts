import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalJson,
  catalogueFramedSha256V2 as frame,
  reconcileCataloguePagedBatch,
} from "@nutrition-tracker/db";
import { afterEach, describe, expect, it } from "vitest";
import type { Database, JsonValue } from "../../../packages/db/src/types.js";
import {
  type CompiledQuery,
  type DatabaseConnection,
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type QueryResult,
} from "../../../packages/db/test/catalogue-paged-test-runtime.js";
import {
  acknowledgeCatalogueValidationPageV2,
  type CatalogueJournalPinV2,
  createCatalogueValidationJournalV2,
  finishCatalogueValidationJournalV2,
  readCatalogueValidationJournalV2,
  retainCatalogueValidationRequestV2,
} from "../src/catalogue-paged-journal.js";

const BATCH = "12345678-1234-8234-8234-123456789abc";
const HASH = "a".repeat(64);
const TERMINAL = "c".repeat(64);
const PRINCIPAL = "paged_validator_fixture";
const REQUEST = '{"retained":"é é 𐐀 exact bytes"}';
const roots: string[] = [];
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: false });
});

async function retainedJournal() {
  const root = await mkdtemp(join(tmpdir(), "journal-reconciliation-"));
  roots.push(root);
  const binding = {
    batchId: BATCH,
    validatorDatabasePrincipal: PRINCIPAL,
    stagingSealSha256: HASH,
    contextSha256: HASH,
    admissionSha256: HASH,
  };
  const requestSha256 = sha(REQUEST);
  const validationCommitmentSha256 = frame("validation-page", [
    frame("validation-start", [BATCH, HASH]),
    HASH,
    "0",
    "0",
    "1",
    HASH,
    requestSha256,
  ]);
  const receiptSha256 = frame("validation-page-receipt", [
    BATCH,
    HASH,
    "0",
    "0",
    "1",
    requestSha256,
    validationCommitmentSha256,
    HASH,
  ]);
  let head = await createCatalogueValidationJournalV2(binding, 1024 * 1024, root);
  const pending = await retainCatalogueValidationRequestV2(head, REQUEST, "page", root, "{}");
  head = await acknowledgeCatalogueValidationPageV2(pending, receiptSha256, root, head);
  const terminalRequest = await retainCatalogueValidationRequestV2(
    head,
    '{"terminal":true}',
    "terminal",
    root,
    "{}",
  );
  const terminal = await finishCatalogueValidationJournalV2(
    terminalRequest,
    TERMINAL,
    "{}",
    root,
    head,
  );
  const input = {
    batchId: BATCH,
    databasePrincipal: PRINCIPAL,
    baselineReleaseId: null,
    validationTerminalSha256: TERMINAL,
    validationPageCount: "1",
    validationContextSha256: HASH,
    validationCommitmentSha256,
    contextSha256: "b".repeat(64),
    baselineEvidence: null,
    maximumReconciliationEvidenceBytes: "1048576",
  };
  const stored = {
    page: {
      pageNumber: "0",
      requestSha256,
      receiptSha256,
      contextSha256: HASH,
      startSequence: "0",
      endSequence: "1",
      observationSha256: HASH,
      validationCommitmentSha256,
      semanticCommitmentSha256: HASH,
    },
    requestDocumentMatches: true,
  };
  return {
    root,
    terminal,
    terminalRequest,
    pending,
    input,
    stored,
    expected: { binding, validationTerminalSha256: TERMINAL },
  };
}

function database(responses: unknown[]) {
  const queries: CompiledQuery[] = [];
  class Driver extends DummyDriver {
    override async acquireConnection(): Promise<DatabaseConnection> {
      return {
        async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
          queries.push(query);
          if (!responses.length) throw new Error("Unexpected database call");
          let response = responses.shift();
          if (typeof response === "function") response = await response();
          if (response instanceof Error) throw response;
          return { rows: [{ result: response }] as R[] };
        },
        streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
          throw new Error("No stream expected");
        },
      };
    }
  }
  const client = new Kysely<Database>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new Driver(),
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { client, queries };
}

async function repin(root: string, pin: CatalogueJournalPinV2, value: JsonValue) {
  const bytes = canonicalJson(value).concat("\n");
  await writeFile(join(root, pin.path), bytes, { mode: 0o600 });
  return { ...pin, byteSize: Buffer.byteLength(bytes), sha256: sha(bytes) };
}
const input = {
  batchId: BATCH,
  validationTerminalSha256: TERMINAL,
  expectedCurrentReleaseId: null,
  principalId: PRINCIPAL,
};

describe("production journal to reconciliation boundary", () => {
  it("submits exact UTF-8 bytes and exhausts the journal before beginning reconciliation", async () => {
    const fixture = await retainedJournal();
    const stop = new Error("Synthetic stop at first mutation");
    let exhausted = false;
    const f = database([
      fixture.input,
      fixture.stored,
      () => {
        expect(exhausted).toBe(true);
        return stop;
      },
    ]);
    async function* pages() {
      yield* readCatalogueValidationJournalV2(fixture.terminal, fixture.expected, fixture.root);
      exhausted = true;
    }
    try {
      await expect(
        reconcileCataloguePagedBatch(f.client, input, {
          validationPages: pages(),
          consumePage: async () => {
            throw new Error("No report expected");
          },
        }),
      ).rejects.toBe(stop);
      expect(f.queries).toHaveLength(3);
      expect(f.queries[1]?.parameters).toEqual([BATCH, TERMINAL, 0, REQUEST]);
      expect(f.queries[2]?.sql).toContain("catalogue_begin_reconciliation_v2");
    } finally {
      await f.client.destroy();
    }
  });

  it.each(["terminal-prefix", "receipt", "file-bytes"] as const)(
    "rejects %s before mutation with the actual journal reader",
    async (fault) => {
      const fixture = await retainedJournal();
      let terminal = fixture.terminal;
      if (fault === "terminal-prefix") {
        const document = JSON.parse(
          await readFile(join(fixture.root, fixture.terminalRequest.path), "utf8"),
        );
        document.head.evidenceBytes += 1;
        const pending = await repin(fixture.root, fixture.terminalRequest, document);
        const end = JSON.parse(await readFile(join(fixture.root, terminal.path), "utf8"));
        terminal = await repin(fixture.root, terminal, { ...end, pendingTerminal: pending });
      } else if (fault === "file-bytes") {
        await writeFile(join(fixture.root, fixture.pending.path), "{}\n");
      }
      const f = database([fixture.input, fixture.stored]);
      let reportPages = 0;
      async function* pages() {
        for await (const page of readCatalogueValidationJournalV2(
          terminal,
          fixture.expected,
          fixture.root,
        ))
          yield fault === "receipt" ? { ...page, receiptSha256: "f".repeat(64) } : page;
      }
      try {
        await expect(
          reconcileCataloguePagedBatch(f.client, input, {
            validationPages: pages(),
            consumePage: async () => {
              reportPages += 1;
            },
          }),
        ).rejects.toThrow(
          fault === "terminal-prefix"
            ? /terminal prefix byte accounting/u
            : fault === "receipt"
              ? /differs from immutable SQL evidence/u
              : /byte size/u,
        );
        expect(f.queries).toHaveLength(fault === "file-bytes" ? 1 : 2);
        expect(
          f.queries.every((query) => !query.sql.includes("catalogue_begin_reconciliation")),
        ).toBe(true);
        expect(reportPages).toBe(0);
      } finally {
        await f.client.destroy();
      }
    },
  );
});
