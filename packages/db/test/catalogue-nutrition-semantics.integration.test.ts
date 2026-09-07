import { createHash, randomBytes } from "node:crypto";

import { type Kysely, sql } from "kysely";
import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  createDatabase,
  type Database,
  getSourceNutrientMappingDigest,
  type JsonObject,
  type JsonValue,
  type ReviewedCatalogueNutrientMapping,
  registerFoodSourceFromReviewedManifest,
  registerSourceNutrientMappings,
  runMigrations,
  supersedeSourceNutrientMapping,
  validateCatalogueRecord,
} from "../src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

interface LoginFixture {
  readonly capability: "nutrition_catalogue_stage" | "nutrition_catalogue_validate";
  readonly login: string;
  readonly password: string;
}

interface SemanticFixture {
  readonly owner: Kysely<Database>;
  readonly stage: Kysely<Database>;
  readonly stageLogin: string;
  readonly validate: Kysely<Database>;
  readonly validateLogin: string;
}

interface StageDocument {
  readonly acquiredAt: string;
  readonly artifactBytes: number;
  readonly artifactSha256: string;
  readonly artifactUri: string;
  readonly evidenceBundleSha256: string;
  readonly evidenceBundleUri: string;
  readonly evidenceDecisionSha256: string;
  readonly evidenceObjectVersionId: string;
  readonly evidenceValidUntil: string;
  readonly mediaType: string;
  readonly parserVersion: string;
  readonly publishedOn: string;
  readonly releaseClass: "live-reviewed";
  readonly releaseKey: string;
  readonly rightsManifestSha256: string;
  readonly rightsManifestUri: string;
  readonly schemaVersion: 1;
  readonly sourceCode: string;
  readonly upstreamSchemaVersion: string;
}

interface StagedRecord {
  readonly canonicalPayloadDocument: string;
  readonly canonicalPayloadSha256: string;
  readonly payload: JsonObject;
  readonly sequenceNumber: number;
  readonly sourcePayloadSha256: string;
  readonly sourceRecordKey: string;
  readonly sourceRecordType: string;
}

interface MappingObservation {
  readonly canonicalUnit: string;
  readonly conversionMultiplier: string;
  readonly nutrientCode: string;
  readonly nutrientId: string;
  readonly revisionId: string;
  readonly sourceNutrientKey: string;
  readonly sourceUnit: string;
}

interface ParserEvidence {
  readonly emittedNutrientCount: number;
  readonly emittedPortionCount: number;
  readonly emittedRecordCount: number;
  readonly excludedNutrientCount: number;
  readonly excludedPortionCount: number;
  readonly excludedRecordCount: number;
  readonly reportSha256: string;
  readonly sourceNutrientCount: number;
  readonly sourcePortionCount: number;
  readonly sourceRecordCount: number;
}

interface ValidationObservation {
  readonly batch: {
    readonly artifactSha256: string;
    readonly evidenceBundleSha256: string;
    readonly evidenceBundleUri: string;
    readonly evidenceDecisionSha256: string;
    readonly evidenceObjectVersionId: string;
    readonly evidenceValidUntil: string;
    readonly id: string;
    readonly releaseClass: string;
    readonly rightsManifestSha256: string;
    readonly stagedDatabasePrincipal: string | null;
    readonly stagingSealSha256: string;
  };
  readonly nutrientMappings: readonly MappingObservation[];
  readonly parserReport: ParserEvidence;
  readonly records: readonly {
    readonly canonicalPayloadSha256: string;
    readonly sourceRecordKey: string;
  }[];
}

interface ValidationObservationResult {
  readonly observation: ValidationObservation;
  readonly observationSha256: string;
  readonly schemaVersion: number;
}

interface Candidate {
  readonly batchId: string;
  readonly observation: ValidationObservationResult;
  readonly record: StagedRecord;
  readonly stagingSealSha256: string;
  readonly validationDocument: string;
  readonly validatedFood: JsonObject;
}

interface ValidationWireDocument {
  readonly digestDocument: string;
  readonly records: readonly {
    readonly sourceRecordKey: string;
    readonly validatedFoodDocument: string | null;
    readonly validationIssuesDocument: string;
  }[];
  readonly schemaVersion: number;
}

describeDatabase("catalogue nutrition semantic database recheck", { timeout: 240_000 }, () => {
  it("rejects recomputed-hash nutrient forgery and preserves exact known, zero, trace, and unknown semantics", async () => {
    await withSemanticFixture(async (fixture) => {
      const token = randomBytes(5).toString("hex");
      const sourceCode = `NS${token.toUpperCase()}`;
      await registerReviewedSource(fixture.owner, sourceCode, token);
      await registerSemanticMappings(fixture.owner, sourceCode);
      const mappingDigest = await getSourceNutrientMappingDigest(fixture.owner, sourceCode);

      const primaryPayload = buildFoodPayload({
        basisAmount: "100",
        nutrients: semanticNutrientInputs(),
        releaseKey: "semantic-primary",
        sourceCode,
        sourceRecordId: "primary",
      });
      const primary = await stageCandidate(
        fixture.stage,
        fixture.validate,
        sourceCode,
        "semantic-primary",
        mappingDigest,
        primaryPayload,
      );

      const frozenNutrients = primary.validatedFood.nutrients as readonly JsonObject[];
      const primaryWire = JSON.parse(primary.validationDocument) as ValidationWireDocument;
      expect(JSON.parse(primaryWire.records[0]?.validationIssuesDocument ?? "[]")).toEqual([]);
      expect(primary.validatedFood.basisQuantity).toBe("100");
      expect(frozenNutrients.map((nutrient) => nutrient.nutrientCode)).toEqual([
        "protein",
        "carbohydrate",
        "fat",
      ]);
      expect(frozenNutrients).toHaveLength(3);
      expect(findNutrient(frozenNutrients, "protein")).toMatchObject({
        amount: "12.5",
        canonicalUnit: "g",
        sourceAmount: "12500",
        sourceBasisQuantity: "100",
        sourceBasisUnit: "g",
        sourceUnit: "mg",
        valueStatus: "measured",
      });
      expect(findNutrient(frozenNutrients, "carbohydrate")).toMatchObject({
        amount: "0",
        sourceAmount: "0",
        sourceBasisQuantity: "100",
        sourceBasisUnit: "g",
        valueStatus: "measured",
      });
      expect(findNutrient(frozenNutrients, "fat")).toMatchObject({
        amount: "0",
        sourceAmount: null,
        sourceBasisQuantity: null,
        sourceBasisUnit: null,
        sourceUnit: null,
        valueStatus: "trace",
      });
      expect(frozenNutrients.some((nutrient) => nutrient.nutrientCode === "fiber")).toBe(false);

      const changedAmount = rewriteValidatedFood(primary.validationDocument, (nutrients) =>
        nutrients.map((nutrient) =>
          nutrient.nutrientCode === "protein" ? { ...nutrient, amount: "12.6" } : nutrient,
        ),
      );
      await expectSemanticRejectionRollsBack(
        fixture.owner,
        primary.batchId,
        validateImportBatch(fixture.validate, primary, changedAmount),
        "catalogue validated nutrient transformation differs",
      );

      const omittedKnown = rewriteValidatedFood(
        primary.validationDocument,
        (nutrients) => nutrients.filter((nutrient) => nutrient.nutrientCode !== "protein"),
        2,
      );
      await expectSemanticRejectionRollsBack(
        fixture.owner,
        primary.batchId,
        validateImportBatch(fixture.validate, primary, omittedKnown),
      );

      const unknownMapping = requireMapping(primary.observation, "1079");
      const zeroTemplate = findNutrient(frozenNutrients, "carbohydrate");
      const fabricatedUnknown = rewriteValidatedFood(
        primary.validationDocument,
        (nutrients) => [
          ...nutrients,
          {
            ...zeroTemplate,
            canonicalUnit: unknownMapping.canonicalUnit,
            mappingRevisionId: unknownMapping.revisionId,
            metadata: {
              dataPoints: null,
              derivationCode: null,
              mappingRevisionId: unknownMapping.revisionId,
              sourceName: "Fiber",
              sourceNutrientId: unknownMapping.sourceNutrientKey,
              sourceUnit: unknownMapping.sourceUnit,
            },
            nutrientCode: unknownMapping.nutrientCode,
            nutrientId: unknownMapping.nutrientId,
            sourceName: "Fiber",
            sourceNutrientId: unknownMapping.sourceNutrientKey,
          },
        ],
        4,
      );
      await expectSemanticRejectionRollsBack(
        fixture.owner,
        primary.batchId,
        validateImportBatch(fixture.validate, primary, fabricatedUnknown),
      );

      const traceAsKnownZero = rewriteValidatedFood(primary.validationDocument, (nutrients) =>
        nutrients.map((nutrient) =>
          nutrient.nutrientCode === "fat"
            ? {
                ...nutrient,
                sourceAmount: "0",
                sourceBasisQuantity: "100",
                sourceBasisUnit: "g",
                sourceUnit: "g",
                valueStatus: "measured",
              }
            : nutrient,
        ),
      );
      await expectSemanticRejectionRollsBack(
        fixture.owner,
        primary.batchId,
        validateImportBatch(fixture.validate, primary, traceAsKnownZero),
      );

      const knownZeroAsTrace = rewriteValidatedFood(primary.validationDocument, (nutrients) =>
        nutrients.map((nutrient) =>
          nutrient.nutrientCode === "carbohydrate"
            ? {
                ...nutrient,
                sourceAmount: null,
                sourceBasisQuantity: null,
                sourceBasisUnit: null,
                sourceUnit: null,
                valueStatus: "trace",
              }
            : nutrient,
        ),
      );
      await expectSemanticRejectionRollsBack(
        fixture.owner,
        primary.batchId,
        validateImportBatch(fixture.validate, primary, knownZeroAsTrace),
      );

      const accepted = await validateImportBatch(
        fixture.validate,
        primary,
        primary.validationDocument,
      );
      expect(accepted).toMatchObject({
        nutrientMaterializableCount: 3,
        promotionEligible: true,
        stagedCount: 1,
        validCount: 1,
        wasAlreadyValidated: false,
      });
      const frozenState = await readSemanticState(fixture.owner, primary.batchId);
      expect(frozenState).toMatchObject({
        batchSemanticContract: 1,
        batchStatus: "ready",
        recordSemanticContract: 1,
        recordStatus: "valid",
      });
      expect(frozenState.batchSemanticSha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(frozenState.recordSemanticSha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(
        await validateImportBatch(fixture.validate, primary, primary.validationDocument),
      ).toMatchObject({
        validationDigest: accepted.validationDigest,
        wasAlreadyValidated: true,
      });

      await expectPostgresCode(
        validateImportBatch(fixture.validate, primary, changedAmount),
        "55000",
        "catalogue validation replay differs",
      );
      expect(await readSemanticState(fixture.owner, primary.batchId)).toEqual(frozenState);

      const nonHundredPayload = buildFoodPayload({
        basisAmount: "50",
        nutrients: [semanticNutrientInputs()[0] as JsonObject],
        releaseKey: "semantic-non-100g",
        sourceCode,
        sourceRecordId: "non-100g",
      });
      const nonHundred = await stageCandidate(
        fixture.stage,
        fixture.validate,
        sourceCode,
        "semantic-non-100g",
        mappingDigest,
        nonHundredPayload,
        { ...nonHundredPayload, basis: { amount: "100", unit: "g" } },
      );
      const plausibleHundredGramDocument = rewriteValidatedFoodDocument(
        nonHundred.validationDocument,
        (food) => ({ ...food, basisQuantity: "100" }),
      );
      await expectSemanticRejectionRollsBack(
        fixture.owner,
        nonHundred.batchId,
        validateImportBatch(fixture.validate, nonHundred, plausibleHundredGramDocument),
        "catalogue nutrition semantic basis is not exactly 100 grams",
      );

      const ownerPayload = buildFoodPayload({
        basisAmount: "100",
        nutrients: [semanticNutrientInputs()[0] as JsonObject],
        releaseKey: "semantic-owner",
        sourceCode,
        sourceRecordId: "owner",
      });
      const ownerCandidate = await stageCandidate(
        fixture.owner,
        fixture.owner,
        sourceCode,
        "semantic-owner",
        mappingDigest,
        ownerPayload,
      );
      await expect(
        validateImportBatch(fixture.owner, ownerCandidate, ownerCandidate.validationDocument),
      ).resolves.toMatchObject({
        nutrientMaterializableCount: 1,
        promotionEligible: true,
        validCount: 1,
      });
      expect(await readAuditLineage(fixture.owner, ownerCandidate.batchId)).toEqual({
        stagedCapability: null,
        stagedPrincipal: null,
        validatedCapability: null,
        validatedPrincipal: null,
      });
      expect(await readAuditLineage(fixture.owner, primary.batchId)).toEqual({
        stagedCapability: "nutrition_catalogue_stage",
        stagedPrincipal: fixture.stageLogin,
        validatedCapability: "nutrition_catalogue_validate",
        validatedPrincipal: fixture.validateLogin,
      });
    });
  });

  it("matches numeric basis, text normalization, UTF-16 bounds, and decimal bounds", async () => {
    await withSemanticFixture(async (fixture) => {
      const token = randomBytes(5).toString("hex");
      const sourceCode = `NE${token.toUpperCase()}`;
      await registerReviewedSource(fixture.owner, sourceCode, `${token}-edges`);
      await registerSemanticMappings(fixture.owner, sourceCode);
      await registerBoundaryMappings(fixture.owner, sourceCode);
      const mappingDigest = await getSourceNutrientMappingDigest(fixture.owner, sourceCode);
      const atSourceNameLimit = "😀".repeat(1_000);
      const overSourceNameLimit = "😀".repeat(1_001);
      const boundaryNutrient = (sourceNutrientId: string, amount: string | number): JsonObject => ({
        canonicalNutrientId: null,
        canonicalUnit: null,
        originalUnit: "g",
        provenance: { dataPoints: null, derivationCode: null },
        sourceName: sourceNutrientId,
        sourceNutrientId,
        value: { amount, quality: "measured", state: "known" },
      });
      const traceBoundaryNutrient = (
        sourceNutrientId: string,
        detectionLimit: number,
      ): JsonObject => ({
        canonicalNutrientId: null,
        canonicalUnit: null,
        originalUnit: "g",
        provenance: { dataPoints: null, derivationCode: null },
        sourceName: sourceNutrientId,
        sourceNutrientId,
        value: { detectionLimit, state: "trace" },
      });
      const edgePayload = buildFoodPayload({
        basisAmount: 100,
        nutrients: [
          {
            canonicalNutrientId: null,
            canonicalUnit: null,
            originalUnit: "\u00a0mg\u2003",
            provenance: {
              dataPoints: 1,
              derivationCode: "  de\u0301rived\u00a0\u2003value  ",
            },
            sourceName: "  Prote\u0301in\u00a0\u2003source  ",
            sourceNutrientId: "\u00a0 1003 \u2003",
            value: { amount: "12500", quality: "measured", state: "known" },
          },
          {
            canonicalNutrientId: null,
            canonicalUnit: null,
            originalUnit: "g",
            provenance: { dataPoints: null, derivationCode: null },
            sourceName: atSourceNameLimit,
            sourceNutrientId: "1004",
            value: { amount: "1", quality: "measured", state: "known" },
          },
          {
            canonicalNutrientId: null,
            canonicalUnit: null,
            originalUnit: "g",
            provenance: { dataPoints: null, derivationCode: null },
            sourceName: overSourceNameLimit,
            sourceNutrientId: "1005",
            value: { amount: "1", quality: "measured", state: "known" },
          },
          boundaryNutrient("bound-accepted", "999999999999.999999999999"),
          boundaryNutrient("bound-product-integer", "999999999999.999999999999"),
          boundaryNutrient("bound-product-scale", "0.000000000001"),
          boundaryNutrient("bound-input-integer", "1000000000000"),
          boundaryNutrient("bound-input-scale", "0.0000000000001"),
          boundaryNutrient("bound-known-exponent-accepted", 0.000001),
          boundaryNutrient("bound-known-exponent-excluded", 1e-7),
          traceBoundaryNutrient("bound-trace-exponent-accepted", 0.000001),
          traceBoundaryNutrient("bound-trace-exponent-excluded", 1e-7),
        ],
        releaseKey: "semantic-edge-parity",
        sourceCode,
        sourceRecordId: "edge-parity",
      });
      const edgeCandidate = await stageCandidate(
        fixture.stage,
        fixture.validate,
        sourceCode,
        "semantic-edge-parity",
        mappingDigest,
        edgePayload,
      );
      const edgeNutrients = edgeCandidate.validatedFood.nutrients as readonly JsonObject[];
      expect(edgeNutrients.map((nutrient) => nutrient.nutrientCode)).toEqual([
        "protein",
        "fat",
        "semantic_boundary",
        "semantic_known_exponent_accepted",
        "semantic_trace_exponent_accepted",
      ]);
      expect(findNutrient(edgeNutrients, "protein")).toMatchObject({
        derivationCode: "dérived value",
        sourceName: "Protéin source",
        sourceNutrientId: "1003",
        sourceUnit: "mg",
      });
      expect(findNutrient(edgeNutrients, "fat").sourceName).toBe(atSourceNameLimit);
      expect(findNutrient(edgeNutrients, "semantic_boundary")).toMatchObject({
        amount: "999999999999.999999999999",
        sourceAmount: "999999999999.999999999999",
      });
      expect(findNutrient(edgeNutrients, "semantic_known_exponent_accepted")).toMatchObject({
        amount: "0.000001",
        sourceAmount: "0.000001",
        valueStatus: "measured",
      });
      expect(findNutrient(edgeNutrients, "semantic_trace_exponent_accepted")).toMatchObject({
        amount: "0",
        metadata: { detectionLimit: 0.000001 },
        valueStatus: "trace",
      });
      const edgeWire = JSON.parse(edgeCandidate.validationDocument) as ValidationWireDocument;
      const edgeIssues = JSON.parse(
        edgeWire.records[0]?.validationIssuesDocument ?? "[]",
      ) as readonly { readonly code: string }[];
      expect(edgeIssues.filter((issue) => issue.code === "NUTRIENT_INVALID_FIELDS")).toHaveLength(
        1,
      );
      expect(edgeIssues.filter((issue) => issue.code === "NUTRIENT_AMOUNT_INVALID")).toHaveLength(
        3,
      );
      expect(
        edgeIssues.filter((issue) => issue.code === "NUTRIENT_CONVERSION_NOT_EXACT"),
      ).toHaveLength(2);
      expect(
        edgeIssues.filter((issue) => issue.code === "NUTRIENT_TRACE_LIMIT_INVALID"),
      ).toHaveLength(1);
      await expect(
        validateImportBatch(fixture.validate, edgeCandidate, edgeCandidate.validationDocument),
      ).resolves.toMatchObject({
        excludedNutrientCount: 7,
        nutrientInputCount: 12,
        nutrientMaterializableCount: 5,
        promotionEligible: false,
        unresolvedErrorCount: 1,
        validCount: 1,
      });
      expect(await readSemanticState(fixture.owner, edgeCandidate.batchId)).toMatchObject({
        batchSemanticContract: 1,
        batchStatus: "quarantined",
        recordSemanticContract: 1,
        recordStatus: "valid",
      });

      const scaledNumberPayload = buildFoodPayload({
        basisAmount: 100,
        nutrients: [semanticNutrientInputs()[0] as JsonObject],
        releaseKey: "semantic-numeric-100-scale",
        sourceCode,
        sourceRecordId: "numeric-100-scale",
      });
      const canonicalNumberDocument = canonicalJson(scaledNumberPayload);
      const scaledNumberDocument = canonicalNumberDocument.replace(
        '"basis":{"amount":100,"unit":"g"}',
        '"basis":{"amount":100.0,"unit":"g"}',
      );
      expect(scaledNumberDocument).not.toBe(canonicalNumberDocument);
      const scaledNumberCandidate = await stageCandidate(
        fixture.stage,
        fixture.validate,
        sourceCode,
        "semantic-numeric-100-scale",
        mappingDigest,
        scaledNumberPayload,
        scaledNumberPayload,
        scaledNumberDocument,
      );
      await expect(
        validateImportBatch(
          fixture.validate,
          scaledNumberCandidate,
          scaledNumberCandidate.validationDocument,
        ),
      ).resolves.toMatchObject({
        nutrientMaterializableCount: 1,
        promotionEligible: true,
        validCount: 1,
      });
      expect(await readSemanticState(fixture.owner, scaledNumberCandidate.batchId)).toMatchObject({
        batchSemanticContract: 1,
        recordSemanticContract: 1,
      });

      const scaledStringPayload = buildFoodPayload({
        basisAmount: "100.0",
        nutrients: [semanticNutrientInputs()[0] as JsonObject],
        releaseKey: "semantic-string-100-scale",
        sourceCode,
        sourceRecordId: "string-100-scale",
      });
      const scaledStringCandidate = await stageCandidate(
        fixture.stage,
        fixture.validate,
        sourceCode,
        "semantic-string-100-scale",
        mappingDigest,
        scaledStringPayload,
        { ...scaledStringPayload, basis: { amount: "100", unit: "g" } },
      );
      await expectSemanticRejectionRollsBack(
        fixture.owner,
        scaledStringCandidate.batchId,
        validateImportBatch(
          fixture.validate,
          scaledStringCandidate,
          scaledStringCandidate.validationDocument,
        ),
        "catalogue nutrition semantic basis is not exactly 100 grams",
      );
    });
  });

  it("re-attests against frozen mapping revisions after the active mapping is superseded", async () => {
    await withSemanticFixture(async (fixture) => {
      const token = randomBytes(5).toString("hex");
      const sourceCode = `NF${token.toUpperCase()}`;
      await registerReviewedSource(fixture.owner, sourceCode, `${token}-frozen`);
      await registerSemanticMappings(fixture.owner, sourceCode);
      const mappingDigest = await getSourceNutrientMappingDigest(fixture.owner, sourceCode);
      const payload = buildFoodPayload({
        basisAmount: "100",
        nutrients: [semanticNutrientInputs()[0] as JsonObject],
        releaseKey: "semantic-frozen-mapping",
        sourceCode,
        sourceRecordId: "frozen-mapping",
      });
      const candidate = await stageCandidate(
        fixture.stage,
        fixture.validate,
        sourceCode,
        "semantic-frozen-mapping",
        mappingDigest,
        payload,
      );
      await validateImportBatch(fixture.validate, candidate, candidate.validationDocument);
      const frozenState = await readSemanticState(fixture.owner, candidate.batchId);
      const proteinMapping = requireMapping(candidate.observation, "1003");

      await supersedeSourceNutrientMapping(fixture.owner, {
        changeReason: "Prove semantic replay uses the batch-frozen mapping revision",
        expectedCurrentRevisionId: proteinMapping.revisionId,
        mapping: {
          canonicalNutrient: {
            code: "protein",
            dimension: "mass",
            name: "Protein",
            unit: "g",
          },
          conversionMultiplier: "0.002",
          sourceName: "Protein",
          sourceNutrientKey: "1003",
          sourceUnit: "mg",
        },
        reviewedAt: new Date().toISOString(),
        reviewedBy: "principal:nutrition-semantic-mapping-supersession",
        sourceCode,
      });
      expect(await getSourceNutrientMappingDigest(fixture.owner, sourceCode)).not.toBe(
        mappingDigest,
      );
      await expect(
        attestNutritionSemantics(fixture.owner, candidate.batchId),
      ).resolves.toMatchObject({
        excludedNutrientCount: 0,
        nutrientInputCount: 1,
        nutrientMaterializableCount: 1,
        nutritionSemanticContractVersion: 1,
        nutritionSemanticSha256: frozenState.batchSemanticSha256,
      });
      expect(await readSemanticState(fixture.owner, candidate.batchId)).toEqual(frozenState);
    });
  });

  it("replays pre-attested semantics unchanged while promoting and completed", async () => {
    await withSemanticFixture(async (fixture) => {
      const token = randomBytes(5).toString("hex");
      const sourceCode = `NR${token.toUpperCase()}`;
      await registerReviewedSource(fixture.owner, sourceCode, `${token}-replay`);
      await fixture.owner
        .updateTable("food_source")
        .set({ active: true })
        .where("code", "=", sourceCode)
        .execute();
      await registerSemanticMappings(fixture.owner, sourceCode);
      const mappingDigest = await getSourceNutrientMappingDigest(fixture.owner, sourceCode);
      const payload = buildFoodPayload({
        basisAmount: "100",
        nutrients: [semanticNutrientInputs()[0] as JsonObject],
        releaseKey: "semantic-state-replay",
        sourceCode,
        sourceRecordId: "state-replay",
      });
      const candidate = await stageCandidate(
        fixture.stage,
        fixture.validate,
        sourceCode,
        "semantic-state-replay",
        mappingDigest,
        payload,
      );
      await expect(
        validateImportBatch(fixture.validate, candidate, candidate.validationDocument),
      ).resolves.toMatchObject({
        nutritionSemanticContractVersion: 1,
        promotionEligible: true,
        validCount: 1,
      });
      const readyState = await readSemanticState(fixture.owner, candidate.batchId);
      expect(readyState).toMatchObject({
        batchSemanticContract: 1,
        batchStatus: "ready",
        recordSemanticContract: 1,
      });
      expect(readyState.batchSemanticSha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(readyState.recordSemanticSha256).toMatch(/^[0-9a-f]{64}$/u);

      const releaseId = await seedHistoricalPromotingRelease(fixture.owner, candidate.batchId);
      const promotingState = await readSemanticState(fixture.owner, candidate.batchId);
      expect(promotingState).toEqual({ ...readyState, batchStatus: "promoting" });
      await expect(
        attestNutritionSemantics(fixture.owner, candidate.batchId),
      ).resolves.toMatchObject({
        nutritionSemanticContractVersion: 1,
        nutritionSemanticSha256: readyState.batchSemanticSha256,
      });
      expect(await readSemanticState(fixture.owner, candidate.batchId)).toEqual(promotingState);

      await completeHistoricalPromotingRelease(fixture.owner, candidate.batchId, releaseId);
      const completedState = await readSemanticState(fixture.owner, candidate.batchId);
      expect(completedState).toEqual({ ...promotingState, batchStatus: "completed" });
      await expect(
        attestNutritionSemantics(fixture.owner, candidate.batchId),
      ).resolves.toMatchObject({
        nutritionSemanticContractVersion: 1,
        nutritionSemanticSha256: readyState.batchSemanticSha256,
      });
      expect(await readSemanticState(fixture.owner, candidate.batchId)).toEqual(completedState);
    });
  });

  it("blocks approval, promotion, owner backfill, and rollback when legacy validation lacks semantic attestation", async () => {
    await withSemanticFixture(async (fixture) => {
      const token = randomBytes(5).toString("hex");
      const sourceCode = `NL${token.toUpperCase()}`;
      await registerReviewedSource(fixture.owner, sourceCode, `${token}-legacy`);
      await fixture.owner
        .updateTable("food_source")
        .set({ active: true })
        .where("code", "=", sourceCode)
        .execute();
      await registerSemanticMappings(fixture.owner, sourceCode);
      const mappingDigest = await getSourceNutrientMappingDigest(fixture.owner, sourceCode);
      const payload = buildFoodPayload({
        basisAmount: "100",
        nutrients: [semanticNutrientInputs()[0] as JsonObject],
        releaseKey: "semantic-legacy-v1",
        sourceCode,
        sourceRecordId: "legacy-v1",
      });
      const candidate = await stageCandidate(
        fixture.owner,
        fixture.owner,
        sourceCode,
        "semantic-legacy-v1",
        mappingDigest,
        payload,
      );

      const legacyResult = await validateImportBatchV1(
        fixture.owner,
        candidate,
        candidate.validationDocument,
      );
      expect(legacyResult).toMatchObject({
        promotionEligible: true,
        validCount: 1,
      });
      const batch = (
        await sql<{
          readonly nutritionSemanticContractVersion: number | null;
          readonly nutritionSemanticSha256: string | null;
          readonly rightsManifestSha256: string;
          readonly validationDigest: string;
        }>`
          select
            nutrition_semantic_contract_version as "nutritionSemanticContractVersion",
            nutrition_semantic_sha256 as "nutritionSemanticSha256",
            rights_manifest_sha256 as "rightsManifestSha256",
            validation_digest as "validationDigest"
          from public.food_import_batch
          where id = ${candidate.batchId}::uuid
        `.execute(fixture.owner)
      ).rows[0];
      if (!batch) throw new Error("Legacy semantic batch is unavailable");
      expect(batch).toMatchObject({
        nutritionSemanticContractVersion: null,
        nutritionSemanticSha256: null,
      });

      await expectPostgresCode(
        recordApproval(
          fixture.owner,
          candidate.batchId,
          batch.validationDigest,
          batch.rightsManifestSha256,
        ),
        "55000",
        "nutrition semantic attestation",
      );
      await expectPostgresCode(
        promoteImportBatch(fixture.owner, candidate.batchId),
        "55000",
        "nutrition semantic attestation",
      );
      expect(
        (
          await sql<{ readonly approvalCount: number }>`
            select pg_catalog.count(*)::integer as "approvalCount"
            from public.food_import_approval
            where batch_id = ${candidate.batchId}::uuid
          `.execute(fixture.owner)
        ).rows[0],
      ).toEqual({ approvalCount: 0 });

      const historicalReleaseId = await seedHistoricalPromotingRelease(
        fixture.owner,
        candidate.batchId,
      );
      const unattestedPromotingState = await readSemanticState(fixture.owner, candidate.batchId);
      expect(unattestedPromotingState).toMatchObject({
        batchSemanticContract: null,
        batchSemanticSha256: null,
        batchStatus: "promoting",
        recordSemanticContract: null,
        recordSemanticSha256: null,
        recordStatus: "valid",
      });
      await expectPostgresCode(
        attestNutritionSemantics(fixture.owner, candidate.batchId),
        "55000",
        "cannot backfill a completed or promoting batch",
      );
      expect(await readSemanticState(fixture.owner, candidate.batchId)).toEqual(
        unattestedPromotingState,
      );
      await completeHistoricalPromotingRelease(
        fixture.owner,
        candidate.batchId,
        historicalReleaseId,
      );
      const unattestedCompletedState = await readSemanticState(fixture.owner, candidate.batchId);
      expect(unattestedCompletedState).toMatchObject({
        batchSemanticContract: null,
        batchSemanticSha256: null,
        batchStatus: "completed",
        recordSemanticContract: null,
        recordSemanticSha256: null,
        recordStatus: "valid",
      });
      await expectPostgresCode(
        attestNutritionSemantics(fixture.owner, candidate.batchId),
        "55000",
        "cannot backfill a completed or promoting batch",
      );
      expect(await readSemanticState(fixture.owner, candidate.batchId)).toEqual(
        unattestedCompletedState,
      );
      await expectPostgresCode(
        rollbackSourceRelease(fixture.owner, sourceCode, historicalReleaseId),
        "55000",
        "nutrition semantic attestation",
      );
      expect(
        (
          await sql<{
            readonly activeReleaseId: string | null;
            readonly rollbackCount: number;
          }>`
            select
              source.active_release_id as "activeReleaseId",
              (
                select pg_catalog.count(*)::integer
                from public.food_source_release_activation as activation
                where activation.food_source_id = source.id
                  and activation.operation = 'rollback'
              ) as "rollbackCount"
            from public.food_source as source
            where source.code = ${sourceCode}
          `.execute(fixture.owner)
        ).rows[0],
      ).toEqual({ activeReleaseId: null, rollbackCount: 0 });

      const incompleteBatchSemanticSha256 = "0".repeat(64);
      await sql`
        update public.food_import_batch
        set
          nutrition_semantic_contract_version = 1,
          nutrition_semantic_sha256 = ${incompleteBatchSemanticSha256}
        where id = ${candidate.batchId}::uuid
      `.execute(fixture.owner);
      const incompleteRecordState = await readSemanticState(fixture.owner, candidate.batchId);
      expect(incompleteRecordState).toMatchObject({
        batchSemanticContract: 1,
        batchSemanticSha256: incompleteBatchSemanticSha256,
        batchStatus: "completed",
        recordSemanticContract: null,
        recordSemanticSha256: null,
      });
      await expectPostgresCode(
        attestNutritionSemantics(fixture.owner, candidate.batchId),
        "55000",
        "verification requires prior record attestation",
      );
      expect(await readSemanticState(fixture.owner, candidate.batchId)).toEqual(
        incompleteRecordState,
      );
    });
  });
});

async function withSemanticFixture(
  operation: (fixture: SemanticFixture) => Promise<void>,
): Promise<void> {
  if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
  assertLoopbackDatabaseUrl(databaseUrl);
  const bootstrap = createDatabase({
    applicationName: "catalogue-nutrition-semantics-bootstrap",
    connectionString: databaseUrl,
    maxConnections: 1,
  });
  const token = randomBytes(6).toString("hex");
  const ephemeralDatabaseName = `catalogue_nutrition_semantics_${token}`;
  const fixtures = {
    stage: {
      capability: "nutrition_catalogue_stage",
      login: `cat_ns_stage_${token}`,
      password: randomBytes(24).toString("hex"),
    },
    validate: {
      capability: "nutrition_catalogue_validate",
      login: `cat_ns_validate_${token}`,
      password: randomBytes(24).toString("hex"),
    },
  } as const satisfies Record<string, LoginFixture>;
  const fixtureList = Object.values(fixtures);
  const clients: Kysely<Database>[] = [];
  let cleanupReserved = false;
  let owner: Kysely<Database> | undefined;
  let primaryFailure: unknown;
  const cleanupFailures: unknown[] = [];

  try {
    const databaseState = (
      await sql<{
        readonly name: string;
        readonly owner: string;
        readonly sessionPrincipal: string;
      }>`
        select
          database_row.datname as name,
          pg_catalog.pg_get_userbyid(database_row.datdba) as owner,
          session_user as "sessionPrincipal"
        from pg_catalog.pg_database as database_row
        where database_row.datname = pg_catalog.current_database()
      `.execute(bootstrap)
    ).rows[0];
    if (!databaseState) throw new Error("Test database identity is unavailable");
    if (databaseState.owner !== databaseState.sessionPrincipal) {
      throw new Error("TEST_DATABASE_URL must authenticate as the local test database owner");
    }

    const collision = (
      await sql<{ readonly exists: boolean }>`
        select
          exists (
            select 1
            from pg_catalog.pg_database as database_row
            where database_row.datname = ${ephemeralDatabaseName}
          ) or exists (
            select 1
            from pg_catalog.pg_roles as role_row
            where role_row.rolname in (${sql.join(
              fixtureList.map((fixture) => sql`${fixture.login}`),
            )})
          ) as exists
      `.execute(bootstrap)
    ).rows[0]?.exists;
    if (collision !== false) {
      throw new Error("Generated catalogue nutrition semantic resources already exist");
    }
    cleanupReserved = true;

    await sql`
      create database ${sql.id(ephemeralDatabaseName)}
      owner ${sql.id(databaseState.owner)}
      template template0
    `.execute(bootstrap);
    const ownerUrl = databaseUrlForName(databaseUrl, ephemeralDatabaseName);
    const ownerClient = createDatabase({
      applicationName: "catalogue-nutrition-semantics-owner",
      connectionString: ownerUrl,
      maxConnections: 2,
    });
    owner = ownerClient;
    await runMigrations(ownerClient);
    await sql`
      revoke connect on database ${sql.id(ephemeralDatabaseName)} from public
    `.execute(bootstrap);

    const validUntil = new Date(Date.now() + 10 * 60 * 1_000).toISOString();
    for (const fixture of fixtureList) {
      await sql`
        create role ${sql.id(fixture.login)}
        login inherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls
        connection limit 1
        password ${sql.lit(fixture.password)}
        valid until ${sql.lit(validUntil)}
      `.execute(bootstrap);
      await sql`
        grant connect on database ${sql.id(ephemeralDatabaseName)}
        to ${sql.id(fixture.login)}
      `.execute(bootstrap);
      await sql`
        grant ${sql.id(fixture.capability)} to ${sql.id(fixture.login)}
        with admin false, inherit true, set false
      `.execute(bootstrap);
    }

    const createLoginClient = (fixture: LoginFixture): Kysely<Database> => {
      const url = new URL(ownerUrl);
      url.username = fixture.login;
      url.password = fixture.password;
      const client = createDatabase({
        applicationName: `catalogue-nutrition-semantics-${fixture.login}`,
        connectionString: url.toString(),
        maxConnections: 1,
      });
      clients.push(client);
      return client;
    };
    await operation({
      owner: ownerClient,
      stage: createLoginClient(fixtures.stage),
      stageLogin: fixtures.stage.login,
      validate: createLoginClient(fixtures.validate),
      validateLogin: fixtures.validate.login,
    });
  } catch (error) {
    primaryFailure = error;
  } finally {
    const attemptCleanup = async (cleanup: () => Promise<unknown>): Promise<void> => {
      try {
        await cleanup();
      } catch (error) {
        cleanupFailures.push(error);
      }
    };
    for (const client of clients) await attemptCleanup(() => client.destroy());
    const ownerClient = owner;
    if (ownerClient) await attemptCleanup(() => ownerClient.destroy());
    if (cleanupReserved) {
      await attemptCleanup(() =>
        sql`drop database if exists ${sql.id(ephemeralDatabaseName)}`.execute(bootstrap),
      );
      for (const fixture of [...fixtureList].reverse()) {
        await attemptCleanup(() =>
          sql`drop role if exists ${sql.id(fixture.login)}`.execute(bootstrap),
        );
      }
      await attemptCleanup(async () => {
        const residue = (
          await sql<{ readonly exists: boolean }>`
            select
              exists (
                select 1
                from pg_catalog.pg_database as database_row
                where database_row.datname = ${ephemeralDatabaseName}
              ) or exists (
                select 1
                from pg_catalog.pg_roles as role_row
                where role_row.rolname in (${sql.join(
                  fixtureList.map((fixture) => sql`${fixture.login}`),
                )})
              ) as exists
          `.execute(bootstrap)
        ).rows[0]?.exists;
        if (residue !== false) {
          throw new Error("Catalogue nutrition semantic cleanup left database or role residue");
        }
      });
    }
    await attemptCleanup(() => bootstrap.destroy());
  }

  if (primaryFailure !== undefined || cleanupFailures.length > 0) {
    throw new AggregateError(
      [...(primaryFailure === undefined ? [] : [primaryFailure]), ...cleanupFailures],
      "Catalogue nutrition semantic integration test or cleanup failed",
    );
  }
}

async function registerReviewedSource(
  database: Kysely<Database>,
  sourceCode: string,
  suffix: string,
): Promise<void> {
  await registerFoodSourceFromReviewedManifest(database, {
    attributionRequired: true,
    attributionText: "Catalogue nutrition semantic integration fixture",
    code: sourceCode,
    commercialUseAllowed: true,
    databaseRightsNotes: "Synthetic loopback-only integration fixture",
    displayName: `Nutrition semantic source ${suffix}`,
    homepageUrl: "https://example.invalid/catalogue-nutrition-semantics",
    kind: "government",
    licenseExpression: "CC0-1.0",
    licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
    redistributionAllowed: true,
    rightsReviewStatus: "approved",
    rightsReviewedAt: new Date(Date.now() - 120_000).toISOString(),
    rightsReviewedBy: "principal:nutrition-semantic-rights-review",
  });
}

async function registerSemanticMappings(
  database: Kysely<Database>,
  sourceCode: string,
): Promise<void> {
  await registerSourceNutrientMappings(database, {
    mappings: [
      {
        canonicalNutrient: {
          code: "protein",
          dimension: "mass",
          name: "Protein",
          unit: "g",
        },
        conversionMultiplier: "0.001",
        sourceName: "Protein",
        sourceNutrientKey: "1003",
        sourceUnit: "mg",
      },
      {
        canonicalNutrient: {
          code: "fat",
          dimension: "mass",
          name: "Total fat",
          unit: "g",
        },
        conversionMultiplier: "1",
        sourceName: "Total fat",
        sourceNutrientKey: "1004",
        sourceUnit: "g",
      },
      {
        canonicalNutrient: {
          code: "carbohydrate",
          dimension: "mass",
          name: "Carbohydrate",
          unit: "g",
        },
        conversionMultiplier: "1",
        sourceName: "Carbohydrate",
        sourceNutrientKey: "1005",
        sourceUnit: "g",
      },
      {
        canonicalNutrient: {
          code: "fiber",
          dimension: "mass",
          name: "Fiber",
          unit: "g",
        },
        conversionMultiplier: "1",
        sourceName: "Fiber",
        sourceNutrientKey: "1079",
        sourceUnit: "g",
      },
    ],
    reviewedAt: new Date(Date.now() - 60_000).toISOString(),
    reviewedBy: "principal:nutrition-semantic-mapping-review",
    sourceCode,
  });
}

async function registerBoundaryMappings(
  database: Kysely<Database>,
  sourceCode: string,
): Promise<void> {
  const definitions = [
    {
      code: "semantic_boundary",
      multiplier: "1",
      name: "Semantic boundary",
      sourceNutrientKey: "bound-accepted",
    },
    {
      code: "semantic_product_integer",
      multiplier: "10",
      name: "Semantic product integer overflow",
      sourceNutrientKey: "bound-product-integer",
    },
    {
      code: "semantic_product_scale",
      multiplier: "0.1",
      name: "Semantic product scale overflow",
      sourceNutrientKey: "bound-product-scale",
    },
    {
      code: "semantic_input_integer",
      multiplier: "1",
      name: "Semantic input integer overflow",
      sourceNutrientKey: "bound-input-integer",
    },
    {
      code: "semantic_input_scale",
      multiplier: "1",
      name: "Semantic input scale overflow",
      sourceNutrientKey: "bound-input-scale",
    },
    {
      code: "semantic_known_exponent_accepted",
      multiplier: "1",
      name: "Semantic known exponent accepted",
      sourceNutrientKey: "bound-known-exponent-accepted",
    },
    {
      code: "semantic_known_exponent_excluded",
      multiplier: "1",
      name: "Semantic known exponent excluded",
      sourceNutrientKey: "bound-known-exponent-excluded",
    },
    {
      code: "semantic_trace_exponent_accepted",
      multiplier: "1",
      name: "Semantic trace exponent accepted",
      sourceNutrientKey: "bound-trace-exponent-accepted",
    },
    {
      code: "semantic_trace_exponent_excluded",
      multiplier: "1",
      name: "Semantic trace exponent excluded",
      sourceNutrientKey: "bound-trace-exponent-excluded",
    },
  ] as const;
  await registerSourceNutrientMappings(database, {
    mappings: definitions.map((definition) => ({
      canonicalNutrient: {
        code: definition.code,
        dimension: "mass" as const,
        name: definition.name,
        unit: "g",
      },
      conversionMultiplier: definition.multiplier,
      sourceName: definition.name,
      sourceNutrientKey: definition.sourceNutrientKey,
      sourceUnit: "g",
    })),
    reviewedAt: new Date(Date.now() - 60_000).toISOString(),
    reviewedBy: "principal:nutrition-semantic-boundary-review",
    sourceCode,
  });
}

function semanticNutrientInputs(): readonly JsonObject[] {
  return [
    {
      canonicalNutrientId: "caller-protein-id-is-untrusted",
      canonicalUnit: "caller-unit-is-untrusted",
      originalUnit: "mg",
      provenance: { dataPoints: 7, derivationCode: "analytical" },
      sourceName: "Protein",
      sourceNutrientId: "1003",
      value: { amount: "12500", quality: "measured", state: "known" },
    },
    {
      canonicalNutrientId: null,
      canonicalUnit: null,
      originalUnit: "g",
      provenance: { dataPoints: 3, derivationCode: "analytical" },
      sourceName: "Carbohydrate",
      sourceNutrientId: "1005",
      value: { amount: "0", quality: "measured", state: "known" },
    },
    {
      canonicalNutrientId: null,
      canonicalUnit: null,
      originalUnit: "g",
      provenance: { dataPoints: null, derivationCode: "below-detection" },
      sourceName: "Total fat",
      sourceNutrientId: "1004",
      value: { detectionLimit: "0.01", state: "trace" },
    },
    {
      canonicalNutrientId: null,
      canonicalUnit: null,
      originalUnit: "g",
      provenance: null,
      sourceName: "Fiber",
      sourceNutrientId: "1079",
      value: { reason: "not_reported", state: "unknown" },
    },
  ];
}

function buildFoodPayload(input: {
  readonly basisAmount: string | number;
  readonly nutrients: readonly JsonObject[];
  readonly releaseKey: string;
  readonly sourceCode: string;
  readonly sourceRecordId: string;
}): JsonObject {
  const sourceRecordKey = `${input.sourceCode}:${input.releaseKey}:Foundation:${input.sourceRecordId}`;
  return {
    basis: { amount: input.basisAmount, unit: "g" },
    idempotencyKey: sourceRecordKey,
    identity: {
      brandOwner: null,
      description: `Semantic food ${input.sourceRecordId}`,
      descriptionFr: null,
      gtin: null,
    },
    nutrients: [...input.nutrients],
    schemaVersion: 1,
    servings: [],
    source: {
      languageTag: "en-US",
      marketCode: "US",
      releaseKey: input.releaseKey,
      sourceCode: input.sourceCode,
      sourceDataType: "Foundation",
      sourceModifiedAt: "2026-09-06T00:00:00.000Z",
      sourceRecordId: input.sourceRecordId,
    },
    sourcePayloadHash: sourcePayloadDigest(sourceRecordKey),
    unlistedNutrientPolicy: "unknown_not_reported",
  };
}

async function stageCandidate(
  stageDatabase: Kysely<Database>,
  validateDatabase: Kysely<Database>,
  sourceCode: string,
  releaseKey: string,
  mappingDigest: string,
  payload: JsonObject,
  validatorPayload: JsonObject = payload,
  canonicalPayloadDocument: string = canonicalJson(payload),
): Promise<Candidate> {
  const stageDocument = buildStageDocument(sourceCode, releaseKey, mappingDigest);
  const batch = await stageImportBatch(
    stageDatabase,
    canonicalJson(stageDocument as unknown as JsonValue),
  );
  const record = buildStagedRecord(payload, canonicalPayloadDocument);
  const chunk = await stageRecordChunk(
    stageDatabase,
    batch.batchId,
    canonicalJson({
      records: [
        {
          canonicalPayloadDocument: record.canonicalPayloadDocument,
          canonicalPayloadSha256: record.canonicalPayloadSha256,
          sequenceNumber: record.sequenceNumber,
          sourcePayloadSha256: record.sourcePayloadSha256,
          sourceRecordKey: record.sourceRecordKey,
          sourceRecordType: record.sourceRecordType,
        },
      ],
      schemaVersion: 1,
    }),
  );
  expect(chunk).toMatchObject({ inserted: 1, nextOffset: 1, stagedCount: 1 });

  const nutrients = payload.nutrients as readonly JsonValue[];
  const servings = payload.servings as readonly JsonValue[];
  const reportDocument = canonicalJson({
    releaseKey,
    reportKind: "catalogue-nutrition-semantic-integration",
    schemaVersion: 1,
  });
  const parserReportDocument = canonicalJson({
    emittedNutrientCount: nutrients.length,
    emittedPortionCount: servings.length,
    emittedRecordCount: 1,
    excludedNutrientCount: 0,
    excludedPortionCount: 0,
    excludedRecordCount: 0,
    reportDocument,
    reportSha256: sha256Text(reportDocument),
    schemaVersion: 1,
    sourceNutrientCount: nutrients.length,
    sourcePortionCount: servings.length,
    sourceRecordCount: 1,
  });
  const seal = await stageParserReport(stageDatabase, batch.batchId, parserReportDocument);
  const observation = await observeValidation(validateDatabase, batch.batchId);
  const reviewedMappings = new Map<string, ReviewedCatalogueNutrientMapping>(
    observation.observation.nutrientMappings.map((mapping) => [
      mapping.sourceNutrientKey,
      {
        canonicalUnit: mapping.canonicalUnit,
        conversionMultiplier: mapping.conversionMultiplier,
        mappingRevisionId: mapping.revisionId,
        nutrientCode: mapping.nutrientCode,
        nutrientId: mapping.nutrientId,
        sourceNutrientId: mapping.sourceNutrientKey,
        sourceUnit: mapping.sourceUnit,
      },
    ]),
  );
  const validation = validateCatalogueRecord(
    validatorPayload,
    {
      // A malicious validator can recompute its own output from a modified view;
      // the database must compare that output with the sealed canonical row.
      canonicalPayloadSha256: sha256Text(canonicalJson(validatorPayload)),
      expectedReleaseKey: releaseKey,
      expectedSourceCode: sourceCode,
      sourcePayloadSha256: record.sourcePayloadSha256,
      sourceRecordKey: record.sourceRecordKey,
      sourceRecordType: record.sourceRecordType,
    },
    reviewedMappings,
  );
  if (!validation.recordIsValid || !validation.food) {
    throw new Error("Application validator did not produce the expected valid semantic fixture");
  }
  const validatedFood = validation.food as unknown as JsonObject;
  return {
    batchId: batch.batchId,
    observation,
    record,
    stagingSealSha256: seal.stagingSealSha256,
    validatedFood,
    validationDocument: buildValidationDocument(
      observation,
      mappingDigest,
      record,
      validatedFood,
      validation.excludedNutrientCount,
      validation.issues as readonly JsonObject[],
      validation.nutrientInputCount,
      validation.nutrientMaterializableCount,
      validation.portionInputCount,
    ),
  };
}

function buildStageDocument(
  sourceCode: string,
  releaseKey: string,
  mappingDigest: string,
): StageDocument {
  const artifactSha256 = sha256Text(`${sourceCode}:${releaseKey}:artifact`);
  const evidenceBundleSha256 = sha256Text(`${sourceCode}:${releaseKey}:evidence-bundle`);
  const parserBuildSha256 = sha256Text(`${sourceCode}:${releaseKey}:parser-build`);
  const rightsManifestSha256 = sha256Text(`${sourceCode}:rights-manifest`);
  return {
    acquiredAt: new Date(Date.now() - 30_000).toISOString(),
    artifactBytes: 2_048,
    artifactSha256,
    artifactUri: `s3://catalogue-nutrition-semantics/${sourceCode}/${releaseKey}.json`,
    evidenceBundleSha256,
    evidenceBundleUri: `s3://catalogue-evidence/sha256/${evidenceBundleSha256}/bundle.json`,
    evidenceDecisionSha256: sha256Text(`${sourceCode}:${releaseKey}:evidence-decision`),
    evidenceObjectVersionId: `fixture-${evidenceBundleSha256}`,
    evidenceValidUntil: new Date(Date.now() + 12 * 60 * 60 * 1_000).toISOString(),
    mediaType: "application/json",
    parserVersion: `semantic-parser@1.0.0+build.${parserBuildSha256}+mapping.${mappingDigest}`,
    publishedOn: "2026-09-06",
    releaseClass: "live-reviewed",
    releaseKey,
    rightsManifestSha256,
    rightsManifestUri: `repo://manifests/${sourceCode}.json`,
    schemaVersion: 1,
    sourceCode,
    upstreamSchemaVersion: "nutrition-semantic-integration-v1",
  };
}

function buildStagedRecord(
  payload: JsonObject,
  canonicalPayloadDocument: string = canonicalJson(payload),
): StagedRecord {
  const sourceRecordKey = payload.idempotencyKey;
  if (typeof sourceRecordKey !== "string") {
    throw new Error("Semantic fixture idempotency key is unavailable");
  }
  const source = payload.source as JsonObject;
  const sourceRecordType = source.sourceDataType;
  if (typeof sourceRecordType !== "string") {
    throw new Error("Semantic fixture source record type is unavailable");
  }
  return {
    canonicalPayloadDocument,
    canonicalPayloadSha256: sha256Text(canonicalPayloadDocument),
    payload,
    sequenceNumber: 0,
    sourcePayloadSha256: sourcePayloadDigest(sourceRecordKey),
    sourceRecordKey,
    sourceRecordType,
  };
}

function buildValidationDocument(
  observationResult: ValidationObservationResult,
  nutrientMappingDigest: string,
  record: StagedRecord,
  validatedFood: JsonObject,
  excludedNutrientCount: number,
  issues: readonly JsonObject[],
  nutrientInputCount: number,
  nutrientMaterializableCount: number,
  portionInputCount: number,
): string {
  const { batch, nutrientMappings, parserReport } = observationResult.observation;
  const policy: JsonObject = {
    maximumExcludedNutrientFraction: 0,
    maximumQuarantineFraction: 0,
    maximumQuarantinedRecords: 0,
    requireAtLeastOneValidRecord: true,
    requireDistinctApprovalPrincipals: true,
    requireMaterializedNutrientPerValidRecord: true,
  };
  const validatedFoodDocument = canonicalJson(validatedFood);
  const validatedFoodSha256 = sha256Text(validatedFoodDocument);
  const digestDocument = canonicalJson({
    artifactSha256: batch.artifactSha256,
    batchId: batch.id,
    evidenceBundleSha256: batch.evidenceBundleSha256,
    evidenceBundleUri: batch.evidenceBundleUri,
    evidenceDecisionSha256: batch.evidenceDecisionSha256,
    evidenceObjectVersionId: batch.evidenceObjectVersionId,
    evidenceValidUntil: batch.evidenceValidUntil,
    nutrientMappingDigest,
    nutrientMappingRevisionIds: nutrientMappings.map((mapping) => mapping.revisionId).sort(),
    observationSha256: observationResult.observationSha256,
    parserEvidence: {
      emittedNutrientCount: parserReport.emittedNutrientCount,
      emittedPortionCount: parserReport.emittedPortionCount,
      emittedRecordCount: parserReport.emittedRecordCount,
      excludedNutrientCount: parserReport.excludedNutrientCount,
      excludedPortionCount: parserReport.excludedPortionCount,
      excludedRecordCount: parserReport.excludedRecordCount,
      sourceNutrientCount: parserReport.sourceNutrientCount,
      sourcePortionCount: parserReport.sourcePortionCount,
      sourceRecordCount: parserReport.sourceRecordCount,
    },
    parserReportSha256: parserReport.reportSha256,
    policy,
    records: [
      {
        canonicalPayloadSha256: record.canonicalPayloadSha256,
        excludedNutrientCount,
        issues,
        nutrientInputCount,
        nutrientMaterializableCount,
        portionInputCount,
        sourceRecordKey: record.sourceRecordKey,
        status: "valid",
        validatedFoodContractVersion: 1,
        validatedFoodSha256,
      },
    ],
    releaseClass: batch.releaseClass,
    rightsManifestSha256: batch.rightsManifestSha256,
    validatedFoodContractVersion: 1,
  });
  return canonicalJson({
    digestDocument,
    records: [
      {
        sourceRecordKey: record.sourceRecordKey,
        validatedFoodDocument,
        validationIssuesDocument: canonicalJson(issues as unknown as JsonValue),
      },
    ],
    schemaVersion: 1,
  });
}

function rewriteValidatedFood(
  validationDocument: string,
  rewrite: (nutrients: readonly JsonObject[]) => readonly JsonObject[],
  nutrientMaterializableCount?: number,
): string {
  return rewriteValidatedFoodDocument(
    validationDocument,
    (food) => ({
      ...food,
      nutrients: rewrite(food.nutrients as readonly JsonObject[]),
    }),
    nutrientMaterializableCount,
  );
}

function rewriteValidatedFoodDocument(
  validationDocument: string,
  rewrite: (food: JsonObject) => JsonObject,
  nutrientMaterializableCount?: number,
): string {
  const wire = JSON.parse(validationDocument) as ValidationWireDocument;
  const resultRecord = wire.records[0];
  if (
    !resultRecord ||
    wire.records.length !== 1 ||
    typeof resultRecord.validatedFoodDocument !== "string"
  ) {
    throw new Error("Semantic validation fixture must contain one valid result record");
  }
  const food = JSON.parse(resultRecord.validatedFoodDocument) as JsonObject;
  const rewrittenFoodDocument = canonicalJson(rewrite(food));
  const digest = JSON.parse(wire.digestDocument) as JsonObject;
  const digestRecords = digest.records as readonly JsonObject[];
  const digestRecord = digestRecords[0];
  if (!digestRecord || digestRecords.length !== 1) {
    throw new Error("Semantic validation digest must contain one record");
  }
  const rewrittenDigestRecord: JsonObject = {
    ...digestRecord,
    ...(nutrientMaterializableCount === undefined ? {} : { nutrientMaterializableCount }),
    validatedFoodSha256: sha256Text(rewrittenFoodDocument),
  };
  return canonicalJson({
    digestDocument: canonicalJson({ ...digest, records: [rewrittenDigestRecord] }),
    records: [{ ...resultRecord, validatedFoodDocument: rewrittenFoodDocument }],
    schemaVersion: wire.schemaVersion,
  });
}

function findNutrient(nutrients: readonly JsonObject[], nutrientCode: string): JsonObject {
  const nutrient = nutrients.find((candidate) => candidate.nutrientCode === nutrientCode);
  if (!nutrient) throw new Error(`Frozen nutrient ${nutrientCode} is unavailable`);
  return nutrient;
}

function requireMapping(
  observation: ValidationObservationResult,
  sourceNutrientKey: string,
): MappingObservation {
  const mapping = observation.observation.nutrientMappings.find(
    (candidate) => candidate.sourceNutrientKey === sourceNutrientKey,
  );
  if (!mapping) throw new Error(`Reviewed mapping ${sourceNutrientKey} is unavailable`);
  return mapping;
}

function sourcePayloadDigest(sourceRecordKey: string): string {
  return sha256Text(`${sourceRecordKey}:source-payload`);
}

async function stageImportBatch(
  database: Kysely<Database>,
  stageDocument: string,
): Promise<{ readonly batchId: string }> {
  const result = (
    await sql<{ readonly result: { readonly batchId: string } }>`
      select public.catalogue_stage_import_batch(${stageDocument}::text) as result
    `.execute(database)
  ).rows[0]?.result;
  if (!result) throw new Error("Catalogue stage function returned no result");
  return result;
}

async function stageRecordChunk(
  database: Kysely<Database>,
  batchId: string,
  recordsDocument: string,
): Promise<Record<string, unknown>> {
  const result = (
    await sql<{ readonly result: Record<string, unknown> }>`
      select public.catalogue_stage_import_record_chunk(
        ${batchId}::uuid,
        0::bigint,
        ${recordsDocument}::text
      ) as result
    `.execute(database)
  ).rows[0]?.result;
  if (!result) throw new Error("Catalogue stage-chunk function returned no result");
  return result;
}

async function stageParserReport(
  database: Kysely<Database>,
  batchId: string,
  parserReportDocument: string,
): Promise<{ readonly stagingSealSha256: string }> {
  const result = (
    await sql<{ readonly result: { readonly stagingSealSha256: string } }>`
      select public.catalogue_stage_import_parser_report(
        ${batchId}::uuid,
        ${parserReportDocument}::text
      ) as result
    `.execute(database)
  ).rows[0]?.result;
  if (!result) throw new Error("Catalogue parser-seal function returned no result");
  return result;
}

async function observeValidation(
  database: Kysely<Database>,
  batchId: string,
): Promise<ValidationObservationResult> {
  const result = (
    await sql<{ readonly result: ValidationObservationResult }>`
      select public.catalogue_observe_import_validation(${batchId}::uuid) as result
    `.execute(database)
  ).rows[0]?.result;
  if (!result) throw new Error("Catalogue validation observation returned no result");
  return result;
}

async function validateImportBatch(
  database: Kysely<Database>,
  candidate: Candidate,
  validationDocument: string,
): Promise<Record<string, unknown>> {
  const result = (
    await sql<{ readonly result: Record<string, unknown> }>`
      select public.catalogue_validate_import_batch(
        ${candidate.batchId}::uuid,
        ${candidate.stagingSealSha256}::text,
        ${candidate.observation.observationSha256}::text,
        ${validationDocument}::text
      ) as result
    `.execute(database)
  ).rows[0]?.result;
  if (!result) throw new Error("Catalogue semantic validation function returned no result");
  return result;
}

async function attestNutritionSemantics(
  database: Kysely<Database>,
  batchId: string,
): Promise<Record<string, unknown>> {
  const result = (
    await sql<{ readonly result: Record<string, unknown> }>`
      select public.catalogue_attest_import_nutrition_semantics(${batchId}::uuid) as result
    `.execute(database)
  ).rows[0]?.result;
  if (!result) throw new Error("Catalogue nutrition semantic attestation returned no result");
  return result;
}

async function validateImportBatchV1(
  database: Kysely<Database>,
  candidate: Candidate,
  validationDocument: string,
): Promise<Record<string, unknown>> {
  const result = (
    await sql<{ readonly result: Record<string, unknown> }>`
      select public.catalogue_validate_import_batch_v1(
        ${candidate.batchId}::uuid,
        ${candidate.stagingSealSha256}::text,
        ${candidate.observation.observationSha256}::text,
        ${validationDocument}::text
      ) as result
    `.execute(database)
  ).rows[0]?.result;
  if (!result) throw new Error("Legacy catalogue validation function returned no result");
  return result;
}

async function expectSemanticRejectionRollsBack(
  database: Kysely<Database>,
  batchId: string,
  operation: Promise<unknown>,
  expectedMessage?: string,
): Promise<void> {
  await expectPostgresCode(operation, "55000", expectedMessage);
  expect(await readSemanticState(database, batchId)).toEqual({
    batchSemanticContract: null,
    batchSemanticSha256: null,
    batchStatus: "staging",
    recordSemanticContract: null,
    recordSemanticSha256: null,
    recordStatus: "pending",
    validatedFoodDocument: null,
    validationDigest: null,
  });
}

async function readSemanticState(
  database: Kysely<Database>,
  batchId: string,
): Promise<{
  readonly batchSemanticContract: number | null;
  readonly batchSemanticSha256: string | null;
  readonly batchStatus: string;
  readonly recordSemanticContract: number | null;
  readonly recordSemanticSha256: string | null;
  readonly recordStatus: string;
  readonly validatedFoodDocument: string | null;
  readonly validationDigest: string | null;
}> {
  const state = (
    await sql<{
      readonly batchSemanticContract: number | null;
      readonly batchSemanticSha256: string | null;
      readonly batchStatus: string;
      readonly recordSemanticContract: number | null;
      readonly recordSemanticSha256: string | null;
      readonly recordStatus: string;
      readonly validatedFoodDocument: string | null;
      readonly validationDigest: string | null;
    }>`
      select
        batch.nutrition_semantic_contract_version as "batchSemanticContract",
        batch.nutrition_semantic_sha256 as "batchSemanticSha256",
        batch.status as "batchStatus",
        record.nutrition_semantic_contract_version as "recordSemanticContract",
        record.nutrition_semantic_sha256 as "recordSemanticSha256",
        record.validation_status as "recordStatus",
        record.validated_food_document as "validatedFoodDocument",
        batch.validation_digest as "validationDigest"
      from public.food_import_batch as batch
      join public.food_import_record as record on record.batch_id = batch.id
      where batch.id = ${batchId}::uuid
    `.execute(database)
  ).rows[0];
  if (!state) throw new Error("Catalogue semantic state is unavailable");
  return state;
}

async function readAuditLineage(
  database: Kysely<Database>,
  batchId: string,
): Promise<{
  readonly stagedCapability: string | null;
  readonly stagedPrincipal: string | null;
  readonly validatedCapability: string | null;
  readonly validatedPrincipal: string | null;
}> {
  const row = (
    await sql<{
      readonly stagedCapability: string | null;
      readonly stagedPrincipal: string | null;
      readonly validatedCapability: string | null;
      readonly validatedPrincipal: string | null;
    }>`
      select
        staged_database_capability_role as "stagedCapability",
        staged_database_principal as "stagedPrincipal",
        validated_database_capability_role as "validatedCapability",
        validated_database_principal as "validatedPrincipal"
      from public.food_import_batch
      where id = ${batchId}::uuid
    `.execute(database)
  ).rows[0];
  if (!row) throw new Error("Catalogue audit lineage is unavailable");
  return row;
}

async function recordApproval(
  database: Kysely<Database>,
  batchId: string,
  validationDigest: string,
  rightsDigest: string,
): Promise<boolean> {
  const recorded = (
    await sql<{ readonly recorded: boolean }>`
      select public.catalogue_record_import_approval(
        p_batch_id => ${batchId}::uuid,
        p_requested_approval_role => 'data',
        p_validation_digest => ${validationDigest},
        p_rights_digest => ${rightsDigest},
        p_external_principal_id => 'principal:semantic-legacy-reviewer',
        p_approval_reference => 'review://catalogue-semantic/legacy-v1'
      ) as recorded
    `.execute(database)
  ).rows[0]?.recorded;
  if (recorded === undefined) throw new Error("Catalogue approval function returned no result");
  return recorded;
}

async function promoteImportBatch(
  database: Kysely<Database>,
  batchId: string,
): Promise<Record<string, unknown>> {
  const result = (
    await sql<{ readonly result: Record<string, unknown> }>`
      select public.catalogue_promote_import_batch(
        p_batch_id => ${batchId}::uuid,
        p_external_principal_id => 'principal:semantic-legacy-promoter',
        p_reason => 'Reject promotion without database nutrition semantic evidence'
      ) as result
    `.execute(database)
  ).rows[0]?.result;
  if (!result) throw new Error("Catalogue promotion function returned no result");
  return result;
}

async function rollbackSourceRelease(
  database: Kysely<Database>,
  sourceCode: string,
  targetReleaseId: string,
): Promise<Record<string, unknown>> {
  const result = (
    await sql<{ readonly result: Record<string, unknown> }>`
      select public.catalogue_rollback_source_release(
        p_source_code => ${sourceCode},
        p_target_release_id => ${targetReleaseId}::uuid,
        p_external_principal_id => 'principal:semantic-legacy-rollback',
        p_reason => 'Reject rollback target without database nutrition semantic evidence'
      ) as result
    `.execute(database)
  ).rows[0]?.result;
  if (!result) throw new Error("Catalogue rollback function returned no result");
  return result;
}

async function seedHistoricalPromotingRelease(
  database: Kysely<Database>,
  batchId: string,
): Promise<string> {
  const release = (
    await sql<{ readonly id: string }>`
      insert into public.food_source_release (
        acquired_at, artifact_bytes, artifact_sha256, artifact_uri,
        evidence_bundle_sha256, evidence_bundle_uri, evidence_decision_sha256,
        evidence_object_version_id, evidence_valid_until, food_source_id,
        media_type, parser_version, published_on, record_counts, release_class,
        release_key, rights_manifest_sha256, rights_manifest_uri, status,
        upstream_schema_version, validation_summary
      )
      select
        batch.acquired_at, batch.artifact_bytes, batch.artifact_sha256,
        batch.artifact_uri, batch.evidence_bundle_sha256,
        batch.evidence_bundle_uri, batch.evidence_decision_sha256,
        batch.evidence_object_version_id, batch.evidence_valid_until,
        batch.food_source_id, batch.media_type, batch.parser_version,
        batch.published_on, '{}'::jsonb, batch.release_class,
        batch.release_key, batch.rights_manifest_sha256,
        batch.rights_manifest_uri, 'imported',
        batch.upstream_schema_version, '{}'::jsonb
      from public.food_import_batch as batch
      where batch.id = ${batchId}::uuid
      returning id
    `.execute(database)
  ).rows[0];
  if (!release) throw new Error("Historical promoted release fixture was not created");
  await sql`
    update public.food_source_release
    set promoted_at = pg_catalog.clock_timestamp(), status = 'promoted'
    where id = ${release.id}::uuid
  `.execute(database);
  await sql`
    update public.food_import_batch
    set release_id = ${release.id}::uuid, status = 'promoting'
    where id = ${batchId}::uuid
  `.execute(database);
  return release.id;
}

async function completeHistoricalPromotingRelease(
  database: Kysely<Database>,
  batchId: string,
  releaseId: string,
): Promise<void> {
  await sql`
    insert into public.food_source_release_activation (
      food_source_id, import_batch_id, operation, performed_by,
      previous_release_id, reason, release_id,
      database_principal, database_capability_role
    )
    select
      batch.food_source_id, batch.id, 'activate',
      'principal:semantic-legacy-origin', null,
      'Synthetic pre-0021 activation lineage', ${releaseId}::uuid,
      null, null
    from public.food_import_batch as batch
    where batch.id = ${batchId}::uuid
  `.execute(database);
  await sql`
    update public.food_import_batch
    set
      completed_at = pg_catalog.clock_timestamp(),
      materialized_count = 1,
      status = 'completed'
    where id = ${batchId}::uuid
  `.execute(database);
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function expectPostgresCode(
  operation: Promise<unknown>,
  expectedCode: string,
  expectedMessage?: string,
): Promise<void> {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  expect(caught).toMatchObject({ code: expectedCode });
  if (expectedMessage) {
    expect(caught).toMatchObject({ message: expect.stringContaining(expectedMessage) });
  }
}

function assertLoopbackDatabaseUrl(connectionString: string): void {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error("TEST_DATABASE_URL must be a PostgreSQL URL on literal loopback");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["127.0.0.1", "[::1]", "::1"].includes(url.hostname) ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("TEST_DATABASE_URL must use a literal loopback PostgreSQL host");
  }
}

function databaseUrlForName(connectionString: string, databaseName: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${databaseName}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}
