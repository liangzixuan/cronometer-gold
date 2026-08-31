import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import {
  approveBatch,
  type BatchCheckpoint,
  canonicalJsonChunks,
  createDatabaseFromEnvironment,
  getBatchCheckpoint,
  getSourceNutrientMappingDigest,
  type JsonObject,
  type JsonValue,
  promoteBatch,
  reconcileCatalogueBatch,
  recordBatchParserReportAndValidate,
  registerFoodSourceFromReviewedManifest,
  registerSourceNutrientMappings,
  rollbackSourceRelease,
  saveBatchCheckpoint,
  sha256CanonicalJson,
  stageBatch,
  stageBatchRecords,
  validateBatch,
} from "@nutrition-tracker/db";
import {
  acquireArtifact,
  adaptFdcJsonRelease,
  assertImportReadyManifest,
  assertManifestParserIdentity,
  CNF_ARCHIVE_CSV_PATHS,
  type CnfArchiveParseResult,
  extractZipArchive,
  type FoodSourceManifestV3,
  parseCnfArchive,
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
const CATALOGUE_RECONCILIATION_REPORT_ROOT = ".local-data/evidence/catalogue-reconciliation";
const PRINCIPAL_ID_PATTERN = /^[a-z][-a-z0-9._:@/]{2,255}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CATALOGUE_RECONCILE_OPTIONS = Object.freeze([
  "batch-id",
  "expected-current-release-id",
  "expected-validation-digest",
  "report-out",
]);
const STAGE_CNF_OPTIONS = Object.freeze([
  "artifact",
  "cache-dir",
  "extract-dir",
  "manifest-object-uri",
]);
const INSPECT_CNF_OPTIONS = Object.freeze(["artifact", "cache-dir", "extract-dir"]);
const CNF_ARCHIVE_LIMITS = Object.freeze({
  maxCompressionRatio: 250,
  maxEntries: 100,
  maxFileBytes: 250_000_000,
  maxTotalBytes: 500_000_000,
});

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
      case "cnf inspect":
        await inspectCnfCommand(argv, arguments_.positionals, arguments_.options, io);
        return 0;
      case "catalogue stage-fdc":
        await stageFdcCommand(arguments_.positionals, arguments_.options, io);
        return 0;
      case "catalogue stage-cnf":
        await stageCnfCommand(argv, arguments_.positionals, arguments_.options, io);
        return 0;
      case "catalogue mappings":
        await mappingsCommand(arguments_.positionals, io);
        return 0;
      case "catalogue register-source":
        await registerSourceCommand(arguments_.positionals, io);
        return 0;
      case "catalogue reconcile":
        await reconcileCommand(argv, arguments_.positionals, arguments_.options, io);
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
    io.writeError(formatCommandError(error));
    return 1;
  }
}

const MAX_COMMAND_ERROR_DEPTH = 3;
const MAX_COMMAND_ERROR_DETAILS = 8;
const MAX_COMMAND_ERROR_MESSAGE_LENGTH = 500;
const MAX_COMMAND_ERROR_OUTPUT_LENGTH = 4_000;

export function formatCommandError(error: unknown): string {
  const lines: string[] = [];
  appendCommandError(lines, error, 0);
  const output = `${lines.join("\n") || "Unknown ingestion error"}\n`;
  return output.length <= MAX_COMMAND_ERROR_OUTPUT_LENGTH
    ? output
    : `${output.slice(0, MAX_COMMAND_ERROR_OUTPUT_LENGTH - 2)}…\n`;
}

function appendCommandError(lines: string[], error: unknown, depth: number): void {
  if (lines.length >= MAX_COMMAND_ERROR_DETAILS) return;
  lines.push(safeCommandErrorMessage(error));
  if (!(error instanceof AggregateError) || depth >= MAX_COMMAND_ERROR_DEPTH) return;
  for (const nested of error.errors) {
    if (lines.length >= MAX_COMMAND_ERROR_DETAILS) break;
    appendCommandError(lines, nested, depth + 1);
  }
}

function safeCommandErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : "Unknown ingestion error";
  const boundedRaw = raw.slice(0, MAX_COMMAND_ERROR_MESSAGE_LENGTH * 4);
  const singleLine = [...boundedRaw]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127 ? " " : character;
    })
    .join("")
    .trim();
  const withoutUrlCredentials = singleLine.replace(
    /([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/giu,
    "$1[redacted]@",
  );
  const withoutUrlQueries = withoutUrlCredentials.replace(
    /(https?:\/\/[^\s?#]+)\?[^\s#]*/giu,
    "$1?[redacted]",
  );
  const withoutPrivateKeys = withoutUrlQueries.replace(
    /-----BEGIN [^-]{0,80}PRIVATE KEY-----.*?(?:-----END [^-]{0,80}PRIVATE KEY-----|$)/giu,
    "[private-key redacted]",
  );
  const withoutAuthorization = withoutPrivateKeys
    .replace(
      /\b(authorization|proxy-authorization)\s*:\s*(?:bearer|basic)\s+[^\s,;]+/giu,
      "$1: [redacted]",
    )
    .replace(/\bbearer\s+[a-z0-9._~+/-]+=*/giu, "Bearer [redacted]");
  const withoutSensitiveAssignments = withoutAuthorization
    .replace(
      /(--[a-z0-9_-]*(?:password|passwd|secret|token|private[_-]?key|api[_-]?key|access[_-]?key)[a-z0-9_-]*)(?:\s*=\s*|\s+)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/giu,
      "$1=[redacted]",
    )
    .replace(
      /((?:["'])?[a-z0-9_-]*(?:password|passwd|secret|token|private[_-]?key|api[_-]?key|access[_-]?key|authorization|cookie)[a-z0-9_-]*(?:["'])?\s*[=:]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/giu,
      "$1[redacted]",
    )
    .replace(/\b(?:gh[pousr]_[a-z0-9]{10,}|github_pat_[a-z0-9_]{10,})\b/giu, "[token redacted]")
    .replace(
      /\b(?:akia|asia|aida|aroa|aipa|anpa|anva|a3t)[a-z0-9]{12,}\b/giu,
      "[access-key redacted]",
    )
    .replace(/\beyj[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\b/giu, "[jwt redacted]");
  const redacted = withoutSensitiveAssignments.replace(
    /\b(set-cookie|cookie)\s*:\s*.*/giu,
    "$1: [redacted]",
  );
  const message = redacted.length > 0 ? redacted : "Unknown ingestion error";
  return message.length <= MAX_COMMAND_ERROR_MESSAGE_LENGTH
    ? message
    : `${message.slice(0, MAX_COMMAND_ERROR_MESSAGE_LENGTH - 1)}…`;
}

async function reconcileCommand(
  argv: readonly string[],
  positionals: readonly string[],
  options: Readonly<Record<string, string | true>>,
  io: CommandIo,
): Promise<void> {
  assertExactCatalogueReconcileArguments(argv, positionals, options);
  const batchId = uuidInput(requiredOption(options, "batch-id"), "--batch-id");
  const expectedCurrentReleaseValue = requiredOption(options, "expected-current-release-id");
  const expectedCurrentReleaseId =
    expectedCurrentReleaseValue === "none"
      ? null
      : uuidInput(expectedCurrentReleaseValue, "--expected-current-release-id");
  const expectedValidationDigest = sha256Input(
    requiredOption(options, "expected-validation-digest"),
    "--expected-validation-digest",
  );
  const reportOut = requiredOption(options, "report-out");
  const reportPath = resolveCatalogueReconciliationReportPath(reportOut);

  const database = createDatabaseFromEnvironment(io.environment);
  await runAfterRequiredCleanup(
    () =>
      reconcileCatalogueBatch(database, {
        batchId,
        expectedCurrentReleaseId,
        expectedValidationDigest,
      }),
    () => database.destroy(),
    async (document) => {
      await writeCatalogueReconciliationReportAtPath(
        reportPath,
        document as unknown as JsonValue,
        WORKSPACE_ROOT,
      );
      output(io, {
        batchId,
        currentReleaseId: expectedCurrentReleaseId,
        reconciliationSha256: document.reconciliationSha256,
        reportPath,
      });
    },
  );
}

export async function runAfterRequiredCleanup<T>(
  operation: () => Promise<T>,
  cleanup: () => Promise<void>,
  success: (value: T) => Promise<void>,
): Promise<T> {
  let operationResult:
    | { readonly error: unknown; readonly succeeded: false }
    | { readonly succeeded: true; readonly value: T };
  try {
    operationResult = { succeeded: true, value: await operation() };
  } catch (error) {
    operationResult = { error, succeeded: false };
  }

  let cleanupError: unknown;
  let cleanupFailed = false;
  try {
    await cleanup();
  } catch (error) {
    cleanupError = error;
    cleanupFailed = true;
  }

  if (!operationResult.succeeded) {
    if (cleanupFailed) {
      throw new AggregateError(
        [operationResult.error, cleanupError],
        "Operation and required cleanup both failed",
      );
    }
    throw operationResult.error;
  }
  if (cleanupFailed) throw cleanupError;
  await success(operationResult.value);
  return operationResult.value;
}

export async function writeCatalogueReconciliationReport(
  reportOut: string,
  document: JsonValue,
  workspaceRoot = WORKSPACE_ROOT,
): Promise<string> {
  const reportPath = resolveCatalogueReconciliationReportPath(reportOut, workspaceRoot);
  await writeCatalogueReconciliationReportAtPath(reportPath, document, workspaceRoot);
  return reportPath;
}

async function writeCatalogueReconciliationReportAtPath(
  reportPath: string,
  document: JsonValue,
  workspaceRoot: string,
): Promise<void> {
  const userId = currentUserId();
  const reportParent = dirname(reportPath);
  await assertTrustedWorkspaceRoot(workspaceRoot, userId);
  await preparePrivateReportParent(reportParent, workspaceRoot, userId);
  await assertReportLeafAbsent(reportPath);

  const temporaryPath = resolve(
    reportParent,
    `.catalogue-reconciliation-${process.pid}-${randomBytes(16).toString("hex")}.tmp`,
  );
  const handle = await open(
    temporaryPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  let handleOpen = true;
  let operationFailed = false;
  let operationError: unknown;
  let publishingFinalLink = false;
  try {
    const statistics = await handle.stat();
    if (!statistics.isFile() || statistics.uid !== userId || (statistics.mode & 0o777) !== 0o600) {
      throw new Error(
        "Catalogue reconciliation temporary report must be a current-user-owned mode-0600 file",
      );
    }
    for (const chunk of canonicalJsonChunks(document)) {
      await handle.writeFile(chunk, { encoding: "utf8" });
    }
    await handle.writeFile("\n", { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    handleOpen = false;
    publishingFinalLink = true;
    await link(temporaryPath, reportPath);
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  const cleanupErrors: unknown[] = [];
  if (handleOpen) {
    try {
      await handle.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    await unlink(temporaryPath);
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) cleanupErrors.push(error);
  }
  try {
    await syncPrivateReportDirectory(reportParent, userId);
  } catch (error) {
    cleanupErrors.push(error);
  }

  if (operationFailed || cleanupErrors.length > 0) {
    let primaryError: unknown;
    if (operationFailed) {
      primaryError =
        publishingFinalLink && hasErrorCode(operationError, "EEXIST")
          ? new Error("Catalogue reconciliation report already exists; refusing to overwrite it")
          : operationError;
    }
    const failures: unknown[] = [];
    if (primaryError !== undefined) failures.push(primaryError);
    else if (operationFailed) failures.push(new Error("Unknown report publication failure"));
    failures.push(...cleanupErrors);
    if (failures.length === 1) throw failures[0];
    throw new AggregateError(failures, "Catalogue reconciliation report publication failed");
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

async function inspectCnfCommand(
  argv: readonly string[],
  positionals: readonly string[],
  options: Readonly<Record<string, string | true>>,
  io: CommandIo,
): Promise<void> {
  assertExactCnfInspectArguments(argv, positionals, options);
  const manifestPath = workspacePath(singlePositional(positionals, "manifest path"));
  const manifestBytes = await readFile(manifestPath);
  const manifest = parseFoodSourceManifest(JSON.parse(manifestBytes.toString("utf8")));
  assertManifestParserIdentity(manifest);
  const guideFiles = requireCnfManifest(manifest);
  const parserBuildSha256 = trustedParserBuildSha256(manifest, io.environment);
  const artifactSha256 = requiredManifestValue(manifest.artifact.sha256, "artifact.sha256");
  const artifactByteSize = requiredPositiveSafeInteger(
    manifest.artifact.byteSize,
    "artifact.byteSize",
  );
  const artifact = await acquireArtifact({
    cacheDirectory: workspacePath(requiredOption(options, "cache-dir")),
    operatorPrincipalId: "local-cnf-inspection",
    source: workspacePath(requiredOption(options, "artifact")),
    sourceMode: "local-test",
    tool: "nutrition-tracker-ingest/0.1.0",
    verification: {
      mode: "verified",
      expected: {
        byteSize: artifactByteSize,
        provenance: `manifest:${hashBytes(manifestBytes)}`,
        sha256: artifactSha256,
      },
    },
  });
  const parsed = await parseCnfArchive({
    archivePath: artifact.path,
    context: { releaseKey: manifest.release.releaseKey },
    destinationDirectory: workspacePath(requiredOption(options, "extract-dir")),
    expectedFiles: manifest.validation.expectedFiles,
    guideFiles,
    archiveLimits: CNF_ARCHIVE_LIMITS,
  });
  const evidence = buildCnfStageEvidence(parsed);
  output(io, {
    archive: parsed.archive,
    artifact: artifact.observation,
    baseline: evidence.baseline,
    exclusionReasonCounts: evidence.exclusionReasonCounts,
    metrics: evidence.metrics,
    parserBuildSha256,
    parserPackage: manifest.ingestion.parserPackage,
    parserVersion: requiredManifestValue(
      manifest.ingestion.parserVersion,
      "ingestion.parserVersion",
    ),
    releaseKey: manifest.release.releaseKey,
    rowDispositions: evidence.rowDispositions,
    tables: parsed.tables,
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
  await runAfterRequiredCleanup(
    async () => {
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
        assertFrozenReplayStatus(stagedBatch.status);
        const validation = await validateBatch(database, stagedBatch.batchId);
        return {
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
        };
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
      const checkpointOffset = validatedStageCheckpointOffset(checkpoint, records.length);
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
      const { parserReportSha256, validation } = await recordBatchParserReportAndValidate(
        database,
        {
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
        },
        {
          maximumExcludedNutrientFraction:
            metrics.excludedNutrients / (metrics.stagedNutrients + metrics.excludedNutrients),
          maximumQuarantineFraction: metrics.quarantined / (metrics.records + metrics.quarantined),
          maximumQuarantinedRecords: metrics.quarantined,
        },
      );
      return {
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
      };
    },
    () => database.destroy(),
    async (result) => output(io, result),
  );
}

export interface CnfStageMetrics {
  readonly acceptedSourcePayloadSha256: string;
  readonly bilingualDescriptionCount: number;
  readonly emittedNutrientCount: number;
  readonly emittedPortionCount: number;
  readonly emittedRecordCount: number;
  readonly englishOnlyDescriptionCount: number;
  readonly excludedMeasureCount: number;
  readonly excludedNutrientCount: number;
  readonly exclusionReasonCountsSha256: string;
  readonly frenchOnlyDescriptionCount: number;
  readonly missingBothDescriptionCount: number;
  readonly quarantinedRecordCount: number;
  readonly skippedMeasureCount: number;
  readonly sourceNutrientCount: number;
  readonly sourcePortionCount: number;
  readonly sourceRecordCount: number;
  readonly rowDispositionsSha256: string;
  readonly tableEvidenceSha256: string;
}

export interface CnfStageEvidence {
  readonly baseline: Readonly<Record<string, boolean | number | string>>;
  readonly exclusionReasonCounts: JsonObject;
  readonly exclusions: JsonObject;
  readonly metrics: CnfStageMetrics;
  readonly rowDispositions: JsonObject;
}

async function stageCnfCommand(
  argv: readonly string[],
  positionals: readonly string[],
  options: Readonly<Record<string, string | true>>,
  io: CommandIo,
): Promise<void> {
  assertExactStageCnfArguments(argv, positionals, options);
  const actor = trustedRunnerActor(io.environment);
  const manifestPath = workspacePath(singlePositional(positionals, "manifest path"));
  const manifestBytes = await readFile(manifestPath);
  const manifestSha256 = hashBytes(manifestBytes);
  const manifest = parseFoodSourceManifest(JSON.parse(manifestBytes.toString("utf8")));
  assertImportReadyManifest(manifest);
  const guideFiles = requireCnfManifest(manifest);
  const parserBuildSha256 = trustedParserBuildSha256(manifest, io.environment);
  const manifestObjectUri = immutableManifestObjectUri(
    requiredOption(options, "manifest-object-uri"),
    manifestSha256,
  );
  const artifact = await acquireArtifact({
    cacheDirectory: workspacePath(requiredOption(options, "cache-dir")),
    operatorPrincipalId: actor.principalId,
    source: workspacePath(requiredOption(options, "artifact")),
    sourceMode: "local-test",
    tool: "nutrition-tracker-ingest/0.1.0",
    verification: {
      mode: "verified",
      expected: {
        byteSize: manifest.artifact.byteSize,
        provenance: `manifest:${manifestSha256}`,
        sha256: manifest.artifact.sha256,
      },
    },
  });
  const parsed = await parseCnfArchive({
    archivePath: artifact.path,
    context: { releaseKey: manifest.release.releaseKey },
    destinationDirectory: workspacePath(requiredOption(options, "extract-dir")),
    expectedFiles: manifest.validation.expectedFiles,
    guideFiles,
    archiveLimits: CNF_ARCHIVE_LIMITS,
  });
  const evidence = buildCnfStageEvidence(parsed);
  const { exclusionReasonCounts, exclusions, metrics, rowDispositions } = evidence;
  assertCnfParserBaseline(manifest, parsed, metrics);
  const records = stagedInputs(parsed.parsed);
  const database = createDatabaseFromEnvironment(io.environment);
  await runAfterRequiredCleanup(
    async () => {
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
        rightsManifestSha256: manifestSha256,
        rightsManifestUri: manifestObjectUri,
        sourceCode: manifest.source.code,
        upstreamSchemaVersion: manifest.release.upstreamSchemaVersion,
      });
      if (stagedBatch.status !== "staging") {
        assertFrozenReplayStatus(stagedBatch.status);
        const validation = await validateBatch(database, stagedBatch.batchId);
        return {
          actor: actor.principalId,
          batchId: stagedBatch.batchId,
          excludedNutrients: validation.excludedNutrientCount,
          inserted: 0,
          nutrientMappingDigest,
          parserBuildSha256,
          parserReportSha256: validation.parserReportSha256,
          promotionEligible: validation.promotionEligible,
          quarantined: validation.quarantinedCount,
          replayed: 0,
          resumed: true,
          staged: validation.stagedCount,
          status: stagedBatch.status,
          validationDigest: validation.validationDigest,
          valid: validation.validCount,
          warnings: validation.warningCount,
        };
      }

      const checkpoint = await getBatchCheckpoint(database, stagedBatch.batchId, "stage");
      const checkpointOffset = validatedStageCheckpointOffset(checkpoint, records.length);
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
      const { parserReportSha256, validation } = await recordBatchParserReportAndValidate(
        database,
        {
          batchId: stagedBatch.batchId,
          emittedNutrientCount: metrics.emittedNutrientCount,
          emittedPortionCount: metrics.emittedPortionCount,
          emittedRecordCount: metrics.emittedRecordCount,
          excludedNutrientCount: metrics.excludedNutrientCount,
          excludedPortionCount: metrics.excludedMeasureCount + metrics.skippedMeasureCount,
          excludedRecordCount: metrics.quarantinedRecordCount,
          report: cnfParserReport(
            manifest,
            parsed,
            metrics,
            exclusions,
            exclusionReasonCounts,
            rowDispositions,
            actor,
            parserBuildSha256,
            nutrientMappingDigest,
          ),
          sourceNutrientCount: metrics.sourceNutrientCount,
          sourcePortionCount: metrics.sourcePortionCount,
          sourceRecordCount: metrics.sourceRecordCount,
        },
        {
          maximumExcludedNutrientFraction: safeObservedFraction(
            metrics.excludedNutrientCount,
            metrics.sourceNutrientCount,
          ),
          maximumQuarantineFraction: safeObservedFraction(
            metrics.quarantinedRecordCount,
            metrics.sourceRecordCount,
          ),
          maximumQuarantinedRecords: metrics.quarantinedRecordCount,
        },
      );
      return {
        actor: actor.principalId,
        batchId: stagedBatch.batchId,
        excludedNutrients: validation.excludedNutrientCount,
        inserted,
        nutrientMappingDigest,
        parser: metrics,
        parserBuildSha256,
        parserReportSha256,
        promotionEligible: validation.promotionEligible,
        quarantined: validation.quarantinedCount,
        replayed,
        staged: validation.stagedCount,
        status: validation.promotionEligible ? "ready" : "quarantined",
        validationDigest: validation.validationDigest,
        valid: validation.validCount,
        warnings: validation.warningCount,
      };
    },
    () => database.destroy(),
    async (result) => output(io, result),
  );
}

export function buildCnfStageEvidence(result: CnfArchiveParseResult): CnfStageEvidence {
  const exclusions = cnfExclusions(result);
  const exclusionReasonCounts = cnfExclusionReasonCounts(exclusions);
  const rowDispositions = result.parsed.rowDispositions as unknown as JsonObject;
  const metrics = cnfMetrics(result, exclusionReasonCounts);
  return Object.freeze({
    baseline: cnfParserBaselineEvidence(result, metrics),
    exclusionReasonCounts,
    exclusions,
    metrics,
    rowDispositions,
  });
}

function cnfMetrics(
  result: CnfArchiveParseResult,
  exclusionReasonCounts: JsonObject,
): CnfStageMetrics {
  const conservation = result.parsed.conservation;
  const emittedNutrientCount = result.parsed.records.reduce(
    (total, record) => total + record.nutrients.length,
    0,
  );
  const emittedPortionCount = result.parsed.records.reduce(
    (total, record) => total + record.servings.length,
    0,
  );
  if (
    conservation.foodNames.emittedCount !== result.parsed.records.length ||
    conservation.foodNames.quarantinedCount !== result.parsed.quarantined.length ||
    conservation.nutrientAmounts.emittedCount !== emittedNutrientCount ||
    conservation.nutrientAmounts.excludedCount !== result.parsed.excludedNutrients.length ||
    conservation.measureWeightConversions.emittedCount !== emittedPortionCount ||
    conservation.measureWeightConversions.excludedCount !== result.parsed.excludedMeasures.length ||
    conservation.measureWeightConversions.skippedCount !== result.parsed.skippedMeasures.length
  ) {
    throw new Error("CNF adapter conservation evidence is internally inconsistent");
  }
  return Object.freeze({
    acceptedSourcePayloadSha256: sha256CanonicalJson(
      result.parsed.records.map((record) => ({
        sourcePayloadHash: record.sourcePayloadHash,
        sourceRecordKey: record.idempotencyKey,
      })),
    ),
    bilingualDescriptionCount: result.metrics.bilingualDescriptionCount,
    emittedNutrientCount,
    emittedPortionCount,
    emittedRecordCount: result.parsed.records.length,
    englishOnlyDescriptionCount: result.metrics.englishOnlyDescriptionCount,
    excludedMeasureCount: result.parsed.excludedMeasures.length,
    excludedNutrientCount: result.parsed.excludedNutrients.length,
    exclusionReasonCountsSha256: sha256CanonicalJson(exclusionReasonCounts),
    frenchOnlyDescriptionCount: result.metrics.frenchOnlyDescriptionCount,
    missingBothDescriptionCount: result.metrics.missingBothDescriptionCount,
    quarantinedRecordCount: result.parsed.quarantined.length,
    skippedMeasureCount: result.parsed.skippedMeasures.length,
    sourceNutrientCount: conservation.nutrientAmounts.sourceCount,
    sourcePortionCount: conservation.measureWeightConversions.sourceCount,
    sourceRecordCount: conservation.foodNames.sourceCount,
    rowDispositionsSha256: sha256CanonicalJson(
      result.parsed.rowDispositions as unknown as JsonValue,
    ),
    tableEvidenceSha256: result.tableEvidenceSha256,
  });
}

function cnfExclusions(result: CnfArchiveParseResult): JsonObject {
  return Object.freeze({
    measures: result.parsed.excludedMeasures as unknown as JsonValue,
    nutrients: result.parsed.excludedNutrients as unknown as JsonValue,
    records: result.parsed.quarantined as unknown as JsonValue,
    skippedMeasures: result.parsed.skippedMeasures as unknown as JsonValue,
  });
}

function cnfExclusionReasonCounts(exclusions: JsonObject): JsonObject {
  const counts: Record<string, number> = {};
  const add = (prefix: string, values: JsonValue | undefined, field: "code" | "reason"): void => {
    if (!Array.isArray(values)) throw new Error(`CNF ${prefix} exclusions must be an array`);
    for (const [index, value] of values.entries()) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`CNF ${prefix} exclusion ${index} must be an object`);
      }
      const reason = value[field];
      if (typeof reason !== "string" || reason.length === 0) {
        throw new Error(`CNF ${prefix} exclusion ${index} has no ${field}`);
      }
      const key = `${prefix}:${reason}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
  };
  add("measure", exclusions.measures, "code");
  add("nutrient", exclusions.nutrients, "code");
  add("record", exclusions.records, "code");
  add("skipped-measure", exclusions.skippedMeasures, "reason");
  return Object.freeze(counts);
}

function cnfParserReport(
  manifest: FoodSourceManifestV3,
  parsed: CnfArchiveParseResult,
  metrics: CnfStageMetrics,
  exclusions: JsonObject,
  exclusionReasonCounts: JsonObject,
  rowDispositions: JsonObject,
  actor: TrustedRunnerActor,
  parserBuildSha256: string,
  nutrientMappingDigest: string,
): JsonObject {
  return {
    actor: actor as unknown as JsonObject,
    archive: parsed.archive as unknown as JsonObject,
    artifactSha256: requiredManifestValue(manifest.artifact.sha256, "artifact.sha256"),
    exclusionReasonCounts,
    exclusions,
    metrics: metrics as unknown as JsonObject,
    nutrientMappingDigest,
    parserBuildSha256,
    parserPackage: manifest.ingestion.parserPackage,
    parserVersion: requiredManifestValue(
      manifest.ingestion.parserVersion,
      "ingestion.parserVersion",
    ),
    releaseKey: manifest.release.releaseKey,
    reportKind: "health-canada-cnf-stage-v1",
    rowDispositions,
    schemaVersion: 1,
    sourceCode: manifest.source.code,
    tables: parsed.tables as unknown as JsonValue,
  };
}

export function cnfParserBaselineEvidence(
  parsed: CnfArchiveParseResult,
  metrics: CnfStageMetrics,
): Readonly<Record<string, boolean | number | string>> {
  const evidence: Record<string, boolean | number | string> = {
    "cnfArchive.inventoryCount": parsed.archive.inventoryCount,
    "cnfArchive.inventorySha256": parsed.archive.inventorySha256,
    "cnfTables.evidenceSha256": parsed.tableEvidenceSha256,
  };
  for (const table of parsed.tables) {
    const prefix = `cnfTable.${table.archivePath}`;
    evidence[`${prefix}.byteSize`] = table.byteSize;
    evidence[`${prefix}.headerSha256`] = table.headerSha256;
    evidence[`${prefix}.rawSha256`] = table.rawSha256;
    evidence[`${prefix}.rowCount`] = table.rowCount;
    evidence[`${prefix}.rowsSha256`] = table.rowsSha256;
  }
  for (const [key, value] of Object.entries(metrics)) {
    evidence[`cnfParser.${key}`] = value;
  }
  return Object.freeze(evidence);
}

export function assertCnfParserBaseline(
  manifest: FoodSourceManifestV3,
  parsed: CnfArchiveParseResult,
  metrics: CnfStageMetrics,
): void {
  const expected = manifest.validation.releaseSpecificExpectations;
  for (const [key, actual] of Object.entries(cnfParserBaselineEvidence(parsed, metrics))) {
    if (expected[key] !== actual) {
      throw new Error(`CNF parser baseline mismatch for ${key}`);
    }
  }
}

function safeObservedFraction(numerator: number, denominator: number): number {
  if (denominator === 0) return numerator === 0 ? 0 : 1;
  return numerator / denominator;
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

function requireCnfManifest(manifest: FoodSourceManifestV3): readonly string[] {
  if (
    manifest.source.code !== "HEALTH_CANADA_CNF" ||
    manifest.artifact.mediaType !== "application/zip" ||
    manifest.ingestion.parserPackage !== "@nutrition-tracker/ingestion"
  ) {
    throw new Error("This command requires a Health Canada CNF ZIP manifest");
  }
  requireExactStringArray(manifest.ingestion.languages, ["en", "fr"], "CNF languages");
  requireExactStringArray(manifest.ingestion.markets, ["CA"], "CNF markets");
  requireExactStringArray(
    manifest.ingestion.sourceIdentityFields,
    ["food code"],
    "CNF source identity fields",
  );
  requireExactStringArray(
    manifest.ingestion.dataTypes,
    ["foods", "nutrients", "nutrient amounts", "measure weights", "food groups"],
    "CNF data types",
  );
  const officialCsv = new Set<string>(CNF_ARCHIVE_CSV_PATHS);
  const expected = new Set(manifest.validation.expectedFiles);
  for (const archivePath of officialCsv) {
    if (!expected.has(archivePath)) throw new Error(`CNF manifest is missing ${archivePath}`);
  }
  const guides: string[] = [];
  for (const archivePath of manifest.validation.expectedFiles) {
    if (officialCsv.has(archivePath)) continue;
    if (/\.csv$/iu.test(archivePath)) {
      throw new Error(`CNF manifest contains an undeclared CSV member: ${archivePath}`);
    }
    guides.push(archivePath);
  }
  return Object.freeze(guides.sort());
}

function requireExactStringArray(
  actual: readonly string[],
  expected: readonly string[],
  field: string,
): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${field} must exactly match the reviewed contract`);
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

function stagedInputs(
  parsed: ReturnType<typeof adaptFdcJsonRelease> | CnfArchiveParseResult["parsed"],
): readonly {
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

function requiredPositiveSafeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Manifest ${field} must be a pinned positive safe integer`);
  }
  return value;
}

function workspacePath(path: string): string {
  return isAbsolute(path) ? path : resolve(WORKSPACE_ROOT, path);
}

function resolveCatalogueReconciliationReportPath(
  reportOut: string,
  workspaceRoot = WORKSPACE_ROOT,
): string {
  const normalizedWorkspaceRoot = resolve(workspaceRoot);
  if (
    /^[A-Za-z]:[\\/]/.test(normalizedWorkspaceRoot) ||
    /^\/mnt\/[A-Za-z](?:\/|$)/.test(normalizedWorkspaceRoot)
  ) {
    throw new Error("Catalogue reconciliation workspace must reside in the WSL Linux filesystem");
  }
  if (
    isAbsolute(reportOut) ||
    /^[A-Za-z]:[\\/]/.test(reportOut) ||
    reportOut.startsWith("\\\\") ||
    reportOut.includes("\\") ||
    reportOut.includes("\0")
  ) {
    throw new Error(
      `--report-out must be a relative path beneath ${CATALOGUE_RECONCILIATION_REPORT_ROOT}`,
    );
  }
  const reportRoot = resolve(normalizedWorkspaceRoot, CATALOGUE_RECONCILIATION_REPORT_ROOT);
  const reportPath = resolve(normalizedWorkspaceRoot, reportOut);
  const pathWithinRoot = relative(reportRoot, reportPath);
  if (
    pathWithinRoot.length === 0 ||
    pathWithinRoot === ".." ||
    pathWithinRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathWithinRoot)
  ) {
    throw new Error(
      `--report-out must name a file beneath ${CATALOGUE_RECONCILIATION_REPORT_ROOT}`,
    );
  }
  return reportPath;
}

async function assertTrustedWorkspaceRoot(workspaceRoot: string, userId: number): Promise<void> {
  const statistics = await lstat(workspaceRoot);
  if (statistics.isSymbolicLink() || !statistics.isDirectory()) {
    throw new Error("Catalogue reconciliation workspace root must be a real directory");
  }
  if (statistics.uid !== userId || (statistics.mode & 0o022) !== 0) {
    throw new Error(
      "Catalogue reconciliation workspace root must be current-user-owned and not group/other-writable",
    );
  }
}

async function preparePrivateReportParent(
  reportParent: string,
  workspaceRoot: string,
  userId: number,
): Promise<void> {
  const parentWithinWorkspace = relative(workspaceRoot, reportParent);
  if (
    parentWithinWorkspace.length === 0 ||
    parentWithinWorkspace === ".." ||
    parentWithinWorkspace.startsWith(`..${sep}`) ||
    isAbsolute(parentWithinWorkspace)
  ) {
    throw new Error("Catalogue reconciliation report parent escaped the workspace");
  }

  let current = workspaceRoot;
  for (const component of parentWithinWorkspace.split(sep)) {
    current = resolve(current, component);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) throw error;
    }
    const statistics = await lstat(current);
    if (statistics.isSymbolicLink() || !statistics.isDirectory()) {
      throw new Error(
        `Catalogue reconciliation report parent contains a symbolic link: ${current}`,
      );
    }
    if (statistics.uid !== userId || (statistics.mode & 0o777) !== 0o700) {
      throw new Error(
        `Catalogue reconciliation report parent must be current-user-owned with mode 0700: ${current}`,
      );
    }
  }
}

async function syncPrivateReportDirectory(reportParent: string, userId: number): Promise<void> {
  const handle = await open(
    reportParent,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const statistics = await handle.stat();
    if (
      !statistics.isDirectory() ||
      statistics.uid !== userId ||
      (statistics.mode & 0o777) !== 0o700
    ) {
      throw new Error(
        "Catalogue reconciliation report directory must remain current-user-owned with mode 0700",
      );
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertReportLeafAbsent(reportPath: string): Promise<void> {
  try {
    const statistics = await lstat(reportPath);
    if (statistics.isSymbolicLink()) {
      throw new Error("Catalogue reconciliation report leaf must not be a symbolic link");
    }
    throw new Error("Catalogue reconciliation report already exists; refusing to overwrite it");
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }
}

function currentUserId(): number {
  if (typeof process.getuid !== "function") {
    throw new Error("Catalogue reconciliation reports require POSIX ownership checks");
  }
  return process.getuid();
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

function assertExactCatalogueReconcileArguments(
  argv: readonly string[],
  positionals: readonly string[],
  options: Readonly<Record<string, string | true>>,
): void {
  if (positionals.length !== 0) {
    throw new Error("catalogue reconcile does not accept positional arguments");
  }
  const allowed = new Set(CATALOGUE_RECONCILE_OPTIONS);
  for (const name of Object.keys(options)) {
    if (!allowed.has(name)) throw new Error(`Unknown catalogue reconcile option: --${name}`);
  }

  // parseArguments intentionally uses a plain object. Inspect raw option names too
  // so special names such as __proto__ cannot disappear through object semantics.
  const tokens = argv[0] === "--" ? argv.slice(1) : argv;
  for (const token of tokens.slice(2)) {
    if (token === "--") break;
    if (!token.startsWith("--")) continue;
    const name = token.slice(2).split("=", 1)[0];
    if (!name || !allowed.has(name)) {
      throw new Error(`Unknown catalogue reconcile option: --${name ?? ""}`);
    }
  }
}

function assertExactCnfInspectArguments(
  argv: readonly string[],
  positionals: readonly string[],
  options: Readonly<Record<string, string | true>>,
): void {
  if (positionals.length !== 1 || !positionals[0]) {
    throw new Error("cnf inspect requires exactly one manifest path");
  }
  const allowed = new Set(INSPECT_CNF_OPTIONS);
  for (const name of Object.keys(options)) {
    if (!allowed.has(name)) throw new Error(`Unknown cnf inspect option: --${name}`);
  }

  const tokens = argv[0] === "--" ? argv.slice(1) : argv;
  for (const token of tokens.slice(2)) {
    if (token === "--") break;
    if (!token.startsWith("--")) continue;
    const name = token.slice(2).split("=", 1)[0];
    if (!name || !allowed.has(name)) {
      throw new Error(`Unknown cnf inspect option: --${name ?? ""}`);
    }
  }
  for (const name of INSPECT_CNF_OPTIONS) requiredOption(options, name);
}

function assertExactStageCnfArguments(
  argv: readonly string[],
  positionals: readonly string[],
  options: Readonly<Record<string, string | true>>,
): void {
  if (positionals.length !== 1 || !positionals[0]) {
    throw new Error("catalogue stage-cnf requires exactly one manifest path");
  }
  const allowed = new Set(STAGE_CNF_OPTIONS);
  for (const name of Object.keys(options)) {
    if (!allowed.has(name)) throw new Error(`Unknown catalogue stage-cnf option: --${name}`);
  }

  // parseArguments intentionally uses a plain object. Inspect raw option names too
  // so prototype-like names cannot disappear through object assignment semantics.
  const tokens = argv[0] === "--" ? argv.slice(1) : argv;
  for (const token of tokens.slice(2)) {
    if (token === "--") break;
    if (!token.startsWith("--")) continue;
    const name = token.slice(2).split("=", 1)[0];
    if (!name || !allowed.has(name)) {
      throw new Error(`Unknown catalogue stage-cnf option: --${name ?? ""}`);
    }
  }
  for (const name of STAGE_CNF_OPTIONS) requiredOption(options, name);
}

export function validatedStageCheckpointOffset(
  checkpoint: BatchCheckpoint | null | undefined,
  recordCount: number,
): number {
  if (!Number.isSafeInteger(recordCount) || recordCount < 0) {
    throw new Error("Staging record count must be a non-negative safe integer");
  }
  if (!checkpoint) return 0;
  if (checkpoint.stage !== "stage") {
    throw new Error(`Invalid staging checkpoint stage ${checkpoint.stage}`);
  }
  const processedCount = checkpointInteger(checkpoint.processedCount, "processedCount");
  const cursorKeys = Object.keys(checkpoint.cursor);
  if (cursorKeys.length !== 1 || cursorKeys[0] !== "nextOffset") {
    throw new Error("Invalid staging checkpoint cursor shape");
  }
  const nextOffset = checkpointInteger(checkpoint.cursor.nextOffset, "cursor.nextOffset");
  const expectedLastSequenceNumber = processedCount === 0 ? null : processedCount - 1;
  const lastSequenceNumber =
    checkpoint.lastSequenceNumber === null
      ? null
      : checkpointInteger(checkpoint.lastSequenceNumber, "lastSequenceNumber");
  if (
    processedCount > recordCount ||
    nextOffset !== processedCount ||
    lastSequenceNumber !== expectedLastSequenceNumber
  ) {
    throw new Error("Invalid staging checkpoint tuple");
  }
  return processedCount;
}

function checkpointInteger(value: JsonValue | undefined, field: string): number {
  if (typeof value === "number") {
    if (Number.isSafeInteger(value) && value >= 0) return value;
  } else if (typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw new Error(`Invalid staging checkpoint ${field}`);
}

function assertFrozenReplayStatus(status: string): void {
  if (status !== "ready" && status !== "quarantined" && status !== "completed") {
    throw new Error(`Batch in ${status} state cannot be resumed as frozen staging evidence`);
  }
}

function uuidInput(value: string, field: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new Error(`${field} must be a canonical lowercase UUID`);
  }
  return value;
}

function sha256Input(value: string, field: string): string {
  if (!SHA256_PATTERN.test(value)) {
    throw new Error(`${field} must be a lowercase SHA-256 digest`);
  }
  return value;
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
    "  ingest cnf inspect <manifest> --artifact <zip> --cache-dir <path> --extract-dir <path>",
    "  ingest catalogue stage-fdc <manifest> --artifact <zip> --cache-dir <path> --extract-dir <path> --manifest-object-uri <s3-uri>",
    "  ingest catalogue stage-cnf <manifest> --artifact <zip> --cache-dir <path> --extract-dir <path> --manifest-object-uri <s3-uri>",
    "  ingest catalogue mappings <reviewed-mapping.json>",
    "  ingest catalogue register-source <import-ready-manifest>",
    "  ingest catalogue reconcile --batch-id <uuid> --expected-current-release-id <uuid|none> --expected-validation-digest <lowercase-sha256> --report-out .local-data/evidence/catalogue-reconciliation/<file>",
    "  ingest catalogue approve --batch-id <id> --role <role> --manifest-sha256 <sha> --validation-digest <sha>",
    "  ingest catalogue promote --batch-id <id> [--reason <text>]",
    "  ingest catalogue rollback --source-code <code> --reason <text> (--target-release-id <id>|--deactivate)",
    "",
    "Authority-changing release commands derive actor identity from the trusted runner environment; command-line principal overrides are not accepted. Catalogue reconciliation is read-only and has no actor.",
  ].join("\n");
}
