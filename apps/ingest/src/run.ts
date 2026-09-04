import { createHash, randomBytes } from "node:crypto";
import { constants, readFileSync, type Stats } from "node:fs";
import { link, lstat, mkdir, open, readFile, realpath, unlink, writeFile } from "node:fs/promises";
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
  assertFdcCsvArchiveContext,
  assertFdcCsvArchiveContract,
  assertImportReadyManifest,
  assertManifestParserIdentity,
  CNF_ARCHIVE_CSV_PATHS,
  type CnfArchiveParseResult,
  type ExtractedZipFile,
  extractZipArchive,
  type FdcCsvArchiveContext,
  type FdcCsvArchiveParseResult,
  type FdcCsvFileContract,
  type FoodSourceManifestV3,
  IngestionError,
  invariant,
  parseCnfArchive,
  parseFdcCsvArchive,
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
const ARTIFACT_OBSERVE_OPTIONS = Object.freeze(["cache-dir", "observation-out"]);
const CANONICAL_NUMERIC_PACKAGE_VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const PRINCIPAL_ID_PATTERN = /^[a-z][-a-z0-9._:@/]{2,255}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CATALOGUE_RECONCILE_OPTIONS = Object.freeze([
  "batch-id",
  "expected-current-release-id",
  "expected-validation-digest",
  "report-out",
]);
const STAGE_FDC_OPTIONS = Object.freeze([
  "artifact",
  "cache-dir",
  "extract-dir",
  "manifest-object-uri",
]);
const STAGE_CNF_OPTIONS = Object.freeze([
  "artifact",
  "cache-dir",
  "extract-dir",
  "manifest-object-uri",
]);
const INSPECT_FDC_OPTIONS = Object.freeze(["artifact", "cache-dir", "extract-dir"]);
const INSPECT_FDC_CSV_OPTIONS = Object.freeze(["artifact", "cache-dir", "extract-dir"]);
const INSPECT_CNF_OPTIONS = Object.freeze(["artifact", "cache-dir", "extract-dir"]);
const CNF_ARCHIVE_LIMITS = Object.freeze({
  maxCompressionRatio: 250,
  maxEntries: 100,
  maxFileBytes: 250_000_000,
  maxTotalBytes: 500_000_000,
});
const FDC_CSV_ARCHIVE_LIMITS = Object.freeze({
  maxCompressionRatio: 250,
  maxEntries: 256,
  maxFileBytes: 4_000_000_000,
  maxTotalBytes: 5_000_000_000,
});
const FDC_CSV_MAX_ARTIFACT_BYTES = 1_000_000_000;
const FDC_CSV_DISPOSITION_PREFIX = "fdcCsvDisposition:";
const FDC_CSV_DATA_TYPE_PREFIX = "fdcCsvDataTypeMapping:";
const FDC_CSV_MARKET_PREFIX = "fdcCsvMarketMapping:";
const FDC_CSV_DEFAULT_MARKET_KEY = "fdcCsvDefaultMarketCode";

export async function runCommand(argv: readonly string[], io: CommandIo): Promise<number> {
  try {
    const arguments_ = parseArguments(argv);
    const command = arguments_.command.join(" ");
    switch (command) {
      case "manifest validate":
        await validateManifestCommand(arguments_.positionals, arguments_.options, io);
        return 0;
      case "artifact observe":
        await observeArtifactCommand(argv, arguments_.positionals, arguments_.options, io);
        return 0;
      case "fdc inspect":
        await inspectFdcCommand(argv, arguments_.positionals, arguments_.options, io);
        return 0;
      case "fdc inspect-csv":
        await inspectFdcCsvCommand(argv, arguments_.positionals, arguments_.options, io);
        return 0;
      case "cnf inspect":
        await inspectCnfCommand(argv, arguments_.positionals, arguments_.options, io);
        return 0;
      case "catalogue stage-fdc":
        await stageFdcCommand(argv, arguments_.positionals, arguments_.options, io);
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
  argv: readonly string[],
  positionals: readonly string[],
  options: Readonly<Record<string, string | true>>,
  io: CommandIo,
): Promise<void> {
  assertExactArtifactObserveArguments(argv, positionals, options);
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
    tool: readIngestToolIdentity(),
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
  argv: readonly string[],
  positionals: readonly string[],
  options: Readonly<Record<string, string | true>>,
  io: CommandIo,
): Promise<void> {
  assertExactFdcInspectArguments(argv, positionals, options);
  const manifestPath = workspacePath(singlePositional(positionals, "manifest path"));
  const manifestBytes = await readFile(manifestPath);
  const manifest = parseFoodSourceManifest(JSON.parse(manifestBytes.toString("utf8")));
  const manifestSha256 = hashBytes(manifestBytes);
  assertManifestParserIdentity(manifest);
  requireFdcFoundationManifest(manifest);
  const parserBuildSha256 = trustedParserBuildSha256(manifest, io.environment);
  const artifactSha256 = requiredManifestValue(manifest.artifact.sha256, "artifact.sha256");
  const artifactByteSize = requiredPositiveSafeInteger(
    manifest.artifact.byteSize,
    "artifact.byteSize",
  );
  const artifact = await acquireArtifact({
    cacheDirectory: workspacePath(requiredOption(options, "cache-dir")),
    operatorPrincipalId: "local-fdc-inspection",
    source: workspacePath(requiredOption(options, "artifact")),
    sourceReadMode: "require-source-read",
    sourceMode: "local-test",
    tool: "nutrition-tracker-ingest/0.1.0",
    verification: {
      mode: "verified",
      expected: {
        byteSize: artifactByteSize,
        provenance: `manifest:${manifestSha256}`,
        sha256: artifactSha256,
      },
    },
  });
  const inspected = await parseFdcArtifact(
    manifest,
    artifact.path,
    workspacePath(requiredOption(options, "extract-dir")),
  );
  const metrics = fdcMetrics(inspected.parsed);
  const semanticEvidence = fdcSemanticEvidence(inspected.parsed);
  const baseline = fdcParserBaselineEvidence(metrics, semanticEvidence);
  const baselineMismatches = fdcParserBaselineMismatches(manifest, baseline);
  const inspection = {
    archive: fdcArchiveEvidence(manifest, inspected.member),
    baseline,
    baselineReview: {
      kind: "non-qualifying-local-baseline-comparison-v1",
      manifestExpectationsMatched: baselineMismatches.length === 0,
      mismatches: baselineMismatches,
      qualifiesAsAcquisitionOrApprovalEvidence: false,
      status: baselineMismatches.length === 0 ? "matched-manifest-expectations" : "review-required",
    },
    localVerification: {
      artifactByteSize,
      artifactSha256,
      kind: "non-qualifying-local-artifact-verification-v1",
      qualifiesAsAcquisitionObservation: false,
      status: "verified-against-manifest-pins",
    },
    manifestSha256,
    metrics,
    parserBuildSha256,
    parserPackage: manifest.ingestion.parserPackage,
    parserVersion: requiredManifestValue(
      manifest.ingestion.parserVersion,
      "ingestion.parserVersion",
    ),
    releaseKey: manifest.release.releaseKey,
    semanticEvidence,
  };
  if (baselineMismatches.length > 0) {
    output(io, inspection);
    throw new Error(
      `FDC inspection produced a non-qualifying baseline proposal for: ${baselineMismatches
        .map((mismatch) => mismatch.key)
        .join(", ")}`,
    );
  }
  output(io, inspection);
}

async function inspectFdcCsvCommand(
  argv: readonly string[],
  positionals: readonly string[],
  options: Readonly<Record<string, string | true>>,
  io: CommandIo,
): Promise<void> {
  assertExactFdcCsvInspectArguments(argv, positionals, options);
  const paths = await resolveFdcCsvInspectionPaths(positionals, options);
  const manifestBytes = await readFile(paths.manifest);
  const manifest = parseFoodSourceManifest(JSON.parse(manifestBytes.toString("utf8")));
  const manifestSha256 = hashBytes(manifestBytes);
  assertManifestParserIdentity(manifest);
  const contract = requireFdcCsvManifest(manifest);
  assertFdcCsvArchiveContract(manifest.validation.expectedFiles, contract.fileContracts);
  assertFdcCsvArchiveContext(contract.context);
  const parserBuildSha256 = trustedParserBuildSha256(manifest, io.environment);
  const artifactSha256 = requiredManifestValue(manifest.artifact.sha256, "artifact.sha256");
  const artifactByteSize = requiredPositiveSafeInteger(
    manifest.artifact.byteSize,
    "artifact.byteSize",
  );
  const artifact = await acquireArtifact({
    cacheDirectory: paths.cacheDirectory,
    maxBytes: FDC_CSV_MAX_ARTIFACT_BYTES,
    operatorPrincipalId: "local-fdc-csv-inspection",
    source: paths.artifact,
    sourceReadMode: "require-source-read",
    sourceMode: "local-test",
    tool: "nutrition-tracker-ingest/0.1.0",
    verification: {
      mode: "verified",
      expected: {
        byteSize: artifactByteSize,
        provenance: `manifest:${manifestSha256}`,
        sha256: artifactSha256,
      },
    },
  });
  const parsed = await parseFdcCsvArchive({
    archiveExpectation: { byteSize: artifactByteSize, sha256: artifactSha256 },
    archiveLimits: FDC_CSV_ARCHIVE_LIMITS,
    archivePath: artifact.path,
    context: contract.context,
    destinationDirectory: paths.extractionDirectory,
    expectedFiles: manifest.validation.expectedFiles,
    fileContracts: contract.fileContracts,
  });
  const baseline = fdcCsvParserBaselineEvidence(parsed);
  const baselineMismatches = fdcCsvParserBaselineMismatches(manifest, baseline);
  const inspection = {
    archive: parsed.archive,
    baseline,
    baselineReview: {
      kind: "non-qualifying-local-baseline-comparison-v1",
      manifestExpectationsMatched: baselineMismatches.length === 0,
      mismatches: baselineMismatches,
      qualifiesAsAcquisitionOrApprovalEvidence: false,
      status: baselineMismatches.length === 0 ? "matched-manifest-expectations" : "review-required",
    },
    conservation: parsed.conservation,
    exclusionReasonCounts: parsed.exclusionReasonCounts,
    gtinEvidence: parsed.gtinEvidence,
    localVerification: {
      artifactByteSize,
      artifactSha256,
      kind: "non-qualifying-local-artifact-verification-v1",
      qualifiesAsAcquisitionObservation: false,
      status: "verified-against-manifest-pins",
    },
    manifestSha256,
    metrics: parsed.metrics,
    parserBuildSha256,
    parserPackage: manifest.ingestion.parserPackage,
    parserVersion: requiredManifestValue(
      manifest.ingestion.parserVersion,
      "ingestion.parserVersion",
    ),
    processing: parsed.processing,
    releaseKey: manifest.release.releaseKey,
    reportKind: "usda-fdc-full-csv-inspection-v1",
    schemaVersion: 1,
    semanticEvidence: parsed.semanticEvidence,
    sourceMixEvidence: parsed.sourceMixEvidence,
    tableEvidenceSha256: parsed.tableEvidenceSha256,
    tables: parsed.tables,
  };
  output(io, inspection);
  if (baselineMismatches.length > 0) {
    throw new Error(
      `FDC CSV inspection produced a non-qualifying baseline proposal for: ${baselineMismatches
        .map((mismatch) => mismatch.key)
        .join(", ")}`,
    );
  }
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
  argv: readonly string[],
  positionals: readonly string[],
  options: Readonly<Record<string, string | true>>,
  io: CommandIo,
): Promise<void> {
  assertExactStageFdcArguments(argv, positionals, options);
  const actor = trustedRunnerActor(io.environment);
  const manifestPath = workspacePath(singlePositional(positionals, "manifest path"));
  const manifestBytes = await readFile(manifestPath);
  const manifestSha256 = hashBytes(manifestBytes);
  const manifest = parseFoodSourceManifest(JSON.parse(manifestBytes.toString("utf8")));
  assertImportReadyManifest(manifest);
  const parserBuildSha256 = trustedParserBuildSha256(manifest, io.environment);
  requireFdcFoundationManifest(manifest);
  const manifestObjectUri = immutableManifestObjectUri(
    requiredOption(options, "manifest-object-uri"),
    manifestSha256,
  );
  const artifact = await acquireArtifact({
    cacheDirectory: workspacePath(requiredOption(options, "cache-dir")),
    operatorPrincipalId: actor.principalId,
    source: workspacePath(requiredOption(options, "artifact")),
    sourceReadMode: "require-source-read",
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
  const { parsed } = await parseFdcArtifact(
    manifest,
    artifact.path,
    workspacePath(requiredOption(options, "extract-dir")),
  );
  const metrics = fdcMetrics(parsed);
  const semanticEvidence = fdcSemanticEvidence(parsed);
  assertFdcParserBaseline(manifest, metrics, semanticEvidence);
  const records = stagedInputs(parsed);
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
  if (
    manifest.source.code !== "USDA_FDC" ||
    manifest.artifact.mediaType !== "application/zip" ||
    manifest.validation.expectedFiles.length !== 1
  ) {
    throw new Error("This command requires a USDA FDC single-member JSON manifest");
  }
  requireExactStringArray(manifest.ingestion.dataTypes, ["Foundation"], "FDC data types");
  requireExactStringArray(manifest.ingestion.languages, ["en"], "FDC languages");
  requireExactStringArray(manifest.ingestion.markets, ["US"], "FDC markets");
  requireExactStringArray(
    manifest.ingestion.sourceIdentityFields,
    ["fdcId", "dataType"],
    "FDC source identity fields",
  );
  const member = manifest.validation.expectedFiles[0];
  if (!member?.toLowerCase().endsWith(".json")) {
    throw new Error("FDC manifest must select exactly one JSON archive member");
  }
}

interface FdcCsvManifestContract {
  readonly context: FdcCsvArchiveContext;
  readonly fileContracts: readonly FdcCsvFileContract[];
}

const FDC_CSV_DISPOSITIONS: Readonly<
  Record<string, Pick<FdcCsvFileContract, "referenceOnlyReason" | "role">>
> = Object.freeze({
  "adapter-input:food-v1": Object.freeze({ role: "food", referenceOnlyReason: null }),
  "adapter-input:branded-food-v1": Object.freeze({
    role: "branded-food",
    referenceOnlyReason: null,
  }),
  "adapter-input:food-nutrient-v1": Object.freeze({
    role: "food-nutrient",
    referenceOnlyReason: null,
  }),
  "adapter-input:nutrient-v1": Object.freeze({ role: "nutrient", referenceOnlyReason: null }),
  "adapter-input:food-nutrient-derivation-v1": Object.freeze({
    role: "food-nutrient-derivation",
    referenceOnlyReason: null,
  }),
  "adapter-input:food-portion-v1": Object.freeze({
    role: "food-portion",
    referenceOnlyReason: null,
  }),
  "adapter-input:measure-unit-v1": Object.freeze({
    role: "measure-unit",
    referenceOnlyReason: null,
  }),
  "reference-only:unmaterialized-supporting-table-v1": Object.freeze({
    role: "reference-only",
    referenceOnlyReason: "unmaterialized-supporting-table-v1",
  }),
  "guide:publisher-documentation-v1": Object.freeze({
    role: "guide",
    referenceOnlyReason: "publisher-documentation-v1",
  }),
});

function requireFdcCsvManifest(manifest: FoodSourceManifestV3): FdcCsvManifestContract {
  if (
    manifest.source.code !== "USDA_FDC" ||
    manifest.artifact.mediaType !== "application/zip" ||
    manifest.ingestion.parserPackage !== "@nutrition-tracker/ingestion" ||
    manifest.validation.expectedFiles.length === 0
  ) {
    throw new Error("This command requires a pinned USDA FDC full-CSV ZIP manifest");
  }
  requireExactStringArray(
    manifest.ingestion.dataTypes,
    ["Foundation", "Experimental", "FNDDS", "SR Legacy", "Branded"],
    "FDC CSV data types",
  );
  requireExactStringArray(manifest.ingestion.languages, ["en"], "FDC CSV languages");
  requireExactStringArray(manifest.ingestion.markets, ["US", "NZ"], "FDC CSV markets");
  requireExactStringArray(
    manifest.ingestion.sourceIdentityFields,
    ["fdcId", "dataType"],
    "FDC CSV source identity fields",
  );
  const expected = new Set(manifest.validation.expectedFiles);
  const expectations = manifest.validation.releaseSpecificExpectations;
  const fileContracts = manifest.validation.expectedFiles.map((archivePath) => {
    const key = `${FDC_CSV_DISPOSITION_PREFIX}${archivePath}`;
    const dispositionValue = expectations[key];
    if (typeof dispositionValue !== "string") {
      throw new Error(`FDC CSV manifest is missing explicit disposition ${key}`);
    }
    if (!Object.hasOwn(FDC_CSV_DISPOSITIONS, dispositionValue)) {
      throw new Error(`FDC CSV manifest disposition is unsupported for ${archivePath}`);
    }
    const disposition = FDC_CSV_DISPOSITIONS[dispositionValue];
    if (!disposition) throw new Error(`FDC CSV manifest disposition is invalid for ${archivePath}`);
    return Object.freeze({ archivePath, ...disposition });
  });
  for (const key of Object.keys(expectations)) {
    if (!key.startsWith(FDC_CSV_DISPOSITION_PREFIX)) continue;
    const archivePath = key.slice(FDC_CSV_DISPOSITION_PREFIX.length);
    if (!expected.has(archivePath)) {
      throw new Error(`FDC CSV disposition names a file outside expectedFiles: ${archivePath}`);
    }
  }

  const defaultMarketCode = expectations[FDC_CSV_DEFAULT_MARKET_KEY];
  if (typeof defaultMarketCode !== "string") {
    throw new Error(`FDC CSV manifest requires ${FDC_CSV_DEFAULT_MARKET_KEY}`);
  }
  const dataTypeMappings = Object.create(null) as Record<string, string>;
  for (const [key, value] of Object.entries(expectations)) {
    if (!key.startsWith(FDC_CSV_DATA_TYPE_PREFIX)) continue;
    const source = key.slice(FDC_CSV_DATA_TYPE_PREFIX.length);
    if (
      source.length === 0 ||
      source.trim() !== source ||
      source.normalize("NFKC") !== source ||
      typeof value !== "string"
    ) {
      throw new Error("FDC CSV data-type mappings require normalized text keys and string values");
    }
    dataTypeMappings[source] = value;
  }
  if (Object.keys(dataTypeMappings).length === 0) {
    throw new Error("FDC CSV manifest requires at least one reviewed data-type mapping");
  }
  const marketMappings = Object.create(null) as Record<string, string>;
  for (const [key, value] of Object.entries(expectations)) {
    if (!key.startsWith(FDC_CSV_MARKET_PREFIX)) continue;
    const source = key.slice(FDC_CSV_MARKET_PREFIX.length);
    if (
      source.length === 0 ||
      source.trim() !== source ||
      source.normalize("NFKC") !== source ||
      typeof value !== "string"
    ) {
      throw new Error("FDC CSV market mappings require normalized text keys and string values");
    }
    marketMappings[source] = value;
  }
  if (Object.keys(marketMappings).length === 0) {
    throw new Error("FDC CSV manifest requires at least one reviewed branded market mapping");
  }
  return Object.freeze({
    context: Object.freeze({
      releaseKey: manifest.release.releaseKey,
      allowedDataTypes: manifest.ingestion.dataTypes,
      allowedMarketCodes: manifest.ingestion.markets,
      dataTypeMappings: Object.freeze(dataTypeMappings),
      defaultMarketCode,
      marketMappings: Object.freeze(marketMappings),
    }),
    fileContracts: Object.freeze(fileContracts),
  });
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

interface FdcMemberEvidence {
  readonly archivePath: string;
  readonly byteSize: number;
  readonly sha256: string;
}

interface ParsedFdcArtifact {
  readonly extracted: readonly ExtractedZipFile[];
  readonly member: FdcMemberEvidence;
  readonly parsed: ReturnType<typeof adaptFdcJsonRelease>;
}

async function parseFdcArtifact(
  manifest: FoodSourceManifestV3,
  archivePath: string,
  extractionDirectory: string,
): Promise<ParsedFdcArtifact> {
  const extracted = await extractZipArchive({
    archiveExpectation: {
      byteSize: requiredPositiveSafeInteger(manifest.artifact.byteSize, "artifact.byteSize"),
      sha256: requiredManifestValue(manifest.artifact.sha256, "artifact.sha256"),
    },
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
  const exact = await readExactFdcJsonMember(selected);
  return Object.freeze({
    extracted,
    member: exact.evidence,
    parsed: adaptFdcJsonRelease(JSON.parse(exact.bytes.toString("utf8")), {
      releaseKey: manifest.release.releaseKey,
    }),
  });
}

export interface ReadExactFdcMemberResult {
  readonly bytes: Buffer;
  readonly evidence: FdcMemberEvidence;
}

export async function readExactFdcJsonMember(
  file: ExtractedZipFile,
): Promise<ReadExactFdcMemberResult> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new IngestionError(
      "INVALID_ARCHIVE_ENTRY",
      "Unable to open the exact extracted FDC member for parsing",
      { path: file.archivePath },
      { cause: error },
    );
  }
  let identityEstablished = false;
  let operationFailed = false;
  let operationError: unknown;
  let result: ReadExactFdcMemberResult | undefined;
  try {
    invariant(
      Number.isSafeInteger(file.byteSize) &&
        file.byteSize >= 0 &&
        file.byteSize === file.identity.size,
      "INVALID_ARCHIVE_ENTRY",
      "FDC member size differs from extractor identity",
      { path: file.archivePath },
    );
    const before = await handle.stat();
    invariant(
      matchesFdcExtractedIdentity(before, file.identity),
      "INVALID_ARCHIVE_ENTRY",
      "Extracted FDC member changed before parsing",
      { path: file.archivePath },
    );
    const pathBefore = await lstat(file.path);
    invariant(
      matchesFdcExtractedIdentity(pathBefore, file.identity),
      "INVALID_ARCHIVE_ENTRY",
      "Extracted FDC member path changed before parsing",
      { path: file.archivePath },
    );
    identityEstablished = true;
    const bytes = Buffer.allocUnsafe(file.identity.size);
    const hash = createHash("sha256");
    let position = 0;
    while (position < bytes.byteLength) {
      const { bytesRead } = await handle.read(
        bytes,
        position,
        bytes.byteLength - position,
        position,
      );
      invariant(bytesRead > 0, "INVALID_ARCHIVE_ENTRY", "FDC exact-member read made no progress", {
        path: file.archivePath,
      });
      hash.update(bytes.subarray(position, position + bytesRead));
      position += bytesRead;
    }
    const trailing = Buffer.allocUnsafe(1);
    const trailingRead = await handle.read(trailing, 0, 1, position);
    invariant(
      trailingRead.bytesRead === 0,
      "INVALID_ARCHIVE_ENTRY",
      "FDC exact member grew while parsing",
      { path: file.archivePath },
    );
    const sha256 = hash.digest("hex");
    invariant(
      sha256 === file.identity.sha256,
      "INVALID_ARCHIVE_ENTRY",
      "Parsed FDC member content differs from extractor evidence",
      { path: file.archivePath },
    );
    result = Object.freeze({
      bytes,
      evidence: Object.freeze({
        archivePath: file.archivePath,
        byteSize: bytes.byteLength,
        sha256,
      }),
    });
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  const finalizationErrors: unknown[] = [];
  if (identityEstablished) {
    try {
      const after = await handle.stat();
      invariant(
        matchesFdcExtractedIdentity(after, file.identity),
        "INVALID_ARCHIVE_ENTRY",
        "Extracted FDC member changed while parsing",
        { path: file.archivePath },
      );
      const pathAfter = await lstat(file.path);
      invariant(
        matchesFdcExtractedIdentity(pathAfter, file.identity),
        "INVALID_ARCHIVE_ENTRY",
        "Extracted FDC member path changed while parsing",
        { path: file.archivePath },
      );
    } catch (error) {
      finalizationErrors.push(error);
    }
  }
  try {
    await handle.close();
  } catch (error) {
    finalizationErrors.push(
      new IngestionError(
        "INVALID_ARCHIVE_ENTRY",
        "Unable to close the exact extracted FDC member after parsing",
        { path: file.archivePath },
        { cause: error },
      ),
    );
  }
  if (operationFailed) {
    if (finalizationErrors.length > 0) {
      throw new AggregateError(
        [operationError, ...finalizationErrors],
        "FDC exact-member parsing failed and finalization was incomplete",
        { cause: operationError },
      );
    }
    throw operationError;
  }
  if (finalizationErrors.length === 1) throw finalizationErrors[0];
  if (finalizationErrors.length > 1) {
    throw new AggregateError(finalizationErrors, "FDC exact-member finalization failed", {
      cause: finalizationErrors[0],
    });
  }
  invariant(result, "INVALID_ARCHIVE_ENTRY", "FDC exact-member result is unavailable");
  return result;
}

function matchesFdcExtractedIdentity(
  metadata: Stats,
  identity: ExtractedZipFile["identity"],
): boolean {
  const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
  return (
    currentUid !== null &&
    metadata.isFile() &&
    !metadata.isSymbolicLink() &&
    metadata.birthtimeMs === identity.birthtimeMs &&
    metadata.ctimeMs === identity.ctimeMs &&
    metadata.dev === identity.device &&
    metadata.ino === identity.inode &&
    metadata.uid === currentUid &&
    metadata.uid === identity.uid &&
    (metadata.mode & 0o777) === identity.mode &&
    metadata.mtimeMs === identity.mtimeMs &&
    metadata.nlink === identity.nlink &&
    metadata.size === identity.size
  );
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

interface FdcArchiveEvidence {
  readonly expectedFiles: readonly string[];
  readonly inventoryCount: number;
  readonly inventorySha256: string;
  readonly memberEvidenceSha256: string;
  readonly members: readonly {
    readonly archivePath: string;
    readonly byteSize: number;
    readonly sha256: string;
  }[];
}

interface FdcEvidenceDigest {
  readonly count: number;
  readonly sha256: string;
}

interface FdcSemanticEvidence {
  readonly canonicalAcceptedRecords: FdcEvidenceDigest;
  readonly orderedDispositions: {
    readonly excludedAttributes: FdcEvidenceDigest;
    readonly excludedNutrients: FdcEvidenceDigest;
    readonly excludedPortions: FdcEvidenceDigest;
    readonly quarantined: FdcEvidenceDigest;
  };
  readonly schemaVersion: 1;
  readonly sha256: string;
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

function fdcArchiveEvidence(
  manifest: FoodSourceManifestV3,
  member: FdcMemberEvidence,
): FdcArchiveEvidence {
  const expectedFiles = Object.freeze([...manifest.validation.expectedFiles].sort());
  const members = Object.freeze([member]);
  return Object.freeze({
    expectedFiles,
    inventoryCount: expectedFiles.length,
    inventorySha256: sha256CanonicalJson(expectedFiles as unknown as JsonValue),
    memberEvidenceSha256: sha256CanonicalJson(members as unknown as JsonValue),
    members,
  });
}

function fdcSemanticEvidence(parsed: ReturnType<typeof adaptFdcJsonRelease>): FdcSemanticEvidence {
  const evidence = Object.freeze({
    canonicalAcceptedRecords: fdcEvidenceDigest(parsed.records),
    orderedDispositions: Object.freeze({
      excludedAttributes: fdcEvidenceDigest(parsed.excludedAttributes),
      excludedNutrients: fdcEvidenceDigest(parsed.excludedNutrients),
      excludedPortions: fdcEvidenceDigest(parsed.excludedPortions),
      quarantined: fdcEvidenceDigest(parsed.quarantined),
    }),
    schemaVersion: 1 as const,
  });
  return Object.freeze({
    ...evidence,
    sha256: sha256CanonicalJson(evidence as unknown as JsonValue),
  });
}

function fdcEvidenceDigest(values: readonly unknown[]): FdcEvidenceDigest {
  return Object.freeze({
    count: values.length,
    sha256: sha256CanonicalJson(values as unknown as JsonValue),
  });
}

function fdcParserBaselineEvidence(
  metrics: FdcMetrics,
  semanticEvidence: FdcSemanticEvidence,
): Readonly<Record<string, number | string>> {
  return Object.freeze({
    parserBaselineAcceptedFoodCount: metrics.records,
    parserBaselineCanonicalAcceptedRecordsDigest: semanticEvidence.canonicalAcceptedRecords.sha256,
    parserBaselineQuarantinedFoodCount: metrics.quarantined,
    parserBaselineStagedNutrientCount: metrics.stagedNutrients,
    parserBaselineExcludedNutrientCount: metrics.excludedNutrients,
    parserBaselineStagedPortionCount: metrics.stagedPortions,
    parserBaselineExcludedPortionCount: metrics.excludedPortions,
    parserBaselineExcludedAttributeCount: metrics.excludedAttributes,
    parserBaselineAcceptedPayloadDigest: metrics.sourcePayloadDigest,
    parserBaselineOrderedQuarantinedDispositionsDigest:
      semanticEvidence.orderedDispositions.quarantined.sha256,
    parserBaselineOrderedExcludedNutrientDispositionsDigest:
      semanticEvidence.orderedDispositions.excludedNutrients.sha256,
    parserBaselineOrderedExcludedPortionDispositionsDigest:
      semanticEvidence.orderedDispositions.excludedPortions.sha256,
    parserBaselineOrderedExcludedAttributeDispositionsDigest:
      semanticEvidence.orderedDispositions.excludedAttributes.sha256,
    parserBaselineSemanticEvidenceDigest: semanticEvidence.sha256,
  });
}

export function fdcCsvParserBaselineEvidence(
  parsed: FdcCsvArchiveParseResult,
): Readonly<Record<string, number | string>> {
  const baseline: Record<string, number | string> = {
    parserBaselineCsvAcceptedFoodCount: parsed.metrics.acceptedFoodCount,
    parserBaselineCsvAdapterInputDataRowCount: parsed.metrics.adapterInputDataRowCount,
    parserBaselineCsvArchiveContractDigest: parsed.archive.contractSha256,
    parserBaselineCsvArchiveInventoryDigest: parsed.archive.inventorySha256,
    parserBaselineCsvCanonicalAcceptedRecordsDigest:
      parsed.semanticEvidence.canonicalAcceptedRecords.sha256,
    parserBaselineCsvConservationDigest: sha256CanonicalJson(
      parsed.conservation as unknown as JsonValue,
    ),
    parserBaselineCsvContextDigest: parsed.contextSha256,
    parserBaselineCsvDerivedLabelServingCount: parsed.metrics.derivedLabelServingCount,
    parserBaselineCsvExcludedAttributeCount: parsed.metrics.excludedAttributeCount,
    parserBaselineCsvExcludedNutrientCount: parsed.metrics.excludedNutrientCount,
    parserBaselineCsvExcludedPortionCount: parsed.metrics.excludedPortionCount,
    parserBaselineCsvExclusionReasonCountsDigest: sha256CanonicalJson(
      parsed.exclusionReasonCounts as unknown as JsonValue,
    ),
    parserBaselineCsvGuideCount: parsed.metrics.guideCount,
    parserBaselineCsvGtinAssignmentCount: parsed.gtinEvidence.assignmentCount,
    parserBaselineCsvGtinAssignmentsDigest: parsed.gtinEvidence.assignmentsSha256,
    parserBaselineCsvGtinCollisionAssignmentCount: parsed.gtinEvidence.collisionAssignmentCount,
    parserBaselineCsvGtinCollisionCount: parsed.gtinEvidence.collisionCount,
    parserBaselineCsvGtinCollisionsDigest: parsed.gtinEvidence.collisionsSha256,
    parserBaselineCsvGtinOrdering: parsed.gtinEvidence.ordering,
    parserBaselineCsvGtinUniqueCount: parsed.gtinEvidence.uniqueCount,
    parserBaselineCsvMaximumCombinedPartitionBytes:
      parsed.processing.maximumObservedCombinedPartitionBytes,
    parserBaselineCsvMaximumCombinedPartitionRows:
      parsed.processing.maximumObservedCombinedPartitionRows,
    parserBaselineCsvMaximumPartitionBytes: parsed.processing.maximumObservedPartitionBytes,
    parserBaselineCsvMaximumPartitionRows: parsed.processing.maximumObservedPartitionRows,
    parserBaselineCsvOrderedExcludedAttributeDispositionsDigest:
      parsed.semanticEvidence.orderedDispositions.excludedAttributes.sha256,
    parserBaselineCsvOrderedExcludedNutrientDispositionsDigest:
      parsed.semanticEvidence.orderedDispositions.excludedNutrients.sha256,
    parserBaselineCsvOrderedExcludedPortionDispositionsDigest:
      parsed.semanticEvidence.orderedDispositions.excludedPortions.sha256,
    parserBaselineCsvOrderedQuarantinedFoodDispositionsDigest:
      parsed.semanticEvidence.orderedDispositions.quarantinedFoods.sha256,
    parserBaselineCsvParsedRowCount: parsed.metrics.parsedCsvRowCount,
    parserBaselineCsvPartitionAlgorithm: parsed.processing.algorithm,
    parserBaselineCsvPartitionCount: parsed.processing.partitionCount,
    parserBaselineCsvProcessingLimitsDigest: parsed.processing.limitsSha256,
    parserBaselineCsvQuarantinedFoodCount: parsed.metrics.quarantinedFoodCount,
    parserBaselineCsvReferenceOnlyDataRowCount: parsed.metrics.referenceOnlyDataRowCount,
    parserBaselineCsvSemanticOrdering: parsed.semanticEvidence.ordering,
    parserBaselineCsvSemanticEvidenceDigest: parsed.semanticEvidence.sha256,
    parserBaselineCsvSourceMixEvidenceDigest: parsed.sourceMixEvidence.sha256,
    parserBaselineCsvSpoolByteSize: parsed.processing.spoolByteSize,
    parserBaselineCsvStagedNutrientCount: parsed.metrics.stagedNutrientCount,
    parserBaselineCsvStagedPortionCount: parsed.metrics.stagedPortionCount,
    parserBaselineCsvTableEvidenceDigest: parsed.tableEvidenceSha256,
  };
  for (const table of parsed.tables) {
    const prefix = `parserBaselineCsvTable:${table.archivePath}:`;
    baseline[`${prefix}byteSize`] = table.byteSize;
    baseline[`${prefix}headerSha256`] = table.headerSha256;
    baseline[`${prefix}rawSha256`] = table.rawSha256;
    baseline[`${prefix}rowCount`] = table.rowCount;
    baseline[`${prefix}rowsSha256`] = table.rowsSha256;
  }
  return Object.freeze(baseline);
}

interface FdcParserBaselineMismatch {
  readonly actual: number | string | null;
  readonly expected: boolean | number | string | null;
  readonly issue: "mismatch" | "missing" | "unexpected";
  readonly key: string;
}

function fdcParserBaselineMismatches(
  manifest: FoodSourceManifestV3,
  actual: Readonly<Record<string, number | string>>,
): readonly FdcParserBaselineMismatch[] {
  const expected = manifest.validation.releaseSpecificExpectations;
  const mismatches: FdcParserBaselineMismatch[] = [];
  for (const [key, value] of Object.entries(actual)) {
    if (expected[key] === value) continue;
    const present = Object.hasOwn(expected, key);
    mismatches.push(
      Object.freeze({
        actual: value,
        expected: present ? (expected[key] ?? null) : null,
        issue: present ? "mismatch" : "missing",
        key,
      }),
    );
  }
  return Object.freeze(mismatches);
}

function fdcCsvParserBaselineMismatches(
  manifest: FoodSourceManifestV3,
  actual: Readonly<Record<string, number | string>>,
): readonly FdcParserBaselineMismatch[] {
  const mismatches = [...fdcParserBaselineMismatches(manifest, actual)];
  for (const [key, value] of Object.entries(manifest.validation.releaseSpecificExpectations)) {
    if (!key.startsWith("parserBaselineCsv") || Object.hasOwn(actual, key)) continue;
    mismatches.push(
      Object.freeze({ actual: null, expected: value, issue: "unexpected" as const, key }),
    );
  }
  return Object.freeze(
    mismatches.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0)),
  );
}

function assertFdcParserBaseline(
  manifest: FoodSourceManifestV3,
  metrics: FdcMetrics,
  semanticEvidence: FdcSemanticEvidence,
): void {
  const actual = fdcParserBaselineEvidence(metrics, semanticEvidence);
  const mismatch = fdcParserBaselineMismatches(manifest, actual)[0];
  if (mismatch) {
    throw new Error(
      `FDC parser baseline mismatch for ${mismatch.key}: expected ${String(mismatch.expected)}, received ${String(mismatch.actual)}`,
    );
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

function readIngestToolIdentity(): string {
  let packageMetadata: unknown;
  try {
    packageMetadata = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as unknown;
  } catch {
    throw new Error("Unable to read co-located ingest package metadata");
  }
  if (typeof packageMetadata !== "object" || packageMetadata === null) {
    throw new Error("Ingest package metadata must be an object");
  }
  const { name, version } = packageMetadata as Record<string, unknown>;
  if (
    name !== "@nutrition-tracker/ingest" ||
    typeof version !== "string" ||
    !CANONICAL_NUMERIC_PACKAGE_VERSION_PATTERN.test(version)
  ) {
    throw new Error(
      "Ingest package metadata must have the expected name and a canonical numeric version",
    );
  }
  return `${name.slice(1).replace("/", "-")}/${version}`;
}

function workspacePath(path: string): string {
  return isAbsolute(path) ? path : resolve(WORKSPACE_ROOT, path);
}

export interface FdcCsvInspectionPaths {
  readonly artifact: string;
  readonly cacheDirectory: string;
  readonly extractionDirectory: string;
  readonly manifest: string;
}

export async function resolveFdcCsvInspectionPaths(
  positionals: readonly string[],
  options: Readonly<Record<string, string | true>>,
  sourceRoot = WORKSPACE_ROOT,
): Promise<FdcCsvInspectionPaths> {
  const workspaceRoot = await realpath(sourceRoot);
  assertLinuxFilesystemPath(workspaceRoot, "FDC CSV workspace");
  const manifestCandidate = repositoryRelativePath(
    singlePositional(positionals, "manifest path"),
    "data/manifests",
    "FDC CSV manifest",
    workspaceRoot,
  );
  const artifactCandidate = repositoryRelativePath(
    requiredOption(options, "artifact"),
    ".local-data",
    "FDC CSV artifact",
    workspaceRoot,
  );
  const cacheCandidate = repositoryRelativePath(
    requiredOption(options, "cache-dir"),
    ".local-data",
    "FDC CSV cache directory",
    workspaceRoot,
  );
  const extractionCandidate = repositoryRelativePath(
    requiredOption(options, "extract-dir"),
    ".local-data",
    "FDC CSV extraction directory",
    workspaceRoot,
  );
  const manifestRoot = await trustedRepositoryDirectory(
    resolve(workspaceRoot, "data/manifests"),
    workspaceRoot,
    "FDC CSV manifest root",
    false,
  );
  const localDataRoot = await trustedRepositoryDirectory(
    resolve(workspaceRoot, ".local-data"),
    workspaceRoot,
    "FDC CSV local-data root",
    true,
  );
  const manifest = await canonicalExistingLinuxPath(
    manifestCandidate,
    manifestRoot,
    "FDC CSV manifest",
  );
  const artifact = await canonicalExistingLinuxPath(
    artifactCandidate,
    localDataRoot,
    "FDC CSV artifact",
  );
  const cacheDirectory = await canonicalFutureLinuxPath(
    cacheCandidate,
    localDataRoot,
    "FDC CSV cache directory",
  );
  const extractionDirectory = await canonicalFutureLinuxPath(
    extractionCandidate,
    localDataRoot,
    "FDC CSV extraction directory",
  );
  if (pathsOverlap(cacheDirectory, extractionDirectory)) {
    throw new Error("FDC CSV cache and extraction directories must be disjoint");
  }
  if (pathsOverlap(artifact, cacheDirectory) || pathsOverlap(artifact, extractionDirectory)) {
    throw new Error("FDC CSV artifact, cache, and extraction paths must be disjoint");
  }
  return Object.freeze({ artifact, cacheDirectory, extractionDirectory, manifest });
}

function repositoryRelativePath(
  rawPath: string,
  allowedRoot: string,
  field: string,
  workspaceRoot = WORKSPACE_ROOT,
): string {
  if (
    isAbsolute(rawPath) ||
    /^[A-Za-z]:[\\/]/u.test(rawPath) ||
    rawPath.startsWith("\\\\") ||
    rawPath.includes("\\") ||
    rawPath.includes("\0")
  ) {
    throw new Error(`${field} must be a relative Linux path inside ${allowedRoot}`);
  }
  const root = resolve(workspaceRoot, allowedRoot);
  const candidate = resolve(workspaceRoot, rawPath);
  const within = relative(root, candidate);
  if (
    within.length === 0 ||
    within === ".." ||
    within.startsWith(`..${sep}`) ||
    isAbsolute(within)
  ) {
    throw new Error(`${field} must be beneath ${allowedRoot}`);
  }
  assertLinuxFilesystemPath(candidate, field);
  return candidate;
}

async function trustedRepositoryDirectory(
  path: string,
  workspaceRoot: string,
  field: string,
  requirePrivateMode: boolean,
): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new Error(`${field} must be a real directory`, { cause: error });
  }
  try {
    const descriptor = await handle.stat();
    const pathname = await lstat(path);
    const resolved = await realpath(path);
    const currentUid = process.getuid?.();
    if (
      currentUid === undefined ||
      !descriptor.isDirectory() ||
      descriptor.isSymbolicLink() ||
      !pathname.isDirectory() ||
      pathname.isSymbolicLink() ||
      descriptor.dev !== pathname.dev ||
      descriptor.ino !== pathname.ino ||
      descriptor.uid !== currentUid ||
      pathname.uid !== currentUid ||
      resolved !== resolve(path) ||
      (requirePrivateMode && (descriptor.mode & 0o777) !== 0o700)
    ) {
      throw new Error(
        `${field} must be a real current-user-owned${requirePrivateMode ? " mode-0700" : ""} directory`,
      );
    }
    assertPathWithinWorkspace(resolved, workspaceRoot, field);
    return resolved;
  } finally {
    await handle.close();
  }
}

async function canonicalExistingLinuxPath(
  path: string,
  allowedRoot: string,
  field: string,
): Promise<string> {
  const resolved = await realpath(path);
  assertPathBeneathRoot(resolved, allowedRoot, field);
  return resolved;
}

async function canonicalFutureLinuxPath(
  path: string,
  allowedRoot: string,
  field: string,
): Promise<string> {
  let candidate = path;
  const missingSuffix: string[] = [];
  while (true) {
    try {
      const resolved = await realpath(candidate);
      assertPathBeneathRoot(resolved, allowedRoot, field);
      if (missingSuffix.length > 0) {
        const metadata = await lstat(resolved);
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
          throw new Error(`${field} has a non-directory existing ancestor`);
        }
      }
      const rebuilt = resolve(resolved, ...missingSuffix);
      assertPathBeneathRoot(rebuilt, allowedRoot, field);
      return rebuilt;
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      missingSuffix.unshift(candidate.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
      candidate = parent;
    }
  }
}

function assertPathBeneathRoot(path: string, allowedRoot: string, field: string): void {
  assertLinuxFilesystemPath(path, field);
  const within = relative(allowedRoot, path);
  if (
    within.length === 0 ||
    within === ".." ||
    within.startsWith(`..${sep}`) ||
    isAbsolute(within)
  ) {
    throw new Error(`${field} resolves outside its required repository subtree`);
  }
}

function assertPathWithinWorkspace(path: string, workspaceRoot: string, field: string): void {
  assertLinuxFilesystemPath(path, field);
  const within = relative(workspaceRoot, path);
  if (within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) {
    throw new Error(`${field} resolves outside the WSL source checkout`);
  }
}

function assertLinuxFilesystemPath(path: string, field: string): void {
  if (
    process.platform !== "linux" ||
    !path.startsWith("/") ||
    /^\/mnt\/[A-Za-z](?:\/|$)/u.test(path) ||
    /^[A-Za-z]:[\\/]/u.test(path) ||
    path.includes("\\") ||
    path.includes("\0")
  ) {
    throw new Error(`${field} must reside in the WSL Linux filesystem`);
  }
}

function pathsOverlap(left: string, right: string): boolean {
  const leftToRight = relative(left, right);
  const rightToLeft = relative(right, left);
  return (
    leftToRight.length === 0 ||
    (leftToRight !== ".." && !leftToRight.startsWith(`..${sep}`) && !isAbsolute(leftToRight)) ||
    (rightToLeft !== ".." && !rightToLeft.startsWith(`..${sep}`) && !isAbsolute(rightToLeft))
  );
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
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

function assertExactArtifactObserveArguments(
  argv: readonly string[],
  positionals: readonly string[],
  options: Readonly<Record<string, string | true>>,
): void {
  if (positionals.length !== 1 || !positionals[0]) {
    throw new Error("artifact observe requires exactly one manifest path");
  }
  const allowed = new Set(ARTIFACT_OBSERVE_OPTIONS);
  for (const name of Object.keys(options)) {
    if (!allowed.has(name)) throw new Error(`Unknown artifact observe option: --${name}`);
  }

  // parseArguments intentionally uses a plain object. Inspect raw option names too
  // so prototype-like names cannot disappear through object assignment semantics.
  const tokens = argv[0] === "--" ? argv.slice(1) : argv;
  for (const token of tokens.slice(2)) {
    if (token === "--") break;
    if (!token.startsWith("--")) continue;
    const name = token.slice(2).split("=", 1)[0];
    if (!name || !allowed.has(name)) {
      throw new Error(`Unknown artifact observe option: --${name ?? ""}`);
    }
  }
  for (const name of ARTIFACT_OBSERVE_OPTIONS) requiredOption(options, name);
}

function assertExactFdcInspectArguments(
  argv: readonly string[],
  positionals: readonly string[],
  options: Readonly<Record<string, string | true>>,
): void {
  if (positionals.length !== 1 || !positionals[0]) {
    throw new Error("fdc inspect requires exactly one manifest path");
  }
  const allowed = new Set(INSPECT_FDC_OPTIONS);
  for (const name of Object.keys(options)) {
    if (!allowed.has(name)) throw new Error(`Unknown fdc inspect option: --${name}`);
  }

  const tokens = argv[0] === "--" ? argv.slice(1) : argv;
  for (const token of tokens.slice(2)) {
    if (token === "--") break;
    if (!token.startsWith("--")) continue;
    const name = token.slice(2).split("=", 1)[0];
    if (!name || !allowed.has(name)) {
      throw new Error(`Unknown fdc inspect option: --${name ?? ""}`);
    }
  }
  for (const name of INSPECT_FDC_OPTIONS) requiredOption(options, name);
}

function assertExactFdcCsvInspectArguments(
  argv: readonly string[],
  positionals: readonly string[],
  options: Readonly<Record<string, string | true>>,
): void {
  if (positionals.length !== 1 || !positionals[0]) {
    throw new Error("fdc inspect-csv requires exactly one manifest path");
  }
  const allowed = new Set(INSPECT_FDC_CSV_OPTIONS);
  for (const name of Object.keys(options)) {
    if (!allowed.has(name)) throw new Error(`Unknown fdc inspect-csv option: --${name}`);
  }

  const tokens = argv[0] === "--" ? argv.slice(1) : argv;
  for (const token of tokens.slice(2)) {
    if (token === "--") break;
    if (!token.startsWith("--")) continue;
    const name = token.slice(2).split("=", 1)[0];
    if (!name || !allowed.has(name)) {
      throw new Error(`Unknown fdc inspect-csv option: --${name ?? ""}`);
    }
  }
  for (const name of INSPECT_FDC_CSV_OPTIONS) requiredOption(options, name);
}

function assertExactStageFdcArguments(
  argv: readonly string[],
  positionals: readonly string[],
  options: Readonly<Record<string, string | true>>,
): void {
  if (positionals.length !== 1 || !positionals[0]) {
    throw new Error("catalogue stage-fdc requires exactly one manifest path");
  }
  const allowed = new Set(STAGE_FDC_OPTIONS);
  for (const name of Object.keys(options)) {
    if (!allowed.has(name)) throw new Error(`Unknown catalogue stage-fdc option: --${name}`);
  }

  // parseArguments intentionally uses a plain object. Inspect raw option names too
  // so prototype-like names cannot disappear through object assignment semantics.
  const tokens = argv[0] === "--" ? argv.slice(1) : argv;
  for (const token of tokens.slice(2)) {
    if (token === "--") break;
    if (!token.startsWith("--")) continue;
    const name = token.slice(2).split("=", 1)[0];
    if (!name || !allowed.has(name)) {
      throw new Error(`Unknown catalogue stage-fdc option: --${name ?? ""}`);
    }
  }
  for (const name of STAGE_FDC_OPTIONS) requiredOption(options, name);
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
    "  ingest fdc inspect-csv <manifest> --artifact <zip> --cache-dir <path> --extract-dir <path>",
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
    "Authority-changing release commands derive actor identity from the trusted runner environment; command-line principal overrides are not accepted. FDC inspection is database-free and non-authority-changing but writes only the caller-selected local cache/extraction paths. Catalogue reconciliation reads PostgreSQL and writes one local evidence report; neither command grants authority or accepts an actor.",
  ].join("\n");
}
