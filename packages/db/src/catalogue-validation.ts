import { createHash } from "node:crypto";

import type { JsonObject, JsonValue, NutrientValueStatus, ServingUnitKind } from "./types.js";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const DECIMAL_PATTERN = /^(0|[1-9]\d*)(?:\.(\d*[1-9]))?$/;
const GTIN_PATTERN = /^(?:\d{8}|\d{12}|\d{13}|\d{14})$/;

export type CatalogueValidationIssueSeverity = "error" | "warning";
export type CatalogueValidationDisposition =
  | "exclude_barcode"
  | "exclude_nutrient"
  | "exclude_record"
  | "exclude_serving";

export interface CatalogueValidationIssue extends JsonObject {
  readonly code: string;
  readonly disposition: CatalogueValidationDisposition;
  readonly message: string;
  readonly path: string;
  readonly severity: CatalogueValidationIssueSeverity;
}

export interface ValidatedNutrientValue {
  readonly amount: string;
  readonly canonicalUnit: string;
  readonly dataPoints: number | null;
  readonly derivationCode: string | null;
  readonly metadata: JsonObject;
  readonly mappingRevisionId: string;
  readonly nutrientCode: string;
  readonly nutrientId: string;
  readonly sourceAmount: string | null;
  readonly sourceBasisQuantity: string | null;
  readonly sourceBasisUnit: "g" | null;
  readonly sourceName: string;
  readonly sourceNutrientId: string;
  readonly sourceUnit: string | null;
  readonly valueStatus: NutrientValueStatus;
}

export interface ReviewedCatalogueNutrientMapping {
  readonly canonicalUnit: string;
  readonly conversionMultiplier: string;
  readonly mappingRevisionId: string;
  readonly nutrientCode: string;
  readonly nutrientId: string;
  readonly sourceNutrientId: string;
  readonly sourceUnit: string;
}

export interface ValidatedServing {
  readonly displayOrder: number;
  readonly gramWeight: string;
  readonly isDefault: boolean;
  readonly label: string;
  readonly metadata: JsonObject;
  readonly quantity: string;
  readonly sourceServingKey: string;
  readonly unit: string;
  readonly unitKind: ServingUnitKind;
}

export interface ValidatedCatalogueFood {
  readonly attributes: JsonObject;
  readonly basisQuantity: string;
  readonly brandName: string | null;
  readonly description: string | null;
  readonly gtin: string | null;
  readonly kind: "branded" | "generic";
  readonly marketCode: string;
  readonly name: string;
  readonly normalizedName: string;
  readonly nutrients: readonly ValidatedNutrientValue[];
  readonly servings: readonly ValidatedServing[];
  readonly sourceDataType: string;
  readonly sourceFoodKey: string;
  readonly sourceModifiedAt: string | null;
  readonly languageTag: string;
}

export interface CatalogueRecordValidationContext {
  readonly canonicalPayloadSha256: string;
  readonly expectedReleaseKey: string;
  readonly expectedSourceCode: string;
  readonly sourcePayloadSha256: string;
  readonly sourceRecordKey: string;
  readonly sourceRecordType: string;
}

export interface CatalogueRecordValidationResult {
  readonly excludedNutrientCount: number;
  readonly food: ValidatedCatalogueFood | null;
  readonly issues: readonly CatalogueValidationIssue[];
  readonly nutrientInputCount: number;
  readonly nutrientMaterializableCount: number;
  readonly portionInputCount: number;
  readonly recordIsValid: boolean;
}

/**
 * Deterministic JSON serialization used to bind staged rows, validation
 * approvals, and imported versions to exactly the bytes represented by JSON.
 */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Canonical JSON rejects non-finite numbers");
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  const object = value as JsonObject;
  return `{${Object.keys(object)
    .sort(compareCodePoints)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key] ?? null)}`)
    .join(",")}}`;
}

export function sha256CanonicalJson(value: JsonValue): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function validateCatalogueRecord(
  payload: JsonValue,
  context: CatalogueRecordValidationContext,
  reviewedMappings: ReadonlyMap<string, ReviewedCatalogueNutrientMapping> = new Map(),
  forbiddenGtins: ReadonlySet<string> = new Set(),
  duplicateSourceFoodKeys: ReadonlySet<string> = new Set(),
): CatalogueRecordValidationResult {
  const issues: CatalogueValidationIssue[] = [];
  const root = objectValue(payload);
  if (!root) {
    issues.push(
      issue(
        "RECORD_NOT_OBJECT",
        "error",
        "exclude_record",
        "$",
        "Canonical food record must be a JSON object",
      ),
    );
    return emptyResult(issues);
  }

  const schemaVersion = root.schemaVersion;
  if (schemaVersion !== 1) {
    issues.push(
      issue(
        "UNSUPPORTED_SCHEMA_VERSION",
        "error",
        "exclude_record",
        "$.schemaVersion",
        "Canonical food record schemaVersion must be 1",
      ),
    );
  }

  const idempotencyKey = boundedText(root.idempotencyKey, 1, 1_024);
  if (!idempotencyKey || idempotencyKey !== context.sourceRecordKey) {
    issues.push(
      issue(
        "IDEMPOTENCY_KEY_MISMATCH",
        "error",
        "exclude_record",
        "$.idempotencyKey",
        "Record idempotency key does not match its staged identity",
      ),
    );
  }

  const source = objectValue(root.source);
  const sourceCode = boundedText(source?.sourceCode, 1, 256);
  const releaseKey = boundedText(source?.releaseKey, 1, 1_024);
  const sourceRecordId = boundedText(source?.sourceRecordId, 1, 256);
  const sourceDataType = boundedText(source?.sourceDataType, 1, 256);
  const languageTag = boundedText(source?.languageTag, 2, 35);
  const marketCode = boundedText(source?.marketCode, 2, 3);
  const sourceModifiedAt = isoTimestamp(source?.sourceModifiedAt);
  if (
    !source ||
    sourceCode !== context.expectedSourceCode ||
    releaseKey !== context.expectedReleaseKey ||
    !sourceRecordId ||
    !sourceDataType ||
    sourceDataType !== context.sourceRecordType ||
    !languageTag ||
    !marketCode ||
    !/^[A-Z0-9]{2,3}$/.test(marketCode) ||
    sourceModifiedAt === undefined
  ) {
    issues.push(
      issue(
        "SOURCE_PROVENANCE_MISMATCH",
        "error",
        "exclude_record",
        "$.source",
        "Record source identity does not match its immutable import batch",
      ),
    );
  }
  if (
    (sourceCode === "USDA_FDC" || sourceCode === "FDC") &&
    sourceRecordId &&
    !/^[1-9]\d*$/.test(sourceRecordId)
  ) {
    issues.push(
      issue(
        "FDC_ID_NOT_POSITIVE_INTEGER",
        "error",
        "exclude_record",
        "$.source.sourceRecordId",
        "USDA FoodData Central food IDs must be positive integers",
      ),
    );
  }
  if (sourceRecordId && duplicateSourceFoodKeys.has(sourceRecordId)) {
    issues.push(
      issue(
        "DUPLICATE_SOURCE_FOOD_KEY",
        "error",
        "exclude_record",
        "$.source.sourceRecordId",
        "Source food identity occurs more than once in this release",
      ),
    );
  }

  if (
    !SHA256_PATTERN.test(context.sourcePayloadSha256) ||
    root.sourcePayloadHash !== context.sourcePayloadSha256
  ) {
    issues.push(
      issue(
        "SOURCE_PAYLOAD_HASH_MISMATCH",
        "error",
        "exclude_record",
        "$.sourcePayloadHash",
        "Record source payload checksum does not match staged provenance",
      ),
    );
  }
  if (
    !SHA256_PATTERN.test(context.canonicalPayloadSha256) ||
    sha256CanonicalJson(payload) !== context.canonicalPayloadSha256
  ) {
    issues.push(
      issue(
        "CANONICAL_PAYLOAD_HASH_MISMATCH",
        "error",
        "exclude_record",
        "$",
        "Canonical payload checksum does not match the staged JSON",
      ),
    );
  }

  const identity = objectValue(root.identity);
  const name = boundedText(identity?.description, 1, 2_000);
  const descriptionFr = optionalText(identity?.descriptionFr, 2_000);
  const brandName = optionalText(identity?.brandOwner, 2_000);
  if (!identity || !name) {
    issues.push(
      issue(
        "FOOD_NAME_REQUIRED",
        "error",
        "exclude_record",
        "$.identity.description",
        "Food description is required",
      ),
    );
  }

  const basis = objectValue(root.basis);
  if (basis?.unit !== "g" || !positiveDecimal(basis.amount, 12, 6)) {
    issues.push(
      issue(
        "INVALID_BASIS",
        "error",
        "exclude_record",
        "$.basis",
        "Food basis must be a positive gram quantity representable by the database",
      ),
    );
  }
  if (root.unlistedNutrientPolicy !== "unknown_not_reported") {
    issues.push(
      issue(
        "INVALID_UNLISTED_NUTRIENT_POLICY",
        "error",
        "exclude_record",
        "$.unlistedNutrientPolicy",
        "Missing nutrients must remain unknown/not reported",
      ),
    );
  }

  const nutrientsInput = arrayValue(root.nutrients);
  if (!nutrientsInput) {
    issues.push(
      issue(
        "NUTRIENTS_NOT_ARRAY",
        "error",
        "exclude_record",
        "$.nutrients",
        "Nutrients must be an array",
      ),
    );
  }
  const nutrients = validateNutrients(nutrientsInput ?? [], reviewedMappings, issues);

  const servingsInput = arrayValue(root.servings);
  if (!servingsInput) {
    issues.push(
      issue(
        "SERVINGS_NOT_ARRAY",
        "error",
        "exclude_record",
        "$.servings",
        "Servings must be an array; an empty array is valid",
      ),
    );
  }
  const servings = validateServings(servingsInput ?? [], issues);

  const rawGtin = optionalText(identity?.gtin, 32);
  let gtin: string | null = null;
  const gtinMarketKey = rawGtin && marketCode ? `${rawGtin}:${marketCode}` : null;
  if (rawGtin && GTIN_PATTERN.test(rawGtin) && !forbiddenGtins.has(gtinMarketKey ?? rawGtin)) {
    gtin = rawGtin;
  } else if (rawGtin && forbiddenGtins.has(gtinMarketKey ?? rawGtin)) {
    issues.push(
      issue(
        "BARCODE_CROSS_SOURCE_CONFLICT",
        "warning",
        "exclude_barcode",
        "$.identity.gtin",
        "GTIN is already active for another food source and was excluded",
      ),
    );
  } else if (rawGtin) {
    issues.push(
      issue(
        "BARCODE_UNSUPPORTED_LENGTH",
        "warning",
        "exclude_barcode",
        "$.identity.gtin",
        "Only GTIN-8, UPC-A, EAN-13, and GTIN-14 values are stored",
      ),
    );
  }

  const recordIsValid = !issues.some((entry) => entry.severity === "error");
  if (!recordIsValid || !name || !sourceRecordId || !sourceDataType || !basis) {
    return {
      ...emptyResult(issues),
      excludedNutrientCount: nutrients.excludedCount,
      nutrientInputCount: nutrients.inputCount,
      portionInputCount: servingsInput?.length ?? 0,
    };
  }

  const attributes: JsonObject = {
    descriptionFr,
    idempotencyKey: idempotencyKey ?? context.sourceRecordKey,
    sourceDataType,
    sourcePayloadSha256: context.sourcePayloadSha256,
    unlistedNutrientPolicy: "unknown_not_reported",
  };
  return {
    food: {
      attributes,
      basisQuantity: String(basis.amount),
      brandName,
      description: null,
      gtin,
      kind: brandName || gtin ? "branded" : "generic",
      languageTag: languageTag as string,
      marketCode: marketCode as string,
      name,
      normalizedName: normalizeSearchText(name),
      nutrients: nutrients.values,
      servings,
      sourceDataType,
      sourceFoodKey: sourceRecordId,
      sourceModifiedAt: sourceModifiedAt as string | null,
    },
    excludedNutrientCount: nutrients.excludedCount,
    issues,
    nutrientInputCount: nutrients.inputCount,
    nutrientMaterializableCount: nutrients.values.length,
    portionInputCount: servingsInput?.length ?? 0,
    recordIsValid: true,
  };
}

function validateNutrients(
  input: readonly JsonValue[],
  reviewedMappings: ReadonlyMap<string, ReviewedCatalogueNutrientMapping>,
  issues: CatalogueValidationIssue[],
): {
  readonly excludedCount: number;
  readonly inputCount: number;
  readonly values: readonly ValidatedNutrientValue[];
} {
  const output: ValidatedNutrientValue[] = [];
  const canonicalCodes = new Set<string>();
  let excludedCount = 0;
  for (let index = 0; index < input.length; index += 1) {
    const path = `$.nutrients[${index}]`;
    const row = objectValue(input[index]);
    if (!row) {
      issues.push(
        issue(
          "NUTRIENT_NOT_OBJECT",
          "warning",
          "exclude_nutrient",
          path,
          "Non-object nutrient row was excluded",
        ),
      );
      excludedCount += 1;
      continue;
    }
    const sourceNutrientId = boundedText(row.sourceNutrientId, 1, 256);
    const sourceName = boundedText(row.sourceName, 1, 2_000);
    const originalUnit = boundedText(row.originalUnit, 1, 128);
    const mapping = sourceNutrientId ? reviewedMappings.get(sourceNutrientId) : undefined;
    if (!mapping) {
      issues.push(
        issue(
          "NUTRIENT_MAPPING_UNREVIEWED",
          "warning",
          "exclude_nutrient",
          path,
          "Nutrient has no reviewed source mapping and was excluded from canonical values",
        ),
      );
      excludedCount += 1;
      continue;
    }
    if (originalUnit !== mapping.sourceUnit) {
      issues.push(
        issue(
          "NUTRIENT_SOURCE_UNIT_MISMATCH",
          "warning",
          "exclude_nutrient",
          path,
          "Source nutrient unit does not match the reviewed mapping",
        ),
      );
      excludedCount += 1;
      continue;
    }
    const nutrientCode = mapping.nutrientCode;
    if (canonicalCodes.has(nutrientCode)) {
      issues.push(
        issue(
          "NUTRIENT_DUPLICATE_CANONICAL_CODE",
          "warning",
          "exclude_nutrient",
          path,
          "Duplicate canonical nutrient value was excluded",
        ),
      );
      excludedCount += 1;
      continue;
    }

    const value = objectValue(row.value);
    if (!value || !sourceNutrientId || !sourceName || !originalUnit) {
      issues.push(
        issue(
          "NUTRIENT_INVALID_FIELDS",
          "warning",
          "exclude_nutrient",
          path,
          "Nutrient identity or value fields are invalid",
        ),
      );
      excludedCount += 1;
      continue;
    }
    if (value.state === "unknown") {
      continue;
    }
    const provenance = objectValue(row.provenance);
    const derivationCode = optionalText(provenance?.derivationCode, 128);
    const dataPoints = provenance?.dataPoints;
    if (
      !provenance ||
      (provenance.derivationCode !== null && derivationCode === null) ||
      (dataPoints !== null &&
        (typeof dataPoints !== "number" ||
          !Number.isSafeInteger(dataPoints) ||
          dataPoints < 0 ||
          dataPoints > 2_147_483_647))
    ) {
      issues.push(
        issue(
          "NUTRIENT_PROVENANCE_INVALID",
          "warning",
          "exclude_nutrient",
          `${path}.provenance`,
          "Nutrient derivation provenance is missing or invalid",
        ),
      );
      excludedCount += 1;
      continue;
    }
    let normalized: ValidatedNutrientValue | null = null;
    if (value.state === "known") {
      if (value.amount === null || value.amount === undefined || value.amount === "") {
        issues.push(
          issue(
            "NUTRIENT_NULL_AMOUNT",
            "warning",
            "exclude_nutrient",
            `${path}.value.amount`,
            "Nutrient with a null amount was excluded; it was not converted to zero",
          ),
        );
        excludedCount += 1;
        continue;
      }
      if (typeof value.amount === "string" && value.amount.trim().startsWith("-")) {
        issues.push(
          issue(
            "NUTRIENT_NEGATIVE_AMOUNT",
            "warning",
            "exclude_nutrient",
            `${path}.value.amount`,
            "Negative nutrient amount was excluded",
          ),
        );
        excludedCount += 1;
        continue;
      }
      if (!nonNegativeDecimal(value.amount, 12, 12)) {
        issues.push(
          issue(
            "NUTRIENT_AMOUNT_INVALID",
            "warning",
            "exclude_nutrient",
            `${path}.value.amount`,
            "Nutrient amount cannot be represented exactly by the canonical datastore",
          ),
        );
        excludedCount += 1;
        continue;
      }
      const quality = value.quality;
      if (!isKnownQuality(quality)) {
        issues.push(
          issue(
            "NUTRIENT_QUALITY_INVALID",
            "warning",
            "exclude_nutrient",
            `${path}.value.quality`,
            "Known nutrient quality is invalid",
          ),
        );
        excludedCount += 1;
        continue;
      }
      const convertedAmount = multiplyDecimals(String(value.amount), mapping.conversionMultiplier);
      if (!convertedAmount || !nonNegativeDecimal(convertedAmount, 12, 12)) {
        issues.push(
          issue(
            "NUTRIENT_CONVERSION_NOT_EXACT",
            "warning",
            "exclude_nutrient",
            `${path}.value.amount`,
            "Reviewed nutrient conversion cannot be stored exactly",
          ),
        );
        excludedCount += 1;
        continue;
      }
      normalized = {
        amount: convertedAmount,
        canonicalUnit: mapping.canonicalUnit,
        dataPoints: dataPoints as number | null,
        derivationCode,
        metadata: {
          dataPoints,
          derivationCode,
          mappingRevisionId: mapping.mappingRevisionId,
          sourceName,
          sourceNutrientId,
          sourceUnit: originalUnit,
        },
        mappingRevisionId: mapping.mappingRevisionId,
        nutrientCode,
        nutrientId: mapping.nutrientId,
        sourceAmount: String(value.amount),
        sourceBasisQuantity: "100",
        sourceBasisUnit: "g",
        sourceName,
        sourceNutrientId,
        sourceUnit: originalUnit,
        valueStatus: quality,
      };
    } else if (value.state === "trace") {
      const detectionLimit = value.detectionLimit;
      if (detectionLimit !== null && !positiveDecimal(detectionLimit, 12, 12)) {
        issues.push(
          issue(
            "NUTRIENT_TRACE_LIMIT_INVALID",
            "warning",
            "exclude_nutrient",
            `${path}.value.detectionLimit`,
            "Trace detection limit is invalid",
          ),
        );
        excludedCount += 1;
        continue;
      }
      normalized = {
        amount: "0",
        canonicalUnit: mapping.canonicalUnit,
        dataPoints: dataPoints as number | null,
        derivationCode,
        metadata: {
          dataPoints,
          detectionLimit: detectionLimit as string | null,
          derivationCode,
          mappingRevisionId: mapping.mappingRevisionId,
          sourceName,
          sourceNutrientId,
          sourceUnit: originalUnit,
        },
        mappingRevisionId: mapping.mappingRevisionId,
        nutrientCode,
        nutrientId: mapping.nutrientId,
        sourceAmount: null,
        sourceBasisQuantity: null,
        sourceBasisUnit: null,
        sourceName,
        sourceNutrientId,
        sourceUnit: null,
        valueStatus: "trace",
      };
    } else {
      issues.push(
        issue(
          "NUTRIENT_STATE_INVALID",
          "warning",
          "exclude_nutrient",
          `${path}.value.state`,
          "Nutrient value state is invalid",
        ),
      );
      excludedCount += 1;
      continue;
    }

    canonicalCodes.add(nutrientCode);
    if (normalized) output.push(normalized);
  }
  return { excludedCount, inputCount: input.length, values: output };
}

function validateServings(
  input: readonly JsonValue[],
  issues: CatalogueValidationIssue[],
): readonly ValidatedServing[] {
  const output: ValidatedServing[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < input.length; index += 1) {
    const path = `$.servings[${index}]`;
    const row = objectValue(input[index]);
    const sourceServingKey = boundedText(row?.sourceServingId, 1, 256);
    const label = boundedText(row?.description, 1, 2_000);
    const unit = boundedText(row?.unit, 1, 128);
    if (!row || !sourceServingKey || !label || !unit || seen.has(sourceServingKey)) {
      issues.push(
        issue(
          "SERVING_INVALID_FIELDS",
          "warning",
          "exclude_serving",
          path,
          "Serving identity fields are invalid or duplicated",
        ),
      );
      continue;
    }
    if (!positiveDecimal(row.amount, 12, 6)) {
      issues.push(
        issue(
          "SERVING_AMOUNT_INVALID",
          "warning",
          "exclude_serving",
          `${path}.amount`,
          "Serving amount is invalid",
        ),
      );
      continue;
    }
    if (!positiveDecimal(row.gramWeight, 12, 6)) {
      issues.push(
        issue(
          "SERVING_MISSING_GRAM_WEIGHT",
          "warning",
          "exclude_serving",
          `${path}.gramWeight`,
          "Serving without a positive gram weight was excluded",
        ),
      );
      continue;
    }
    seen.add(sourceServingKey);
    output.push({
      displayOrder: output.length,
      gramWeight: String(row.gramWeight),
      isDefault: output.length === 0,
      label,
      metadata: {},
      quantity: String(row.amount),
      sourceServingKey,
      unit,
      unitKind: unit.toLowerCase() === "g" ? "mass" : "count",
    });
  }
  return output;
}

function issue(
  code: string,
  severity: CatalogueValidationIssueSeverity,
  disposition: CatalogueValidationDisposition,
  path: string,
  message: string,
): CatalogueValidationIssue {
  return { code, disposition, message, path, severity };
}

function objectValue(value: JsonValue | undefined): Readonly<Record<string, JsonValue>> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Readonly<Record<string, JsonValue>>;
}

function arrayValue(value: JsonValue | undefined): readonly JsonValue[] | null {
  return Array.isArray(value) ? value : null;
}

function boundedText(
  value: JsonValue | undefined,
  minimum: number,
  maximum: number,
): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFC").trim().replace(/\s+/g, " ");
  return normalized.length >= minimum && normalized.length <= maximum ? normalized : null;
}

function optionalText(value: JsonValue | undefined, maximum: number): string | null {
  if (value === null || value === undefined) return null;
  return boundedText(value, 1, maximum);
}

function isoTimestamp(value: JsonValue | undefined): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? undefined : parsed.toISOString();
}

function nonNegativeDecimal(value: JsonValue | undefined, integer: number, scale: number): boolean {
  if (typeof value !== "string" && typeof value !== "number") return false;
  const match = DECIMAL_PATTERN.exec(String(value));
  if (!match) return false;
  const [whole = "", fraction = ""] = String(value).split(".");
  return whole.length <= integer && fraction.length <= scale;
}

function positiveDecimal(value: JsonValue | undefined, integer: number, scale: number): boolean {
  return nonNegativeDecimal(value, integer, scale) && !/^0(?:\.0*)?$/.test(String(value));
}

function isKnownQuality(
  value: JsonValue | undefined,
): value is Exclude<NutrientValueStatus, "trace"> {
  return (
    value === "calculated" || value === "estimated" || value === "label" || value === "measured"
  );
}

function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/g, " ").trim();
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function emptyResult(issues: readonly CatalogueValidationIssue[]): CatalogueRecordValidationResult {
  return {
    excludedNutrientCount: 0,
    food: null,
    issues,
    nutrientInputCount: 0,
    nutrientMaterializableCount: 0,
    portionInputCount: 0,
    recordIsValid: false,
  };
}

function multiplyDecimals(left: string, right: string): string | null {
  const leftParts = decimalParts(left);
  const rightParts = decimalParts(right);
  if (!leftParts || !rightParts) return null;
  const product = leftParts.coefficient * rightParts.coefficient;
  let digits = product.toString();
  let scale = leftParts.scale + rightParts.scale;
  while (scale > 0 && digits.endsWith("0")) {
    digits = digits.slice(0, -1);
    scale -= 1;
  }
  if (scale === 0) return digits;
  if (scale >= digits.length) return `0.${"0".repeat(scale - digits.length)}${digits}`;
  return `${digits.slice(0, digits.length - scale)}.${digits.slice(digits.length - scale)}`;
}

function decimalParts(
  value: string,
): { readonly coefficient: bigint; readonly scale: number } | null {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) return null;
  const whole = match[1] ?? "0";
  const fraction = match[2] ?? "";
  return { coefficient: BigInt(`${whole}${fraction}`), scale: fraction.length };
}

export function nutrientDimensionFromUnit(unit: string): "amount" | "energy" | "mass" {
  if (unit === "kcal" || unit === "kJ") return "energy";
  if (/^(?:g|mg|ug)(?:_|$)/.test(unit)) return "mass";
  return "amount";
}
