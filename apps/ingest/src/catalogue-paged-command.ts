import {
  createDatabaseFromEnvironment,
  type JsonValue,
  readCataloguePagedReconciliationPage,
  reconcileCataloguePagedBatch,
  type SubmitCataloguePagedApprovalInput,
  submitCataloguePagedApproval,
  validateCatalogueValidationPolicy,
} from "@nutrition-tracker/db";
import { requiredOption } from "./arguments.js";
import {
  type CatalogueJournalPinV2,
  readCatalogueValidationJournalIdentityV2,
  readCatalogueValidationJournalV2,
} from "./catalogue-paged-journal.js";
import { createCataloguePagedReportSink } from "./catalogue-paged-report.js";
import {
  prepareAndSubmitCataloguePagedValidation,
  publishCataloguePagedValidationCompletion,
  readCataloguePagedValidationRetry,
  retryCataloguePagedValidation,
} from "./catalogue-paged-validation-flow.js";
import {
  assertCatalogueValidationRequestDestination,
  readCatalogueValidationRequest,
  writeCatalogueValidationRequest,
} from "./catalogue-validation-request.js";
import { type CommandIo, runAfterRequiredCleanup } from "./run.js";

const POLICY_OPTIONS = [
  "maximum-excluded-nutrient-fraction",
  "maximum-quarantine-fraction",
  "maximum-quarantined-records",
  "require-distinct-approval-principals",
  "require-at-least-one-valid-record",
  "require-materialized-nutrient-per-valid-record",
] as const;
const PIN_OPTIONS = ["request", "request-sha256", "request-bytes"] as const;
const APPROVAL_OPTIONS = [
  "role",
  "external-principal-id",
  "manifest-sha256",
  "validation-terminal-sha256",
  "report-sha256",
  "context-sha256",
  "approval-reference",
] as const;
const OPTIONS = {
  "validate-paged": ["staging-seal-sha256", ...POLICY_OPTIONS],
  "retry-paged-validation": PIN_OPTIONS,
  "reconcile-paged": [
    ...PIN_OPTIONS,
    "validation-terminal-sha256",
    "expected-current-release-id",
    "external-principal-id",
  ],
  "prepare-paged-approval": [...APPROVAL_OPTIONS, "request-out"],
  "submit-paged-approval": PIN_OPTIONS,
  "read-paged-report": [
    "role",
    "external-principal-id",
    "report-sha256",
    "page-number",
    "page-out",
  ],
} as const;
export type CataloguePagedCommand = keyof typeof OPTIONS;

export async function runCataloguePagedCommand(
  command: CataloguePagedCommand,
  argv: readonly string[],
  positionals: readonly string[],
  options: Readonly<Record<string, string | true>>,
  io: CommandIo,
  workspaceRoot: string,
): Promise<void> {
  const allowed: readonly string[] = OPTIONS[command];
  for (const token of argv[0] === "--" ? argv.slice(1) : argv) {
    if (token.startsWith("--") && !allowed.includes(token.slice(2).split("=", 1)[0] ?? ""))
      throw new Error(`Unknown catalogue ${command} option: ${token.split("=", 1)[0]}`);
  }
  for (const key of Object.keys(options))
    if (!allowed.includes(key)) throw new Error(`Unknown catalogue ${command} option: --${key}`);
  for (const key of allowed) requiredOption(options, key);
  if (positionals.length !== 1)
    throw new Error(`catalogue ${command} requires exactly one batch UUID`);
  const batchId = uuid(positionals[0]);
  io.signal?.throwIfAborted();
  const checkpoint = (value: unknown) =>
    io.writeOutput(`${JSON.stringify({ kind: "retained-validation-checkpoint-v2", value })}\n`);

  if (command === "validate-paged") {
    const stagingSealSha256 = digest(requiredOption(options, "staging-seal-sha256"));
    const policy = validateCatalogueValidationPolicy({
      maximumExcludedNutrientFraction: fraction(options, "maximum-excluded-nutrient-fraction"),
      maximumQuarantineFraction: fraction(options, "maximum-quarantine-fraction"),
      maximumQuarantinedRecords: count(
        requiredOption(options, "maximum-quarantined-records"),
        false,
      ),
      requireDistinctApprovalPrincipals: explicitTrue(
        options,
        "require-distinct-approval-principals",
      ),
      requireAtLeastOneValidRecord: explicitTrue(options, "require-at-least-one-valid-record"),
      requireMaterializedNutrientPerValidRecord: explicitTrue(
        options,
        "require-materialized-nutrient-per-valid-record",
      ),
    });
    const database = createDatabaseFromEnvironment(io.environment);
    await runAfterRequiredCleanup(
      () =>
        prepareAndSubmitCataloguePagedValidation(
          database,
          { batchId, stagingSealSha256, policy },
          { workspaceRoot, checkpoint, ...(io.signal ? { signal: io.signal } : {}) },
        ),
      () => database.destroy(),
      async (completion) =>
        output(io, await publishCataloguePagedValidationCompletion(completion, workspaceRoot)),
    );
    return;
  }
  if (command === "retry-paged-validation") {
    const request = requestPin(options);
    await readCataloguePagedValidationRetry(request, batchId, workspaceRoot);
    io.signal?.throwIfAborted();
    const database = createDatabaseFromEnvironment(io.environment);
    await runAfterRequiredCleanup(
      () =>
        retryCataloguePagedValidation(database, request, batchId, {
          workspaceRoot,
          checkpoint,
          ...(io.signal ? { signal: io.signal } : {}),
        }),
      () => database.destroy(),
      async (completion) =>
        output(io, await publishCataloguePagedValidationCompletion(completion, workspaceRoot)),
    );
    return;
  }
  if (command === "reconcile-paged") {
    const request = requestPin(options);
    const validationTerminalSha256 = digest(requiredOption(options, "validation-terminal-sha256"));
    const current = requiredOption(options, "expected-current-release-id");
    const expectedCurrentReleaseId = current === "none" ? null : uuid(current);
    const principalId = principal(requiredOption(options, "external-principal-id"));
    const binding = await readCatalogueValidationJournalIdentityV2(
      request,
      batchId,
      validationTerminalSha256,
      workspaceRoot,
    );
    if (binding.validatorDatabasePrincipal !== principalId)
      throw new Error("Reconciliation principal differs from retained validation");
    let sink: ReturnType<typeof createCataloguePagedReportSink> | undefined;
    const database = createDatabaseFromEnvironment(io.environment);
    await runAfterRequiredCleanup(
      () =>
        reconcileCataloguePagedBatch(
          database,
          { batchId, validationTerminalSha256, expectedCurrentReleaseId, principalId },
          {
            validationPages: readCatalogueValidationJournalV2(
              request,
              { binding, validationTerminalSha256 },
              workspaceRoot,
            ),
            admitEvidenceBudget: (maximumBytes) => {
              if (sink) throw new Error("Report admission was supplied twice");
              sink = createCataloguePagedReportSink({
                batchId,
                maximumEvidenceBytes: count(maximumBytes, true),
                workspaceRoot,
              });
            },
            consumePage: async (page) => {
              if (!sink) throw new Error("Report has no verified evidence admission");
              await sink.consumePage(page);
            },
            ...(io.signal ? { signal: io.signal } : {}),
          },
        ),
      () => database.destroy(),
      async (terminal) => {
        if (!sink) throw new Error("Report has no verified evidence admission");
        io.signal?.throwIfAborted();
        const report = await sink.publishTerminal(terminal);
        output(io, { batchId, terminal, report });
      },
    );
    return;
  }
  if (command === "prepare-paged-approval") {
    const request = approval({
      batchId,
      approvalRole: requiredOption(options, "role"),
      principalId: requiredOption(options, "external-principal-id"),
      rightsManifestSha256: requiredOption(options, "manifest-sha256"),
      validationTerminalSha256: requiredOption(options, "validation-terminal-sha256"),
      reportSha256: requiredOption(options, "report-sha256"),
      contextSha256: requiredOption(options, "context-sha256"),
      approvalReference: requiredOption(options, "approval-reference"),
    });
    const path = requiredOption(options, "request-out");
    await assertCatalogueValidationRequestDestination(path, workspaceRoot);
    const file = await writeCatalogueValidationRequest(
      path,
      request as unknown as JsonValue,
      workspaceRoot,
    );
    output(io, { batchId, request: file, approvalRole: request.approvalRole });
    return;
  }
  if (command === "submit-paged-approval") {
    const file = requestPin(options);
    if (file.byteSize > 16384) throw new Error("Approval request exceeds its byte bound");
    const request = approval(await readCatalogueValidationRequest(file.path, file, workspaceRoot));
    if (request.batchId !== batchId) throw new Error("Retained approval belongs to another batch");
    io.signal?.throwIfAborted();
    const database = createDatabaseFromEnvironment(io.environment);
    await runAfterRequiredCleanup(
      () => submitCataloguePagedApproval(database, request),
      () => database.destroy(),
      async (receipt) => output(io, { batchId, request: file, receipt }),
    );
    return;
  }
  const approvalRole = role(requiredOption(options, "role"));
  const principalId = principal(requiredOption(options, "external-principal-id"));
  const reportSha256 = digest(requiredOption(options, "report-sha256"));
  const pageNumber = String(count(requiredOption(options, "page-number"), true));
  const pageOut = requiredOption(options, "page-out");
  await assertCatalogueValidationRequestDestination(pageOut, workspaceRoot);
  const database = createDatabaseFromEnvironment(io.environment);
  await runAfterRequiredCleanup(
    () =>
      readCataloguePagedReconciliationPage(database, {
        batchId,
        approvalRole,
        principalId,
        reportSha256,
        pageNumber,
      }),
    () => database.destroy(),
    async (page) => {
      io.signal?.throwIfAborted();
      const file = await writeCatalogueValidationRequest(
        pageOut,
        page as unknown as JsonValue,
        workspaceRoot,
      );
      output(io, { batchId, pageNumber, reportSha256, file });
    },
  );
}

function approval(value: unknown): SubmitCataloguePagedApprovalInput {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Approval request object required");
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).sort().join() !==
    [
      "batchId",
      "approvalRole",
      "principalId",
      "rightsManifestSha256",
      "validationTerminalSha256",
      "reportSha256",
      "contextSha256",
      "approvalReference",
    ]
      .sort()
      .join()
  )
    throw new Error("Approval request fields differ");
  uuid(row.batchId);
  role(row.approvalRole);
  principal(row.principalId);
  for (const key of [
    "rightsManifestSha256",
    "validationTerminalSha256",
    "reportSha256",
    "contextSha256",
  ])
    digest(row[key]);
  if (
    typeof row.approvalReference !== "string" ||
    row.approvalReference.trim() !== row.approvalReference ||
    !row.approvalReference ||
    Buffer.byteLength(row.approvalReference) > 2048 ||
    [...row.approvalReference].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new Error("Invalid explicit approval reference");
  return row as unknown as SubmitCataloguePagedApprovalInput;
}
function requestPin(options: Readonly<Record<string, string | true>>): CatalogueJournalPinV2 {
  return {
    path: requiredOption(options, "request"),
    sha256: digest(requiredOption(options, "request-sha256")),
    byteSize: count(requiredOption(options, "request-bytes"), true),
  };
}
function uuid(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
  )
    throw new Error("Canonical lowercase batch UUID required");
  return value;
}
function digest(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value))
    throw new Error("Lowercase SHA-256 required");
  return value;
}
function principal(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z][-a-z0-9._:@/]{2,62}$/u.test(value))
    throw new Error("Explicit database principal required");
  return value;
}
function role(value: unknown): "data" | "quality" | "rights" {
  if (value !== "data" && value !== "quality" && value !== "rights")
    throw new Error("Explicit reviewer role required");
  return value;
}
function count(value: string, positive: boolean): number {
  const parsed = Number(value);
  if (
    !/^(?:0|[1-9][0-9]*)$/u.test(value) ||
    !Number.isSafeInteger(parsed) ||
    (positive && parsed < 1)
  )
    throw new Error("Exact bounded unsigned count required");
  return parsed;
}
function fraction(options: Readonly<Record<string, string | true>>, key: string): number {
  const value = requiredOption(options, key);
  if (!/^(?:0(?:\.[0-9]+)?|1(?:\.0+)?)$/u.test(value))
    throw new Error(`--${key} requires a fraction between zero and one`);
  return Number(value);
}
function explicitTrue(options: Readonly<Record<string, string | true>>, key: string): true {
  if (requiredOption(options, key) !== "true") throw new Error(`--${key} must explicitly be true`);
  return true;
}
function output(io: CommandIo, value: unknown): void {
  io.writeOutput(`${JSON.stringify(value, null, 2)}\n`);
}
