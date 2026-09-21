import { createHash } from "node:crypto";
import { type Kysely, sql } from "kysely";
import { CATALOGUE_CAPABILITY_ROLES } from "./catalogue-authority-deployment.js";
import {
  type BatchRecordValidation,
  type BatchValidationPolicy,
  evaluateBatchPolicy,
  nutrientMappingRevisionDigest,
  type ParserCountEvidence,
} from "./catalogue-ingestion.js";
import {
  type CatalogueValidationIssue,
  canonicalJson,
  type ReviewedCatalogueNutrientMapping,
  sha256CanonicalJson,
  validateCatalogueRecord,
} from "./catalogue-validation.js";
import type { Database, JsonObject, JsonValue } from "./types.js";

const SHA = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAPPING_REVISION_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MIB = 1024 * 1024;
const MAX_RECORDS = 10_000;
const COUNT_KEYS = [
  "emittedNutrientCount",
  "emittedPortionCount",
  "emittedRecordCount",
  "excludedNutrientCount",
  "excludedPortionCount",
  "excludedRecordCount",
  "sourceNutrientCount",
  "sourcePortionCount",
  "sourceRecordCount",
];
const POLICY_KEYS = [
  "maximumExcludedNutrientFraction",
  "maximumQuarantineFraction",
  "maximumQuarantinedRecords",
  "requireAtLeastOneValidRecord",
  "requireDistinctApprovalPrincipals",
  "requireMaterializedNutrientPerValidRecord",
];
const DIGEST_KEYS = [
  "artifactSha256",
  "batchId",
  "evidenceBundleSha256",
  "evidenceBundleUri",
  "evidenceDecisionSha256",
  "evidenceObjectVersionId",
  "evidenceValidUntil",
  "nutrientMappingDigest",
  "nutrientMappingRevisionIds",
  "observationSha256",
  "policy",
  "parserEvidence",
  "parserReportSha256",
  "records",
  "releaseClass",
  "rightsManifestSha256",
  "validatedFoodContractVersion",
];
const RECORD_KEYS = [
  "canonicalPayloadSha256",
  "excludedNutrientCount",
  "issues",
  "nutrientInputCount",
  "nutrientMaterializableCount",
  "portionInputCount",
  "sourceRecordKey",
  "status",
  "validatedFoodContractVersion",
  "validatedFoodSha256",
];
const REQUEST_KEYS = [
  "schemaVersion",
  "kind",
  "validatorDatabasePrincipal",
  "batchId",
  "expectedStagingSealSha256",
  "observationSha256",
  "nutrientMappingDigest",
  "parserReportSha256",
  "policy",
  "validationDocument",
  "validationDocumentByteSize",
  "validationDocumentSha256",
  "validationDigest",
];

export interface CatalogueValidatePrincipal {
  readonly databasePrincipal: string;
  readonly capabilityRole: "nutrition_catalogue_validate";
}
export interface PreparedCatalogueValidationRequest {
  readonly schemaVersion: 1;
  readonly kind: "catalogue-fdc-csv-validation-request-v1";
  readonly validatorDatabasePrincipal: string;
  readonly batchId: string;
  readonly expectedStagingSealSha256: string;
  readonly observationSha256: string;
  readonly nutrientMappingDigest: string;
  readonly parserReportSha256: string;
  readonly policy: BatchValidationPolicy;
  readonly validationDocument: string;
  readonly validationDocumentByteSize: number;
  readonly validationDocumentSha256: string;
  readonly validationDigest: string;
}
interface ValidationReceiptBase {
  readonly excludedNutrientCount: number;
  readonly nutrientInputCount: number;
  readonly nutrientMaterializableCount: number;
  readonly nutrientMappingDigest: string;
  readonly nutritionSemanticContractVersion: 1;
  readonly nutritionSemanticSha256: string;
  readonly promotionEligible: boolean;
  readonly quarantinedCount: number;
  readonly stagedCount: number;
  readonly validCount: number;
  readonly validationDigest: string;
  readonly warningCount: number;
}
export type CatalogueValidationReceipt = ValidationReceiptBase &
  (
    | {
        readonly wasAlreadyValidated: false;
        readonly recordErrorCount: number;
        readonly unresolvedErrorCount: number;
      }
    | { readonly wasAlreadyValidated: true }
  );

/** Requires an actual login, not SET ROLE or the SQL owner's compatibility lane. */
export async function assertCatalogueValidatePrincipal(
  database: Kysely<Database>,
): Promise<CatalogueValidatePrincipal> {
  const row = onlyResult(
    (
      await sql<{ result: unknown }>`
    select pg_catalog.jsonb_build_object(
      'databasePrincipal', session_user::text,
      'effectivePrincipal', current_user::text,
      'canLogin', actor.rolcanlogin,
      'privileged', actor.rolsuper or actor.rolcreatedb or actor.rolcreaterole
        or actor.rolreplication or actor.rolbypassrls,
      'ownerMember', pg_catalog.pg_has_role(session_user, target.relowner, 'member'),
      'capabilities', (
        select coalesce(pg_catalog.jsonb_agg(role_name order by role_name), '[]'::jsonb)
        from pg_catalog.unnest(${[...CATALOGUE_CAPABILITY_ROLES]}::text[]) as names(role_name)
        where pg_catalog.pg_has_role(session_user, role_name, 'member')
      )
    ) as result
    from pg_catalog.pg_roles as actor
    join pg_catalog.pg_class as target on target.oid = 'public.food_import_batch'::pg_catalog.regclass
    where actor.rolname = session_user
  `.execute(database)
    ).rows,
  );
  keys(row, [
    "databasePrincipal",
    "effectivePrincipal",
    "canLogin",
    "privileged",
    "ownerMember",
    "capabilities",
  ]);
  text(row.databasePrincipal, "databasePrincipal", 63);
  if (
    row.effectivePrincipal !== row.databasePrincipal ||
    row.canLogin !== true ||
    row.privileged !== false ||
    row.ownerMember !== false ||
    !Array.isArray(row.capabilities) ||
    row.capabilities.length !== 1 ||
    row.capabilities[0] !== "nutrition_catalogue_validate"
  ) {
    throw new Error(
      "Catalogue validation requires a non-owner restricted login with exactly the validate capability",
    );
  }
  return {
    databasePrincipal: row.databasePrincipal as string,
    capabilityRole: "nutrition_catalogue_validate",
  };
}

/** Explicit complete policy: this consumer never derives thresholds or disables safety requirements. */
export function validateCatalogueValidationPolicy(value: unknown): BatchValidationPolicy {
  const policy = object(value);
  keys(policy, POLICY_KEYS);
  for (const key of ["maximumExcludedNutrientFraction", "maximumQuarantineFraction"]) {
    const n = policy[key];
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 1)
      fail(`Invalid validation policy ${key}`);
  }
  count(policy.maximumQuarantinedRecords);
  for (const key of [
    "requireAtLeastOneValidRecord",
    "requireDistinctApprovalPrincipals",
    "requireMaterializedNutrientPerValidRecord",
  ]) {
    if (policy[key] !== true) fail(`Validation policy ${key} must be true`);
  }
  return { ...policy } as BatchValidationPolicy;
}

export async function prepareCatalogueValidation(
  database: Kysely<Database>,
  input: {
    readonly batchId: string;
    readonly expectedStagingSealSha256: string;
    readonly expectedNutrientMappingDigest: string;
    readonly policy: BatchValidationPolicy;
  },
): Promise<PreparedCatalogueValidationRequest> {
  uuid(input.batchId);
  hash(input.expectedStagingSealSha256);
  hash(input.expectedNutrientMappingDigest);
  const policy = validateCatalogueValidationPolicy(input.policy);
  const principal = await assertCatalogueValidatePrincipal(database);
  const response = onlyResult(
    (
      await sql<{ result: unknown }>`
    select public.catalogue_observe_import_validation(${input.batchId}::uuid) as result
  `.execute(database)
    ).rows,
  );
  keys(response, ["schemaVersion", "observationSha256", "observation"]);
  if (response.schemaVersion !== 1) fail("Unsupported validation observation");
  hash(response.observationSha256);
  // PostgreSQL hashes its own JSONB rendering. Retain that token verbatim; a
  // JavaScript canonical hash is not an equivalent observation identity.
  const observation = object(response.observation);
  document(observation, 128 * MIB);
  keys(observation, [
    "schemaVersion",
    "sourceCode",
    "batch",
    "forbiddenGtins",
    "nutrientMappings",
    "parserReport",
    "records",
    "stageCheckpoint",
  ]);
  if (observation.schemaVersion !== 1 || observation.sourceCode !== "USDA_FDC")
    fail("Only USDA_FDC observations are supported");
  const batch = object(observation.batch);
  keys(batch, [
    "acquiredAt",
    "artifactBytes",
    "artifactSha256",
    "artifactUri",
    "evidenceBundleSha256",
    "evidenceBundleUri",
    "evidenceDecisionSha256",
    "evidenceObjectVersionId",
    "evidenceValidUntil",
    "id",
    "mediaType",
    "parserVersion",
    "publishedOn",
    "releaseClass",
    "releaseKey",
    "rightsManifestSha256",
    "rightsManifestUri",
    "stagedCount",
    "stagedDatabasePrincipal",
    "stagingSealSha256",
    "stagingSealedAt",
    "status",
    "upstreamSchemaVersion",
  ]);
  provenance(batch);
  for (const name of [
    "artifactUri",
    "rightsManifestUri",
    "mediaType",
    "releaseKey",
    "parserVersion",
  ])
    text(batch[name], name, 4096);
  for (const name of ["acquiredAt", "stagingSealedAt"]) timestamp(batch[name]);
  if (batch.publishedOn !== null) {
    text(batch.publishedOn, "publishedOn", 10);
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(batch.publishedOn as string)) fail("Invalid publishedOn");
  }
  if (batch.upstreamSchemaVersion !== null)
    text(batch.upstreamSchemaVersion, "upstreamSchemaVersion", 256);
  if (count(batch.artifactBytes) === 0) fail("Invalid artifact bytes");
  text(batch.stagedDatabasePrincipal, "stagedDatabasePrincipal", 63);
  if (
    batch.id !== input.batchId ||
    batch.stagingSealSha256 !== input.expectedStagingSealSha256 ||
    batch.status !== "staging" ||
    batch.stagedDatabasePrincipal === principal.databasePrincipal
  )
    fail("Validation batch, staging seal, state or distinct principal mismatch");
  const rows = array(observation.records, MAX_RECORDS);
  if (count(batch.stagedCount) !== rows.length) fail("Observed staged count mismatch");
  const checkpoint = object(observation.stageCheckpoint);
  keys(checkpoint, ["cursor", "lastSequenceNumber", "processedCount"]);
  const cursor = object(checkpoint.cursor);
  keys(cursor, ["nextOffset"]);
  if (
    checkpoint.processedCount !== rows.length ||
    cursor.nextOffset !== rows.length ||
    checkpoint.lastSequenceNumber !== (rows.length === 0 ? null : rows.length - 1)
  )
    fail("Observed stage checkpoint mismatch");
  const mappingRows = array(observation.nutrientMappings, 10_000).map((value) => {
    const row = object(value);
    keys(row, [
      "canonicalUnit",
      "conversionMultiplier",
      "nutrientCode",
      "nutrientDimension",
      "nutrientId",
      "nutrientName",
      "revisionId",
      "sourceNutrientKey",
      "sourceUnit",
    ]);
    for (const key of Object.keys(row)) text(row[key], key, 1024);
    mappingRevisionUuid(row.revisionId);
    if (
      !/^[1-9][0-9]*$/u.test(row.nutrientId as string) ||
      !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(row.conversionMultiplier as string) ||
      /^0(?:\.0+)?$/u.test(row.conversionMultiplier as string)
    )
      fail("Invalid observed nutrient mapping");
    return row as unknown as Parameters<typeof nutrientMappingRevisionDigest>[0][number];
  });
  const mappingDigest = nutrientMappingRevisionDigest(mappingRows);
  if (mappingDigest !== input.expectedNutrientMappingDigest)
    fail("Observed nutrient mapping digest mismatch");
  const mappings = new Map<string, ReviewedCatalogueNutrientMapping>(
    mappingRows.map((row) => [
      row.sourceNutrientKey,
      {
        canonicalUnit: row.canonicalUnit,
        conversionMultiplier: row.conversionMultiplier,
        mappingRevisionId: row.revisionId,
        nutrientCode: row.nutrientCode,
        nutrientId: row.nutrientId,
        sourceNutrientId: row.sourceNutrientKey,
        sourceUnit: row.sourceUnit,
      },
    ]),
  );
  const forbidden = array(observation.forbiddenGtins, MAX_RECORDS).map((value) => {
    text(value, "forbidden GTIN", 18);
    if (!/^[0-9]{14}:[A-Z0-9]{2,3}$/u.test(value as string)) fail("Invalid forbidden GTIN");
    return value as string;
  });
  unique(forbidden, "forbidden GTIN");
  let payloadBytes = 0;
  const payloadHash = createHash("sha256");
  const seenKeys = new Set<string>();
  const staged = rows.map((value, index) => {
    const row = object(value);
    keys(row, [
      "canonicalPayload",
      "canonicalPayloadSha256",
      "sequenceNumber",
      "sourcePayloadSha256",
      "sourceRecordKey",
      "sourceRecordType",
      "validatedFoodContractVersion",
      "validatedFoodDocument",
      "validatedFoodSha256",
      "validatedAt",
      "validationIssues",
      "validationStatus",
    ]);
    hash(row.canonicalPayloadSha256);
    hash(row.sourcePayloadSha256);
    text(row.sourceRecordKey, "sourceRecordKey", 1024);
    text(row.sourceRecordType, "sourceRecordType", 256);
    if (seenKeys.has(row.sourceRecordKey as string)) fail("Duplicate source record key");
    seenKeys.add(row.sourceRecordKey as string);
    if (
      row.sequenceNumber !== index ||
      row.validationStatus !== "pending" ||
      row.validatedAt !== null ||
      row.validatedFoodContractVersion !== null ||
      row.validatedFoodDocument !== null ||
      row.validatedFoodSha256 !== null ||
      !Array.isArray(row.validationIssues) ||
      row.validationIssues.length !== 0
    )
      fail(
        "Observation contains non-pending or non-contiguous records; retry the retained request instead",
      );
    const payload = row.canonicalPayload as JsonValue;
    const serialized = document(payload, MIB);
    payloadBytes += postgresTextBound(payload);
    if (payloadBytes > 64 * MIB) fail("Observed staged payload exceeds the existing 64-MiB bound");
    if (sha(serialized) !== row.canonicalPayloadSha256)
      fail("Observed canonical payload checksum mismatch");
    payloadHash.update(serialized).update("\n");
    return {
      payload,
      context: {
        canonicalPayloadSha256: row.canonicalPayloadSha256 as string,
        expectedReleaseKey: batch.releaseKey as string,
        expectedSourceCode: "USDA_FDC",
        sourcePayloadSha256: row.sourcePayloadSha256 as string,
        sourceRecordKey: row.sourceRecordKey as string,
        sourceRecordType: row.sourceRecordType as string,
      },
    };
  });
  const parser = verifyParserReport(
    observation.parserReport,
    batch,
    mappingDigest,
    rows.length,
    payloadHash.digest("hex"),
  );
  const forbiddenSet = new Set(forbidden);
  const initial = staged.map((row) =>
    validateCatalogueRecord(row.payload, row.context, mappings, forbiddenSet),
  );
  const sourceKeys = new Map<string, number>();
  for (const result of initial)
    if (result.food)
      sourceKeys.set(
        result.food.sourceFoodKey,
        (sourceKeys.get(result.food.sourceFoodKey) ?? 0) + 1,
      );
  const duplicates = new Set([...sourceKeys].filter(([, n]) => n > 1).map(([key]) => key));
  const results =
    duplicates.size === 0
      ? initial
      : staged.map((row) =>
          validateCatalogueRecord(row.payload, row.context, mappings, forbiddenSet, duplicates),
        );
  const records: BatchRecordValidation[] = results.map((result, index) => ({
    canonicalPayloadSha256: required(staged[index]).context.canonicalPayloadSha256,
    excludedNutrientCount: result.excludedNutrientCount,
    issues: result.issues,
    nutrientInputCount: result.nutrientInputCount,
    nutrientMaterializableCount: result.nutrientMaterializableCount,
    portionInputCount: result.portionInputCount,
    sourceRecordKey: required(staged[index]).context.sourceRecordKey,
    status: result.recordIsValid ? "valid" : "quarantined",
    validatedFoodContractVersion: result.food ? 1 : null,
    validatedFoodSha256: result.food
      ? sha256CanonicalJson(result.food as unknown as JsonValue)
      : null,
  }));
  verifyEmitted(records, parser.counts);
  const digestDocument = document(
    {
      artifactSha256: batch.artifactSha256 as string,
      batchId: input.batchId,
      evidenceBundleSha256: batch.evidenceBundleSha256 as string,
      evidenceBundleUri: batch.evidenceBundleUri as string,
      evidenceDecisionSha256: batch.evidenceDecisionSha256 as string,
      evidenceObjectVersionId: batch.evidenceObjectVersionId as string,
      evidenceValidUntil: batch.evidenceValidUntil as string,
      nutrientMappingDigest: mappingDigest,
      nutrientMappingRevisionIds: [...new Set(mappingRows.map((row) => row.revisionId))].sort(),
      observationSha256: response.observationSha256 as string,
      policy,
      parserEvidence: { ...parser.counts },
      parserReportSha256: parser.sha256,
      records: records as unknown as JsonValue,
      releaseClass: batch.releaseClass as string,
      rightsManifestSha256: batch.rightsManifestSha256 as string,
      validatedFoodContractVersion: 1,
    },
    120 * MIB,
  );
  const validationDocument = document(
    {
      schemaVersion: 1,
      digestDocument,
      records: results.map((result, index) => ({
        sourceRecordKey: required(staged[index]).context.sourceRecordKey,
        validatedFoodDocument: result.food
          ? document(result.food as unknown as JsonValue, 2 * MIB)
          : null,
        validationIssuesDocument: document(result.issues as JsonValue, MIB),
      })),
    },
    128 * MIB,
  );
  return parsePreparedCatalogueValidationRequest({
    schemaVersion: 1,
    kind: "catalogue-fdc-csv-validation-request-v1",
    validatorDatabasePrincipal: principal.databasePrincipal,
    batchId: input.batchId,
    expectedStagingSealSha256: input.expectedStagingSealSha256,
    observationSha256: response.observationSha256,
    nutrientMappingDigest: mappingDigest,
    parserReportSha256: parser.sha256,
    policy,
    validationDocument,
    validationDocumentByteSize: Buffer.byteLength(validationDocument),
    validationDocumentSha256: sha(validationDocument),
    validationDigest: sha(digestDocument),
  });
}

/** Pure decoder for a retained request. It never substitutes a new observation. */
export function parsePreparedCatalogueValidationRequest(
  value: unknown,
): PreparedCatalogueValidationRequest {
  return decodeRequest(value).request;
}

export async function submitCatalogueValidation(
  database: Kysely<Database>,
  value: PreparedCatalogueValidationRequest,
): Promise<CatalogueValidationReceipt> {
  const { request, records, counts } = decodeRequest(value);
  const principal = await assertCatalogueValidatePrincipal(database);
  if (principal.databasePrincipal !== request.validatorDatabasePrincipal)
    fail("Prepared request belongs to another validator database principal");
  const row = onlyResult(
    (
      await sql<{ result: unknown }>`
    select public.catalogue_validate_import_batch(${request.batchId}::uuid, ${request.expectedStagingSealSha256}::text, ${request.observationSha256}::text, ${request.validationDocument}::text) as result
  `.execute(database)
    ).rows,
  );
  const base = [
    "excludedNutrientCount",
    "nutrientInputCount",
    "nutrientMaterializableCount",
    "nutrientMappingDigest",
    "nutritionSemanticContractVersion",
    "nutritionSemanticSha256",
    "promotionEligible",
    "quarantinedCount",
    "stagedCount",
    "validCount",
    "validationDigest",
    "warningCount",
    "wasAlreadyValidated",
  ];
  if (typeof row.wasAlreadyValidated !== "boolean") fail("Invalid validation receipt replay flag");
  keys(row, row.wasAlreadyValidated ? base : [...base, "recordErrorCount", "unresolvedErrorCount"]);
  hash(row.nutritionSemanticSha256);
  if (
    row.nutritionSemanticContractVersion !== 1 ||
    row.validationDigest !== request.validationDigest ||
    row.nutrientMappingDigest !== request.nutrientMappingDigest ||
    row.stagedCount !== records.length
  )
    fail("Validation receipt identity or semantic attestation mismatch");
  const expected = evaluateBatchPolicy(records, request.policy, counts);
  const fields = [
    "excludedNutrientCount",
    "nutrientInputCount",
    "nutrientMaterializableCount",
    "promotionEligible",
    "quarantinedCount",
    "validCount",
    "warningCount",
    ...(row.wasAlreadyValidated ? [] : ["recordErrorCount", "unresolvedErrorCount"]),
  ];
  for (const key of fields)
    if (row[key] !== expected[key as keyof typeof expected])
      fail(`Validation receipt ${key} differs from the retained request`);
  return row as unknown as CatalogueValidationReceipt;
}

function decodeRequest(value: unknown) {
  const request = object(value);
  keys(request, REQUEST_KEYS);
  if (request.schemaVersion !== 1 || request.kind !== "catalogue-fdc-csv-validation-request-v1")
    fail("Unsupported prepared validation request");
  uuid(request.batchId);
  text(request.validatorDatabasePrincipal, "validatorDatabasePrincipal", 63);
  for (const key of [
    "expectedStagingSealSha256",
    "observationSha256",
    "nutrientMappingDigest",
    "parserReportSha256",
    "validationDocumentSha256",
    "validationDigest",
  ])
    hash(request[key]);
  const policy = validateCatalogueValidationPolicy(request.policy);
  const outer = parseDocument(request.validationDocument, 128 * MIB);
  keys(outer, ["schemaVersion", "digestDocument", "records"]);
  if (
    outer.schemaVersion !== 1 ||
    request.validationDocumentByteSize !==
      Buffer.byteLength(request.validationDocument as string) ||
    sha(request.validationDocument as string) !== request.validationDocumentSha256
  )
    fail("Prepared validation document byte identity mismatch");
  const digest = parseDocument(outer.digestDocument, 120 * MIB);
  keys(digest, DIGEST_KEYS);
  provenance(digest);
  if (
    sha(outer.digestDocument as string) !== request.validationDigest ||
    digest.batchId !== request.batchId ||
    digest.observationSha256 !== request.observationSha256 ||
    digest.nutrientMappingDigest !== request.nutrientMappingDigest ||
    digest.parserReportSha256 !== request.parserReportSha256 ||
    digest.validatedFoodContractVersion !== 1 ||
    canonicalJson(validateCatalogueValidationPolicy(digest.policy)) !== canonicalJson(policy)
  )
    fail("Prepared validation digest bindings mismatch");
  const revisions = array(digest.nutrientMappingRevisionIds, 10_000);
  revisions.forEach(mappingRevisionUuid);
  if (
    canonicalJson(revisions as JsonValue) !==
    canonicalJson([...new Set(revisions)].sort() as JsonValue)
  )
    fail("Mapping revisions must be unique and ordered");
  const counts = parserCounts(digest.parserEvidence);
  const resultRows = array(outer.records, MAX_RECORDS);
  const digestRows = array(digest.records, MAX_RECORDS);
  if (resultRows.length !== digestRows.length) fail("Prepared validation record coverage mismatch");
  const seen = new Set<string>();
  const records = digestRows.map((value, index) => {
    const row = object(value);
    keys(row, RECORD_KEYS);
    hash(row.canonicalPayloadSha256);
    text(row.sourceRecordKey, "sourceRecordKey", 1024);
    if (seen.has(row.sourceRecordKey as string)) fail("Duplicate prepared source record key");
    seen.add(row.sourceRecordKey as string);
    for (const key of [
      "nutrientInputCount",
      "nutrientMaterializableCount",
      "excludedNutrientCount",
      "portionInputCount",
    ])
      count(row[key]);
    if (
      (row.nutrientMaterializableCount as number) > (row.nutrientInputCount as number) ||
      (row.excludedNutrientCount as number) > (row.nutrientInputCount as number)
    )
      fail("Invalid prepared nutrient counts");
    const issues = array(row.issues, 100_000).map((entry) => {
      const issue = object(entry);
      keys(issue, ["code", "disposition", "message", "path", "severity"]);
      for (const key of ["code", "message", "path"]) text(issue[key], key, MIB, key === "path");
      if (
        !["warning", "error"].includes(issue.severity as string) ||
        !["exclude_barcode", "exclude_nutrient", "exclude_record", "exclude_serving"].includes(
          issue.disposition as string,
        )
      )
        fail("Invalid prepared validation issue");
      return issue as unknown as CatalogueValidationIssue;
    });
    const result = object(resultRows[index]);
    keys(result, ["sourceRecordKey", "validatedFoodDocument", "validationIssuesDocument"]);
    if (
      result.sourceRecordKey !== row.sourceRecordKey ||
      document(issues, MIB) !== result.validationIssuesDocument
    )
      fail("Prepared validation issues or record order mismatch");
    if (row.status === "valid") {
      const food = parseDocument(result.validatedFoodDocument, 2 * MIB);
      if (
        row.validatedFoodContractVersion !== 1 ||
        sha(result.validatedFoodDocument as string) !== row.validatedFoodSha256 ||
        !Array.isArray(food.nutrients) ||
        food.nutrients.length !== row.nutrientMaterializableCount ||
        issues.some((issue) => issue.severity === "error")
      )
        fail("Prepared validated food binding mismatch");
    } else if (
      row.status !== "quarantined" ||
      result.validatedFoodDocument !== null ||
      row.validatedFoodContractVersion !== null ||
      row.validatedFoodSha256 !== null ||
      row.nutrientMaterializableCount !== 0 ||
      !issues.some((issue) => issue.severity === "error")
    )
      fail("Prepared quarantine binding mismatch");
    return { ...row, issues } as unknown as BatchRecordValidation;
  });
  verifyEmitted(records, counts);
  return {
    request: { ...request, policy } as unknown as PreparedCatalogueValidationRequest,
    records,
    counts,
  };
}

function verifyParserReport(
  value: unknown,
  batch: JsonObject,
  mappingDigest: string,
  recordCount: number,
  recordsSha256: string,
) {
  const parser = object(value);
  keys(parser, [...COUNT_KEYS, "report", "reportSha256"]);
  const counts = parserCounts(Object.fromEntries(COUNT_KEYS.map((key) => [key, parser[key]])));
  hash(parser.reportSha256);
  const report = object(parser.report);
  if (sha256CanonicalJson(report) !== parser.reportSha256)
    fail("Observed parser report checksum mismatch");
  keys(report, [
    "artifactSha256",
    "inspection",
    "nutrientMappingDigest",
    "parserBuildSha256",
    "parserPackage",
    "parserVersion",
    "portionCountBasis",
    "recordsExport",
    "releaseKey",
    "reportKind",
    "schemaVersion",
    "sourceCode",
  ]);
  hash(report.parserBuildSha256);
  text(report.parserPackage, "parserPackage", 256);
  text(report.parserVersion, "parserVersion", 256);
  if (
    report.schemaVersion !== 1 ||
    report.reportKind !== "usda-fdc-full-csv-capability-stage-v1" ||
    report.sourceCode !== "USDA_FDC" ||
    report.artifactSha256 !== batch.artifactSha256 ||
    report.releaseKey !== batch.releaseKey ||
    report.nutrientMappingDigest !== mappingDigest ||
    batch.parserVersion !==
      `${report.parserVersion}+build.${report.parserBuildSha256}+mapping.${mappingDigest}` ||
    report.portionCountBasis !== "source-csv-portions-plus-emitted-derived-label-servings-v1"
  )
    fail("Observed full-CSV parser provenance mismatch");
  const exported = object(report.recordsExport);
  keys(exported, ["byteSize", "sha256", "recordCount", "recordsSha256"]);
  hash(exported.sha256);
  if (
    count(exported.byteSize) === 0 ||
    exported.recordCount !== recordCount ||
    exported.recordsSha256 !== recordsSha256 ||
    counts.emittedRecordCount !== recordCount
  )
    fail("Observed normalized record export binding mismatch");
  const inspection = object(report.inspection);
  const semantic = object(object(inspection.semanticEvidence).canonicalAcceptedRecords);
  keys(semantic, ["count", "sha256"]);
  if (semantic.count !== recordCount || semantic.sha256 !== recordsSha256)
    fail("Observed full-CSV semantic record evidence mismatch");
  const conservation = object(inspection.conservation);
  const foods = object(conservation.foods);
  const nutrients = object(conservation.foodNutrients);
  const portions = object(conservation.foodPortions);
  const metrics = object(inspection.metrics);
  const derived = count(metrics.derivedLabelServingCount);
  const expected = {
    emittedRecordCount: count(foods.acceptedCount),
    excludedRecordCount: count(foods.quarantinedCount),
    sourceRecordCount: count(foods.sourceCount),
    emittedNutrientCount: count(nutrients.emittedCount),
    excludedNutrientCount: count(nutrients.excludedCount) + count(nutrients.quarantinedParentCount),
    sourceNutrientCount: count(nutrients.sourceCount),
    emittedPortionCount: count(portions.emittedCount) + derived,
    excludedPortionCount: count(portions.excludedCount) + count(portions.quarantinedParentCount),
    sourcePortionCount: count(portions.sourceCount) + derived,
  };
  for (const key of COUNT_KEYS)
    if (counts[key as keyof ParserCountEvidence] !== expected[key as keyof typeof expected])
      fail("Observed full-CSV conservation mismatch");
  if (
    metrics.acceptedFoodCount !== counts.emittedRecordCount ||
    metrics.quarantinedFoodCount !== counts.excludedRecordCount ||
    metrics.stagedNutrientCount !== counts.emittedNutrientCount ||
    metrics.stagedPortionCount !== portions.emittedCount ||
    metrics.excludedNutrientCount !== nutrients.excludedCount ||
    metrics.excludedPortionCount !== portions.excludedCount
  )
    fail("Observed full-CSV metrics mismatch");
  return { counts, sha256: parser.reportSha256 as string };
}

function parserCounts(value: unknown): ParserCountEvidence {
  const row = object(value);
  keys(row, COUNT_KEYS);
  for (const key of COUNT_KEYS) count(row[key]);
  for (const kind of ["Record", "Nutrient", "Portion"])
    if (
      row[`source${kind}Count`] !==
      (row[`emitted${kind}Count`] as number) + (row[`excluded${kind}Count`] as number)
    )
      fail("Parser conservation mismatch");
  return row as unknown as ParserCountEvidence;
}
function verifyEmitted(records: readonly BatchRecordValidation[], counts: ParserCountEvidence) {
  if (
    records.length !== counts.emittedRecordCount ||
    records.reduce((n, row) => n + row.nutrientInputCount, 0) !== counts.emittedNutrientCount ||
    records.reduce((n, row) => n + row.portionInputCount, 0) !== counts.emittedPortionCount
  )
    fail("Parser emitted counts differ from canonical records");
}
function provenance(row: JsonObject) {
  for (const key of [
    "artifactSha256",
    "evidenceBundleSha256",
    "evidenceDecisionSha256",
    "rightsManifestSha256",
  ])
    hash(row[key]);
  for (const key of ["evidenceBundleUri", "evidenceObjectVersionId"]) text(row[key], key, 4096);
  timestamp(row.evidenceValidUntil);
  if (!["fixture-nonrelease", "live-reviewed"].includes(row.releaseClass as string))
    fail("Unsupported release class");
}
function onlyResult(rows: readonly { result: unknown }[]): JsonObject {
  if (rows.length !== 1) fail("Expected exactly one validation result");
  return object(rows[0]?.result);
}
function object(value: unknown): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail("Expected validation object");
  return value as JsonObject;
}
function array(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum)
    fail("Invalid or oversized validation array");
  return value;
}
function keys(value: JsonObject, expected: readonly string[]) {
  if (Object.keys(value).sort().join("\0") !== [...expected].sort().join("\0"))
    fail("Unexpected validation object fields");
}
function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    fail("Expected non-negative safe validation count");
  return value;
}
function hash(value: unknown) {
  if (typeof value !== "string" || !SHA.test(value)) fail("Expected lowercase SHA256");
}
// Migration 0020 restricts mapping revision evidence to versions 1–5; batch
// identifiers retain the existing stage client's versions 1–8 contract.
function mappingRevisionUuid(value: unknown) {
  if (typeof value !== "string" || !MAPPING_REVISION_UUID.test(value))
    fail("Expected version 1–5 mapping revision UUID");
}
function uuid(value: unknown) {
  if (typeof value !== "string" || !UUID.test(value)) fail("Expected canonical UUID");
}
function text(value: unknown, name: string, maximum: number, empty = false) {
  if (
    typeof value !== "string" ||
    (!empty && value.length === 0) ||
    Buffer.byteLength(value) > maximum ||
    value.includes(String.fromCharCode(0)) ||
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)
  )
    fail(`Invalid validation ${name}`);
}
function timestamp(value: unknown) {
  text(value, "timestamp", 64);
  if (
    !/^\d{4}-\d{2}-\d{2}T/u.test(value as string) ||
    !Number.isFinite(Date.parse(value as string))
  )
    fail("Invalid validation timestamp");
}
function unique(values: readonly string[], label: string) {
  if (new Set(values).size !== values.length) fail(`Duplicate ${label}`);
}
function sha(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
function parseDocument(value: unknown, maximum: number): JsonObject {
  text(value, "document", maximum);
  const parsed = object(JSON.parse(value as string));
  if (document(parsed, maximum) !== value)
    fail("Validation document must have exact canonical bytes");
  return parsed;
}
function document(value: JsonValue, maximum: number): string {
  postgresTextBound(value);
  const result = canonicalJson(value);
  if (Buffer.byteLength(result) > maximum) fail("Validation document exceeds its byte limit");
  return result;
}
/** Conservative PostgreSQL JSONB text bound, not an equality claim or storage measurement. */
function postgresTextBound(value: JsonValue, depth = 0): number {
  if (depth > 64) fail("Validation JSON nesting exceeds the bound");
  if (value === null) return 4;
  if (typeof value === "boolean") return value ? 4 : 5;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("Invalid validation JSON number");
    return Number.isSafeInteger(value) ? String(value).length : 400;
  }
  if (typeof value === "string") {
    text(value, "JSON string", 128 * MIB, true);
    return Buffer.byteLength(JSON.stringify(value));
  }
  if (Array.isArray(value))
    return (
      2 +
      Math.max(0, value.length - 1) * 2 +
      value.reduce((n, entry) => n + postgresTextBound(entry, depth + 1), 0)
    );
  if (typeof value !== "object") fail("Invalid validation JSON value");
  return (
    2 +
    Math.max(0, Object.keys(value).length - 1) * 2 +
    Object.entries(value).reduce(
      (n, [key, entry]) =>
        n + postgresTextBound(key, depth + 1) + 2 + postgresTextBound(entry, depth + 1),
      0,
    )
  );
}
function required<T>(value: T | undefined): T {
  if (value === undefined) fail("Missing bounded validation record");
  return value;
}
function fail(message: string): never {
  throw new Error(message);
}
