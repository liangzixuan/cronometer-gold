import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { describe, expect, it } from "vitest";
import { registerPasswordAccount } from "../../../packages/db/src/accounts.js";
import {
  getSourceNutrientMappingDigest,
  registerFoodSourceFromReviewedManifest,
  registerSourceNutrientMappings,
  type StagedCatalogueRecordInput,
} from "../../../packages/db/src/catalogue-ingestion.js";
import {
  type CataloguePublicationOperationV2,
  encodeCataloguePublicationRequestV2,
  submitCataloguePublicationRequestV2,
} from "../../../packages/db/src/catalogue-paged-publication.js";
import {
  type CataloguePagedReconciliationTerminal,
  reconcileCataloguePagedBatch,
  submitCataloguePagedApproval,
} from "../../../packages/db/src/catalogue-paged-reconciliation.js";
import {
  admitCataloguePreparationV2,
  beginCataloguePreparationSealV2,
  beginCataloguePreparationV2,
  encodeCataloguePreparationAdmissionV2,
  encodeCataloguePreparationParserReportV2,
  encodeCataloguePreparationSealTerminalV2,
  encodeCataloguePreparationStageIdentityV2,
  encodeCataloguePreparationStagePageV2,
  finishCataloguePreparationSealV2,
  submitCataloguePreparationStagePageV2,
  verifyCataloguePreparationSealPageV2,
} from "../../../packages/db/src/catalogue-paged-stage.js";
import {
  advanceCatalogueValidationContextV2,
  beginCatalogueValidationV2,
  prepareCatalogueValidationPageV2,
  prepareCatalogueValidationTerminalV2,
  submitCatalogueValidationPageV2,
  submitCatalogueValidationTerminalV2,
} from "../../../packages/db/src/catalogue-paged-validation.js";
import {
  canonicalJson,
  sha256CanonicalJson,
} from "../../../packages/db/src/catalogue-validation.js";
import { createDatabase } from "../../../packages/db/src/client.js";
import { createFoodDiaryEntry, getDiaryDay } from "../../../packages/db/src/diary.js";
import {
  lookupPromotedFoodByBarcode,
  pageFoodSearchProjection,
  searchPromotedFoodsPostgres,
} from "../../../packages/db/src/food-search.js";
import { runMigrations } from "../../../packages/db/src/migrator.js";
import { createRecipe, getRecipe } from "../../../packages/db/src/recipes.js";
import { createCustomFood } from "../../../packages/db/src/retention.js";
import type { JsonObject, JsonValue } from "../../../packages/db/src/types.js";
import { readPagedRestoreTableInventory } from "../../../packages/db/test/catalogue-paged-restore-fixture.js";
import { sql } from "../../../packages/db/test/catalogue-paged-test-runtime.js";
import {
  acknowledgeCatalogueValidationPageV2,
  createCatalogueValidationJournalV2,
  finishCatalogueValidationJournalV2,
  readCatalogueValidationJournalV2,
  retainCatalogueValidationRequestV2,
} from "../src/catalogue-paged-journal.js";
import {
  createBaseline,
  MAPPING,
  POLICY,
  parserReport,
  stageIdentity,
  syntheticRecord,
} from "./catalogue-paged-fixtures.js";

// Explicitly opted-in synthetic rehearsal only. No acquisition, engine startup,
// installation, or external authority is performed by this test.
const enabled = process.env.CATALOGUE_PAGED_PUBLICATION_INTEGRATION === "1";
const databaseDescribe = enabled ? describe : describe.skip;
const HASH = "a".repeat(64);
const BARCODE = "4006381333931";
const COUNT = 251;
type Client = ReturnType<typeof createDatabase>;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const identifier = (value: string) => {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(value)) throw new Error("Unsafe synthetic identifier");
  return `"${value}"`;
};
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing synthetic fixture value");
  return value;
}
function textField(object: JsonObject, field: string): string {
  const value = object[field];
  if (typeof value !== "string") throw new Error(`Missing receipt field ${field}`);
  return value;
}
async function durable(path: string, document: string) {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(document);
    await file.sync();
  } finally {
    await file.close();
  }
}
function record(releaseKey: string, sequence: number): StagedCatalogueRecordInput {
  const result = syntheticRecord(releaseKey, sequence, 0);
  if (sequence !== 1) return result;
  const payload = structuredClone(result.canonicalPayload) as Record<string, JsonValue>;
  const key = `FDC:${releaseKey}:Branded:2`;
  payload.idempotencyKey = key;
  (payload.identity as Record<string, JsonValue>).brandOwner = "Synthetic fixture";
  (payload.identity as Record<string, JsonValue>).gtin = BARCODE;
  (payload.source as Record<string, JsonValue>).sourceDataType = "Branded";
  return {
    ...result,
    sourceRecordKey: key,
    sourceRecordType: "Branded",
    canonicalPayload: payload,
    canonicalPayloadSha256: sha256CanonicalJson(payload),
  };
}

databaseDescribe("catalogue paged publication V2 integration", () => {
  it("publishes, rolls back, and reuses a 251-record synthetic release under restricted logins", async () => {
    const url = new URL(required(process.env.TEST_DATABASE_URL));
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !["127.0.0.1", "[::1]"].includes(url.hostname)
    )
      throw new Error("Synthetic publication requires literal loopback PostgreSQL");
    if (process.env.CATALOGUE_PAGED_PUBLICATION_RECORDS !== "251")
      throw new Error("Synthetic publication is fixed at 251 records");
    const evidenceRoot = required(process.env.CATALOGUE_PAGED_PUBLICATION_EVIDENCE_ROOT);
    const rootStat = await lstat(evidenceRoot);
    if (
      !isAbsolute(evidenceRoot) ||
      !rootStat.isDirectory() ||
      rootStat.isSymbolicLink() ||
      (await realpath(evidenceRoot)) !== evidenceRoot ||
      (rootStat.mode & 0o077) !== 0
    )
      throw new Error("Evidence root must be an existing private native directory");
    const token = randomBytes(8).toString("hex");
    const databaseName = `paged_catalogue_${token}`;
    const scratch = await mkdtemp(join(evidenceRoot, "publication-"));
    const admin = createDatabase({
      connectionString: url.toString(),
      maxConnections: 1,
      statementTimeoutMs: 30_000,
    });
    const ownerUrl = new URL(url);
    ownerUrl.pathname = `/${databaseName}`;
    const clients = new Map<string, Client>();
    const createdRoles: string[] = [];
    const assertions: string[] = [];
    let owner: Client | undefined;
    let createdDatabase = false;
    let failure: unknown;
    const cleanupErrors: unknown[] = [];
    const roleSpecs = [
      { key: "stage", capabilities: ["nutrition_catalogue_stage"] },
      { key: "validate", capabilities: ["nutrition_catalogue_validate"] },
      { key: "data", capabilities: ["nutrition_catalogue_approve_data"] },
      { key: "quality", capabilities: ["nutrition_catalogue_approve_quality"] },
      { key: "rights", capabilities: ["nutrition_catalogue_approve_rights"] },
      { key: "promote", capabilities: ["nutrition_catalogue_promote_activate"] },
      { key: "rollback", capabilities: ["nutrition_catalogue_rollback"] },
      { key: "wrong", capabilities: [] },
      { key: "multi", capabilities: ["nutrition_catalogue_stage", "nutrition_catalogue_validate"] },
    ].map((item) => ({
      ...item,
      name: `paged_${item.key}_${token}`,
      password: randomBytes(24).toString("hex"),
    }));
    const actor = (key: string) => required(roleSpecs.find((item) => item.key === key)).name;
    const client = (key: string) => required(clients.get(key));
    async function reconnect(key: string) {
      if (clients.has(key)) {
        await client(key).destroy();
        clients.delete(key);
      }
      const spec = required(roleSpecs.find((item) => item.key === key));
      const target = new URL(ownerUrl);
      target.username = spec.name;
      target.password = spec.password;
      const connection = createDatabase({
        connectionString: target.toString(),
        maxConnections: 1,
        statementTimeoutMs: 30_000,
      });
      clients.set(key, connection);
      await sql`set lock_timeout='2s'`.execute(connection);
    }
    const memoryInitial = process.memoryUsage();
    let sampledPeakRssBytes = memoryInitial.rss;
    const operationMeasurements: JsonObject[] = [];
    let finalDatabaseBytes = "0";
    const sampler = setInterval(() => {
      sampledPeakRssBytes = Math.max(sampledPeakRssBytes, process.memoryUsage().rss);
    }, 100);
    async function measuredSubmit(
      key: string,
      operation: CataloguePublicationOperationV2,
      document: string,
      replay: boolean,
    ) {
      const started = performance.now();
      let outcome = "rejected";
      try {
        const result = await submitCataloguePublicationRequestV2(client(key), operation, document);
        outcome = "acknowledged";
        return result;
      } finally {
        const elapsedMs = performance.now() - started;
        const memory = process.memoryUsage();
        sampledPeakRssBytes = Math.max(sampledPeakRssBytes, memory.rss);
        const footprint = required(
          (
            await sql<{
              bytes: string;
            }>`select pg_database_size(current_database())::text as bytes`.execute(db())
          ).rows[0],
        );
        finalDatabaseBytes = footprint.bytes;
        operationMeasurements.push({
          operation,
          replay,
          outcome,
          elapsedMs,
          databaseBytes: footprint.bytes,
          rssBytes: memory.rss,
          heapUsedBytes: memory.heapUsed,
          externalBytes: memory.external,
          processHighWaterRssBytes: process.resourceUsage().maxRSS * 1024,
        });
      }
    }
    let requestNumber = 0;
    async function publication(
      operation: CataloguePublicationOperationV2,
      input: JsonObject,
      replay = true,
    ) {
      const key =
        operation === "admit" ? "quality" : operation === "rollback" ? "rollback" : "promote";
      const document = encodeCataloguePublicationRequestV2(operation, {
        schemaVersion: 2,
        ...input,
      });
      const path = join(scratch, `${++requestNumber}-${operation}.request.json`);
      await durable(path, document);
      const receipt = await measuredSubmit(key, operation, await readFile(path, "utf8"), false);
      expect(receipt.requestSha256).toBe(sha(document));
      if (replay) {
        // Commit happened but no acknowledgement has been retained. A fresh login
        // must recover exactly from the persisted request before writing a receipt.
        await reconnect(key);
        expect(await measuredSubmit(key, operation, await readFile(path, "utf8"), true)).toEqual(
          receipt,
        );
      }
      await durable(`${path}.receipt.json`, canonicalJson(receipt));
      return { receipt, document };
    }
    const db = () => required(owner);
    async function state() {
      return required(
        (
          await sql<{ value: JsonObject }>`select jsonb_build_object(
        'source',(select to_jsonb(s) from food_source s where code='USDA_FDC'),
        'foods',(select coalesce(jsonb_agg(to_jsonb(f) order by f.id),'[]') from food f join food_source s on s.id=f.food_source_id where s.code='USDA_FDC'),
        'barcodes',(select coalesce(jsonb_agg(to_jsonb(b) order by b.id),'[]') from food_barcode b),
        'activations',(select count(*) from food_source_release_activation),
        'outbox',(select count(*) from outbox_event where event_type='catalogue.source_release_activated'),
        'publications',(select coalesce(jsonb_agg(to_jsonb(p) order by batch_id),'[]') from catalogue_publication_v2 p)
      ) as value`.execute(db())
        ).rows[0],
      ).value;
    }
    async function active() {
      return required(
        (
          await sql<{
            id: string | null;
          }>`select active_release_id::text as id from food_source where code='USDA_FDC'`.execute(
            db(),
          )
        ).rows[0],
      ).id;
    }
    async function projection(releaseId: string | null, count: number) {
      const page = await pageFoodSearchProjection(db(), { limit: 500 });
      expect(page.documents).toHaveLength(count);
      expect(page.documents.every((item) => item.sourceReleaseId === releaseId)).toBe(true);
      const search = await searchPromotedFoodsPostgres(db(), { query: "Synthetic", limit: 20 });
      expect(search.length).toBe(Math.min(count, 20));
    }
    let mappingSha = "";
    async function reviewedBatch(
      label: string,
      count: number,
      expectedCurrentReleaseId: string | null,
    ) {
      const releaseKey = `publication-${token}-${label}`;
      const stage = stageIdentity(releaseKey, mappingSha);
      const stageDocument = encodeCataloguePreparationStageIdentityV2(stage);
      const admission = await admitCataloguePreparationV2(
        client("quality"),
        encodeCataloguePreparationAdmissionV2({
          stageDocument,
          manifestSha256: HASH,
          exportSha256: HASH,
          exportBytes: count * 8192,
          stagePrincipal: actor("stage"),
          maxRecords: count,
          maxPayloadTextBytes: count * 16384,
          maxIntermediateBytes: 256 * 1024 ** 2,
          maxValidationEvidenceBytes: 64 * 1024 ** 2,
          maxReconciliationEvidenceBytes: 64 * 1024 ** 2,
          maxBaselineRecords: COUNT,
          maxBaselinePayloadBytes: 4 * 1024 ** 2,
          reviewReference: `urn:test:publication:${label}`,
        }),
      );
      const batch = await beginCataloguePreparationV2(client("stage"), {
        admissionSha256: admission.admissionSha256,
        stageDocument,
      });
      let previous: string | null = null;
      let recordCommitment = batch.recordCommitmentSha256;
      let payloadBytes = "0",
        pageCount = 0;
      const payloadHash = createHash("sha256");
      for (let first = 0; first < count; first += 250) {
        const records = Array.from({ length: Math.min(250, count - first) }, (_, i) =>
          record(releaseKey, first + i),
        );
        for (const item of records) payloadHash.update(`${canonicalJson(item.canonicalPayload)}\n`);
        const document = encodeCataloguePreparationStagePageV2({
          batchId: batch.batchId,
          admissionSha256: admission.admissionSha256,
          parserVersion: stage.parserVersion,
          pageNumber: pageCount,
          firstSequence: first,
          previousReceiptSha256: previous,
          records,
        });
        const receipt = await submitCataloguePreparationStagePageV2(client("stage"), {
          batchId: batch.batchId,
          document,
        });
        previous = receipt.receiptSha256;
        recordCommitment = receipt.recordCommitmentSha256;
        payloadBytes = receipt.totalPayloadTextBytes;
        pageCount++;
      }
      const parser = await beginCataloguePreparationSealV2(client("stage"), {
        batchId: batch.batchId,
        document: encodeCataloguePreparationParserReportV2(
          parserReport(
            batch.batchId,
            stage,
            count,
            payloadHash.digest("hex"),
            admission.admissionSha256,
          ),
        ),
      });
      for (let pageNumber = 0; pageNumber < pageCount; pageNumber++)
        await verifyCataloguePreparationSealPageV2(client("stage"), {
          batchId: batch.batchId,
          pageNumber,
        });
      const seal = await finishCataloguePreparationSealV2(client("stage"), {
        batchId: batch.batchId,
        document: encodeCataloguePreparationSealTerminalV2({
          schemaVersion: 2,
          batchId: batch.batchId,
          admissionSha256: admission.admissionSha256,
          recordCount: String(count),
          payloadTextBytes: payloadBytes,
          recordCommitmentSha256: recordCommitment,
          stageReceiptSha256: previous,
          parserReportSha256: parser.parserReportSha256,
          sealRequestSha256: parser.sealRequestSha256,
        }),
      });
      const batchScratch = join(scratch, label);
      await mkdir(batchScratch, { mode: 0o700 });
      let context = await beginCatalogueValidationV2(client("validate"), {
        batchId: batch.batchId,
        stagingSealSha256: seal.stagingSealSha256,
        policy: POLICY,
      });
      const binding = {
        batchId: context.batchId,
        validatorDatabasePrincipal: context.validatorDatabasePrincipal,
        stagingSealSha256: context.stagingSealSha256,
        contextSha256: context.contextSha256,
        admissionSha256: context.admissionSha256,
      };
      let journal = await createCatalogueValidationJournalV2(
        binding,
        Number(context.maximumValidationEvidenceBytes),
        batchScratch,
      );
      while (context.nextSequence !== context.stagedCount) {
        const prepared = await prepareCatalogueValidationPageV2(client("validate"), context);
        const pending = await retainCatalogueValidationRequestV2(
          journal,
          prepared.requestDocument,
          "page",
          batchScratch,
          canonicalJson(context as unknown as JsonValue),
        );
        const receipt = await submitCatalogueValidationPageV2(
          client("validate"),
          prepared,
          context,
        );
        journal = await acknowledgeCatalogueValidationPageV2(
          pending,
          receipt.receiptSha256,
          batchScratch,
          journal,
        );
        context = advanceCatalogueValidationContextV2(context, prepared, receipt);
      }
      const terminalRequest = prepareCatalogueValidationTerminalV2(context);
      const pending = await retainCatalogueValidationRequestV2(
        journal,
        terminalRequest.terminalDocument,
        "terminal",
        batchScratch,
        canonicalJson(context as unknown as JsonValue),
      );
      const terminal = await submitCatalogueValidationTerminalV2(
        client("validate"),
        context,
        terminalRequest,
      );
      await client("validate").destroy();
      clients.delete("validate");
      const journalTerminal = await finishCatalogueValidationJournalV2(
        pending,
        terminal.terminalSha256,
        canonicalJson(terminal as unknown as JsonValue),
        batchScratch,
        journal,
      );
      await reconnect("validate");
      const report = await reconcileCataloguePagedBatch(
        client("validate"),
        {
          batchId: batch.batchId,
          validationTerminalSha256: terminal.terminalSha256,
          expectedCurrentReleaseId,
          principalId: actor("validate"),
        },
        {
          validationPages: readCatalogueValidationJournalV2(
            journalTerminal,
            { binding, validationTerminalSha256: terminal.terminalSha256 },
            batchScratch,
          ),
          consumePage: async (page) =>
            durable(
              join(batchScratch, `report-${page.pageNumber}.json`),
              canonicalJson(page as unknown as JsonValue),
            ),
        },
      );
      for (const approvalRole of ["data", "quality", "rights"] as const) {
        const decision = {
          batchId: batch.batchId,
          approvalRole,
          principalId: actor(approvalRole),
          rightsManifestSha256: HASH,
          validationTerminalSha256: terminal.terminalSha256,
          reportSha256: report.reportSha256,
          contextSha256: report.contextSha256,
          approvalReference: `urn:test:publication:${label}:${approvalRole}`,
        };
        await expect(submitCataloguePagedApproval(client("promote"), decision)).rejects.toThrow();
        await submitCataloguePagedApproval(client(approvalRole), decision);
      }
      return { batchId: batch.batchId, report };
    }
    const limits = {
      maxRecords: String(COUNT),
      maxMaterializationBytes: "67108864",
      maxIntermediateBytes: "268435456",
      maxEvidenceBytes: "67108864",
      maxCutoverFoodRows: "1000",
      maxCutoverBarcodeRows: "1000",
      maxCutoverBytes: "67108864",
    };
    function admissionInput(batch: {
      batchId: string;
      report: CataloguePagedReconciliationTerminal;
    }): JsonObject {
      return {
        batchId: batch.batchId,
        contextSha256: batch.report.contextSha256,
        validationTerminalSha256: batch.report.validationTerminalSha256,
        reportSha256: batch.report.reportSha256,
        publisherPrincipal: actor("promote"),
        limits,
      };
    }
    async function beginPublication(batch: {
      batchId: string;
      report: CataloguePagedReconciliationTerminal;
    }) {
      const admission = await publication("admit", admissionInput(batch));
      return publication("begin", {
        batchId: batch.batchId,
        admissionSha256: textField(admission.receipt, "admissionSha256"),
      });
    }
    async function materializeAndSeal(
      batchId: string,
      initial: JsonObject,
      baselineReleaseId: string,
      count: number,
    ) {
      let progress = initial;
      while (progress.phase === "materializing") {
        const result = await publication("materialize", {
          batchId,
          publicationSha256: progress.publicationSha256 as string,
          pageNumber: progress.pageCount as string,
          firstSequence: progress.nextSequence as string,
          previousReceiptSha256: progress.receiptSha256 as string,
        });
        progress = result.receipt;
        await projection(
          baselineReleaseId,
          baselineReleaseId === firstBaselineReleaseId ? 1 : COUNT,
        );
        expect(await active()).toBe(baselineReleaseId);
      }
      expect(progress.nextSequence).toBe(String(count));
      expect(progress.pageCount).toBe(String(Math.ceil(count / 250)));
      while (progress.verifiedSequence !== String(count))
        progress = (
          await publication("verify", {
            batchId,
            publicationSha256: progress.publicationSha256 as string,
            pageNumber: progress.verifiedPageCount as string,
            firstSequence: progress.verifiedSequence as string,
            previousReceiptSha256: progress.receiptSha256 as string,
          })
        ).receipt;
      return publication("finish", {
        batchId,
        publicationSha256: progress.publicationSha256 as string,
        previousReceiptSha256: progress.receiptSha256 as string,
      });
    }
    let firstBaselineReleaseId = "";
    try {
      await sql
        .raw(`create database ${identifier(databaseName)} template template0 encoding 'UTF8'`)
        .execute(admin);
      createdDatabase = true;
      owner = createDatabase({
        connectionString: ownerUrl.toString(),
        maxConnections: 1,
        statementTimeoutMs: 30_000,
      });
      await runMigrations(owner);
      await sql
        .raw(`revoke connect on database ${identifier(databaseName)} from public`)
        .execute(admin);
      const expires = new Date(Date.now() + 30 * 60_000).toISOString();
      for (const role of roleSpecs) {
        await sql
          .raw(
            `create role ${identifier(role.name)} login inherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls connection limit 2 password '${role.password}' valid until '${expires}'`,
          )
          .execute(admin);
        createdRoles.push(role.name);
        await sql
          .raw(`grant connect on database ${identifier(databaseName)} to ${identifier(role.name)}`)
          .execute(admin);
        for (const capability of role.capabilities)
          await sql
            .raw(
              `grant ${identifier(capability)} to ${identifier(role.name)} with admin false, inherit true, set false`,
            )
            .execute(admin);
        await reconnect(role.key);
      }
      await registerFoodSourceFromReviewedManifest(owner, {
        code: "USDA_FDC",
        displayName: "Synthetic publication fixture",
        kind: "government",
        homepageUrl: "https://example.invalid/publication",
        licenseExpression: "CC0-1.0",
        licenseUrl: "https://example.invalid/synthetic-rights",
        attributionRequired: true,
        attributionText: "Synthetic disposable rehearsal",
        commercialUseAllowed: true,
        redistributionAllowed: true,
        rightsReviewStatus: "approved",
        rightsReviewedAt: new Date(),
        rightsReviewedBy: "fixture:publication:rights",
      });
      await registerSourceNutrientMappings(owner, {
        sourceCode: "USDA_FDC",
        reviewedAt: new Date(),
        reviewedBy: "fixture:publication:mapping",
        mappings: [MAPPING],
      });
      mappingSha = await getSourceNutrientMappingDigest(owner, "USDA_FDC");
      const baseline = await createBaseline({ owner, client, actor, mappingSha, token });
      firstBaselineReleaseId = baseline.releaseId;
      const account = await registerPasswordAccount(owner, {
        email: `publication-${token}@example.invalid`,
        passwordHash: "$argon2id$fixture-hash-value",
        passwordSalt: "fixture-salt-value-123456",
        passwordParameters: { algorithm: "argon2id" },
        timeZone: "UTC",
      });
      const nutrient = required(
        (
          await sql<{ id: string }>`select id::text from nutrient where code='protein'`.execute(
            owner,
          )
        ).rows[0],
      );
      const custom = await createCustomFood(owner, {
        userId: account.userId,
        clientOperationId: randomUUID(),
        requestDigest: HASH,
        food: {
          name: "Private synthetic food",
          brandName: null,
          notes: null,
          serving: null,
          nutrients: [{ nutrientId: nutrient.id, state: "quantified", amountPer100Grams: "2" }],
        },
      });
      const original = required((await pageFoodSearchProjection(owner)).documents[0]);
      for (const foodVersionId of [original.foodVersionId, custom.food.currentVersion.id])
        await createFoodDiaryEntry(owner, {
          userId: account.userId,
          clientOperationId: randomUUID(),
          requestDigest: HASH,
          expectedProfileTimeZone: "UTC",
          occurredAt: "2026-09-23T12:00:00Z",
          foodVersionId,
          portion: { kind: "grams", grams: "100" },
          mealSlot: "breakfast",
        });
      const recipe = await createRecipe(owner, {
        userId: account.userId,
        clientOperationId: randomUUID(),
        requestDigest: HASH,
        recipe: {
          name: "Synthetic recipe",
          description: null,
          instructions: null,
          ingredients: [
            {
              kind: "food",
              foodVersionId: original.foodVersionId,
              portion: { kind: "grams", grams: "100" },
            },
            {
              kind: "food",
              foodVersionId: custom.food.currentVersion.id,
              portion: { kind: "grams", grams: "100" },
            },
          ],
          yield: { grams: "200", source: "measured" },
          servingCount: null,
          servingLabel: null,
        },
      });
      const diaryBefore = await getDiaryDay(owner, {
        userId: account.userId,
        localDate: "2026-09-23",
      });
      const recipeBefore = await getRecipe(owner, {
        userId: account.userId,
        recipeId: recipe.recipe.id,
      });
      const candidate = await reviewedBatch("first", COUNT, baseline.releaseId);
      const beforeAdmission = await state();
      await expect(
        publication("admit", {
          ...admissionInput(candidate),
          limits: { ...limits, maxRecords: "250" },
        }),
      ).rejects.toMatchObject({ code: "54000" });
      expect(await state()).toEqual(beforeAdmission);
      assertions.push("resource-admission-denial");
      const admitDocument = encodeCataloguePublicationRequestV2("admit", {
        schemaVersion: 2,
        ...admissionInput(candidate),
      });
      for (const unauthorized of [
        owner,
        client("stage"),
        client("wrong"),
        client("multi"),
        client("promote"),
      ])
        await expect(
          submitCataloguePublicationRequestV2(unauthorized, "admit", admitDocument),
        ).rejects.toThrow();
      const begun = await beginPublication(candidate);
      for (const unauthorized of [
        owner,
        client("stage"),
        client("quality"),
        client("wrong"),
        client("multi"),
      ]) {
        await expect(
          submitCataloguePublicationRequestV2(unauthorized, "begin", begun.document),
        ).rejects.toThrow();
        await expect(
          sql`update catalogue_publication_v2 set materialized_count=materialized_count+1 where batch_id=${candidate.batchId}::uuid`.execute(
            unauthorized,
          ),
        ).rejects.toThrow();
      }
      assertions.push("restricted-roles-reviewers-and-direct-dml");
      const early = await state();
      await expect(
        publication("finish", {
          batchId: candidate.batchId,
          publicationSha256: begun.receipt.publicationSha256 as string,
          previousReceiptSha256: begun.receipt.receiptSha256 as string,
        }),
      ).rejects.toThrow();
      expect(await state()).toEqual(early);
      const finished = await materializeAndSeal(
        candidate.batchId,
        begun.receipt,
        baseline.releaseId,
        COUNT,
      );
      expect(await lookupPromotedFoodByBarcode(owner, { barcode: BARCODE })).toBeNull();
      const beforeBadActivation = await state();
      await expect(
        publication("activate", {
          batchId: candidate.batchId,
          publicationSha256: finished.receipt.publicationSha256 as string,
          sealSha256: finished.receipt.sealSha256 as string,
          expectedCurrentReleaseId: null,
          reason: "Synthetic wrong head",
        }),
      ).rejects.toThrow();
      expect(await state()).toEqual(beforeBadActivation);
      assertions.push("bounded-pages-off-current-and-terminal-atomicity");
      const activated = await publication("activate", {
        batchId: candidate.batchId,
        publicationSha256: finished.receipt.publicationSha256 as string,
        sealSha256: finished.receipt.sealSha256 as string,
        expectedCurrentReleaseId: baseline.releaseId,
        reason: "Synthetic activation",
      });
      const firstRelease = textField(activated.receipt, "releaseId");
      expect(activated.receipt).toMatchObject({
        previousReleaseId: baseline.releaseId,
        activeReleaseId: firstRelease,
        phase: "activated",
      });
      await projection(firstRelease, COUNT);
      expect(
        (await lookupPromotedFoodByBarcode(owner, { barcode: BARCODE }))?.sourceReleaseId,
      ).toBe(firstRelease);
      const audit = required(
        (
          await sql<{
            principal: string;
            capability: string;
          }>`select database_principal as principal,database_capability_role as capability from food_source_release_activation where id=${textField(activated.receipt, "activationId")}::bigint`.execute(
            owner,
          )
        ).rows[0],
      );
      expect(audit).toEqual({
        principal: actor("promote"),
        capability: "nutrition_catalogue_promote_activate",
      });
      assertions.push("activation-receipt-search-and-barcode");
      const history = (
        await sql<{
          value: JsonObject;
        }>`select to_jsonb(v) as value from food_version v order by id`.execute(owner)
      ).rows;
      const rollback = (target: string | null, expected: string | null) =>
        publication("rollback", {
          sourceCode: "USDA_FDC",
          targetReleaseId: target,
          expectedCurrentReleaseId: expected,
          reason: "Synthetic rollback",
          requestId: randomUUID(),
        });
      for (const name of [
        "catalogue_rollback_source_release",
        "catalogue_rollback_source_release_v1",
      ])
        await expect(
          sql`select public.${sql.id(name)}('USDA_FDC',${baseline.releaseId}::uuid,${actor("rollback")},'Synthetic legacy fence')`.execute(
            client("rollback"),
          ),
        ).rejects.toThrow();
      const backV1 = await rollback(baseline.releaseId, firstRelease);
      await projection(baseline.releaseId, 1);
      await expect(
        submitCataloguePublicationRequestV2(client("promote"), "activate", activated.document),
      ).rejects.toThrow();
      await expect(rollback(null, baseline.releaseId)).rejects.toThrow("V1-only");
      await rollback(firstRelease, baseline.releaseId);
      await projection(firstRelease, COUNT);
      await expect(
        submitCataloguePublicationRequestV2(client("rollback"), "rollback", backV1.document),
      ).rejects.toThrow();
      await rollback(null, firstRelease);
      await projection(null, 0);
      expect(await lookupPromotedFoodByBarcode(owner, { barcode: BARCODE })).toBeNull();
      await rollback(firstRelease, null);
      await projection(firstRelease, COUNT);
      assertions.push("rollback-v1-v2-deactivation-and-superseded-replay");
      expect(
        (
          await sql<{
            value: JsonObject;
          }>`select to_jsonb(v) as value from food_version v order by id`.execute(owner)
        ).rows,
      ).toEqual(history);
      expect(await getDiaryDay(owner, { userId: account.userId, localDate: "2026-09-23" })).toEqual(
        diaryBefore,
      );
      expect(
        await getRecipe(owner, { userId: account.userId, recipeId: recipe.recipe.id }),
      ).toEqual(recipeBefore);
      expect(
        (await pageFoodSearchProjection(owner, { limit: 500 })).documents.some(
          (item) => item.foodId === custom.food.foodId,
        ),
      ).toBe(false);
      assertions.push("immutable-history-diary-recipe-and-private-food");
      const successor = await reviewedBatch("successor", COUNT, firstRelease);
      expect(successor.report.counts.baselineRecords).toBe(String(COUNT));
      const nextBegin = await beginPublication(successor);
      const nextFinish = await materializeAndSeal(
        successor.batchId,
        nextBegin.receipt,
        firstRelease,
        COUNT,
      );
      const next = await publication("activate", {
        batchId: successor.batchId,
        publicationSha256: nextFinish.receipt.publicationSha256 as string,
        sealSha256: nextFinish.receipt.sealSha256 as string,
        expectedCurrentReleaseId: firstRelease,
        reason: "Synthetic successor",
      });
      const secondRelease = textField(next.receipt, "releaseId");
      await projection(secondRelease, COUNT);
      await rollback(firstRelease, secondRelease);
      await projection(firstRelease, COUNT);
      assertions.push("published-v2-successor-baseline-and-v2-rollback");
      const drift = await reviewedBatch("drift", 1, firstRelease);
      const driftBegin = await beginPublication(drift);
      // A normal catalogued write after begin invalidates the frozen generation.
      await createCustomFood(owner, {
        userId: account.userId,
        clientOperationId: randomUUID(),
        requestDigest: HASH,
        food: {
          name: "Generation drift fixture",
          brandName: null,
          notes: null,
          serving: null,
          nutrients: [{ nutrientId: nutrient.id, state: "quantified", amountPer100Grams: "1" }],
        },
      });
      const beforeDrift = await state();
      await expect(
        publication("materialize", {
          batchId: drift.batchId,
          publicationSha256: driftBegin.receipt.publicationSha256 as string,
          pageNumber: "0",
          firstSequence: "0",
          previousReceiptSha256: driftBegin.receipt.receiptSha256 as string,
        }),
      ).rejects.toMatchObject({ code: "40001" });
      expect(await state()).toEqual(beforeDrift);
      assertions.push("generation-drift-atomic-rejection");
      // Rollback always rechecks barcode ownership, independently of historical
      // generation. Introduce a competing public root only in this disposable DB.
      await rollback(null, firstRelease);
      const otherSource = await owner
        .insertInto("food_source")
        .values({
          code: "SYNTHETIC_CONFLICT",
          display_name: "Synthetic conflict",
          kind: "government",
          homepage_url: "https://example.invalid/conflict",
          license_expression: "CC0-1.0",
          license_url: "https://example.invalid/synthetic-rights",
          attribution_required: false,
          attribution_text: "Synthetic",
          commercial_use_allowed: true,
          redistribution_allowed: true,
          rights_review_status: "approved",
          rights_reviewed_at: new Date(),
          rights_reviewed_by: "fixture",
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const otherFood = await owner
        .insertInto("food")
        .values({
          food_source_id: otherSource.id,
          kind: "branded",
          owner_user_id: null,
          source_food_key: "conflict",
          visibility: "public",
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const otherVersion = await owner
        .insertInto("food_version")
        .values({
          food_id: otherFood.id,
          version_number: 1,
          name: "Synthetic conflict",
          normalized_name: "synthetic conflict",
          brand_name: "Synthetic",
          description: null,
          ingredients_text: null,
          language_tag: "en",
          market_code: "US",
          source_release_id: null,
          source_modified_at: null,
          data_quality: "verified",
          basis_quantity: "100",
          basis_unit: "g",
          attributes: {},
          created_by_user_id: null,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const conflict = await owner
        .insertInto("food_barcode")
        .values({
          food_id: otherFood.id,
          food_version_id: otherVersion.id,
          gtin: BARCODE.padStart(14, "0"),
          market_code: "US",
          source_release_id: null,
          metadata: { synthetic: true },
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const beforeConflict = await state();
      await expect(rollback(firstRelease, null)).rejects.toMatchObject({ code: "23505" });
      expect(await state()).toEqual(beforeConflict);
      await owner
        .updateTable("food_barcode")
        .set({ valid_to: sql`clock_timestamp()` })
        .where("id", "=", conflict.id)
        .execute();
      await rollback(firstRelease, null);
      await projection(firstRelease, COUNT);
      assertions.push("late-barcode-conflict-atomic-rejection");
      const inventory = await readPagedRestoreTableInventory(owner);
      for (const table of [
        "catalogue_publication_admission_v2",
        "catalogue_publication_v2",
        "catalogue_publication_record_v2",
        "catalogue_publication_page_v2",
        "catalogue_publication_rollback_v2",
      ])
        expect(JSON.stringify(inventory)).toContain(table);
      assertions.push("restore-inventory-includes-publication-history");
      assertions.push("exact-request-restart-and-lost-ack-replay");
    } catch (error) {
      failure = error;
    } finally {
      clearInterval(sampler);
      for (const connection of clients.values())
        try {
          await connection.destroy();
        } catch (error) {
          cleanupErrors.push(error);
        }
      if (owner)
        try {
          await owner.destroy();
        } catch (error) {
          cleanupErrors.push(error);
        }
      if (createdDatabase)
        try {
          await sql.raw(`drop database ${identifier(databaseName)}`).execute(admin);
        } catch (error) {
          cleanupErrors.push(error);
        }
      for (const role of [...createdRoles].reverse())
        try {
          await sql.raw(`drop role ${identifier(role)}`).execute(admin);
        } catch (error) {
          cleanupErrors.push(error);
        }
      try {
        await admin.destroy();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (failure || cleanupErrors.length)
      throw new AggregateError(
        [...(failure ? [failure] : []), ...cleanupErrors],
        "Synthetic publication lifecycle or owned cleanup failed",
      );
    await durable(
      join(evidenceRoot, "publication-evidence.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          syntheticOnly: true,
          recordCount: COUNT,
          status: "passed",
          ownedCleanupComplete: true,
          databaseName,
          assertions,
          resources: {
            resourceQualification: false,
            workload: "251-record functional lifecycle, not a comparable scale measurement",
            initialRssBytes: memoryInitial.rss,
            sampledPeakRssBytes,
            sampledRssGrowthBytes: Math.max(0, sampledPeakRssBytes - memoryInitial.rss),
            sampleIntervalMs: 100,
            processHighWaterRssBytes: process.resourceUsage().maxRSS * 1024,
            processHighWaterScope: "Linux process lifetime, including Vitest and fixture setup",
            finalDatabaseBytes,
            databaseFootprintScope: "Whole disposable database after each publication adapter call",
            operationElapsedScope:
              "Actual production adapter call, excluding footprint query and retained-file IO",
            requiredComparablePeakRssBytes: 256 * 1024 ** 2,
            requiredComparableRssGrowthBytes: 32 * 1024 ** 2,
            operationMeasurements,
          },
        },
        null,
        2,
      )}\n`,
    );
  }, 300_000);
});
