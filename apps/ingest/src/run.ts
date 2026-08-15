import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import {
  approveBatch,
  createDatabaseFromEnvironment,
  getBatchCheckpoint,
  getSourceNutrientMappingDigest,
  type JsonObject,
  type JsonValue,
  promoteBatch,
  recordBatchParserReport,
  registerFoodSourceFromReviewedManifest,
  registerSourceNutrientMappings,
  rollbackSourceRelease,
  saveBatchCheckpoint,
  stageBatch,
  stageBatchRecords,
  validateBatch,
} from "@nutrition-tracker/db";
import {
  acquireArtifact,
  adaptFdcJsonRelease,
  assertImportReadyManifest,
  extractZipArchive,
  type FoodSourceManifestV3,
  parseFoodSourceManifest,
} from "@nutrition-tracker/ingestion";

import { flagOption, optionalOption, parseArguments, requiredOption } from "./arguments.js";

export interface CommandIo {
  readonly environment: NodeJS.ProcessEnv;
  readonly writeError: (value: string) => void;
  readonly writeOutput: (value: string) => void;
}

const SOURCE_POLICIES: Readonly<
  Record<
    string,
    readonly {
      readonly host: string;
      readonly pathExact?: string;
      readonly pathPrefix?: string;
    }[]
  >
> = Object.freeze({
  USDA_FDC: Object.freeze([{ host: "fdc.nal.usda.gov", pathPrefix: "/fdc-datasets/" }]),
  HEALTH_CANADA_CNF: Object.freeze([
    {
      host: "open.canada.ca",
      pathExact:
        "/data/dataset/1b6139bd-ed7e-4043-bc28-ff00e10f3109/resource/019f2a90-e3a9-489d-b6e1-f74f4ba1d006/download/cnf_fcen_all-files-data_2026.zip",
    },
    {
      host: "opencanada.blob.core.windows.net",
      pathExact:
        "/opengovprod/resources/019f2a90-e3a9-489d-b6e1-f74f4ba1d006/cnf_fcen_all-files-data_2026.zip",
    },
  ]),
});
const WORKSPACE_ROOT = resolve(import.meta.dirname, "../../..");
const PRINCIPAL_ID_PATTERN = /^[a-z][-a-z0-9._:@/]{2,255}$/;

export async function runCommand(argv: readonly string[], io: CommandIo): Promise<number> {
  try {
    const arguments_ = parseArguments(argv);
    const command = arguments_.command.join(" ");
    switch (command) {
      case "manifest validate":
        await validateManifestCommand(arguments_.positionals, arguments_.options, io);
        return 0;
      case "artifact observe":
        await observeArtifactCommand(arguments_.positionals, arguments_.options, io);
        return 0;
      case "fdc inspect":
        await inspectFdcCommand(arguments_.positionals, arguments_.options, io);
        return 0;
      case "catalogue stage-fdc":
        await stageFdcCommand(arguments_.positionals, arguments_.options, io);
        return 0;
      case "catalogue mappings":
        await mappingsCommand(arguments_.positionals, io);
        return 0;
      case "catalogue register-source":
        await registerSourceCommand(arguments_.positionals, io);
        return 0;
      case "catalogue approve":
        await approveCommand(arguments_.options, io);
        return 0;
      case "catalogue promote":
        await promoteCommand(arguments_.options, io);
        return 0;
      case "catalogue rollback":
        await rollbackCommand(arguments_.options, io);
        return 0;
      default:
        throw new Error(usage());
    }
  } catch (error) {
    io.writeError(`${error instanceof Error ? error.message : "Unknown ingestion error"}\n`);
    return 1;
  }
}

async function validateManifestCommand(
  positionals: readonly string[],
  options: Readonly<Record<string, string | true>>,
  io: CommandIo,
): Promise<void> {
  const manifest = await readManifest(singlePositional(positionals, "manifest path"));
  if (flagOption(options, "import-ready")) assertImportReadyManifest(manifest);
  output(io, {
    importReadyRequested: flagOption(options, "import-ready"),
    manifestVersion: manifest.manifestVersion,
    releaseKey: manifest.release.releaseKey,
    sourceCode: manifest.source.code,
    templateOnly: manifest.templateOnly,
    valid: true,
  });
}

async function observeArtifactCommand(
  positionals: readonly string[],
  options: Readonly<Record<string, string | true>>,
  io: CommandIo,
): Promise<void> {
  const manifest = await readManifest(singlePositional(positionals, "manifest path"));
  const actor = trustedRunnerActor(io.environment);
  if (!manifest.artifact.downloadUrl) throw new Error("Manifest has no artifact download URL");
  const allowedSources = SOURCE_POLICIES[manifest.source.code];
  if (!allowedSources) throw new Error(`No release acquisition policy for ${manifest.source.code}`);
  const acquired = await acquireArtifact({
    cacheDirectory: workspacePath(requiredOption(options, "cache-dir")),
    freshness: "require-fresh-network",
    operatorPrincipalId: actor.principalId,
    remotePolicy: { allowedSources },
    source: manifest.artifact.downloadUrl,
    sourceMode: "release",
    tool: optionalOption(options, "tool") ?? "nutrition-tracker-ingest/0.1.0",
    verification: { mode: "observe-only" },
  });
  const observationPath = workspacePath(requiredOption(options, "observation-out"));
  await mkdir(dirname(observationPath), { mode: 0o700, recursive: true });
  await writeFile(observationPath, `${JSON.stringify(acquired.observation, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  output(io, {
    byteSize: acquired.observation.byteSize,
    cacheHit: acquired.cacheHit,
    observationPath,
    path: acquired.path,
    sha256: acquired.observation.sha256,
  });
}

async function inspectFdcCommand(
  positionals: readonly string[],
  options: Readonly<Record<string, string | true>>,
  io: CommandIo,
): Promise<void> {
  const manifest = await readManifest(singlePositional(positionals, "manifest path"));
  requireFdcFoundationManifest(manifest);
  const artifact = workspacePath(requiredOption(options, "artifact"));
  const cacheDirectory = workspacePath(requiredOption(options, "cache-dir"));
  const observation = await acquireArtifact({
    cacheDirectory,
    operatorPrincipalId: "local-inspection",
    source: artifact,
    sourceMode: "local-test",
    tool: "nutrition-tracker-ingest/0.1.0",
    verification: { mode: "observe-only" },
  });
  const parsed = await parseFdcArtifact(
    manifest,
    observation.path,
    workspacePath(requiredOption(options, "extract-dir")),
  );
  const metrics = fdcMetrics(parsed);
  assertFdcParserBaseline(manifest, metrics);
  output(io, {
    artifact: observation.observation,
    ...metrics,
  });
}

async function stageFdcCommand(
  positionals: readonly string[],
  options: Readonly<Record<string, string | true>>,
  io: CommandIo,
): Promise<void> {
  const actor = trustedRunnerActor(io.environment);
  const manifestPath = workspacePath(singlePositional(positionals, "manifest path"));
  const manifestBytes = await readFile(manifestPath);
  const manifest = parseFoodSourceManifest(JSON.parse(manifestBytes.toString("utf8")));
  assertImportReadyManifest(manifest);
  const parserBuildSha256 = trustedParserBuildSha256(manifest, io.environment);
  requireFdcFoundationManifest(manifest);
  const artifact = await acquireArtifact({
    cacheDirectory: workspacePath(requiredOption(options, "cache-dir")),
    operatorPrincipalId: "local-import-verifier",
    source: workspacePath(requiredOption(options, "artifact")),
    sourceMode: "local-test",
    tool: "nutrition-tracker-ingest/0.1.0",
    verification: {
      mode: "verified",
      expected: {
        byteSize: manifest.artifact.byteSize,
        provenance: `manifest:${hashBytes(manifestBytes)}`,
        sha256: manifest.artifact.sha256,
      },
    },
  });
  const database = createDatabaseFromEnvironment(io.environment);
  try {
    await registerManifestSource(database, manifest);
    const nutrientMappingDigest = await getSourceNutrientMappingDigest(
      database,
      manifest.source.code,
    );
    const stagedBatch = await stageBatch(database, {
      acquiredAt: requiredManifestValue(manifest.release.acquiredAt, "release.acquiredAt"),
      artifactBytes: manifest.artifact.byteSize,
      artifactSha256: manifest.artifact.sha256,
      artifactUri: manifest.artifact.objectUri,
      mediaType: manifest.artifact.mediaType,
      parserVersion: `${manifest.ingestion.parserVersion}+build.${parserBuildSha256}+mapping.${nutrientMappingDigest}`,
      publishedOn: manifest.release.publishedOn,
      releaseKey: manifest.release.releaseKey,
      rightsManifestSha256: hashBytes(manifestBytes),
      rightsManifestUri: immutableManifestObjectUri(
        requiredOption(options, "manifest-object-uri"),
        hashBytes(manifestBytes),
      ),
      sourceCode: manifest.source.code,
      upstreamSchemaVersion: manifest.release.upstreamSchemaVersion,
    });
    if (stagedBatch.status !== "staging") {
      const validation = await validateBatch(database, stagedBatch.batchId);
      output(io, {
        actor: actor.principalId,
        batchId: stagedBatch.batchId,
        excludedNutrients: validation.excludedNutrientCount,
        inserted: 0,
        promotionEligible: validation.promotionEligible,
        parserBuildSha256,
        nutrientMappingDigest,
        quarantined: validation.quarantinedCount,
        replayed: 0,
        resumed: true,
        staged: validation.stagedCount,
        status: stagedBatch.status,
        validationDigest: validation.validationDigest,
        valid: validation.validCount,
        warnings: validation.warningCount,
      });
      return;
    }
    const parsed = await parseFdcArtifact(
      manifest,
      artifact.path,
      workspacePath(requiredOption(options, "extract-dir")),
    );
    const metrics = fdcMetrics(parsed);
    assertFdcParserBaseline(manifest, metrics);
    const records = stagedInputs(parsed);
    const checkpoint = await getBatchCheckpoint(database, stagedBatch.batchId, "stage");
    const checkpointOffset = checkpoint ? Number(checkpoint.processedCount) : 0;
    if (
      !Number.isSafeInteger(checkpointOffset) ||
      checkpointOffset < 0 ||
      checkpointOffset > records.length
    ) {
      throw new Error(`Invalid staging checkpoint offset ${String(checkpoint?.processedCount)}`);
    }
    let inserted = 0;
    let replayed = 0;
    for (let offset = checkpointOffset; offset < records.length; offset += 250) {
      const endOffset = Math.min(offset + 250, records.length);
      const result = await stageBatchRecords(
        database,
        stagedBatch.batchId,
        records.slice(offset, endOffset),
      );
      inserted += result.inserted;
      replayed += result.replayed;
      await saveBatchCheckpoint(database, {
        batchId: stagedBatch.batchId,
        cursor: { nextOffset: endOffset },
        lastSequenceNumber: endOffset - 1,
        processedCount: endOffset,
        stage: "stage",
      });
    }
    const parserReportSha256 = await recordBatchParserReport(database, {
      batchId: stagedBatch.batchId,
      emittedNutrientCount: metrics.stagedNutrients,
      emittedPortionCount: metrics.stagedPortions,
      emittedRecordCount: metrics.records,
      excludedNutrientCount: metrics.excludedNutrients,
      excludedPortionCount: metrics.excludedPortions,
      excludedRecordCount: metrics.quarantined,
      report: parserReport(manifest, parsed, metrics, parserBuildSha256, nutrientMappingDigest),
      sourceNutrientCount: metrics.stagedNutrients + metrics.excludedNutrients,
      sourcePortionCount: metrics.stagedPortions + metrics.excludedPortions,
      sourceRecordCount: metrics.records + metrics.quarantined,
    });
    const validation = await validateBatch(database, stagedBatch.batchId, {
      maximumExcludedNutrientFraction:
        metrics.excludedNutrients / (metrics.stagedNutrients + metrics.excludedNutrients),
      maximumQuarantineFraction: metrics.quarantined / (metrics.records + metrics.quarantined),
      maximumQuarantinedRecords: metrics.quarantined,
    });
    output(io, {
      actor: actor.principalId,
      batchId: stagedBatch.batchId,
      excludedNutrients: validation.excludedNutrientCount,
      inserted,
      promotionEligible: validation.promotionEligible,
      quarantined: validation.quarantinedCount,
      replayed,
      staged: validation.stagedCount,
      validationDigest: validation.validationDigest,
      valid: validation.validCount,
      warnings: validation.warningCount,
      parser: metrics,
      parserBuildSha256,
      nutrientMappingDigest,
      parserReportSha256,
    });
  } finally {
    await database.destroy();
  }
}

async function approveCommand(
  options: Readonly<Record<string, string | true>>,
  io: CommandIo,
): Promise<void> {
  const actor = trustedRunnerActor(io.environment);
  const role = requiredOption(options, "role");
  if (role !== "data" && role !== "quality" && role !== "rights") {
    throw new Error("--role must be data, quality, or rights");
  }
  const database = createDatabaseFromEnvironment(io.environment);
  try {
    await approveBatch(database, {
      approvalReference: `${actor.authenticationMethod}:${actor.runReference}`,
      approvalRole: role,
      batchId: requiredOption(options, "batch-id"),
      principalId: actor.principalId,
      rightsManifestSha256: requiredOption(options, "manifest-sha256"),
      validationDigest: requiredOption(options, "validation-digest"),
    });
    output(io, { approved: true, role });
  } finally {
    await database.destroy();
  }
}

async function mappingsCommand(positionals: readonly string[], io: CommandIo): Promise<void> {
  const actor = trustedRunnerActor(io.environment);
  const mappingFile = parseMappingFile(
    JSON.parse(
      await readFile(workspacePath(singlePositional(positionals, "mapping file")), "utf8"),
    ),
  );
  if (mappingFile.reviewedBy !== actor.principalId) {
    throw new Error("Mapping reviewedBy must match the trusted runner principal");
  }
  const database = createDatabaseFromEnvironment(io.environment);
  try {
    await registerSourceNutrientMappings(database, mappingFile);
    output(io, { mappings: mappingFile.mappings.length, sourceCode: mappingFile.sourceCode });
  } finally {
    await database.destroy();
  }
}

async function registerSourceCommand(positionals: readonly string[], io: CommandIo): Promise<void> {
  trustedRunnerActor(io.environment);
  const manifest = await readManifest(singlePositional(positionals, "manifest path"));
  assertImportReadyManifest(manifest);
  const database = createDatabaseFromEnvironment(io.environment);
  try {
    output(io, { sourceId: await registerManifestSource(database, manifest) });
  } finally {
    await database.destroy();
  }
}

async function promoteCommand(
  options: Readonly<Record<string, string | true>>,
  io: CommandIo,
): Promise<void> {
  const actor = trustedRunnerActor(io.environment);
  const database = createDatabaseFromEnvironment(io.environment);
  try {
    const reason = optionalOption(options, "reason");
    output(
      io,
      await promoteBatch(database, {
        batchId: requiredOption(options, "batch-id"),
        performedBy: actor.principalId,
        reason: auditReason(actor, reason ?? "Promote validated catalogue batch"),
      }),
    );
  } finally {
    await database.destroy();
  }
}

async function rollbackCommand(
  options: Readonly<Record<string, string | true>>,
  io: CommandIo,
): Promise<void> {
  const actor = trustedRunnerActor(io.environment);
  const target = optionalOption(options, "target-release-id");
  const deactivate = flagOption(options, "deactivate");
  if ((target === undefined) === !deactivate) {
    throw new Error("Specify exactly one of --target-release-id or --deactivate");
  }
  const database = createDatabaseFromEnvironment(io.environment);
  try {
    output(
      io,
      await rollbackSourceRelease(database, {
        performedBy: actor.principalId,
        reason: auditReason(actor, requiredOption(options, "reason")),
        sourceCode: requiredOption(options, "source-code"),
        targetReleaseId: target ?? null,
      }),
    );
  } finally {
    await database.destroy();
  }
}

async function readManifest(path: string): Promise<FoodSourceManifestV3> {
  return parseFoodSourceManifest(JSON.parse(await readFile(workspacePath(path), "utf8")));
}

function requireFdcFoundationManifest(manifest: FoodSourceManifestV3): void {
  if (manifest.source.code !== "USDA_FDC" || manifest.validation.expectedFiles.length !== 1) {
    throw new Error("This command requires a USDA FDC single-member JSON manifest");
  }
  const member = manifest.validation.expectedFiles[0];
  if (!member?.toLowerCase().endsWith(".json")) {
    throw new Error("FDC manifest must select exactly one JSON archive member");
  }
}

async function parseFdcArtifact(
  manifest: FoodSourceManifestV3,
  archivePath: string,
  extractionDirectory: string,
): Promise<ReturnType<typeof adaptFdcJsonRelease>> {
  const extracted = await extractZipArchive({
    archivePath,
    destinationDirectory: extractionDirectory,
    expectedFiles: manifest.validation.expectedFiles,
    limits: {
      maxCompressionRatio: 250,
      maxEntries: 100,
      maxFileBytes: 200_000_000,
      maxTotalBytes: 200_000_000,
    },
  });
  const selected = extracted[0];
  if (!selected) throw new Error("FDC archive produced no selected JSON member");
  return adaptFdcJsonRelease(JSON.parse(await readFile(selected.path, "utf8")), {
    releaseKey: manifest.release.releaseKey,
  });
}

function stagedInputs(parsed: ReturnType<typeof adaptFdcJsonRelease>): readonly {
  readonly canonicalPayload: JsonValue;
  readonly sequenceNumber: number;
  readonly sourcePayloadSha256: string;
  readonly sourceRecordKey: string;
  readonly sourceRecordType: string;
}[] {
  return Object.freeze(
    parsed.records.map((record, sequenceNumber) => ({
      canonicalPayload: record as unknown as JsonValue,
      sequenceNumber,
      sourcePayloadSha256: record.sourcePayloadHash,
      sourceRecordKey: record.idempotencyKey,
      sourceRecordType: record.source.sourceDataType,
    })),
  );
}

function parserReport(
  manifest: FoodSourceManifestV3,
  parsed: ReturnType<typeof adaptFdcJsonRelease>,
  metrics: FdcMetrics,
  parserBuildSha256: string,
  nutrientMappingDigest: string,
): JsonObject {
  return {
    artifactSha256: requiredManifestValue(manifest.artifact.sha256, "artifact.sha256"),
    excludedAttributes: parsed.excludedAttributes as unknown as JsonValue,
    excludedNutrients: parsed.excludedNutrients as unknown as JsonValue,
    excludedPortions: parsed.excludedPortions as unknown as JsonValue,
    excludedRecords: parsed.quarantined as unknown as JsonValue,
    metrics: metrics as unknown as JsonValue,
    nutrientMappingDigest,
    parserPackage: manifest.ingestion.parserPackage,
    parserVersion: requiredManifestValue(
      manifest.ingestion.parserVersion,
      "ingestion.parserVersion",
    ),
    parserBuildSha256,
    releaseKey: manifest.release.releaseKey,
    schemaVersion: 1,
    sourceCode: manifest.source.code,
  };
}

async function registerManifestSource(
  database: Parameters<typeof registerFoodSourceFromReviewedManifest>[0],
  manifest: FoodSourceManifestV3,
): Promise<string> {
  assertImportReadyManifest(manifest);
  const status = manifest.rights.review.status;
  if (status !== "approved" && status !== "restricted") {
    throw new Error("Manifest rights review is incomplete");
  }
  return registerFoodSourceFromReviewedManifest(database, {
    accessUrl: manifest.source.accessUrl,
    active: true,
    attributionRequired:
      manifest.rights.licenseAttributionRequired || manifest.rights.productAttributionRequired,
    attributionText: manifest.rights.attributionFixture,
    code: manifest.source.code,
    commercialUseAllowed: manifest.rights.commercialUseAllowed === true,
    databaseRightsNotes: manifest.rights.databaseRightsNotes,
    displayName: manifest.source.displayName,
    homepageUrl: manifest.source.homepageUrl,
    kind: manifest.source.kind,
    licenseExpression: manifest.rights.licenseExpression,
    licenseUrl: manifest.rights.licenseUrl,
    redistributionAllowed: manifest.rights.redistributionAllowed,
    rightsReviewStatus: status,
    rightsReviewedAt: requiredManifestValue(
      manifest.rights.review.reviewedAt,
      "rights.review.reviewedAt",
    ),
    rightsReviewedBy: requiredManifestValue(
      manifest.rights.review.reviewedBy,
      "rights.review.reviewedBy",
    ),
    termsUrl: manifest.rights.termsUrl,
  });
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function immutableManifestObjectUri(value: string, sha256: string): string {
  const url = new URL(value);
  const pathSegments = url.pathname.split("/").filter(Boolean);
  const digestIsBound = pathSegments.some(
    (segment, index) => segment === "sha256" && pathSegments[index + 1] === sha256,
  );
  if (
    url.protocol !== "s3:" ||
    url.hostname.length === 0 ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    !digestIsBound
  ) {
    throw new Error(
      `--manifest-object-uri must be a content-addressed S3 URI containing /sha256/${sha256}`,
    );
  }
  return url.href;
}

function parseMappingFile(input: unknown): Parameters<typeof registerSourceNutrientMappings>[1] {
  const root = exactInput(input, "mapping file", [
    "sourceCode",
    "reviewedAt",
    "reviewedBy",
    "mappings",
  ]);
  const sourceCode = textInput(root.sourceCode, "sourceCode");
  const reviewedAt = rfc3339Input(root.reviewedAt, "reviewedAt");
  const reviewedBy = textInput(root.reviewedBy, "reviewedBy");
  if (!Array.isArray(root.mappings) || root.mappings.length === 0) {
    throw new Error("mappings must be a non-empty array");
  }
  const mappings = root.mappings.map((entry, index) => {
    const mapping = exactInput(
      entry,
      `mappings[${index}]`,
      [
        "canonicalNutrient",
        "conversionMultiplier",
        "mappingNotes",
        "sourceName",
        "sourceNutrientKey",
        "sourceUnit",
      ],
      ["canonicalNutrient", "sourceName", "sourceNutrientKey", "sourceUnit"],
    );
    const canonical = exactInput(
      mapping.canonicalNutrient,
      `mappings[${index}].canonicalNutrient`,
      ["code", "dimension", "name", "unit"],
    );
    const dimension = textInput(
      canonical.dimension,
      `mappings[${index}].canonicalNutrient.dimension`,
    );
    if (!["amount", "energy", "mass", "ratio", "volume"].includes(dimension)) {
      throw new Error(`mappings[${index}].canonicalNutrient.dimension is invalid`);
    }
    const conversionMultiplier = mapping.conversionMultiplier;
    const mappingNotes = mapping.mappingNotes;
    return {
      canonicalNutrient: {
        code: textInput(canonical.code, `mappings[${index}].canonicalNutrient.code`),
        dimension: dimension as "amount" | "energy" | "mass" | "ratio" | "volume",
        name: textInput(canonical.name, `mappings[${index}].canonicalNutrient.name`),
        unit: textInput(canonical.unit, `mappings[${index}].canonicalNutrient.unit`),
      },
      ...(conversionMultiplier === undefined
        ? {}
        : {
            conversionMultiplier: textInput(
              conversionMultiplier,
              `mappings[${index}].conversionMultiplier`,
            ),
          }),
      ...(mappingNotes === undefined || mappingNotes === null
        ? {}
        : { mappingNotes: textInput(mappingNotes, `mappings[${index}].mappingNotes`) }),
      sourceName: textInput(mapping.sourceName, `mappings[${index}].sourceName`),
      sourceNutrientKey: textInput(
        mapping.sourceNutrientKey,
        `mappings[${index}].sourceNutrientKey`,
      ),
      sourceUnit: textInput(mapping.sourceUnit, `mappings[${index}].sourceUnit`),
    };
  });
  return { mappings, reviewedAt, reviewedBy, sourceCode };
}

function objectInput(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function exactInput(
  value: unknown,
  field: string,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[] = allowedKeys,
): Readonly<Record<string, unknown>> {
  const object = objectInput(value, field);
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) throw new Error(`${field} contains unknown field ${key}`);
  }
  for (const key of requiredKeys) {
    if (!Object.hasOwn(object, key)) throw new Error(`${field} is missing ${key}`);
  }
  return object;
}

function rfc3339Input(value: unknown, field: string): string {
  const text = textInput(value, field);
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(
      text,
    );
  if (!match || Number.isNaN(Date.parse(text))) throw new Error(`${field} must be RFC 3339`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  if (
    calendarDate.getUTCFullYear() !== year ||
    calendarDate.getUTCMonth() !== month - 1 ||
    calendarDate.getUTCDate() !== day
  ) {
    throw new Error(`${field} must be a real calendar timestamp`);
  }
  return text;
}

function textInput(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error(`${field} must be non-blank text without surrounding whitespace`);
  }
  return value;
}

function hashRecordDigests(digests: readonly string[]): string {
  return createHash("sha256")
    .update([...digests].sort().join("\n"))
    .digest("hex");
}

interface FdcMetrics {
  readonly excludedAttributes: number;
  readonly excludedNutrients: number;
  readonly excludedPortions: number;
  readonly quarantined: number;
  readonly records: number;
  readonly sourcePayloadDigest: string;
  readonly stagedNutrients: number;
  readonly stagedPortions: number;
}

function fdcMetrics(parsed: ReturnType<typeof adaptFdcJsonRelease>): FdcMetrics {
  return Object.freeze({
    excludedAttributes: parsed.excludedAttributes.length,
    excludedNutrients: parsed.excludedNutrients.length,
    excludedPortions: parsed.excludedPortions.length,
    quarantined: parsed.quarantined.length,
    records: parsed.records.length,
    sourcePayloadDigest: hashRecordDigests(
      parsed.records.map((record) => record.sourcePayloadHash),
    ),
    stagedNutrients: parsed.records.reduce((count, record) => count + record.nutrients.length, 0),
    stagedPortions: parsed.records.reduce((count, record) => count + record.servings.length, 0),
  });
}

function assertFdcParserBaseline(manifest: FoodSourceManifestV3, metrics: FdcMetrics): void {
  const expected = manifest.validation.releaseSpecificExpectations;
  const checks: readonly [keyof FdcMetrics, string][] = [
    ["records", "parserBaselineAcceptedFoodCount"],
    ["quarantined", "parserBaselineQuarantinedFoodCount"],
    ["stagedNutrients", "parserBaselineStagedNutrientCount"],
    ["excludedNutrients", "parserBaselineExcludedNutrientCount"],
    ["stagedPortions", "parserBaselineStagedPortionCount"],
    ["excludedPortions", "parserBaselineExcludedPortionCount"],
    ["excludedAttributes", "parserBaselineExcludedAttributeCount"],
    ["sourcePayloadDigest", "parserBaselineAcceptedPayloadDigest"],
  ];
  for (const [metric, expectation] of checks) {
    if (expected[expectation] !== metrics[metric]) {
      throw new Error(
        `FDC parser baseline mismatch for ${expectation}: expected ${String(expected[expectation])}, received ${String(metrics[metric])}`,
      );
    }
  }
}

function requiredManifestValue(value: string | null, field: string): string {
  if (value === null || value.length === 0) throw new Error(`Manifest ${field} is not pinned`);
  return value;
}

function workspacePath(path: string): string {
  return isAbsolute(path) ? path : resolve(WORKSPACE_ROOT, path);
}

function singlePositional(positionals: readonly string[], label: string): string {
  if (positionals.length !== 1 || !positionals[0]) throw new Error(`Expected exactly one ${label}`);
  return positionals[0];
}

function output(io: CommandIo, value: unknown): void {
  io.writeOutput(`${JSON.stringify(value, null, 2)}\n`);
}

interface TrustedRunnerActor {
  readonly authenticationMethod: "oidc" | "workload-identity";
  readonly principalId: string;
  readonly runReference: string;
}

/**
 * Production authority is established by the access-controlled release runner,
 * never by a caller-provided command-line flag. The runner validates its IdP or
 * workload assertion before injecting this non-secret identity context alongside
 * a short-lived, least-privilege database credential.
 */
function trustedRunnerActor(environment: NodeJS.ProcessEnv): TrustedRunnerActor {
  const authenticationMethod = environment.INGEST_AUTHENTICATION_METHOD;
  if (authenticationMethod !== "oidc" && authenticationMethod !== "workload-identity") {
    throw new Error(
      "Release command requires an externally authenticated OIDC or workload-identity runner",
    );
  }
  const principalId = textInput(
    environment.INGEST_AUTHENTICATED_PRINCIPAL_ID,
    "INGEST_AUTHENTICATED_PRINCIPAL_ID",
  );
  if (!PRINCIPAL_ID_PATTERN.test(principalId)) {
    throw new Error(
      "INGEST_AUTHENTICATED_PRINCIPAL_ID must be a canonical lowercase stable principal ID",
    );
  }
  const runReference = trustedRunReference(
    environment.INGEST_AUTHENTICATION_RUN_REFERENCE,
    "INGEST_AUTHENTICATION_RUN_REFERENCE",
  );
  return { authenticationMethod, principalId, runReference };
}

function auditReason(actor: TrustedRunnerActor, reason: string): string {
  return `${reason} [${actor.authenticationMethod}:${actor.runReference}]`;
}

function trustedParserBuildSha256(
  manifest: FoodSourceManifestV3,
  environment: NodeJS.ProcessEnv,
): string {
  const runtimeDigest = textInput(
    environment.INGEST_PARSER_BUILD_SHA256,
    "INGEST_PARSER_BUILD_SHA256",
  );
  if (!/^[0-9a-f]{64}$/.test(runtimeDigest)) {
    throw new Error("INGEST_PARSER_BUILD_SHA256 must be a lowercase SHA-256 digest");
  }
  if (manifest.ingestion.parserBuildSha256 !== runtimeDigest) {
    throw new Error("Executing parser build digest does not match the reviewed manifest");
  }
  return runtimeDigest;
}

function trustedRunReference(value: unknown, field: string): string {
  const text = textInput(value, field);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${field} must be an immutable HTTPS or URN reference`);
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "urn:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(`${field} must be a credential-free HTTPS or URN reference without a query`);
  }
  return url.href;
}

function usage(): string {
  return [
    "Usage:",
    "  ingest manifest validate <manifest> [--import-ready]",
    "  ingest artifact observe <manifest> --cache-dir <path> --observation-out <path>",
    "  ingest fdc inspect <manifest> --artifact <zip> --cache-dir <path> --extract-dir <path>",
    "  ingest catalogue stage-fdc <manifest> --artifact <zip> --cache-dir <path> --extract-dir <path> --manifest-object-uri <s3-uri>",
    "  ingest catalogue mappings <reviewed-mapping.json>",
    "  ingest catalogue register-source <import-ready-manifest>",
    "  ingest catalogue approve --batch-id <id> --role <role> --manifest-sha256 <sha> --validation-digest <sha>",
    "  ingest catalogue promote --batch-id <id> [--reason <text>]",
    "  ingest catalogue rollback --source-code <code> --reason <text> (--target-release-id <id>|--deactivate)",
    "",
    "Release commands derive actor identity from the trusted runner environment; command-line principal overrides are not accepted.",
  ].join("\n");
}
