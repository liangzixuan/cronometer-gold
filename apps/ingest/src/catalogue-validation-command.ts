import {
  createDatabaseFromEnvironment,
  type JsonValue,
  parsePreparedCatalogueValidationRequest,
  prepareCatalogueValidation,
  submitCatalogueValidation,
  validateCatalogueValidationPolicy,
} from "@nutrition-tracker/db";

import { requiredOption } from "./arguments.js";
import {
  assertCatalogueValidationRequestDestination,
  catalogueValidationRequestPath,
  readCatalogueValidationRequest,
  writeCatalogueValidationRequest,
} from "./catalogue-validation-request.js";
import { type CommandIo, runAfterRequiredCleanup } from "./run.js";

const PREPARE_OPTIONS = [
  "staging-seal-sha256",
  "nutrient-mapping-sha256",
  "maximum-excluded-nutrient-fraction",
  "maximum-quarantine-fraction",
  "maximum-quarantined-records",
  "require-distinct-approval-principals",
  "require-at-least-one-valid-record",
  "require-materialized-nutrient-per-valid-record",
  "request-out",
] as const;
const SUBMIT_OPTIONS = ["request", "request-sha256", "request-bytes"] as const;

export async function runCatalogueValidationCommand(
  command: "prepare-validation" | "submit-validation",
  argv: readonly string[],
  positionals: readonly string[],
  options: Readonly<Record<string, string | true>>,
  io: CommandIo,
  workspaceRoot: string,
): Promise<void> {
  const allowed = command === "prepare-validation" ? PREPARE_OPTIONS : SUBMIT_OPTIONS;
  for (const token of argv[0] === "--" ? argv.slice(1) : argv) {
    if (!token.startsWith("--")) continue;
    const name = token.slice(2).split("=", 1)[0] ?? "";
    if (!(allowed as readonly string[]).includes(name)) {
      throw new Error(`Unknown catalogue ${command} option: --${name}`);
    }
  }
  for (const name of Object.keys(options)) {
    if (!(allowed as readonly string[]).includes(name)) {
      throw new Error(`Unknown catalogue ${command} option: --${name}`);
    }
  }
  for (const name of allowed) requiredOption(options, name);
  const batchId = positionals[0];
  if (
    positionals.length !== 1 ||
    !batchId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(batchId)
  )
    throw new Error(`catalogue ${command} requires exactly one canonical lowercase batch UUID`);
  io.signal?.throwIfAborted();

  if (command === "prepare-validation") {
    const expectedStagingSealSha256 = sha256Option(options, "staging-seal-sha256");
    const expectedNutrientMappingDigest = sha256Option(options, "nutrient-mapping-sha256");
    const policy = validateCatalogueValidationPolicy({
      maximumExcludedNutrientFraction: fractionOption(
        options,
        "maximum-excluded-nutrient-fraction",
      ),
      maximumQuarantineFraction: fractionOption(options, "maximum-quarantine-fraction"),
      maximumQuarantinedRecords: integerOption(options, "maximum-quarantined-records", false),
      requireDistinctApprovalPrincipals: trueOption(
        options,
        "require-distinct-approval-principals",
      ),
      requireAtLeastOneValidRecord: trueOption(options, "require-at-least-one-valid-record"),
      requireMaterializedNutrientPerValidRecord: trueOption(
        options,
        "require-materialized-nutrient-per-valid-record",
      ),
    });
    const requestOut = requiredOption(options, "request-out");
    await assertCatalogueValidationRequestDestination(requestOut, workspaceRoot);
    const db = createDatabaseFromEnvironment(io.environment);
    await runAfterRequiredCleanup(
      () =>
        prepareCatalogueValidation(db, {
          batchId,
          expectedStagingSealSha256,
          expectedNutrientMappingDigest,
          policy,
        }),
      () => db.destroy(),
      async (prepared) => {
        io.signal?.throwIfAborted();
        const request = await writeCatalogueValidationRequest(
          requestOut,
          prepared as unknown as JsonValue,
          workspaceRoot,
        );
        io.writeOutput(
          `${JSON.stringify(
            {
              batchId,
              request,
              validationDigest: prepared.validationDigest,
              validatorDatabasePrincipal: prepared.validatorDatabasePrincipal,
            },
            null,
            2,
          )}\n`,
        );
      },
    );
    return;
  }

  const path = requiredOption(options, "request");
  catalogueValidationRequestPath(path, workspaceRoot);
  const requestSha256 = sha256Option(options, "request-sha256");
  const requestBytes = integerOption(options, "request-bytes", true);
  const request = parsePreparedCatalogueValidationRequest(
    await readCatalogueValidationRequest(
      path,
      { sha256: requestSha256, byteSize: requestBytes },
      workspaceRoot,
    ),
  );
  if (request.batchId !== batchId) throw new Error("Validation request belongs to another batch");
  io.signal?.throwIfAborted();
  const db = createDatabaseFromEnvironment(io.environment);
  await runAfterRequiredCleanup(
    () => submitCatalogueValidation(db, request),
    () => db.destroy(),
    async (validation) => {
      io.writeOutput(`${JSON.stringify({ batchId, requestSha256, validation }, null, 2)}\n`);
    },
  );
}

function sha256Option(options: Readonly<Record<string, string | true>>, name: string): string {
  const value = requiredOption(options, name);
  if (!/^[0-9a-f]{64}$/u.test(value))
    throw new Error(`--${name} requires a lowercase SHA-256 digest`);
  return value;
}

function integerOption(
  options: Readonly<Record<string, string | true>>,
  name: string,
  positive: boolean,
): number {
  const value = requiredOption(options, name);
  const number = Number(value);
  if (
    !/^(?:0|[1-9][0-9]*)$/u.test(value) ||
    !Number.isSafeInteger(number) ||
    (positive && number === 0)
  ) {
    throw new Error(
      `--${name} requires a canonical ${positive ? "positive" : "non-negative"} safe integer`,
    );
  }
  return number;
}

function fractionOption(options: Readonly<Record<string, string | true>>, name: string): number {
  const value = requiredOption(options, name);
  if (!/^(?:0(?:\.[0-9]+)?|1(?:\.0+)?)$/u.test(value)) {
    throw new Error(`--${name} requires an explicit decimal fraction between zero and one`);
  }
  return Number(value);
}

function trueOption(options: Readonly<Record<string, string | true>>, name: string): true {
  if (requiredOption(options, name) !== "true") {
    throw new Error(`--${name} must explicitly be true in this bounded validation lane`);
  }
  return true;
}
