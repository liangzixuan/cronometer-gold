import { createHash } from "node:crypto";
import {
  CATALOGUE_PUBLICATION_LIMIT_KEYS_V2,
  type CataloguePublicationOperationV2,
  cataloguePublicationOperationV2,
  createDatabaseFromEnvironment,
  encodeCataloguePublicationRequestV2,
  type JsonValue,
  parseCataloguePublicationRequestV2,
  readCataloguePublicationV2,
  submitCataloguePublicationRequestV2,
} from "@nutrition-tracker/db";
import { requiredOption } from "./arguments.js";
import {
  assertCatalogueValidationRequestDestination,
  readCatalogueValidationRequest,
  writeCatalogueValidationRequest,
} from "./catalogue-validation-request.js";
import { type CommandIo, runAfterRequiredCleanup } from "./run.js";

export type CataloguePublicationCommand =
  | "prepare-publication"
  | "submit-publication"
  | "read-publication";
const FIELDS = {
  admit: [
    "batchId",
    "contextSha256",
    "validationTerminalSha256",
    "reportSha256",
    "publisherPrincipal",
  ],
  begin: ["batchId", "admissionSha256"],
  materialize: [
    "batchId",
    "publicationSha256",
    "pageNumber",
    "firstSequence",
    "previousReceiptSha256",
  ],
  verify: ["batchId", "publicationSha256", "pageNumber", "firstSequence", "previousReceiptSha256"],
  finish: ["batchId", "publicationSha256", "previousReceiptSha256"],
  activate: ["batchId", "publicationSha256", "sealSha256", "expectedCurrentReleaseId", "reason"],
  rollback: ["sourceCode", "targetReleaseId", "expectedCurrentReleaseId", "reason", "requestId"],
} as const;
const PIN_OPTIONS = ["request", "request-sha256", "request-bytes", "receipt-out"];
const MAX_RETAINED_BYTES = 262_144;

export async function runCataloguePublicationCommand(
  command: CataloguePublicationCommand,
  argv: readonly string[],
  positionals: readonly string[],
  options: Readonly<Record<string, string | true>>,
  io: CommandIo,
  workspaceRoot: string,
): Promise<void> {
  if (positionals.length !== 1)
    throw new Error(
      `catalogue ${command} requires one ${command === "read-publication" ? "batch UUID" : "operation"}`,
    );
  io.signal?.throwIfAborted();
  if (command === "read-publication") {
    exactOptions(argv, options, ["authority"]);
    const batchId = positionals[0];
    if (
      !batchId ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(batchId)
    )
      throw new Error("Publication read requires canonical batch UUID");
    const authority = requiredOption(options, "authority");
    if (authority !== "publisher" && authority !== "rollback")
      throw new Error("Publication authority must be publisher or rollback");
    const database = createDatabaseFromEnvironment(io.environment);
    await runAfterRequiredCleanup(
      () => readCataloguePublicationV2(database, batchId, authority),
      () => database.destroy(),
      async (context) => {
        io.signal?.throwIfAborted();
        output(io, context);
      },
    );
    return;
  }
  const operation = cataloguePublicationOperationV2(positionals[0]);
  if (command === "prepare-publication") {
    const fields: readonly string[] = FIELDS[operation];
    const limits = operation === "admit" ? CATALOGUE_PUBLICATION_LIMIT_KEYS_V2 : [];
    exactOptions(argv, options, [
      ...fields.map(optionName),
      ...limits.map(optionName),
      "request-out",
    ]);
    const request: Record<string, JsonValue> = { schemaVersion: 2 };
    for (const field of fields) {
      const value = requiredOption(options, optionName(field));
      request[field] =
        (field === "targetReleaseId" || field === "expectedCurrentReleaseId") && value === "none"
          ? null
          : value;
    }
    if (operation === "admit")
      request.limits = Object.fromEntries(
        limits.map((field) => [field, requiredOption(options, optionName(field))]),
      );
    const requestDocument = encodeCataloguePublicationRequestV2(operation, request);
    const envelope = {
      schemaVersion: 2,
      kind: "catalogue-publication-request",
      operation,
      requestDocument,
      requestSha256: sha256(requestDocument),
    };
    const pin = await writeCatalogueValidationRequest(
      requiredOption(options, "request-out"),
      envelope,
      workspaceRoot,
    );
    io.signal?.throwIfAborted();
    output(io, {
      schemaVersion: 2,
      operation,
      request: pin,
      requestSha256: envelope.requestSha256,
    });
    return;
  }
  exactOptions(argv, options, PIN_OPTIONS);
  const byteSize = requiredOption(options, "request-bytes");
  if (!/^[1-9][0-9]{0,5}$/u.test(byteSize) || Number(byteSize) > MAX_RETAINED_BYTES)
    throw new Error("Publication request pin exceeds byte limit");
  const envelope = await readCatalogueValidationRequest(
    requiredOption(options, "request"),
    {
      sha256: requiredOption(options, "request-sha256"),
      byteSize: Number(byteSize),
    },
    workspaceRoot,
  );
  const document = retainedPublicationDocument(operation, envelope);
  const receiptOut = requiredOption(options, "receipt-out");
  await assertCatalogueValidationRequestDestination(receiptOut, workspaceRoot);
  io.signal?.throwIfAborted();
  const database = createDatabaseFromEnvironment(io.environment);
  await runAfterRequiredCleanup(
    async () => {
      io.signal?.throwIfAborted();
      return submitCataloguePublicationRequestV2(database, operation, document, io.signal);
    },
    () => database.destroy(),
    async (receipt) => {
      io.signal?.throwIfAborted();
      const pin = await writeCatalogueValidationRequest(
        receiptOut,
        {
          schemaVersion: 2,
          kind: "catalogue-publication-receipt",
          operation,
          requestSha256: sha256(document),
          receipt,
        },
        workspaceRoot,
      );
      io.signal?.throwIfAborted();
      output(io, {
        schemaVersion: 2,
        operation,
        receipt: pin,
        receiptSha256: receipt.receiptSha256,
      });
    },
  );
}

export function retainedPublicationDocument(
  operation: CataloguePublicationOperationV2,
  value: unknown,
): string {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid retained publication request");
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).sort().join("\0") !==
      ["schemaVersion", "kind", "operation", "requestDocument", "requestSha256"]
        .sort()
        .join("\0") ||
    row.schemaVersion !== 2 ||
    row.kind !== "catalogue-publication-request" ||
    row.operation !== operation ||
    typeof row.requestDocument !== "string" ||
    row.requestSha256 !== sha256(row.requestDocument)
  )
    throw new Error("Retained publication request binding differs");
  parseCataloguePublicationRequestV2(operation, row.requestDocument);
  return row.requestDocument;
}
function exactOptions(
  argv: readonly string[],
  options: Readonly<Record<string, string | true>>,
  allowed: readonly string[],
): void {
  for (const token of argv[0] === "--" ? argv.slice(1) : argv) {
    if (token.startsWith("--") && !allowed.includes(token.slice(2).split("=", 1)[0] ?? ""))
      throw new Error(`Unknown publication option: ${token.split("=", 1)[0]}`);
  }
  for (const key of Object.keys(options))
    if (!allowed.includes(key)) throw new Error(`Unknown publication option: --${key}`);
  for (const key of allowed) requiredOption(options, key);
}
function optionName(field: string): string {
  return field.replace(/[A-Z]/gu, (character) => `-${character.toLowerCase()}`);
}
function sha256(document: string): string {
  return createHash("sha256").update(document, "utf8").digest("hex");
}
function output(io: CommandIo, value: unknown): void {
  io.writeOutput(`${JSON.stringify(value, null, 2)}\n`);
}
