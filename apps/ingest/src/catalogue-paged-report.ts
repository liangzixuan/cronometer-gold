import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import {
  type CataloguePagedReconciliationPage,
  type CataloguePagedReconciliationTerminal,
  canonicalJsonChunks,
  catalogueFramedSha256V2,
  type JsonValue,
  parseCataloguePagedReconciliationPage,
  parseCataloguePagedReconciliationTerminal,
} from "@nutrition-tracker/db";
import {
  type CatalogueValidationRequestFile,
  catalogueValidationRequestPath,
  readCatalogueValidationRequest,
  writeCatalogueValidationRequest,
} from "./catalogue-validation-request.js";

type Pin = CatalogueValidationRequestFile;
const ROOT = ".local-data/evidence/catalogue-validation";
const MAX_PAGE_FILE = 32 * 1024 * 1024 + 65536;
interface ReportPageFile {
  readonly schemaVersion: 3;
  readonly kind: "catalogue-reconciliation-page-file-v3";
  readonly previous: Pin | null;
  readonly page: CataloguePagedReconciliationPage;
}

/** Private pages are provisional until a separately published, complete terminal identifies them. */
export function createCataloguePagedReportSink(input: {
  readonly batchId: string;
  readonly maximumEvidenceBytes: number;
  readonly workspaceRoot: string;
}) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      input.batchId,
    ) ||
    !Number.isSafeInteger(input.maximumEvidenceBytes) ||
    input.maximumEvidenceBytes < 1
  )
    throw new Error("Invalid private report identity or evidence budget");
  let last: Pin | null = null;
  let context: string | null = null;
  let commitment: string | null = null;
  let count = 0;
  let bytes = 0;
  let complete = false;
  let busy = false;
  let finalized = false;
  return {
    async consumePage(value: CataloguePagedReconciliationPage): Promise<void> {
      if (busy || complete || finalized) throw new Error("Report sink cannot accept this page now");
      busy = true;
      try {
        const page = parseCataloguePagedReconciliationPage(value);
        if (
          page.batchId !== input.batchId ||
          page.pageNumber !== String(count + 1) ||
          (context !== null && page.contextSha256 !== context) ||
          page.previousCommitmentSha256 !==
            (commitment ??
              catalogueFramedSha256V2("reconciliation-start", [input.batchId, page.contextSha256]))
        )
          throw new Error("Report page differs from the ordered private stream");
        if (count === 0 && page.stream !== "metadata")
          throw new Error("Report requires metadata first");
        const document: ReportPageFile = {
          schemaVersion: 3,
          kind: "catalogue-reconciliation-page-file-v3",
          previous: last,
          page,
        };
        const pin = expectedPin(pagePath(input.batchId, count + 1), document);
        if (pin.byteSize > MAX_PAGE_FILE)
          throw new Error("Private report page exceeds its byte bound");
        budget(bytes + pin.byteSize, input.maximumEvidenceBytes);
        await publishExact(pin, document, input.workspaceRoot);
        last = pin;
        context = page.contextSha256;
        commitment = page.commitmentSha256;
        count += 1;
        bytes += pin.byteSize;
        complete = page.complete;
      } finally {
        busy = false;
      }
    },
    /** Invoke after required database cleanup; reread every immutable page before publication. */
    async publishTerminal(value: CataloguePagedReconciliationTerminal): Promise<Pin> {
      if (busy) throw new Error("Private report is still writing");
      busy = true;
      try {
        const terminal = parseCataloguePagedReconciliationTerminal(value);
        if (
          !complete ||
          !last ||
          terminal.batchId !== input.batchId ||
          terminal.contextSha256 !== context ||
          terminal.pageCount !== String(count) ||
          terminal.pageCommitmentSha256 !== commitment
        )
          throw new Error("Private report is incomplete or differs from its SQL terminal");
        let cursor: Pin | null = last;
        let number = count;
        let expectedCommitment = terminal.pageCommitmentSha256;
        let rereadBytes = 0;
        while (cursor) {
          if (cursor.byteSize > MAX_PAGE_FILE || cursor.path !== pagePath(input.batchId, number))
            throw new Error("Private report file is outside its ordered bounds");
          const document = (await readCatalogueValidationRequest(
            cursor.path,
            cursor,
            input.workspaceRoot,
          )) as unknown as ReportPageFile;
          if (
            document?.schemaVersion !== 3 ||
            document.kind !== "catalogue-reconciliation-page-file-v3" ||
            Object.keys(document).sort().join() !==
              ["schemaVersion", "kind", "previous", "page"].sort().join()
          )
            throw new Error("Invalid private report page envelope");
          const page = parseCataloguePagedReconciliationPage(document.page);
          if (
            page.batchId !== input.batchId ||
            page.contextSha256 !== context ||
            page.pageNumber !== String(number) ||
            page.commitmentSha256 !== expectedCommitment ||
            page.complete !== (number === count)
          )
            throw new Error("Retained report page differs from its terminal");
          if (document.previous !== null) validatePin(document.previous);
          rereadBytes += cursor.byteSize;
          budget(rereadBytes, input.maximumEvidenceBytes);
          expectedCommitment = page.previousCommitmentSha256;
          cursor = document.previous;
          number -= 1;
          if (number < 0) throw new Error("Private report history exceeds count");
        }
        if (
          number !== 0 ||
          rereadBytes !== bytes ||
          expectedCommitment !==
            catalogueFramedSha256V2("reconciliation-start", [input.batchId, context])
        )
          throw new Error("Private report history is incomplete");
        const document = {
          schemaVersion: 3,
          kind: "catalogue-reconciliation-terminal-file-v3",
          terminal,
          lastPage: last,
          pageEvidenceBytes: bytes,
        };
        const pin = expectedPin(`${ROOT}/paged-report-${input.batchId}-terminal.json`, document);
        budget(bytes + pin.byteSize, input.maximumEvidenceBytes);
        await publishExact(pin, document, input.workspaceRoot);
        finalized = true;
        return pin;
      } finally {
        busy = false;
      }
    },
  };
}

function validatePin(value: Pin): void {
  if (
    !value ||
    Object.keys(value).sort().join() !== ["path", "sha256", "byteSize"].sort().join() ||
    typeof value.path !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.sha256) ||
    !Number.isSafeInteger(value.byteSize) ||
    value.byteSize < 1 ||
    value.byteSize > MAX_PAGE_FILE
  )
    throw new Error("Invalid private report file pin");
}
function pagePath(batchId: string, number: number): string {
  return `${ROOT}/paged-report-${batchId}-p${String(number).padStart(16, "0")}.json`;
}
function expectedPin(path: string, document: unknown): Pin {
  const digest = createHash("sha256");
  let byteSize = 1;
  for (const chunk of canonicalJsonChunks(document as JsonValue)) {
    digest.update(chunk);
    byteSize += Buffer.byteLength(chunk);
  }
  digest.update("\n");
  return { path, byteSize, sha256: digest.digest("hex") };
}
async function publishExact(pin: Pin, document: unknown, root: string): Promise<void> {
  try {
    await lstat(catalogueValidationRequestPath(pin.path, root));
    await readCatalogueValidationRequest(pin.path, pin, root);
    return;
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "ENOENT"
    )
      throw error;
  }
  const result = await writeCatalogueValidationRequest(pin.path, document as JsonValue, root);
  if (result.sha256 !== pin.sha256 || result.byteSize !== pin.byteSize || result.path !== pin.path)
    throw new Error("Private report publication differs from expected bytes");
}
function budget(used: number, maximum: number): void {
  if (!Number.isSafeInteger(used) || used > maximum)
    throw new Error("Private report evidence budget exhausted");
}
