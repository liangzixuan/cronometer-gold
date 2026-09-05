import { canonicalJson, sha256CanonicalJson } from "./catalogue-validation.js";
import type { FoodImportReleaseClass, JsonObject, JsonValue } from "./types.js";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UNSIGNED_DECIMAL_PATTERN = /^(?:0|[1-9]\d*)$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const GTIN_14_PATTERN = /^\d{14}$/;
const REPORT_TYPE = "nutrition-tracker.catalogue-reconciliation" as const;
const NUTRIENT_VALUE_STATUSES = Object.freeze([
  "calculated",
  "estimated",
  "label",
  "measured",
  "trace",
] as const);
const SERVING_UNIT_KINDS = Object.freeze(["count", "mass", "volume"] as const);
const COMPONENT_STATUSES = Object.freeze(["added", "changed", "removed"] as const);
const NUTRIENT_STATES = Object.freeze(["missing", "positive", "trace", "zero"] as const);
const VALIDATION_DISPOSITIONS = Object.freeze([
  "exclude_barcode",
  "exclude_nutrient",
  "exclude_record",
  "exclude_serving",
] as const);
const VALIDATION_SEVERITIES = Object.freeze(["error", "warning"] as const);
const REJECTED_BARCODE_REASONS = Object.freeze([
  "BARCODE_CROSS_SOURCE_CONFLICT",
  "BARCODE_INVALID_GTIN",
] as const);
const RELEASE_CLASSES = Object.freeze([
  "fixture-nonrelease",
  "legacy-unbound",
  "live-reviewed",
] as const);
const FOOD_FIELD_ORDER = Object.freeze([
  "kind",
  "name",
  "normalizedName",
  "brandName",
  "description",
  "descriptionFr",
  "languageTag",
  "marketCode",
  "basisQuantity",
  "basisUnit",
  "sourceDataType",
  "sourceModifiedAt",
] as const);
const SEPARATE_EVIDENCE_REQUIRED = Object.freeze([
  "high-impact-nutrient-outlier-review",
  "full-nutrient-mapping-registry-review",
  "representative-search-relevance",
  "zero-result-rate",
  "index-document-count",
  "index-build-time",
  "index-p95-latency",
  "index-memory-footprint",
  "index-disk-footprint",
] as const);

export interface CatalogueReconciliationNutrientSnapshot extends JsonObject {
  readonly amount: string;
  readonly canonicalUnit: string;
  readonly mappingRevisionId: string;
  readonly metadata: JsonObject;
  readonly nutrientCode: string;
  readonly sourceAmount: string | null;
  readonly sourceBasisQuantity: string | null;
  readonly sourceBasisUnit: "g" | null;
  readonly sourceName: string;
  readonly sourceNutrientKey: string;
  readonly sourceUnit: string | null;
  readonly valueStatus: (typeof NUTRIENT_VALUE_STATUSES)[number];
}

export interface CatalogueReconciliationServingSnapshot extends JsonObject {
  readonly displayOrder: number;
  readonly gramWeight: string | null;
  readonly isDefault: boolean;
  readonly label: string;
  readonly metadata: JsonObject;
  readonly milliliterVolume: string | null;
  readonly quantity: string;
  readonly sourceServingKey: string;
  readonly unit: string;
  readonly unitKind: "count" | "mass" | "volume";
}

export interface CatalogueReconciliationFoodSnapshot extends JsonObject {
  readonly basisQuantity: string;
  readonly basisUnit: "g";
  readonly brandName: string | null;
  readonly description: string | null;
  readonly descriptionFr: string | null;
  readonly gtin: string | null;
  readonly kind: "branded" | "generic";
  readonly languageTag: string;
  readonly marketCode: string;
  readonly name: string;
  readonly normalizedName: string;
  readonly nutrients: readonly CatalogueReconciliationNutrientSnapshot[];
  readonly servings: readonly CatalogueReconciliationServingSnapshot[];
  readonly sourceDataType: string;
  readonly sourceFoodKey: string;
  readonly sourceModifiedAt: string | null;
  readonly sourcePayloadSha256: string;
}

export interface CatalogueReconciliationMappingSnapshot extends JsonObject {
  readonly canonicalNutrientCode: string;
  readonly canonicalUnit: string;
  readonly conversionMultiplier: string;
  readonly revisionId: string;
  readonly sourceNutrientKey: string;
  readonly sourceUnit: string;
}

export interface CatalogueReconciliationReleaseEvidence extends JsonObject {
  readonly artifactBytes: string;
  readonly artifactSha256: string;
  readonly batchId: string;
  readonly evidenceBundleSha256: string | null;
  readonly evidenceBundleUri: string | null;
  readonly evidenceDecisionSha256: string | null;
  readonly evidenceObjectVersionId: string | null;
  readonly evidenceValidUntil: string | null;
  readonly nutrientMappingDigest: string;
  readonly parserBuildSha256: string;
  readonly parserReportSha256: string;
  readonly parserVersion: string;
  readonly releaseClass: FoodImportReleaseClass;
  readonly releaseId: string;
  readonly releaseKey: string;
  readonly rightsManifestSha256: string;
  readonly validationDigest: string;
}

export interface CatalogueReconciliationCandidateEvidence extends JsonObject {
  readonly artifactBytes: string;
  readonly artifactSha256: string;
  readonly batchId: string;
  readonly evidenceBundleSha256: string | null;
  readonly evidenceBundleUri: string | null;
  readonly evidenceDecisionSha256: string | null;
  readonly evidenceObjectVersionId: string | null;
  readonly evidenceValidUntil: string | null;
  readonly nutrientMappingDigest: string;
  readonly parserBuildSha256: string;
  readonly parserReportSha256: string;
  readonly parserVersion: string;
  readonly releaseClass: FoodImportReleaseClass;
  readonly releaseKey: string;
  readonly rightsManifestSha256: string;
  readonly validationDigest: string;
}

export interface CatalogueReconciliationCandidateCounts extends JsonObject {
  readonly parserExcludedNutrients: string;
  readonly parserExcludedPortions: string;
  readonly parserExcludedRecords: string;
  readonly stagedQuarantined: string;
  readonly stagedValid: string;
}

export interface CatalogueReconciliationQuarantinedRecord extends JsonObject {
  readonly canonicalPayloadSha256: string;
  readonly issues: readonly JsonObject[];
  readonly sourceRecordKey: string;
}

export interface CatalogueReconciliationRejectedBarcode extends JsonObject {
  readonly marketCode: string | null;
  readonly normalizedGtin: string | null;
  readonly rawValue: string;
  readonly reasonCode: (typeof REJECTED_BARCODE_REASONS)[number];
  readonly sourceFoodKey: string;
}

interface BarcodeAssignment extends JsonObject {
  readonly gtin: string;
  readonly marketCode: string;
  readonly sourceFoodKey: string;
}

export interface CatalogueReconciliationBuildInput {
  readonly baseline: CatalogueReconciliationReleaseEvidence | null;
  readonly baselineFoods: readonly CatalogueReconciliationFoodSnapshot[];
  readonly baselineMappings: readonly CatalogueReconciliationMappingSnapshot[];
  readonly candidate: CatalogueReconciliationCandidateEvidence;
  readonly candidateCounts: CatalogueReconciliationCandidateCounts;
  readonly candidateFoods: readonly CatalogueReconciliationFoodSnapshot[];
  readonly candidateMappings: readonly CatalogueReconciliationMappingSnapshot[];
  readonly quarantinedRecords: readonly CatalogueReconciliationQuarantinedRecord[];
  readonly rejectedCandidateBarcodes: readonly CatalogueReconciliationRejectedBarcode[];
  readonly sourceCode: string;
}

export interface CatalogueReconciliationDocument extends JsonObject {
  readonly evidence: JsonObject;
  readonly reconciliationSha256: string;
  readonly reportType: typeof REPORT_TYPE;
  readonly schemaVersion: 2;
}

export function buildCatalogueReconciliationDocument(
  input: CatalogueReconciliationBuildInput,
): CatalogueReconciliationDocument {
  exactObject(input, "input", [
    "baseline",
    "baselineFoods",
    "baselineMappings",
    "candidate",
    "candidateCounts",
    "candidateFoods",
    "candidateMappings",
    "quarantinedRecords",
    "rejectedCandidateBarcodes",
    "sourceCode",
  ]);
  const sourceCode = requiredText(input.sourceCode, "sourceCode");
  const baselineFoods = normalizeFoods(input.baselineFoods, "baselineFoods");
  const candidateFoods = normalizeFoods(input.candidateFoods, "candidateFoods");
  const baseline = input.baseline
    ? normalizeReleaseEvidence(input.baseline, "baseline", true)
    : null;
  const candidate = normalizeReleaseEvidence(input.candidate, "candidate", false);
  const candidateCounts = normalizeCandidateCounts(input.candidateCounts);
  if (candidateCounts.stagedValid !== String(candidateFoods.length)) {
    throw new Error("candidateCounts.stagedValid does not match candidateFoods");
  }
  const baselineMappings = normalizeMappings(input.baselineMappings, "baselineMappings");
  const candidateMappings = normalizeMappings(input.candidateMappings, "candidateMappings");
  if (baseline === null && (baselineFoods.length > 0 || baselineMappings.length > 0)) {
    throw new Error("A null baseline cannot have catalogue or mapping snapshots");
  }
  const quarantinedRecords = normalizeQuarantine(input.quarantinedRecords);
  if (candidateCounts.stagedQuarantined !== String(quarantinedRecords.length)) {
    throw new Error("candidateCounts.stagedQuarantined does not match quarantine evidence");
  }
  const rejectedCandidateBarcodes = normalizeRejectedBarcodes(input.rejectedCandidateBarcodes);
  const records = reconcileRecords(baselineFoods, candidateFoods);
  const mappingTransitions = reconcileMappings(baselineMappings, candidateMappings);
  const barcodes = reconcileBarcodes(baselineFoods, candidateFoods, rejectedCandidateBarcodes);
  const counts = buildCounts(baselineFoods, candidateFoods, records, candidateCounts, barcodes);
  const evidence: JsonObject = {
    barcodes,
    baseline:
      baseline === null
        ? null
        : {
            ...baseline,
            recordSetSha256: sha256CanonicalJson(baselineFoods),
          },
    candidate: {
      ...candidate,
      recordSetSha256: sha256CanonicalJson(candidateFoods),
    },
    counts,
    mappings: {
      baselineDigest: baseline?.nutrientMappingDigest ?? null,
      candidateDigest: candidate.nutrientMappingDigest,
      digestChanged:
        baseline !== null && baseline.nutrientMappingDigest !== candidate.nutrientMappingDigest,
      transitionScope: "materialized-observations-only",
      transitions: mappingTransitions,
    },
    missingnessStateEvidence: records.missingnessStateEvidence,
    missingnessTransitions: records.missingnessTransitions,
    quarantine: {
      parserExcludedNutrients: candidateCounts.parserExcludedNutrients,
      parserExcludedPortions: candidateCounts.parserExcludedPortions,
      parserExcludedRecords: candidateCounts.parserExcludedRecords,
      parserReportSha256: candidate.parserReportSha256,
      records: quarantinedRecords,
    },
    records: {
      added: records.added,
      changed: records.changed,
      removed: records.removed,
      unchangedCount: String(records.unchangedCount),
    },
    scope: "database-catalogue-only",
    separateEvidenceRequired: SEPARATE_EVIDENCE_REQUIRED,
    sourceCode,
  };
  const digestInput: JsonObject = {
    evidence,
    reportType: REPORT_TYPE,
    schemaVersion: 2,
  };
  const document: CatalogueReconciliationDocument = {
    ...digestInput,
    reconciliationSha256: sha256CanonicalJson(digestInput),
  } as CatalogueReconciliationDocument;
  verifyCatalogueReconciliationDocument(document);
  return document;
}

export function verifyCatalogueReconciliationDocument(
  value: unknown,
): asserts value is CatalogueReconciliationDocument {
  const document = exactObject(value, "document", [
    "evidence",
    "reconciliationSha256",
    "reportType",
    "schemaVersion",
  ]);
  if (document.reportType !== REPORT_TYPE || document.schemaVersion !== 2) {
    throw new Error("Reconciliation report identity is invalid");
  }
  const reconciliationSha256 = sha256(document.reconciliationSha256, "reconciliationSha256");
  const evidence = validateEvidenceSchema(document.evidence);
  const digestInput: JsonObject = {
    evidence,
    reportType: REPORT_TYPE,
    schemaVersion: 2,
  };
  if (sha256CanonicalJson(digestInput) !== reconciliationSha256) {
    throw new Error("Reconciliation document digest does not match its canonical evidence");
  }
}

function reconcileRecords(
  baseline: readonly CatalogueReconciliationFoodSnapshot[],
  candidate: readonly CatalogueReconciliationFoodSnapshot[],
): {
  readonly added: readonly JsonObject[];
  readonly changed: readonly JsonObject[];
  readonly missingnessStateEvidence: readonly JsonObject[];
  readonly missingnessTransitions: readonly JsonObject[];
  readonly removed: readonly JsonObject[];
  readonly unchangedCount: number;
} {
  const baselineByKey = new Map(baseline.map((food) => [food.sourceFoodKey, food]));
  const candidateByKey = new Map(candidate.map((food) => [food.sourceFoodKey, food]));
  const keys = sortedUnique([...baselineByKey.keys(), ...candidateByKey.keys()]);
  const added: JsonObject[] = [];
  const removed: JsonObject[] = [];
  const changed: JsonObject[] = [];
  const missingnessStateEvidence: JsonObject[] = [];
  let unchangedCount = 0;
  for (const sourceFoodKey of keys) {
    const current = baselineByKey.get(sourceFoodKey);
    const next = candidateByKey.get(sourceFoodKey);
    if (!current && next) {
      added.push({ candidateFingerprint: sha256CanonicalJson(next), sourceFoodKey });
      addMissingnessStateEvidence(
        missingnessStateEvidence,
        sourceFoodKey,
        undefined,
        next.nutrients,
      );
      continue;
    }
    if (current && !next) {
      removed.push({ currentFingerprint: sha256CanonicalJson(current), sourceFoodKey });
      addMissingnessStateEvidence(
        missingnessStateEvidence,
        sourceFoodKey,
        current.nutrients,
        undefined,
      );
      continue;
    }
    if (!current || !next) throw new Error("Catalogue record union is inconsistent");
    addMissingnessStateEvidence(
      missingnessStateEvidence,
      sourceFoodKey,
      current.nutrients,
      next.nutrients,
    );
    const currentFingerprint = sha256CanonicalJson(current);
    const candidateFingerprint = sha256CanonicalJson(next);
    if (currentFingerprint === candidateFingerprint) {
      unchangedCount += 1;
      continue;
    }
    const nutrientChanges = componentChanges(
      current.nutrients,
      next.nutrients,
      (entry) => entry.nutrientCode,
    );
    const servingChanges = componentChanges(
      current.servings,
      next.servings,
      (entry) => entry.sourceServingKey,
    );
    const fields = FOOD_FIELD_ORDER.filter(
      (field) =>
        canonicalJson(current[field] as JsonValue) !== canonicalJson(next[field] as JsonValue),
    );
    changed.push({
      barcode:
        current.gtin === next.gtin && current.marketCode === next.marketCode
          ? null
          : {
              candidate: next.gtin ? { gtin: next.gtin, marketCode: next.marketCode } : null,
              current: current.gtin ? { gtin: current.gtin, marketCode: current.marketCode } : null,
            },
      candidateFingerprint,
      currentFingerprint,
      fields,
      nutrients: nutrientChanges,
      servings: servingChanges,
      sourceFoodKey,
      upstreamPayloadProvenanceChanged: current.sourcePayloadSha256 !== next.sourcePayloadSha256,
    });
  }
  return {
    added,
    changed,
    missingnessStateEvidence: missingnessStateEvidence.sort(compareTransition),
    missingnessTransitions: missingnessStateEvidence
      .filter((entry) => entry.currentState !== entry.candidateState)
      .sort(compareTransition),
    removed,
    unchangedCount,
  };
}

function componentChanges<T extends JsonObject>(
  current: readonly T[],
  candidate: readonly T[],
  identity: (value: T) => string,
): readonly JsonObject[] {
  const currentByKey = new Map(current.map((entry) => [identity(entry), entry]));
  const candidateByKey = new Map(candidate.map((entry) => [identity(entry), entry]));
  return sortedUnique([...currentByKey.keys(), ...candidateByKey.keys()]).flatMap((key) => {
    const before = currentByKey.get(key);
    const after = candidateByKey.get(key);
    if (before && after && canonicalJson(before) === canonicalJson(after)) return [];
    return [
      {
        candidate: after ?? null,
        current: before ?? null,
        identity: key,
        status: before ? (after ? "changed" : "removed") : "added",
      },
    ];
  });
}

function addMissingnessStateEvidence(
  output: JsonObject[],
  sourceFoodKey: string,
  current: readonly CatalogueReconciliationNutrientSnapshot[] | undefined,
  candidate: readonly CatalogueReconciliationNutrientSnapshot[] | undefined,
): void {
  const currentByCode = new Map((current ?? []).map((entry) => [entry.nutrientCode, entry]));
  const candidateByCode = new Map((candidate ?? []).map((entry) => [entry.nutrientCode, entry]));
  for (const nutrientCode of sortedUnique([...currentByCode.keys(), ...candidateByCode.keys()])) {
    const currentState = nutrientState(currentByCode.get(nutrientCode));
    const candidateState = nutrientState(candidateByCode.get(nutrientCode));
    output.push({ candidateState, currentState, nutrientCode, sourceFoodKey });
  }
}

function nutrientState(
  nutrient: CatalogueReconciliationNutrientSnapshot | undefined,
): "missing" | "positive" | "trace" | "zero" {
  if (!nutrient) return "missing";
  if (nutrient.valueStatus === "trace") return "trace";
  return decimalIsZero(nutrient.amount) ? "zero" : "positive";
}

function reconcileMappings(
  baseline: readonly CatalogueReconciliationMappingSnapshot[],
  candidate: readonly CatalogueReconciliationMappingSnapshot[],
): readonly JsonObject[] {
  const currentByKey = new Map(baseline.map((entry) => [entry.sourceNutrientKey, entry]));
  const candidateByKey = new Map(candidate.map((entry) => [entry.sourceNutrientKey, entry]));
  return sortedUnique([...currentByKey.keys(), ...candidateByKey.keys()]).flatMap((key) => {
    const current = currentByKey.get(key);
    const next = candidateByKey.get(key);
    if (current && next && canonicalJson(current) === canonicalJson(next)) return [];
    return [
      {
        candidate: next ?? null,
        current: current ?? null,
        sourceNutrientKey: key,
        status: current ? (next ? "changed" : "removed") : "added",
      },
    ];
  });
}

function reconcileBarcodes(
  baseline: readonly CatalogueReconciliationFoodSnapshot[],
  candidate: readonly CatalogueReconciliationFoodSnapshot[],
  rejectedCandidateBarcodes: readonly CatalogueReconciliationRejectedBarcode[],
): JsonObject {
  const baselineAssignments = barcodeAssignments(baseline);
  const candidateAssignments = barcodeAssignments(candidate);
  const crossSourceConflicts = rejectedCandidateBarcodes
    .filter((entry) => entry.reasonCode === "BARCODE_CROSS_SOURCE_CONFLICT")
    .map((entry): BarcodeAssignment => {
      if (!entry.normalizedGtin || !entry.marketCode) {
        throw new Error("Cross-source barcode rejection lacks normalized GTIN and market evidence");
      }
      return {
        gtin: entry.normalizedGtin,
        marketCode: entry.marketCode,
        sourceFoodKey: entry.sourceFoodKey,
      };
    });
  const candidateByIdentity = groupByBarcode(candidateAssignments);
  const transitions = deriveBarcodeTransitions(baselineAssignments, candidateAssignments);
  const acceptedAssignmentsByMarket = new Map<string, number>();
  for (const assignment of candidateAssignments) {
    acceptedAssignmentsByMarket.set(
      assignment.marketCode,
      (acceptedAssignmentsByMarket.get(assignment.marketCode) ?? 0) + 1,
    );
  }
  const collisionAssignmentsByMarket = new Map<string, number>();
  for (const group of candidateByIdentity.values()) {
    if (group.length < 2) continue;
    const marketCode = group[0]?.marketCode;
    if (!marketCode) throw new Error("Candidate barcode collision lacks a market identity");
    collisionAssignmentsByMarket.set(
      marketCode,
      (collisionAssignmentsByMarket.get(marketCode) ?? 0) + group.length,
    );
  }
  const conflictsByMarket = new Map<string, number>();
  for (const conflict of crossSourceConflicts) {
    conflictsByMarket.set(
      conflict.marketCode,
      (conflictsByMarket.get(conflict.marketCode) ?? 0) + 1,
    );
  }
  const markets = sortedUnique([
    ...acceptedAssignmentsByMarket.keys(),
    ...conflictsByMarket.keys(),
  ]).map((marketCode) => {
    const acceptedAssignmentCount = acceptedAssignmentsByMarket.get(marketCode) ?? 0;
    const rejectedConflictCount = conflictsByMarket.get(marketCode) ?? 0;
    const withinCandidateCollisionAssignments = collisionAssignmentsByMarket.get(marketCode) ?? 0;
    const assignmentCount = acceptedAssignmentCount + rejectedConflictCount;
    const collisionAssignmentCount = withinCandidateCollisionAssignments + rejectedConflictCount;
    return {
      assignmentCount: String(assignmentCount),
      collisionAssignmentCount: String(collisionAssignmentCount),
      collisionRate: {
        denominator: String(assignmentCount),
        numerator: String(collisionAssignmentCount),
      },
      crossSourceConflictCount: String(rejectedConflictCount),
      marketCode,
      withinCandidateCollisionAssignmentCount: String(withinCandidateCollisionAssignments),
    };
  });
  return {
    added: transitions.added,
    baselineAssignments,
    candidateAssignments,
    candidateCollisions: [...candidateByIdentity.values()]
      .filter((group) => group.length > 1)
      .map((group) => ({
        gtin: group[0]?.gtin ?? "",
        marketCode: group[0]?.marketCode ?? "",
        sourceFoodKeys: group.map((entry) => entry.sourceFoodKey).sort(compareCodePoints),
      }))
      .sort((left, right) =>
        compareCodePoints(
          `${left.marketCode}\u0000${left.gtin}`,
          `${right.marketCode}\u0000${right.gtin}`,
        ),
      ),
    markets,
    reassigned: transitions.reassigned,
    rejectedCandidate: rejectedCandidateBarcodes,
    removed: transitions.removed,
  };
}

function deriveBarcodeTransitions(
  baselineAssignments: readonly BarcodeAssignment[],
  candidateAssignments: readonly BarcodeAssignment[],
): {
  readonly added: readonly BarcodeAssignment[];
  readonly reassigned: readonly JsonObject[];
  readonly removed: readonly BarcodeAssignment[];
} {
  const baselineByIdentity = groupByBarcode(baselineAssignments);
  const candidateByIdentity = groupByBarcode(candidateAssignments);
  const added: BarcodeAssignment[] = [];
  const removed: BarcodeAssignment[] = [];
  const reassigned: JsonObject[] = [];
  for (const identity of sortedUnique([
    ...baselineByIdentity.keys(),
    ...candidateByIdentity.keys(),
  ])) {
    const current = baselineByIdentity.get(identity) ?? [];
    const next = candidateByIdentity.get(identity) ?? [];
    if (current.length === 1 && next.length === 1) {
      if (current[0]?.sourceFoodKey !== next[0]?.sourceFoodKey) {
        reassigned.push({ candidate: next[0] as JsonValue, current: current[0] as JsonValue });
      }
      continue;
    }
    const currentKeys = new Set(current.map((entry) => entry.sourceFoodKey));
    const candidateKeys = new Set(next.map((entry) => entry.sourceFoodKey));
    for (const assignment of current) {
      if (!candidateKeys.has(assignment.sourceFoodKey)) removed.push(assignment);
    }
    for (const assignment of next) {
      if (!currentKeys.has(assignment.sourceFoodKey)) added.push(assignment);
    }
  }
  return {
    added: added.sort(compareBarcode),
    reassigned: reassigned.sort((left, right) =>
      compareCodePoints(canonicalJson(left), canonicalJson(right)),
    ),
    removed: removed.sort(compareBarcode),
  };
}

function buildCounts(
  baseline: readonly CatalogueReconciliationFoodSnapshot[],
  candidate: readonly CatalogueReconciliationFoodSnapshot[],
  records: ReturnType<typeof reconcileRecords>,
  candidateCounts: CatalogueReconciliationCandidateCounts,
  barcodes: JsonObject,
): JsonObject {
  const baselineNutrients = baseline.reduce((count, food) => count + food.nutrients.length, 0);
  const candidateNutrients = candidate.reduce((count, food) => count + food.nutrients.length, 0);
  const baselineServings = baseline.reduce((count, food) => count + food.servings.length, 0);
  const candidateServings = candidate.reduce((count, food) => count + food.servings.length, 0);
  const baselineBarcodes = baseline.filter((food) => food.gtin !== null).length;
  const candidateBarcodes = candidate.filter((food) => food.gtin !== null).length;
  const rejectedBarcodes =
    barcodes.rejectedCandidate as readonly CatalogueReconciliationRejectedBarcode[];
  const crossSourceConflicts = rejectedBarcodes.filter(
    (entry) => entry.reasonCode === "BARCODE_CROSS_SOURCE_CONFLICT",
  ).length;
  const invalidBarcodes = rejectedBarcodes.filter(
    (entry) => entry.reasonCode === "BARCODE_INVALID_GTIN",
  ).length;
  return {
    addedRecords: String(records.added.length),
    baselineBarcodes: String(baselineBarcodes),
    baselineNutrients: String(baselineNutrients),
    baselineRecords: String(baseline.length),
    baselineServings: String(baselineServings),
    barcodeDelta: signedDelta(candidateBarcodes, baselineBarcodes),
    candidateBarcodeCollisions: String(
      (barcodes.candidateCollisions as readonly JsonValue[]).length,
    ),
    candidateBarcodes: String(candidateBarcodes),
    candidateCrossSourceBarcodeConflicts: String(crossSourceConflicts),
    candidateInvalidBarcodes: String(invalidBarcodes),
    candidateNutrients: String(candidateNutrients),
    candidateParserExcludedNutrients: candidateCounts.parserExcludedNutrients,
    candidateParserExcludedPortions: candidateCounts.parserExcludedPortions,
    candidateParserExcludedRecords: candidateCounts.parserExcludedRecords,
    candidateRecords: String(candidate.length),
    candidateRejectedBarcodes: String(rejectedBarcodes.length),
    candidateServings: String(candidateServings),
    candidateStagedQuarantined: candidateCounts.stagedQuarantined,
    candidateStagedValid: candidateCounts.stagedValid,
    changedRecords: String(records.changed.length),
    nutrientDelta: signedDelta(candidateNutrients, baselineNutrients),
    recordDelta: signedDelta(candidate.length, baseline.length),
    removedRecords: String(records.removed.length),
    servingDelta: signedDelta(candidateServings, baselineServings),
    unchangedRecords: String(records.unchangedCount),
  };
}

function normalizeFoods(
  values: readonly CatalogueReconciliationFoodSnapshot[],
  field: string,
): readonly CatalogueReconciliationFoodSnapshot[] {
  const normalized = jsonArray(values, field).map((value, index) =>
    normalizeFood(value as CatalogueReconciliationFoodSnapshot, `${field}[${index}]`),
  );
  normalized.sort((left, right) => compareCodePoints(left.sourceFoodKey, right.sourceFoodKey));
  rejectDuplicateIdentities(normalized, (entry) => entry.sourceFoodKey, field);
  return normalized;
}

function normalizeFood(
  value: CatalogueReconciliationFoodSnapshot,
  field: string,
): CatalogueReconciliationFoodSnapshot {
  const object = exactObject(value, field, [
    "basisQuantity",
    "basisUnit",
    "brandName",
    "description",
    "descriptionFr",
    "gtin",
    "kind",
    "languageTag",
    "marketCode",
    "name",
    "normalizedName",
    "nutrients",
    "servings",
    "sourceDataType",
    "sourceFoodKey",
    "sourceModifiedAt",
    "sourcePayloadSha256",
  ]);
  const nutrients = jsonArray(object.nutrients, `${field}.nutrients`).map((entry, index) =>
    normalizeNutrientSnapshot(entry, `${field}.nutrients[${index}]`),
  );
  nutrients.sort((left, right) =>
    compareCodePoints(
      `${left.nutrientCode}\u0000${left.sourceNutrientKey}`,
      `${right.nutrientCode}\u0000${right.sourceNutrientKey}`,
    ),
  );
  rejectDuplicateIdentities(nutrients, (entry) => entry.nutrientCode, `${field}.nutrients`);
  const servings = jsonArray(object.servings, `${field}.servings`).map((entry, index) =>
    normalizeServingSnapshot(entry, `${field}.servings[${index}]`),
  );
  servings.sort((left, right) => compareCodePoints(left.sourceServingKey, right.sourceServingKey));
  rejectDuplicateIdentities(servings, (entry) => entry.sourceServingKey, `${field}.servings`);
  const kind = enumValue(object.kind, `${field}.kind`, ["branded", "generic"] as const);
  const brandName = nullableText(object.brandName, `${field}.brandName`);
  const gtin = nullableGtin14(object.gtin, `${field}.gtin`);
  if (kind === "generic" && (brandName !== null || gtin !== null)) {
    throw new Error(`${field} generic food cannot carry a brand or GTIN`);
  }
  if (object.basisUnit !== "g") throw new Error(`${field}.basisUnit must be g`);
  const marketCode = requiredText(object.marketCode, `${field}.marketCode`);
  if (!/^[A-Z0-9]{2,3}$/.test(marketCode)) {
    throw new Error(`${field}.marketCode must be a canonical market code`);
  }
  return {
    basisQuantity: canonicalDecimal(object.basisQuantity, `${field}.basisQuantity`),
    basisUnit: "g",
    brandName,
    description: nullableText(object.description, `${field}.description`),
    descriptionFr: nullableText(object.descriptionFr, `${field}.descriptionFr`),
    gtin,
    kind,
    languageTag: requiredText(object.languageTag, `${field}.languageTag`),
    marketCode,
    name: requiredText(object.name, `${field}.name`),
    normalizedName: requiredText(object.normalizedName, `${field}.normalizedName`),
    nutrients,
    servings,
    sourceDataType: requiredText(object.sourceDataType, `${field}.sourceDataType`),
    sourceFoodKey: requiredText(object.sourceFoodKey, `${field}.sourceFoodKey`),
    sourceModifiedAt: nullableIsoTimestamp(object.sourceModifiedAt, `${field}.sourceModifiedAt`),
    sourcePayloadSha256: sha256(object.sourcePayloadSha256, `${field}.sourcePayloadSha256`),
  };
}

function normalizeNutrientSnapshot(
  value: unknown,
  field: string,
): CatalogueReconciliationNutrientSnapshot {
  const object = exactObject(value, field, [
    "amount",
    "canonicalUnit",
    "mappingRevisionId",
    "metadata",
    "nutrientCode",
    "sourceAmount",
    "sourceBasisQuantity",
    "sourceBasisUnit",
    "sourceName",
    "sourceNutrientKey",
    "sourceUnit",
    "valueStatus",
  ]);
  const amount = canonicalDecimal(object.amount, `${field}.amount`);
  const sourceAmount = nullableCanonicalDecimal(object.sourceAmount, `${field}.sourceAmount`);
  const sourceBasisQuantity = nullableCanonicalDecimal(
    object.sourceBasisQuantity,
    `${field}.sourceBasisQuantity`,
  );
  const sourceBasisUnit = object.sourceBasisUnit;
  if (sourceBasisUnit !== null && sourceBasisUnit !== "g") {
    throw new Error(`${field}.sourceBasisUnit must be g or null`);
  }
  const sourceUnit = nullableText(object.sourceUnit, `${field}.sourceUnit`);
  const valueStatus = enumValue(
    object.valueStatus,
    `${field}.valueStatus`,
    NUTRIENT_VALUE_STATUSES,
  );
  const mappingRevisionId = uuid(object.mappingRevisionId, `${field}.mappingRevisionId`);
  const sourceName = requiredText(object.sourceName, `${field}.sourceName`);
  const sourceNutrientKey = requiredText(object.sourceNutrientKey, `${field}.sourceNutrientKey`);
  if (valueStatus === "trace") {
    if (
      amount !== "0" ||
      sourceAmount !== null ||
      sourceBasisQuantity !== null ||
      sourceBasisUnit !== null ||
      sourceUnit !== null
    ) {
      throw new Error(
        `${field} trace nutrient must use zero amount and null source quantities/units`,
      );
    }
  } else if (
    sourceAmount === null ||
    sourceBasisQuantity === null ||
    sourceBasisUnit !== "g" ||
    sourceUnit === null
  ) {
    throw new Error(`${field} non-trace nutrient must retain complete source quantities/units`);
  }
  const metadata = normalizeNutrientMetadata(object.metadata, `${field}.metadata`, {
    mappingRevisionId,
    sourceName,
    sourceNutrientKey,
    sourceUnit,
    valueStatus,
  });
  return {
    amount,
    canonicalUnit: requiredText(object.canonicalUnit, `${field}.canonicalUnit`),
    mappingRevisionId,
    metadata,
    nutrientCode: requiredText(object.nutrientCode, `${field}.nutrientCode`),
    sourceAmount,
    sourceBasisQuantity,
    sourceBasisUnit,
    sourceName,
    sourceNutrientKey,
    sourceUnit,
    valueStatus,
  };
}

function normalizeNutrientMetadata(
  value: unknown,
  field: string,
  expected: {
    readonly mappingRevisionId: string;
    readonly sourceName: string;
    readonly sourceNutrientKey: string;
    readonly sourceUnit: string | null;
    readonly valueStatus: (typeof NUTRIENT_VALUE_STATUSES)[number];
  },
): JsonObject {
  const object = exactObject(value, field, [
    "dataPoints",
    ...(expected.valueStatus === "trace" ? ["detectionLimit"] : []),
    "derivationCode",
    "mappingRevisionId",
    "sourceName",
    "sourceNutrientId",
    "sourceUnit",
  ]);
  const dataPoints =
    object.dataPoints === null
      ? null
      : nonNegativeSafeInteger(object.dataPoints, `${field}.dataPoints`);
  if (dataPoints !== null && dataPoints > 2_147_483_647) {
    throw new Error(`${field}.dataPoints exceeds the reviewed database bound`);
  }
  const derivationCode = nullableText(object.derivationCode, `${field}.derivationCode`);
  if (derivationCode !== null && derivationCode.length > 128) {
    throw new Error(`${field}.derivationCode exceeds the reviewed source bound`);
  }
  const mappingRevisionId = uuid(object.mappingRevisionId, `${field}.mappingRevisionId`);
  const sourceName = requiredText(object.sourceName, `${field}.sourceName`);
  const sourceNutrientId = requiredText(object.sourceNutrientId, `${field}.sourceNutrientId`);
  const metadataSourceUnit = requiredText(object.sourceUnit, `${field}.sourceUnit`);
  if (
    mappingRevisionId !== expected.mappingRevisionId ||
    sourceName !== expected.sourceName ||
    sourceNutrientId !== expected.sourceNutrientKey ||
    (expected.valueStatus !== "trace" && metadataSourceUnit !== expected.sourceUnit)
  ) {
    throw new Error(`${field} does not match its nutrient snapshot provenance`);
  }
  const detectionLimit =
    expected.valueStatus === "trace"
      ? nullableCanonicalDecimal(object.detectionLimit, `${field}.detectionLimit`)
      : undefined;
  if (detectionLimit === "0") {
    throw new Error(`${field}.detectionLimit must be positive when present`);
  }
  return {
    dataPoints,
    ...(expected.valueStatus === "trace" ? { detectionLimit: detectionLimit ?? null } : {}),
    derivationCode,
    mappingRevisionId,
    sourceName,
    sourceNutrientId,
    sourceUnit: metadataSourceUnit,
  };
}

function normalizeServingSnapshot(
  value: unknown,
  field: string,
): CatalogueReconciliationServingSnapshot {
  const object = exactObject(value, field, [
    "displayOrder",
    "gramWeight",
    "isDefault",
    "label",
    "metadata",
    "milliliterVolume",
    "quantity",
    "sourceServingKey",
    "unit",
    "unitKind",
  ]);
  return {
    displayOrder: nonNegativeSafeInteger(object.displayOrder, `${field}.displayOrder`),
    gramWeight: nullableCanonicalDecimal(object.gramWeight, `${field}.gramWeight`),
    isDefault: booleanValue(object.isDefault, `${field}.isDefault`),
    label: requiredText(object.label, `${field}.label`),
    metadata: exactObject(object.metadata, `${field}.metadata`, []) as JsonObject,
    milliliterVolume: nullableCanonicalDecimal(
      object.milliliterVolume,
      `${field}.milliliterVolume`,
    ),
    quantity: canonicalDecimal(object.quantity, `${field}.quantity`),
    sourceServingKey: requiredText(object.sourceServingKey, `${field}.sourceServingKey`),
    unit: requiredText(object.unit, `${field}.unit`),
    unitKind: enumValue(object.unitKind, `${field}.unitKind`, SERVING_UNIT_KINDS),
  };
}

function normalizeMappings(
  values: readonly CatalogueReconciliationMappingSnapshot[],
  field: string,
): readonly CatalogueReconciliationMappingSnapshot[] {
  const normalized = jsonArray(values, field).map((entry, index) =>
    normalizeMappingSnapshot(entry, `${field}[${index}]`),
  );
  normalized.sort((left, right) =>
    compareCodePoints(
      `${left.canonicalNutrientCode}\u0000${left.sourceNutrientKey}`,
      `${right.canonicalNutrientCode}\u0000${right.sourceNutrientKey}`,
    ),
  );
  rejectDuplicateIdentities(normalized, (entry) => entry.sourceNutrientKey, field);
  return normalized;
}

function normalizeMappingSnapshot(
  value: unknown,
  field: string,
): CatalogueReconciliationMappingSnapshot {
  const object = exactObject(value, field, [
    "canonicalNutrientCode",
    "canonicalUnit",
    "conversionMultiplier",
    "revisionId",
    "sourceNutrientKey",
    "sourceUnit",
  ]);
  const conversionMultiplier = canonicalDecimal(
    object.conversionMultiplier,
    `${field}.conversionMultiplier`,
  );
  if (conversionMultiplier === "0") {
    throw new Error(`${field}.conversionMultiplier must be positive`);
  }
  return {
    canonicalNutrientCode: requiredText(
      object.canonicalNutrientCode,
      `${field}.canonicalNutrientCode`,
    ),
    canonicalUnit: requiredText(object.canonicalUnit, `${field}.canonicalUnit`),
    conversionMultiplier,
    revisionId: uuid(object.revisionId, `${field}.revisionId`),
    sourceNutrientKey: requiredText(object.sourceNutrientKey, `${field}.sourceNutrientKey`),
    sourceUnit: requiredText(object.sourceUnit, `${field}.sourceUnit`),
  };
}

function normalizeReleaseEvidence<
  T extends CatalogueReconciliationReleaseEvidence | CatalogueReconciliationCandidateEvidence,
>(value: T, field: string, hasReleaseId: boolean): T {
  const keys = [
    "artifactBytes",
    "artifactSha256",
    "batchId",
    "evidenceBundleSha256",
    "evidenceBundleUri",
    "evidenceDecisionSha256",
    "evidenceObjectVersionId",
    "evidenceValidUntil",
    "nutrientMappingDigest",
    "parserBuildSha256",
    "parserReportSha256",
    "parserVersion",
    "releaseClass",
    "releaseKey",
    "rightsManifestSha256",
    "validationDigest",
    ...(hasReleaseId ? ["releaseId"] : []),
  ];
  const object = exactObject(value, field, keys);
  const evidenceBinding = normalizeEvidenceBinding(object, field, hasReleaseId);
  const normalized = {
    artifactBytes: unsignedDecimal(object.artifactBytes, `${field}.artifactBytes`),
    artifactSha256: sha256(object.artifactSha256, `${field}.artifactSha256`),
    batchId: uuid(object.batchId, `${field}.batchId`),
    ...evidenceBinding,
    nutrientMappingDigest: sha256(object.nutrientMappingDigest, `${field}.nutrientMappingDigest`),
    parserBuildSha256: sha256(object.parserBuildSha256, `${field}.parserBuildSha256`),
    parserReportSha256: sha256(object.parserReportSha256, `${field}.parserReportSha256`),
    parserVersion: requiredText(object.parserVersion, `${field}.parserVersion`),
    releaseKey: requiredText(object.releaseKey, `${field}.releaseKey`),
    rightsManifestSha256: sha256(object.rightsManifestSha256, `${field}.rightsManifestSha256`),
    validationDigest: sha256(object.validationDigest, `${field}.validationDigest`),
    ...(hasReleaseId ? { releaseId: uuid(object.releaseId, `${field}.releaseId`) } : {}),
  };
  return normalized as T;
}

function normalizeCandidateCounts(
  value: CatalogueReconciliationCandidateCounts,
): CatalogueReconciliationCandidateCounts {
  const object = exactObject(value, "candidateCounts", [
    "parserExcludedNutrients",
    "parserExcludedPortions",
    "parserExcludedRecords",
    "stagedQuarantined",
    "stagedValid",
  ]);
  return {
    parserExcludedNutrients: unsignedDecimal(
      object.parserExcludedNutrients,
      "candidateCounts.parserExcludedNutrients",
    ),
    parserExcludedPortions: unsignedDecimal(
      object.parserExcludedPortions,
      "candidateCounts.parserExcludedPortions",
    ),
    parserExcludedRecords: unsignedDecimal(
      object.parserExcludedRecords,
      "candidateCounts.parserExcludedRecords",
    ),
    stagedQuarantined: unsignedDecimal(
      object.stagedQuarantined,
      "candidateCounts.stagedQuarantined",
    ),
    stagedValid: unsignedDecimal(object.stagedValid, "candidateCounts.stagedValid"),
  };
}

function normalizeQuarantine(
  values: readonly CatalogueReconciliationQuarantinedRecord[],
): readonly CatalogueReconciliationQuarantinedRecord[] {
  const normalized = jsonArray(values, "quarantinedRecords").map((entry, index) => {
    const field = `quarantinedRecords[${index}]`;
    const object = exactObject(entry, field, [
      "canonicalPayloadSha256",
      "issues",
      "sourceRecordKey",
    ]);
    const issues = jsonArray(object.issues, `${field}.issues`).map((issue, issueIndex) =>
      normalizeValidationIssue(issue, `${field}.issues[${issueIndex}]`),
    );
    issues.sort((left, right) => compareCodePoints(issueSortKey(left), issueSortKey(right)));
    rejectDuplicateIdentities(issues, issueSortKey, `${field}.issues`);
    return {
      canonicalPayloadSha256: sha256(
        object.canonicalPayloadSha256,
        `${field}.canonicalPayloadSha256`,
      ),
      issues,
      sourceRecordKey: requiredText(object.sourceRecordKey, `${field}.sourceRecordKey`),
    };
  });
  normalized.sort((left, right) => compareCodePoints(left.sourceRecordKey, right.sourceRecordKey));
  rejectDuplicateIdentities(normalized, (entry) => entry.sourceRecordKey, "quarantinedRecords");
  return normalized;
}

function normalizeValidationIssue(value: unknown, field: string): JsonObject {
  const object = exactObject(value, field, ["code", "disposition", "message", "path", "severity"]);
  return {
    code: requiredText(object.code, `${field}.code`),
    disposition: enumValue(object.disposition, `${field}.disposition`, VALIDATION_DISPOSITIONS),
    message: requiredText(object.message, `${field}.message`),
    path: requiredText(object.path, `${field}.path`),
    severity: enumValue(object.severity, `${field}.severity`, VALIDATION_SEVERITIES),
  };
}

function normalizeRejectedBarcodes(
  values: readonly CatalogueReconciliationRejectedBarcode[],
): readonly CatalogueReconciliationRejectedBarcode[] {
  const normalized = jsonArray(values, "rejectedCandidateBarcodes").map((entry, index) =>
    normalizeRejectedBarcode(entry, `rejectedCandidateBarcodes[${index}]`),
  );
  normalized.sort((left, right) =>
    compareCodePoints(rejectedBarcodeSortKey(left), rejectedBarcodeSortKey(right)),
  );
  rejectDuplicateIdentities(normalized, rejectedBarcodeSortKey, "rejectedCandidateBarcodes");
  return normalized;
}

function normalizeRejectedBarcode(
  value: unknown,
  field: string,
): CatalogueReconciliationRejectedBarcode {
  const object = exactObject(value, field, [
    "marketCode",
    "normalizedGtin",
    "rawValue",
    "reasonCode",
    "sourceFoodKey",
  ]);
  const reasonCode = enumValue(object.reasonCode, `${field}.reasonCode`, REJECTED_BARCODE_REASONS);
  const market =
    object.marketCode === null ? null : marketCode(object.marketCode, `${field}.marketCode`);
  const normalizedGtin = nullableGtin14(object.normalizedGtin, `${field}.normalizedGtin`);
  if (
    (reasonCode === "BARCODE_CROSS_SOURCE_CONFLICT" &&
      (market === null || normalizedGtin === null)) ||
    (reasonCode === "BARCODE_INVALID_GTIN" && normalizedGtin !== null)
  ) {
    throw new Error(`${field} reason does not match its normalized GTIN and market evidence`);
  }
  return {
    marketCode: market,
    normalizedGtin,
    rawValue: requiredText(object.rawValue, `${field}.rawValue`),
    reasonCode,
    sourceFoodKey: requiredText(object.sourceFoodKey, `${field}.sourceFoodKey`),
  };
}

function rejectedBarcodeSortKey(entry: CatalogueReconciliationRejectedBarcode): string {
  return [
    entry.sourceFoodKey,
    entry.reasonCode,
    entry.marketCode ?? "",
    entry.normalizedGtin ?? "",
    entry.rawValue,
  ].join("\u0000");
}

function barcodeAssignments(
  foods: readonly CatalogueReconciliationFoodSnapshot[],
): BarcodeAssignment[] {
  return foods
    .filter((food) => food.gtin !== null)
    .map((food) => ({
      gtin: food.gtin as string,
      marketCode: food.marketCode,
      sourceFoodKey: food.sourceFoodKey,
    }))
    .sort(compareBarcode);
}

function groupByBarcode(
  assignments: readonly BarcodeAssignment[],
): Map<string, BarcodeAssignment[]> {
  const groups = new Map<string, BarcodeAssignment[]>();
  for (const assignment of assignments) {
    const identity = `${String(assignment.marketCode)}\u0000${String(assignment.gtin)}`;
    const group = groups.get(identity) ?? [];
    group.push(assignment);
    groups.set(identity, group);
  }
  for (const group of groups.values()) group.sort(compareBarcode);
  return groups;
}

function compareBarcode(left: BarcodeAssignment, right: BarcodeAssignment): number {
  return compareCodePoints(
    `${String(left.marketCode)}\u0000${String(left.gtin)}\u0000${String(left.sourceFoodKey)}`,
    `${String(right.marketCode)}\u0000${String(right.gtin)}\u0000${String(right.sourceFoodKey)}`,
  );
}

function compareTransition(left: JsonObject, right: JsonObject): number {
  return compareCodePoints(
    `${String(left.sourceFoodKey)}\u0000${String(left.nutrientCode)}`,
    `${String(right.sourceFoodKey)}\u0000${String(right.nutrientCode)}`,
  );
}

function validateEvidenceSchema(value: unknown): JsonObject {
  const evidence = exactObject(value, "evidence", [
    "barcodes",
    "baseline",
    "candidate",
    "counts",
    "mappings",
    "missingnessStateEvidence",
    "missingnessTransitions",
    "quarantine",
    "records",
    "scope",
    "separateEvidenceRequired",
    "sourceCode",
  ]);
  if (evidence.scope !== "database-catalogue-only") {
    throw new Error("Reconciliation scope is invalid");
  }
  requiredText(evidence.sourceCode, "evidence.sourceCode");
  const baseline =
    evidence.baseline === null
      ? null
      : validateReportReleaseEvidence(evidence.baseline, "evidence.baseline", true);
  const candidate = validateReportReleaseEvidence(evidence.candidate, "evidence.candidate", false);
  validateRecordsEvidence(evidence.records, baseline === null);
  const missingnessStateEvidence = validateMissingnessStateEvidence(
    evidence.missingnessStateEvidence,
  );
  validateMissingnessTransitions(evidence.missingnessTransitions, missingnessStateEvidence);
  validateMappingEvidence(evidence.mappings, baseline, candidate);
  validateBarcodeEvidence(evidence.barcodes, baseline === null);
  validateQuarantineEvidence(evidence.quarantine, candidate);
  const required = jsonArray(
    evidence.separateEvidenceRequired,
    "evidence.separateEvidenceRequired",
  );
  if (canonicalJson(required) !== canonicalJson(SEPARATE_EVIDENCE_REQUIRED)) {
    throw new Error("Separate evidence requirements are not canonical");
  }
  validateRecursiveDigests(evidence, "evidence");
  validateEvidenceCounts(evidence, baseline === null);
  return evidence as JsonObject;
}

function validateReportReleaseEvidence(
  value: unknown,
  field: string,
  hasReleaseId: boolean,
): Readonly<Record<string, JsonValue>> {
  const object = exactObject(value, field, [
    "artifactBytes",
    "artifactSha256",
    "batchId",
    "evidenceBundleSha256",
    "evidenceBundleUri",
    "evidenceDecisionSha256",
    "evidenceObjectVersionId",
    "evidenceValidUntil",
    "nutrientMappingDigest",
    "parserBuildSha256",
    "parserReportSha256",
    "parserVersion",
    "recordSetSha256",
    "releaseClass",
    "releaseKey",
    "rightsManifestSha256",
    "validationDigest",
    ...(hasReleaseId ? ["releaseId"] : []),
  ]);
  unsignedDecimal(object.artifactBytes, `${field}.artifactBytes`);
  sha256(object.artifactSha256, `${field}.artifactSha256`);
  uuid(object.batchId, `${field}.batchId`);
  normalizeEvidenceBinding(object, field, hasReleaseId);
  sha256(object.nutrientMappingDigest, `${field}.nutrientMappingDigest`);
  sha256(object.parserBuildSha256, `${field}.parserBuildSha256`);
  sha256(object.parserReportSha256, `${field}.parserReportSha256`);
  requiredText(object.parserVersion, `${field}.parserVersion`);
  sha256(object.recordSetSha256, `${field}.recordSetSha256`);
  requiredText(object.releaseKey, `${field}.releaseKey`);
  sha256(object.rightsManifestSha256, `${field}.rightsManifestSha256`);
  sha256(object.validationDigest, `${field}.validationDigest`);
  if (hasReleaseId) uuid(object.releaseId, `${field}.releaseId`);
  return object;
}

function normalizeEvidenceBinding(
  object: Readonly<Record<string, unknown>>,
  field: string,
  hasReleaseId: boolean,
): {
  readonly evidenceBundleSha256: string | null;
  readonly evidenceBundleUri: string | null;
  readonly evidenceDecisionSha256: string | null;
  readonly evidenceObjectVersionId: string | null;
  readonly evidenceValidUntil: string | null;
  readonly releaseClass: FoodImportReleaseClass;
} {
  const releaseClass = enumValue(object.releaseClass, `${field}.releaseClass`, RELEASE_CLASSES);
  const evidenceBundleSha256 = nullableSha256(
    object.evidenceBundleSha256,
    `${field}.evidenceBundleSha256`,
  );
  const evidenceBundleUri = nullableBoundedText(
    object.evidenceBundleUri,
    `${field}.evidenceBundleUri`,
    2_048,
  );
  const evidenceDecisionSha256 = nullableSha256(
    object.evidenceDecisionSha256,
    `${field}.evidenceDecisionSha256`,
  );
  const evidenceObjectVersionId = nullableOpaqueProviderIdentifier(
    object.evidenceObjectVersionId,
    `${field}.evidenceObjectVersionId`,
  );
  const evidenceValidUntil = nullableIsoTimestamp(
    object.evidenceValidUntil,
    `${field}.evidenceValidUntil`,
  );
  const evidenceValues = [
    evidenceBundleSha256,
    evidenceBundleUri,
    evidenceDecisionSha256,
    evidenceObjectVersionId,
    evidenceValidUntil,
  ];
  if (releaseClass === "legacy-unbound") {
    if (!hasReleaseId || evidenceValues.some((entry) => entry !== null)) {
      throw new Error(`${field} legacy-unbound evidence is only valid for a null-bound baseline`);
    }
  } else if (evidenceValues.some((entry) => entry === null)) {
    throw new Error(`${field} ${releaseClass} evidence must include every binding field`);
  }
  if (evidenceBundleSha256 !== null && evidenceBundleUri !== null) {
    contentAddressedEvidenceBundleUri(
      evidenceBundleUri,
      evidenceBundleSha256,
      `${field}.evidenceBundleUri`,
    );
  }
  if (hasReleaseId && releaseClass === "fixture-nonrelease") {
    throw new Error(`${field} fixture-nonrelease evidence cannot be an active baseline`);
  }
  return {
    evidenceBundleSha256,
    evidenceBundleUri,
    evidenceDecisionSha256,
    evidenceObjectVersionId,
    evidenceValidUntil,
    releaseClass,
  };
}

function validateRecordsEvidence(value: unknown, baselineAbsent: boolean): void {
  const records = exactObject(value, "evidence.records", [
    "added",
    "changed",
    "removed",
    "unchangedCount",
  ]);
  const added = jsonArray(records.added, "evidence.records.added").map((entry, index) => {
    const field = `evidence.records.added[${index}]`;
    const object = exactObject(entry, field, ["candidateFingerprint", "sourceFoodKey"]);
    sha256(object.candidateFingerprint, `${field}.candidateFingerprint`);
    return requiredText(object.sourceFoodKey, `${field}.sourceFoodKey`);
  });
  assertSortedStrings(added, "evidence.records.added");

  const changed = jsonArray(records.changed, "evidence.records.changed").map((entry, index) =>
    validateChangedRecord(entry, `evidence.records.changed[${index}]`),
  );
  assertSortedStrings(
    changed.map((entry) => entry.sourceFoodKey),
    "evidence.records.changed",
  );

  const removed = jsonArray(records.removed, "evidence.records.removed").map((entry, index) => {
    const field = `evidence.records.removed[${index}]`;
    const object = exactObject(entry, field, ["currentFingerprint", "sourceFoodKey"]);
    sha256(object.currentFingerprint, `${field}.currentFingerprint`);
    return requiredText(object.sourceFoodKey, `${field}.sourceFoodKey`);
  });
  assertSortedStrings(removed, "evidence.records.removed");
  unsignedDecimal(records.unchangedCount, "evidence.records.unchangedCount");

  const allKeys = [...added, ...changed.map((entry) => entry.sourceFoodKey), ...removed];
  if (new Set(allKeys).size !== allKeys.length) {
    throw new Error("Record reconciliation categories must have disjoint sourceFoodKey values");
  }
  if (
    baselineAbsent &&
    (changed.length > 0 || removed.length > 0 || records.unchangedCount !== "0")
  ) {
    throw new Error("A null baseline cannot contain changed, removed, or unchanged records");
  }
}

function validateChangedRecord(value: unknown, field: string): { readonly sourceFoodKey: string } {
  const object = exactObject(value, field, [
    "barcode",
    "candidateFingerprint",
    "currentFingerprint",
    "fields",
    "nutrients",
    "servings",
    "sourceFoodKey",
    "upstreamPayloadProvenanceChanged",
  ]);
  const candidateFingerprint = sha256(object.candidateFingerprint, `${field}.candidateFingerprint`);
  const currentFingerprint = sha256(object.currentFingerprint, `${field}.currentFingerprint`);
  if (candidateFingerprint === currentFingerprint) {
    throw new Error(`${field} must have distinct current and candidate fingerprints`);
  }
  const fields = jsonArray(object.fields, `${field}.fields`).map((entry, index) => {
    if (typeof entry !== "string" || !FOOD_FIELD_ORDER.includes(entry as never)) {
      throw new Error(`${field}.fields[${index}] is not a known semantic food field`);
    }
    return entry as (typeof FOOD_FIELD_ORDER)[number];
  });
  let previousFieldIndex = -1;
  for (const foodField of fields) {
    const fieldIndex = FOOD_FIELD_ORDER.indexOf(foodField);
    if (fieldIndex <= previousFieldIndex) {
      throw new Error(
        `${field}.fields must follow canonical semantic field order without duplicates`,
      );
    }
    previousFieldIndex = fieldIndex;
  }
  const barcodeChanged = validateFoodBarcodeChange(object.barcode, `${field}.barcode`);
  const nutrientChanges = validateComponentChanges(
    object.nutrients,
    `${field}.nutrients`,
    "nutrient",
  );
  const servingChanges = validateComponentChanges(object.servings, `${field}.servings`, "serving");
  const provenanceChanged = booleanValue(
    object.upstreamPayloadProvenanceChanged,
    `${field}.upstreamPayloadProvenanceChanged`,
  );
  if (
    fields.length === 0 &&
    !barcodeChanged &&
    nutrientChanges === 0 &&
    servingChanges === 0 &&
    !provenanceChanged
  ) {
    throw new Error(`${field} does not identify any semantic or provenance change`);
  }
  return { sourceFoodKey: requiredText(object.sourceFoodKey, `${field}.sourceFoodKey`) };
}

function validateFoodBarcodeChange(value: unknown, field: string): boolean {
  if (value === null) return false;
  const object = exactObject(value, field, ["candidate", "current"]);
  const candidate =
    object.candidate === null
      ? null
      : validateBarcodeIdentity(object.candidate, `${field}.candidate`);
  const current =
    object.current === null ? null : validateBarcodeIdentity(object.current, `${field}.current`);
  if (candidate === null && current === null) {
    throw new Error(`${field} cannot have two null sides`);
  }
  if (canonicalJson(candidate) === canonicalJson(current)) {
    throw new Error(`${field} must describe different current and candidate assignments`);
  }
  return true;
}

function validateBarcodeIdentity(value: unknown, field: string): JsonObject {
  const object = exactObject(value, field, ["gtin", "marketCode"]);
  return {
    gtin: gtin14(object.gtin, `${field}.gtin`),
    marketCode: marketCode(object.marketCode, `${field}.marketCode`),
  };
}

function validateComponentChanges(
  value: unknown,
  field: string,
  kind: "nutrient" | "serving",
): number {
  const entries = jsonArray(value, field).map((entry, index) => {
    const entryField = `${field}[${index}]`;
    const object = exactObject(entry, entryField, ["candidate", "current", "identity", "status"]);
    const status = enumValue(object.status, `${entryField}.status`, COMPONENT_STATUSES);
    const normalize = kind === "nutrient" ? normalizeNutrientSnapshot : normalizeServingSnapshot;
    const candidate =
      object.candidate === null ? null : normalize(object.candidate, `${entryField}.candidate`);
    const current =
      object.current === null ? null : normalize(object.current, `${entryField}.current`);
    if (
      (status === "added" && (current !== null || candidate === null)) ||
      (status === "removed" && (current === null || candidate !== null)) ||
      (status === "changed" && (current === null || candidate === null))
    ) {
      throw new Error(`${entryField} status does not match its current/candidate nullability`);
    }
    if (status === "changed" && canonicalJson(current) === canonicalJson(candidate)) {
      throw new Error(`${entryField} changed component must contain different snapshots`);
    }
    const identity = requiredText(object.identity, `${entryField}.identity`);
    const candidateIdentity =
      candidate === null
        ? null
        : kind === "nutrient"
          ? (candidate as CatalogueReconciliationNutrientSnapshot).nutrientCode
          : (candidate as CatalogueReconciliationServingSnapshot).sourceServingKey;
    const currentIdentity =
      current === null
        ? null
        : kind === "nutrient"
          ? (current as CatalogueReconciliationNutrientSnapshot).nutrientCode
          : (current as CatalogueReconciliationServingSnapshot).sourceServingKey;
    if (
      (candidateIdentity !== null && candidateIdentity !== identity) ||
      (currentIdentity !== null && currentIdentity !== identity)
    ) {
      throw new Error(`${entryField}.identity does not match its component snapshots`);
    }
    return identity;
  });
  assertSortedStrings(entries, field);
  return entries.length;
}

function validateMissingnessStateEvidence(value: unknown): readonly JsonObject[] {
  const states = jsonArray(value, "evidence.missingnessStateEvidence").map((entry, index) => {
    const field = `evidence.missingnessStateEvidence[${index}]`;
    const object = exactObject(entry, field, [
      "candidateState",
      "currentState",
      "nutrientCode",
      "sourceFoodKey",
    ]);
    const candidateState = enumValue(
      object.candidateState,
      `${field}.candidateState`,
      NUTRIENT_STATES,
    );
    const currentState = enumValue(object.currentState, `${field}.currentState`, NUTRIENT_STATES);
    const sourceFoodKey = requiredText(object.sourceFoodKey, `${field}.sourceFoodKey`);
    const nutrientCode = requiredText(object.nutrientCode, `${field}.nutrientCode`);
    return { candidateState, currentState, nutrientCode, sourceFoodKey };
  });
  assertSortedStrings(
    states.map((entry) => `${entry.sourceFoodKey}\u0000${entry.nutrientCode}`),
    "evidence.missingnessStateEvidence",
  );
  return states;
}

function validateMissingnessTransitions(
  value: unknown,
  stateEvidence: readonly JsonObject[],
): void {
  const transitions = jsonArray(value, "evidence.missingnessTransitions").map((entry, index) => {
    const field = `evidence.missingnessTransitions[${index}]`;
    const object = exactObject(entry, field, [
      "candidateState",
      "currentState",
      "nutrientCode",
      "sourceFoodKey",
    ]);
    const candidateState = enumValue(
      object.candidateState,
      `${field}.candidateState`,
      NUTRIENT_STATES,
    );
    const currentState = enumValue(object.currentState, `${field}.currentState`, NUTRIENT_STATES);
    if (candidateState === currentState) {
      throw new Error(`${field} must describe a state transition`);
    }
    return {
      candidateState,
      currentState,
      nutrientCode: requiredText(object.nutrientCode, `${field}.nutrientCode`),
      sourceFoodKey: requiredText(object.sourceFoodKey, `${field}.sourceFoodKey`),
    };
  });
  assertSortedStrings(
    transitions.map((entry) => `${entry.sourceFoodKey}\u0000${entry.nutrientCode}`),
    "evidence.missingnessTransitions",
  );
  const expected = stateEvidence.filter((entry) => entry.currentState !== entry.candidateState);
  if (canonicalJson(transitions) !== canonicalJson(expected)) {
    throw new Error("Missingness transitions do not exactly match nutrient-state evidence");
  }
}

function validateMappingEvidence(
  value: unknown,
  baseline: Readonly<Record<string, JsonValue>> | null,
  candidate: Readonly<Record<string, JsonValue>>,
): void {
  const mappings = exactObject(value, "evidence.mappings", [
    "baselineDigest",
    "candidateDigest",
    "digestChanged",
    "transitionScope",
    "transitions",
  ]);
  if (mappings.transitionScope !== "materialized-observations-only") {
    throw new Error("Mapping transition scope is invalid");
  }
  const baselineDigest =
    mappings.baselineDigest === null
      ? null
      : sha256(mappings.baselineDigest, "evidence.mappings.baselineDigest");
  const candidateDigest = sha256(mappings.candidateDigest, "evidence.mappings.candidateDigest");
  if (baselineDigest !== (baseline?.nutrientMappingDigest ?? null)) {
    throw new Error("Mapping baseline digest does not match baseline provenance");
  }
  if (candidateDigest !== candidate.nutrientMappingDigest) {
    throw new Error("Mapping candidate digest does not match candidate provenance");
  }
  const digestChanged = booleanValue(mappings.digestChanged, "evidence.mappings.digestChanged");
  if (digestChanged !== (baseline !== null && baselineDigest !== candidateDigest)) {
    throw new Error("Mapping digestChanged does not match its bound digests");
  }
  const transitions = jsonArray(mappings.transitions, "evidence.mappings.transitions").map(
    (entry, index) => {
      const field = `evidence.mappings.transitions[${index}]`;
      const object = exactObject(entry, field, [
        "candidate",
        "current",
        "sourceNutrientKey",
        "status",
      ]);
      const status = enumValue(object.status, `${field}.status`, COMPONENT_STATUSES);
      const candidateSnapshot =
        object.candidate === null
          ? null
          : normalizeMappingSnapshot(object.candidate, `${field}.candidate`);
      const currentSnapshot =
        object.current === null
          ? null
          : normalizeMappingSnapshot(object.current, `${field}.current`);
      if (
        (status === "added" && (currentSnapshot !== null || candidateSnapshot === null)) ||
        (status === "removed" && (currentSnapshot === null || candidateSnapshot !== null)) ||
        (status === "changed" && (currentSnapshot === null || candidateSnapshot === null))
      ) {
        throw new Error(`${field} status does not match its current/candidate nullability`);
      }
      if (
        status === "changed" &&
        canonicalJson(currentSnapshot) === canonicalJson(candidateSnapshot)
      ) {
        throw new Error(`${field} changed mapping must contain different snapshots`);
      }
      if (baseline === null && currentSnapshot !== null) {
        throw new Error(`${field} cannot contain a current mapping without a baseline`);
      }
      const sourceNutrientKey = requiredText(
        object.sourceNutrientKey,
        `${field}.sourceNutrientKey`,
      );
      if (
        (candidateSnapshot !== null && candidateSnapshot.sourceNutrientKey !== sourceNutrientKey) ||
        (currentSnapshot !== null && currentSnapshot.sourceNutrientKey !== sourceNutrientKey)
      ) {
        throw new Error(`${field}.sourceNutrientKey does not match its mapping snapshots`);
      }
      return sourceNutrientKey;
    },
  );
  assertSortedStrings(transitions, "evidence.mappings.transitions");
}

function validateBarcodeEvidence(value: unknown, baselineAbsent: boolean): void {
  const barcodes = exactObject(value, "evidence.barcodes", [
    "added",
    "baselineAssignments",
    "candidateAssignments",
    "candidateCollisions",
    "markets",
    "reassigned",
    "rejectedCandidate",
    "removed",
  ]);
  const baselineAssignments = validateBarcodeAssignmentPopulation(
    barcodes.baselineAssignments,
    "evidence.barcodes.baselineAssignments",
  );
  if (baselineAbsent && baselineAssignments.length > 0) {
    throw new Error("A null baseline cannot contain baseline barcode assignments");
  }
  const candidateAssignments = validateBarcodeAssignmentPopulation(
    barcodes.candidateAssignments,
    "evidence.barcodes.candidateAssignments",
  );
  const addedAssignments = jsonArray(barcodes.added, "evidence.barcodes.added").map(
    (entry, index) => validateBarcodeAssignment(entry, `evidence.barcodes.added[${index}]`),
  );
  const removedAssignments = jsonArray(barcodes.removed, "evidence.barcodes.removed").map(
    (entry, index) => validateBarcodeAssignment(entry, `evidence.barcodes.removed[${index}]`),
  );
  for (const [key, assignments] of [
    ["added", addedAssignments],
    ["removed", removedAssignments],
  ] as const) {
    assertSorted(
      assignments,
      (entry) => barcodeSortKey(entry as BarcodeAssignment),
      `evidence.barcodes.${key}`,
    );
  }
  const expectedCollisions = [...groupByBarcode(candidateAssignments).values()]
    .filter((group) => group.length > 1)
    .map((group) => ({
      gtin: group[0]?.gtin ?? "",
      marketCode: group[0]?.marketCode ?? "",
      sourceFoodKeys: group.map((entry) => entry.sourceFoodKey).sort(compareCodePoints),
    }))
    .sort((left, right) =>
      compareCodePoints(
        `${left.marketCode}\u0000${left.gtin}`,
        `${right.marketCode}\u0000${right.gtin}`,
      ),
    );

  const rejectedRows = jsonArray(
    barcodes.rejectedCandidate,
    "evidence.barcodes.rejectedCandidate",
  ).map((entry, index) =>
    normalizeRejectedBarcode(entry, `evidence.barcodes.rejectedCandidate[${index}]`),
  );
  assertSorted(
    rejectedRows,
    (entry) => rejectedBarcodeSortKey(entry as CatalogueReconciliationRejectedBarcode),
    "evidence.barcodes.rejectedCandidate",
  );
  const crossSourceConflictsByMarket = new Map<string, bigint>();
  for (const rejection of rejectedRows) {
    if (rejection.reasonCode !== "BARCODE_CROSS_SOURCE_CONFLICT") continue;
    if (!rejection.marketCode) {
      throw new Error("Cross-source barcode rejection is missing its market");
    }
    crossSourceConflictsByMarket.set(
      rejection.marketCode,
      (crossSourceConflictsByMarket.get(rejection.marketCode) ?? 0n) + 1n,
    );
  }

  const collisionAssignmentsByMarket = new Map<string, bigint>();
  const collisions = jsonArray(
    barcodes.candidateCollisions,
    "evidence.barcodes.candidateCollisions",
  ).map((entry, index) => {
    const field = `evidence.barcodes.candidateCollisions[${index}]`;
    const object = exactObject(entry, field, ["gtin", "marketCode", "sourceFoodKeys"]);
    const gtin = gtin14(object.gtin, `${field}.gtin`);
    const market = marketCode(object.marketCode, `${field}.marketCode`);
    const sourceFoodKeys = jsonArray(object.sourceFoodKeys, `${field}.sourceFoodKeys`).map(
      (sourceFoodKey, sourceIndex) =>
        requiredText(sourceFoodKey, `${field}.sourceFoodKeys[${sourceIndex}]`),
    );
    if (sourceFoodKeys.length < 2)
      throw new Error(`${field} must contain at least two assignments`);
    assertSortedStrings(sourceFoodKeys, `${field}.sourceFoodKeys`);
    collisionAssignmentsByMarket.set(
      market,
      (collisionAssignmentsByMarket.get(market) ?? 0n) + BigInt(sourceFoodKeys.length),
    );
    return { gtin, marketCode: market, sourceFoodKeys };
  });
  assertSortedStrings(
    collisions.map((entry) => `${entry.marketCode}\u0000${entry.gtin}`),
    "evidence.barcodes.candidateCollisions",
  );
  if (canonicalJson(collisions) !== canonicalJson(expectedCollisions)) {
    throw new Error("Candidate collision evidence does not match candidate assignments");
  }

  const acceptedAssignmentsByMarket = new Map<string, bigint>();
  for (const assignment of candidateAssignments) {
    acceptedAssignmentsByMarket.set(
      assignment.marketCode,
      (acceptedAssignmentsByMarket.get(assignment.marketCode) ?? 0n) + 1n,
    );
  }

  const markets = jsonArray(barcodes.markets, "evidence.barcodes.markets").map((entry, index) => {
    const field = `evidence.barcodes.markets[${index}]`;
    const object = exactObject(entry, field, [
      "assignmentCount",
      "collisionAssignmentCount",
      "collisionRate",
      "crossSourceConflictCount",
      "marketCode",
      "withinCandidateCollisionAssignmentCount",
    ]);
    const market = marketCode(object.marketCode, `${field}.marketCode`);
    const assignmentCount = BigInt(
      unsignedDecimal(object.assignmentCount, `${field}.assignmentCount`),
    );
    const collisionAssignmentCount = BigInt(
      unsignedDecimal(object.collisionAssignmentCount, `${field}.collisionAssignmentCount`),
    );
    const crossSourceConflictCount = BigInt(
      unsignedDecimal(object.crossSourceConflictCount, `${field}.crossSourceConflictCount`),
    );
    const withinCandidateCollisionAssignmentCount = BigInt(
      unsignedDecimal(
        object.withinCandidateCollisionAssignmentCount,
        `${field}.withinCandidateCollisionAssignmentCount`,
      ),
    );
    const rate = exactObject(object.collisionRate, `${field}.collisionRate`, [
      "denominator",
      "numerator",
    ]);
    const denominator = BigInt(
      unsignedDecimal(rate.denominator, `${field}.collisionRate.denominator`),
    );
    const numerator = BigInt(unsignedDecimal(rate.numerator, `${field}.collisionRate.numerator`));
    if (
      denominator !== assignmentCount ||
      numerator !== collisionAssignmentCount ||
      numerator > denominator ||
      withinCandidateCollisionAssignmentCount !==
        (collisionAssignmentsByMarket.get(market) ?? 0n) ||
      crossSourceConflictCount !== (crossSourceConflictsByMarket.get(market) ?? 0n) ||
      assignmentCount !==
        (acceptedAssignmentsByMarket.get(market) ?? 0n) + crossSourceConflictCount ||
      collisionAssignmentCount !==
        withinCandidateCollisionAssignmentCount + crossSourceConflictCount
    ) {
      throw new Error(
        `${field} collision counts/rate do not match candidate and cross-source conflicts`,
      );
    }
    return market;
  });
  assertSortedStrings(markets, "evidence.barcodes.markets");
  for (const market of collisionAssignmentsByMarket.keys()) {
    if (!markets.includes(market)) {
      throw new Error(`Candidate barcode collision market ${market} has no market-rate row`);
    }
  }
  for (const market of crossSourceConflictsByMarket.keys()) {
    if (!markets.includes(market)) {
      throw new Error(`Cross-source barcode conflict market ${market} has no market-rate row`);
    }
  }
  for (const market of acceptedAssignmentsByMarket.keys()) {
    if (!markets.includes(market)) {
      throw new Error(`Candidate barcode assignment market ${market} has no market-rate row`);
    }
  }

  const reassigned = jsonArray(barcodes.reassigned, "evidence.barcodes.reassigned").map(
    (entry, index) => {
      const field = `evidence.barcodes.reassigned[${index}]`;
      const object = exactObject(entry, field, ["candidate", "current"]);
      const candidate = validateBarcodeAssignment(object.candidate, `${field}.candidate`);
      const current = validateBarcodeAssignment(object.current, `${field}.current`);
      if (
        candidate.gtin !== current.gtin ||
        candidate.marketCode !== current.marketCode ||
        candidate.sourceFoodKey === current.sourceFoodKey
      ) {
        throw new Error(`${field} must move one market/GTIN identity to a different source food`);
      }
      return { candidate, current } as JsonObject;
    },
  );
  assertSortedStrings(
    reassigned.map((entry) => canonicalJson(entry)),
    "evidence.barcodes.reassigned",
  );

  const expectedTransitions = deriveBarcodeTransitions(baselineAssignments, candidateAssignments);
  for (const [name, actual, expected] of [
    ["added", addedAssignments, expectedTransitions.added],
    ["removed", removedAssignments, expectedTransitions.removed],
    ["reassigned", reassigned, expectedTransitions.reassigned],
  ] as const) {
    if (
      canonicalJson(actual as unknown as JsonValue) !==
      canonicalJson(expected as unknown as JsonValue)
    ) {
      throw new Error(`Barcode ${name} evidence does not match baseline/candidate assignments`);
    }
  }
}

function validateBarcodeAssignmentPopulation(value: unknown, field: string): BarcodeAssignment[] {
  const assignments = jsonArray(value, field).map((entry, index) =>
    validateBarcodeAssignment(entry, `${field}[${index}]`),
  );
  assertSorted(assignments, (entry) => barcodeSortKey(entry as BarcodeAssignment), field);
  if (
    new Set(assignments.map((assignment) => assignment.sourceFoodKey)).size !== assignments.length
  ) {
    throw new Error(`${field} must contain each source food at most once`);
  }
  return assignments;
}

function validateBarcodeAssignment(value: unknown, field: string): BarcodeAssignment {
  const object = exactObject(value, field, ["gtin", "marketCode", "sourceFoodKey"]);
  return {
    gtin: gtin14(object.gtin, `${field}.gtin`),
    marketCode: marketCode(object.marketCode, `${field}.marketCode`),
    sourceFoodKey: requiredText(object.sourceFoodKey, `${field}.sourceFoodKey`),
  };
}

function validateQuarantineEvidence(
  value: unknown,
  candidate: Readonly<Record<string, JsonValue>>,
): void {
  const quarantine = exactObject(value, "evidence.quarantine", [
    "parserExcludedNutrients",
    "parserExcludedPortions",
    "parserExcludedRecords",
    "parserReportSha256",
    "records",
  ]);
  unsignedDecimal(
    quarantine.parserExcludedNutrients,
    "evidence.quarantine.parserExcludedNutrients",
  );
  unsignedDecimal(quarantine.parserExcludedPortions, "evidence.quarantine.parserExcludedPortions");
  unsignedDecimal(quarantine.parserExcludedRecords, "evidence.quarantine.parserExcludedRecords");
  const parserReportSha256 = sha256(
    quarantine.parserReportSha256,
    "evidence.quarantine.parserReportSha256",
  );
  if (parserReportSha256 !== candidate.parserReportSha256) {
    throw new Error("Quarantine parser report digest does not match candidate provenance");
  }
  const records = jsonArray(quarantine.records, "evidence.quarantine.records").map(
    (entry, index) => {
      const field = `evidence.quarantine.records[${index}]`;
      const object = exactObject(entry, field, [
        "canonicalPayloadSha256",
        "issues",
        "sourceRecordKey",
      ]);
      sha256(object.canonicalPayloadSha256, `${field}.canonicalPayloadSha256`);
      const issues = jsonArray(object.issues, `${field}.issues`).map((issue, issueIndex) => {
        const normalized = normalizeValidationIssue(issue, `${field}.issues[${issueIndex}]`);
        return { normalized, sortKey: issueSortKey(normalized) };
      });
      assertSortedStrings(
        issues.map((issue) => issue.sortKey),
        `${field}.issues`,
      );
      if (!issues.some((issue) => issue.normalized.severity === "error")) {
        throw new Error(`${field} must retain at least one record-blocking error`);
      }
      return requiredText(object.sourceRecordKey, `${field}.sourceRecordKey`);
    },
  );
  assertSortedStrings(records, "evidence.quarantine.records");
}

function validateEvidenceCounts(evidence: JsonObject, baselineAbsent: boolean): void {
  const counts = exactObject(evidence.counts, "evidence.counts", [
    "addedRecords",
    "baselineBarcodes",
    "baselineNutrients",
    "baselineRecords",
    "baselineServings",
    "barcodeDelta",
    "candidateBarcodeCollisions",
    "candidateBarcodes",
    "candidateCrossSourceBarcodeConflicts",
    "candidateInvalidBarcodes",
    "candidateNutrients",
    "candidateParserExcludedNutrients",
    "candidateParserExcludedPortions",
    "candidateParserExcludedRecords",
    "candidateRecords",
    "candidateRejectedBarcodes",
    "candidateServings",
    "candidateStagedQuarantined",
    "candidateStagedValid",
    "changedRecords",
    "nutrientDelta",
    "recordDelta",
    "removedRecords",
    "servingDelta",
    "unchangedRecords",
  ]);
  for (const [key, value] of Object.entries(counts)) {
    if (key.endsWith("Delta")) signedDecimal(value, `evidence.counts.${key}`);
    else unsignedDecimal(value, `evidence.counts.${key}`);
  }
  const baselineRecords = BigInt(String(counts.baselineRecords));
  const candidateRecords = BigInt(String(counts.candidateRecords));
  const added = BigInt(String(counts.addedRecords));
  const removed = BigInt(String(counts.removedRecords));
  const changed = BigInt(String(counts.changedRecords));
  const unchanged = BigInt(String(counts.unchangedRecords));
  if (baselineRecords !== removed + changed + unchanged) {
    throw new Error("Baseline record reconciliation counts do not balance");
  }
  if (candidateRecords !== added + changed + unchanged) {
    throw new Error("Candidate record reconciliation counts do not balance");
  }
  const records = exactObject(evidence.records, "evidence.records", [
    "added",
    "changed",
    "removed",
    "unchangedCount",
  ]);
  if (
    added !== BigInt(jsonArray(records.added, "evidence.records.added").length) ||
    changed !== BigInt(jsonArray(records.changed, "evidence.records.changed").length) ||
    removed !== BigInt(jsonArray(records.removed, "evidence.records.removed").length) ||
    unchanged !== BigInt(unsignedDecimal(records.unchangedCount, "evidence.records.unchangedCount"))
  ) {
    throw new Error("Record reconciliation counts do not match record evidence arrays");
  }
  const deltaChecks: ReadonlyArray<readonly [string, bigint]> = [
    ["recordDelta", candidateRecords - baselineRecords],
    [
      "nutrientDelta",
      BigInt(String(counts.candidateNutrients)) - BigInt(String(counts.baselineNutrients)),
    ],
    [
      "servingDelta",
      BigInt(String(counts.candidateServings)) - BigInt(String(counts.baselineServings)),
    ],
    [
      "barcodeDelta",
      BigInt(String(counts.candidateBarcodes)) - BigInt(String(counts.baselineBarcodes)),
    ],
  ];
  for (const [name, expected] of deltaChecks) {
    if (BigInt(String(counts[name])) !== expected) {
      throw new Error(`evidence.counts.${name} does not match its baseline/candidate counts`);
    }
  }
  const missingnessStateEvidence = jsonArray(
    evidence.missingnessStateEvidence,
    "evidence.missingnessStateEvidence",
  ).map((entry, index) => exactObject(entry, `evidence.missingnessStateEvidence[${index}]`));
  const baselineNutrientStates = missingnessStateEvidence.filter(
    (entry) => entry.currentState !== "missing",
  ).length;
  const candidateNutrientStates = missingnessStateEvidence.filter(
    (entry) => entry.candidateState !== "missing",
  ).length;
  if (
    BigInt(String(counts.baselineNutrients)) !== BigInt(baselineNutrientStates) ||
    BigInt(String(counts.candidateNutrients)) !== BigInt(candidateNutrientStates)
  ) {
    throw new Error("Nutrient counts do not match complete missingness-state evidence");
  }
  const candidate = exactObject(evidence.candidate, "evidence.candidate");
  const quarantine = exactObject(evidence.quarantine, "evidence.quarantine");
  if (
    counts.candidateStagedValid !== counts.candidateRecords ||
    counts.candidateStagedQuarantined !==
      String(jsonArray(quarantine.records, "quarantine.records").length) ||
    counts.candidateParserExcludedNutrients !== quarantine.parserExcludedNutrients ||
    counts.candidateParserExcludedPortions !== quarantine.parserExcludedPortions ||
    counts.candidateParserExcludedRecords !== quarantine.parserExcludedRecords ||
    candidate.parserReportSha256 !== quarantine.parserReportSha256
  ) {
    throw new Error(
      "Candidate staged/parser counts do not match candidate and quarantine evidence",
    );
  }
  const barcodes = exactObject(evidence.barcodes, "evidence.barcodes");
  const baselineAssignments = jsonArray(
    barcodes.baselineAssignments,
    "barcodes.baselineAssignments",
  );
  const candidateAssignments = jsonArray(
    barcodes.candidateAssignments,
    "barcodes.candidateAssignments",
  );
  if (BigInt(String(counts.baselineBarcodes)) !== BigInt(baselineAssignments.length)) {
    throw new Error("Baseline barcode count does not match accepted assignment evidence");
  }
  if (BigInt(String(counts.candidateBarcodes)) !== BigInt(candidateAssignments.length)) {
    throw new Error("Candidate barcode count does not match accepted assignment evidence");
  }
  if (
    BigInt(String(counts.candidateBarcodeCollisions)) !==
    BigInt(jsonArray(barcodes.candidateCollisions, "barcodes.candidateCollisions").length)
  ) {
    throw new Error("Candidate barcode collision count does not match collision evidence");
  }
  const rejectedBarcodes = jsonArray(barcodes.rejectedCandidate, "barcodes.rejectedCandidate").map(
    (entry, index) => normalizeRejectedBarcode(entry, `barcodes.rejectedCandidate[${index}]`),
  );
  const crossSourceConflicts = rejectedBarcodes.filter(
    (entry) => entry.reasonCode === "BARCODE_CROSS_SOURCE_CONFLICT",
  ).length;
  const invalidBarcodes = rejectedBarcodes.filter(
    (entry) => entry.reasonCode === "BARCODE_INVALID_GTIN",
  ).length;
  if (
    BigInt(String(counts.candidateRejectedBarcodes)) !== BigInt(rejectedBarcodes.length) ||
    BigInt(String(counts.candidateCrossSourceBarcodeConflicts)) !== BigInt(crossSourceConflicts) ||
    BigInt(String(counts.candidateInvalidBarcodes)) !== BigInt(invalidBarcodes)
  ) {
    throw new Error("Candidate rejected-barcode counts do not match rejection evidence");
  }
  const marketAssignments = jsonArray(barcodes.markets, "barcodes.markets").reduce(
    (total, market, index) =>
      total +
      BigInt(
        unsignedDecimal(
          exactObject(market, `barcodes.markets[${index}]`).assignmentCount,
          `barcodes.markets[${index}].assignmentCount`,
        ),
      ),
    0n,
  );
  if (
    marketAssignments !==
    BigInt(String(counts.candidateBarcodes)) +
      BigInt(String(counts.candidateCrossSourceBarcodeConflicts))
  ) {
    throw new Error(
      "Candidate accepted and cross-source barcode counts do not match per-market assignments",
    );
  }
  if (
    baselineAbsent &&
    [
      counts.baselineRecords,
      counts.baselineNutrients,
      counts.baselineServings,
      counts.baselineBarcodes,
    ].some((count) => count !== "0")
  ) {
    throw new Error("A null baseline must have zero baseline catalogue counts");
  }
}

function validateRecursiveDigests(value: JsonValue, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      validateRecursiveDigests(entry, `${path}[${index}]`);
    });
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (/(?:Sha256|Digest)$/.test(key) && entry !== null) sha256(entry, `${path}.${key}`);
    validateRecursiveDigests(entry ?? null, `${path}.${key}`);
  }
}

function exactObject(
  value: unknown,
  field: string,
  keys?: readonly string[],
): Readonly<Record<string, JsonValue>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${field} must be a plain JSON object`);
  }
  const object = value as Readonly<Record<string, JsonValue>>;
  if (keys) {
    const expected = [...keys].sort(compareCodePoints);
    const actual = Object.keys(object).sort(compareCodePoints);
    if (canonicalJson(actual) !== canonicalJson(expected)) {
      throw new Error(`${field} contains missing or unknown fields`);
    }
  }
  return object;
}

function jsonArray(value: unknown, field: string): readonly JsonValue[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value as readonly JsonValue[];
}

function assertSorted(
  values: readonly JsonValue[],
  key: (value: JsonValue) => string,
  field: string,
): void {
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1];
    const current = values[index];
    if (
      previous === undefined ||
      current === undefined ||
      compareCodePoints(key(previous), key(current)) >= 0
    ) {
      throw new Error(`${field} must be strictly code-point sorted without duplicates`);
    }
  }
}

function assertSortedStrings(values: readonly string[], field: string): void {
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1];
    const current = values[index];
    if (
      previous === undefined ||
      current === undefined ||
      compareCodePoints(previous, current) >= 0
    ) {
      throw new Error(`${field} must be strictly code-point sorted without duplicates`);
    }
  }
}

function rejectDuplicateIdentities<T>(
  values: readonly T[],
  identity: (value: T) => string,
  field: string,
): void {
  const seen = new Set<string>();
  for (const value of values) {
    const key = identity(value);
    if (seen.has(key)) throw new Error(`${field} contains duplicate identity ${key}`);
    seen.add(key);
  }
}

function issueSortKey(issue: JsonObject): string {
  return ["path", "code", "disposition", "severity", "message"]
    .map((key) => String(issue[key] ?? ""))
    .join("\u0000");
}

function canonicalDecimal(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/.test(value)) {
    throw new Error(`${field} must be a canonical non-negative decimal string`);
  }
  return value;
}

function nullableCanonicalDecimal(value: unknown, field: string): string | null {
  return value === null ? null : canonicalDecimal(value, field);
}

function nullableText(value: unknown, field: string): string | null {
  return value === null ? null : requiredText(value, field);
}

function nullableBoundedText(value: unknown, field: string, maximumBytes: number): string | null {
  const text = nullableText(value, field);
  if (text !== null && Buffer.byteLength(text, "utf8") > maximumBytes) {
    throw new Error(`${field} must contain at most ${maximumBytes} UTF-8 bytes`);
  }
  return text;
}

function nullableIsoTimestamp(value: unknown, field: string): string | null {
  if (value === null) return null;
  const text = requiredText(value, field);
  const parsed = new Date(text);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== text) {
    throw new Error(`${field} must be a canonical UTC ISO timestamp`);
  }
  return text;
}

function contentAddressedEvidenceBundleUri(value: string, digest: string, field: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${field} must be a valid S3 URI`);
  }
  const pathSegments = url.pathname.split("/");
  const pathIsCanonical =
    pathSegments[0] === "" &&
    pathSegments.length > 1 &&
    pathSegments.slice(1).every((segment) => /^[A-Za-z0-9_-][A-Za-z0-9._~-]*$/u.test(segment));
  const digestIsBound = pathSegments.some(
    (segment, index) => segment === "sha256" && pathSegments[index + 1] === digest,
  );
  const canonicalHostname = url.hostname.toLowerCase();
  const bucketIsValid =
    /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(canonicalHostname) &&
    !canonicalHostname.includes("..") &&
    !/^\d+\.\d+\.\d+\.\d+$/.test(canonicalHostname);
  if (
    url.protocol !== "s3:" ||
    !bucketIsValid ||
    url.href !== value ||
    url.hostname !== canonicalHostname ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    !pathIsCanonical ||
    !digestIsBound
  ) {
    throw new Error(`${field} must be a credential-free content-addressed S3 URI`);
  }
}

function nullableGtin14(value: unknown, field: string): string | null {
  return value === null ? null : gtin14(value, field);
}

function gtin14(value: unknown, field: string): string {
  if (typeof value !== "string" || !GTIN_14_PATTERN.test(value)) {
    throw new Error(`${field} must be a canonical GTIN-14`);
  }
  const digits = [...value].map(Number);
  const sum = digits
    .slice(0, 13)
    .reduce((total, digit, index) => total + digit * (index % 2 === 0 ? 3 : 1), 0);
  const expectedCheckDigit = (10 - (sum % 10)) % 10;
  if (digits[13] !== expectedCheckDigit) {
    throw new Error(`${field} must have a valid GTIN check digit`);
  }
  return value;
}

function marketCode(value: unknown, field: string): string {
  const text = requiredText(value, field);
  if (!/^[A-Z0-9]{2,3}$/.test(text)) throw new Error(`${field} must be a canonical market code`);
  return text;
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field} must be boolean`);
  return value;
}

function nonNegativeSafeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  field: string,
  values: T,
): T[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new Error(`${field} is not an allowed value`);
  }
  return value as T[number];
}

function decimalIsZero(value: string): boolean {
  return value === "0";
}

function unsignedDecimal(value: unknown, field: string): string {
  if (typeof value !== "string" || !UNSIGNED_DECIMAL_PATTERN.test(value)) {
    throw new Error(`${field} must be a canonical unsigned decimal string`);
  }
  return value;
}

function signedDecimal(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^(?:0|-?[1-9]\d*)$/.test(value)) {
    throw new Error(`${field} must be a canonical signed decimal string`);
  }
  return value;
}

function signedDelta(candidate: number, baseline: number): string {
  return String(candidate - baseline);
}

function barcodeSortKey(value: BarcodeAssignment): string {
  return `${value.marketCode}\u0000${value.gtin}\u0000${value.sourceFoodKey}`;
}

function sha256(value: unknown, field: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${field} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function nullableSha256(value: unknown, field: string): string | null {
  return value === null ? null : sha256(value, field);
}

function nullableOpaqueProviderIdentifier(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._~+/:@=-]{0,511}$/u.test(value)) {
    throw new Error(`${field} must be a bounded provider-neutral opaque identifier`);
  }
  return value;
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new Error(`${field} must be a canonical UUID`);
  }
  return value;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error(`${field} must be non-blank text without surrounding whitespace`);
  }
  return value;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodePoints);
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
