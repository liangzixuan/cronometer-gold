import {
  advanceCatalogueValidationContextV2,
  type BatchValidationPolicy,
  beginCatalogueValidationV2,
  type CatalogueValidationContextV2,
  type CatalogueValidationTerminalReceiptV2,
  canonicalJson,
  type JsonValue,
  parseCatalogueValidationContextV2,
  parsePreparedCatalogueValidationPageV2,
  prepareCatalogueValidationPageV2,
  prepareCatalogueValidationTerminalV2,
  submitCatalogueValidationPageV2,
  submitCatalogueValidationTerminalV2,
} from "@nutrition-tracker/db";
import {
  acknowledgeCatalogueValidationPageV2,
  assertCatalogueValidationJournalContextV2,
  type CatalogueJournalHeadV2,
  type CatalogueJournalPinV2,
  type CataloguePendingValidationRequestV2,
  createCatalogueValidationJournalV2,
  finishCatalogueValidationJournalV2,
  readRetainedCatalogueValidationRequestV2,
  retainCatalogueValidationRequestV2,
} from "./catalogue-paged-journal.js";

type Database = Parameters<typeof beginCatalogueValidationV2>[0];
export interface CataloguePagedValidationFlowOptions {
  readonly workspaceRoot: string;
  readonly signal?: AbortSignal;
  /** A checkpoint is emitted before SQL submission. It is not a success receipt. */
  readonly checkpoint: (value: {
    readonly batchId: string;
    readonly phase: "page" | "terminal";
    readonly request: CatalogueJournalPinV2;
  }) => void;
}
export interface CataloguePagedValidationCompletion {
  readonly pendingTerminal: CatalogueJournalPinV2;
  readonly head: CatalogueJournalHeadV2;
  readonly receipt: CatalogueValidationTerminalReceiptV2;
}

export async function prepareAndSubmitCataloguePagedValidation(
  database: Database,
  input: {
    readonly batchId: string;
    readonly stagingSealSha256: string;
    readonly policy: BatchValidationPolicy;
  },
  options: CataloguePagedValidationFlowOptions,
): Promise<CataloguePagedValidationCompletion> {
  options.signal?.throwIfAborted();
  const context = await beginCatalogueValidationV2(database, input);
  if (context.phase !== "observing" || context.pageCount !== "0" || context.nextSequence !== "0")
    throw new Error("Existing validation requires its retained pending request for explicit retry");
  const maximum = Number(context.maximumValidationEvidenceBytes);
  if (!Number.isSafeInteger(maximum) || maximum < 1)
    throw new Error("Approved validation evidence budget exceeds the local exact counter");
  const head = await createCatalogueValidationJournalV2(
    {
      batchId: context.batchId,
      validatorDatabasePrincipal: context.validatorDatabasePrincipal,
      stagingSealSha256: context.stagingSealSha256,
      contextSha256: context.contextSha256,
      admissionSha256: context.admissionSha256,
    },
    maximum,
    options.workspaceRoot,
  );
  return continueValidation(database, context, head, options);
}

/** Verify local retained bytes before the caller creates a database connection. */
export async function readCataloguePagedValidationRetry(
  pin: CatalogueJournalPinV2,
  batchId: string,
  workspaceRoot: string,
): Promise<{
  readonly pending: CataloguePendingValidationRequestV2;
  readonly context: CatalogueValidationContextV2;
}> {
  const pending = await readRetainedCatalogueValidationRequestV2(pin, workspaceRoot);
  const context = parseCatalogueValidationContextV2(JSON.parse(pending.contextDocument));
  if (context.batchId !== batchId || context.pageCount !== String(pending.head.nextPageNumber))
    throw new Error("Retained validation context differs from requested batch or journal position");
  await assertCatalogueValidationJournalContextV2(
    pending.head,
    {
      batchId: context.batchId,
      validatorDatabasePrincipal: context.validatorDatabasePrincipal,
      stagingSealSha256: context.stagingSealSha256,
      contextSha256: context.contextSha256,
      admissionSha256: context.admissionSha256,
    },
    Number(context.maximumValidationEvidenceBytes),
    workspaceRoot,
  );
  if (pending.phase === "page") {
    const page = parsePreparedCatalogueValidationPageV2(pending.requestDocument);
    if (
      page.batchId !== batchId ||
      page.contextSha256 !== context.contextSha256 ||
      page.pageNumber !== context.pageCount
    )
      throw new Error("Retained request differs from its pre-submission context");
  } else {
    const terminal = prepareCatalogueValidationTerminalV2(context);
    if (terminal.terminalDocument !== pending.requestDocument)
      throw new Error("Retained terminal differs from its complete validation context");
  }
  return { pending, context };
}

export async function retryCataloguePagedValidation(
  database: Database,
  pin: CatalogueJournalPinV2,
  batchId: string,
  options: CataloguePagedValidationFlowOptions,
): Promise<CataloguePagedValidationCompletion> {
  const { pending, context } = await readCataloguePagedValidationRetry(
    pin,
    batchId,
    options.workspaceRoot,
  );
  options.signal?.throwIfAborted();
  options.checkpoint({ batchId, phase: pending.phase, request: pin });
  if (pending.phase === "terminal") {
    const receipt = await submitCatalogueValidationTerminalV2(database, context, {
      terminalDocument: pending.requestDocument,
      terminalRequestSha256: pending.requestSha256,
    });
    return { pendingTerminal: pin, head: pending.head, receipt };
  }
  const request = parsePreparedCatalogueValidationPageV2(pending.requestDocument);
  const receipt = await submitCatalogueValidationPageV2(database, request, context);
  const head = await acknowledgeCatalogueValidationPageV2(
    pin,
    receipt.receiptSha256,
    options.workspaceRoot,
    pending.head,
  );
  return continueValidation(
    database,
    advanceCatalogueValidationContextV2(context, request, receipt),
    head,
    options,
  );
}

/** Call only after required database cleanup. Failure preserves the exact terminal request. */
export async function publishCataloguePagedValidationCompletion(
  completion: CataloguePagedValidationCompletion,
  workspaceRoot: string,
): Promise<{
  readonly batchId: string;
  readonly validationTerminalSha256: string;
  readonly journal: CatalogueJournalPinV2;
}> {
  const journal = await finishCatalogueValidationJournalV2(
    completion.pendingTerminal,
    completion.receipt.terminalSha256,
    canonicalJson(completion.receipt as unknown as JsonValue),
    workspaceRoot,
    completion.head,
  );
  return {
    batchId: completion.receipt.batchId,
    validationTerminalSha256: completion.receipt.terminalSha256,
    journal,
  };
}

async function continueValidation(
  database: Database,
  initialContext: CatalogueValidationContextV2,
  initialHead: CatalogueJournalHeadV2,
  options: CataloguePagedValidationFlowOptions,
): Promise<CataloguePagedValidationCompletion> {
  let context = initialContext;
  let head = initialHead;
  while (context.nextSequence !== context.stagedCount) {
    options.signal?.throwIfAborted();
    const request = await prepareCatalogueValidationPageV2(database, context);
    const pin = await retainCatalogueValidationRequestV2(
      head,
      request.requestDocument,
      "page",
      options.workspaceRoot,
      canonicalJson(context as unknown as JsonValue),
    );
    options.signal?.throwIfAborted();
    options.checkpoint({ batchId: context.batchId, phase: "page", request: pin });
    const receipt = await submitCatalogueValidationPageV2(database, request, context);
    head = await acknowledgeCatalogueValidationPageV2(
      pin,
      receipt.receiptSha256,
      options.workspaceRoot,
      head,
    );
    context = advanceCatalogueValidationContextV2(context, request, receipt);
  }
  options.signal?.throwIfAborted();
  const terminal = prepareCatalogueValidationTerminalV2(context);
  const pendingTerminal = await retainCatalogueValidationRequestV2(
    head,
    terminal.terminalDocument,
    "terminal",
    options.workspaceRoot,
    canonicalJson(context as unknown as JsonValue),
  );
  options.signal?.throwIfAborted();
  options.checkpoint({ batchId: context.batchId, phase: "terminal", request: pendingTerminal });
  const receipt = await submitCatalogueValidationTerminalV2(database, context, terminal);
  return { pendingTerminal, head, receipt };
}
