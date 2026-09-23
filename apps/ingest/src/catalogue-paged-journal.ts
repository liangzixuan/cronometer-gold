import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { canonicalJsonChunks, type JsonValue } from "@nutrition-tracker/db/canonical-json";
import {
  type CatalogueValidationRequestFile,
  catalogueValidationRequestPath,
  readCatalogueValidationRequest,
  writeCatalogueValidationRequest,
} from "./catalogue-validation-request.js";

export type CatalogueJournalPinV2 = CatalogueValidationRequestFile;
const ROOT = ".local-data/evidence/catalogue-validation";
const SHA = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_REQUEST = 16 * 1024 * 1024;
const MAX_RECEIPT = 64 * 1024;
const MAX_METADATA = 256 * 1024;
const MAX_PENDING = 2 * MAX_REQUEST + MAX_METADATA;
const verifiedHeads = new WeakMap<
  object,
  { readonly signature: string; readonly header: Header }
>();

export interface CatalogueJournalBindingV2 {
  readonly batchId: string;
  readonly validatorDatabasePrincipal: string;
  readonly stagingSealSha256: string;
  readonly contextSha256: string;
  readonly admissionSha256: string;
}
interface Header {
  readonly schemaVersion: 2;
  readonly kind: "catalogue-validation-journal-v2";
  readonly binding: CatalogueJournalBindingV2;
  readonly maximumEvidenceBytes: number;
}
export interface CatalogueJournalHeadV2 {
  readonly header: CatalogueJournalPinV2;
  readonly lastAcknowledgement: CatalogueJournalPinV2 | null;
  readonly nextPageNumber: number;
  readonly evidenceBytes: number;
}
export interface CataloguePendingValidationRequestV2 {
  readonly schemaVersion: 2;
  readonly kind: "catalogue-validation-pending-v2";
  readonly head: CatalogueJournalHeadV2;
  readonly phase: "page" | "terminal";
  readonly requestDocument: string;
  readonly requestSha256: string;
  readonly contextDocument: string;
  readonly contextDocumentSha256: string;
}
type Pending = CataloguePendingValidationRequestV2;
interface Acknowledgement {
  readonly schemaVersion: 2;
  readonly kind: "catalogue-validation-acknowledgement-v2";
  readonly pending: CatalogueJournalPinV2;
  readonly receiptSha256: string;
}
interface IndexNode {
  readonly schemaVersion: 2;
  readonly kind: "catalogue-validation-index-v2";
  readonly pageNumber: number;
  readonly acknowledgement: CatalogueJournalPinV2;
  readonly next: CatalogueJournalPinV2 | null;
}
interface Terminal {
  readonly schemaVersion: 2;
  readonly kind: "catalogue-validation-journal-terminal-v2";
  readonly header: CatalogueJournalPinV2;
  readonly firstIndex: CatalogueJournalPinV2 | null;
  readonly pageCount: number;
  readonly pendingTerminal: CatalogueJournalPinV2;
  readonly validationTerminalSha256: string;
  readonly receiptDocument: string;
  readonly receiptDocumentSha256: string;
}
export interface CatalogueRetainedValidationPageV2 {
  readonly pageNumber: string;
  readonly requestDocument: string;
  readonly requestSha256: string;
  readonly receiptSha256: string;
}

/** One deterministic journal per batch/workspace; never silently create another retry lineage. */
export async function createCatalogueValidationJournalV2(
  binding: CatalogueJournalBindingV2,
  maximumEvidenceBytes: number,
  workspaceRoot: string,
): Promise<CatalogueJournalHeadV2> {
  validateBinding(binding);
  positiveInteger(maximumEvidenceBytes);
  const document: Header = {
    schemaVersion: 2,
    kind: "catalogue-validation-journal-v2",
    binding,
    maximumEvidenceBytes,
  };
  const path = `${prefix(binding.batchId)}-header.json`;
  const expected = filePin(path, document);
  budget(expected.byteSize, maximumEvidenceBytes);
  const header = await publishExact(expected, document, workspaceRoot);
  const head = {
    header,
    lastAcknowledgement: null,
    nextPageNumber: 0,
    evidenceBytes: header.byteSize,
  };
  verifiedHeads.set(head, { signature: headSignature(head), header: document });
  return head;
}

/** Publication and directory sync complete before callers may submit these exact bytes to SQL. */
export async function retainCatalogueValidationRequestV2(
  head: CatalogueJournalHeadV2,
  requestDocument: string,
  phase: "page" | "terminal",
  workspaceRoot: string,
  contextDocument = "{}",
): Promise<CatalogueJournalPinV2> {
  const checked = await verifyHead(head, workspaceRoot);
  if (phase !== "page" && phase !== "terminal") throw new Error("Invalid journal request phase");
  const requestSha256 = documentSha(requestDocument, MAX_REQUEST);
  const contextDocumentSha256 = documentSha(contextDocument, 8192);
  const document: Pending = {
    schemaVersion: 2,
    kind: "catalogue-validation-pending-v2",
    head,
    phase,
    requestDocument,
    requestSha256,
    contextDocument,
    contextDocumentSha256,
  };
  const path =
    phase === "terminal"
      ? `${prefix(checked.binding.batchId)}-terminal-request.json`
      : `${prefix(checked.binding.batchId)}-p${pageName(head.nextPageNumber)}-request.json`;
  const pin = filePin(path, document);
  budget(head.evidenceBytes + pin.byteSize, checked.maximumEvidenceBytes);
  return publishExact(pin, document, workspaceRoot);
}

export async function readRetainedCatalogueValidationRequestV2(
  pin: CatalogueJournalPinV2,
  workspaceRoot: string,
  knownHead?: CatalogueJournalHeadV2,
): Promise<Pending> {
  const pending = parsePending(await read(pin, workspaceRoot, MAX_PENDING));
  if (knownHead && headSignature(knownHead) !== headSignature(pending.head))
    throw new Error("Pending request differs from the current journal head");
  const head = knownHead ?? pending.head;
  const header = await verifyHead(head, workspaceRoot);
  const expectedPath =
    pending.phase === "terminal"
      ? `${prefix(header.binding.batchId)}-terminal-request.json`
      : `${prefix(header.binding.batchId)}-p${pageName(pending.head.nextPageNumber)}-request.json`;
  if (pin.path !== expectedPath)
    throw new Error("Retained request path does not match its journal identity");
  budget(pending.head.evidenceBytes + pin.byteSize, header.maximumEvidenceBytes);
  return { ...pending, head };
}

/** receiptSha256 is the SQL receipt identity; SQL/client receipt checks remain mandatory. */
export async function acknowledgeCatalogueValidationPageV2(
  pendingPin: CatalogueJournalPinV2,
  receiptSha256: string,
  workspaceRoot: string,
  knownHead?: CatalogueJournalHeadV2,
): Promise<CatalogueJournalHeadV2> {
  hash(receiptSha256);
  const pending = await readRetainedCatalogueValidationRequestV2(
    pendingPin,
    workspaceRoot,
    knownHead,
  );
  if (pending.phase !== "page")
    throw new Error("Terminal requests cannot become page acknowledgements");
  const header = await readHeader(pending.head.header, workspaceRoot);
  const document: Acknowledgement = {
    schemaVersion: 2,
    kind: "catalogue-validation-acknowledgement-v2",
    pending: pendingPin,
    receiptSha256,
  };
  const path = `${prefix(header.binding.batchId)}-p${pageName(pending.head.nextPageNumber)}-ack.json`;
  const pin = filePin(path, document);
  const evidenceBytes = pending.head.evidenceBytes + pendingPin.byteSize + pin.byteSize;
  budget(evidenceBytes, header.maximumEvidenceBytes);
  await publishExact(pin, document, workspaceRoot);
  const head = {
    header: pending.head.header,
    lastAcknowledgement: pin,
    nextPageNumber: pending.head.nextPageNumber + 1,
    evidenceBytes,
  };
  verifiedHeads.set(head, { signature: headSignature(head), header });
  return head;
}

/**
 * Build a forward-linked immutable index by walking the authenticated ACK chain backwards.
 * Both passes use constant memory. Dry-run the full allocation before publishing any node.
 */
export async function finishCatalogueValidationJournalV2(
  pendingTerminalPin: CatalogueJournalPinV2,
  validationTerminalSha256: string,
  receiptDocument: string,
  workspaceRoot: string,
  knownHead?: CatalogueJournalHeadV2,
): Promise<CatalogueJournalPinV2> {
  hash(validationTerminalSha256);
  const receiptDocumentSha256 = documentSha(receiptDocument, MAX_RECEIPT);
  const terminalRequest = await readRetainedCatalogueValidationRequestV2(
    pendingTerminalPin,
    workspaceRoot,
    knownHead,
  );
  if (terminalRequest.phase !== "terminal")
    throw new Error("Journal needs a retained terminal request");
  const head = terminalRequest.head;
  const header = await readHeader(head.header, workspaceRoot);
  const preview = await buildIndex(head, header, workspaceRoot, false);
  const document: Terminal = {
    schemaVersion: 2,
    kind: "catalogue-validation-journal-terminal-v2",
    header: head.header,
    firstIndex: preview.first,
    pageCount: head.nextPageNumber,
    pendingTerminal: pendingTerminalPin,
    validationTerminalSha256,
    receiptDocument,
    receiptDocumentSha256,
  };
  const pin = filePin(`${prefix(header.binding.batchId)}-terminal.json`, document);
  budget(
    head.evidenceBytes + pendingTerminalPin.byteSize + preview.bytes + pin.byteSize,
    header.maximumEvidenceBytes,
  );
  const published = await buildIndex(head, header, workspaceRoot, true);
  if (!samePin(preview.first, published.first) || preview.bytes !== published.bytes)
    throw new Error("Journal index changed during publication");
  return publishExact(pin, document, workspaceRoot);
}

export async function assertCatalogueValidationJournalContextV2(
  head: CatalogueJournalHeadV2,
  binding: CatalogueJournalBindingV2,
  maximumEvidenceBytes: number,
  workspaceRoot: string,
): Promise<void> {
  validateBinding(binding);
  const header = await verifyHead(head, workspaceRoot);
  if (
    header.maximumEvidenceBytes !== maximumEvidenceBytes ||
    Object.keys(binding).some(
      (key) =>
        header.binding[key as keyof CatalogueJournalBindingV2] !==
        binding[key as keyof CatalogueJournalBindingV2],
    )
  )
    throw new Error("Retained pre-request context differs from its approved journal binding");
}

/** Read identity from a caller-pinned terminal; full page evidence is checked by the reader. */
export async function readCatalogueValidationJournalIdentityV2(
  terminalPin: CatalogueJournalPinV2,
  batchId: string,
  validationTerminalSha256: string,
  workspaceRoot: string,
): Promise<CatalogueJournalBindingV2> {
  hash(validationTerminalSha256);
  const terminal = parseTerminal(await read(terminalPin, workspaceRoot));
  const header = await readHeader(terminal.header, workspaceRoot);
  if (
    header.binding.batchId !== batchId ||
    terminal.validationTerminalSha256 !== validationTerminalSha256 ||
    terminalPin.path !== `${prefix(batchId)}-terminal.json`
  )
    throw new Error("Pinned terminal differs from expected batch or validation");
  return header.binding;
}

/** Readers must exhaust this stream before any reconciliation mutation or publication. */
export async function* readCatalogueValidationJournalV2(
  terminalPin: CatalogueJournalPinV2,
  expected: {
    readonly binding: CatalogueJournalBindingV2;
    readonly validationTerminalSha256: string;
  },
  workspaceRoot: string,
): AsyncGenerator<CatalogueRetainedValidationPageV2> {
  validateBinding(expected.binding);
  hash(expected.validationTerminalSha256);
  const terminal = parseTerminal(await read(terminalPin, workspaceRoot));
  const header = await readHeader(terminal.header, workspaceRoot);
  if (
    Object.keys(header.binding).some(
      (key) =>
        header.binding[key as keyof CatalogueJournalBindingV2] !==
        expected.binding[key as keyof CatalogueJournalBindingV2],
    ) ||
    terminal.validationTerminalSha256 !== expected.validationTerminalSha256
  )
    throw new Error("Retained journal binding differs from expected validation");
  if (terminalPin.path !== `${prefix(header.binding.batchId)}-terminal.json`)
    throw new Error("Unexpected terminal journal path");
  // Authenticate the terminal directly; the forward pass verifies its complete
  // history once. Generic retained retry reads still verify their heads eagerly.
  const pendingTerminal = parsePending(
    await read(terminal.pendingTerminal, workspaceRoot, MAX_PENDING),
  );
  if (
    pendingTerminal.phase !== "terminal" ||
    terminal.pendingTerminal.path !== `${prefix(header.binding.batchId)}-terminal-request.json` ||
    !samePin(pendingTerminal.head.header, terminal.header) ||
    pendingTerminal.head.nextPageNumber !== terminal.pageCount
  )
    throw new Error("Journal terminal request differs from its ordered history");
  budget(
    pendingTerminal.head.evidenceBytes + terminal.pendingTerminal.byteSize,
    header.maximumEvidenceBytes,
  );
  let cursor = terminal.firstIndex;
  let number = 0;
  let previous: CatalogueJournalPinV2 | null = null;
  let used = terminal.header.byteSize + terminalPin.byteSize + terminal.pendingTerminal.byteSize;
  budget(used, header.maximumEvidenceBytes);
  let prefixBytes = terminal.header.byteSize;
  while (cursor) {
    const nodePin = cursor;
    const node = parseIndex(await read(nodePin, workspaceRoot));
    if (
      node.pageNumber !== number ||
      number >= terminal.pageCount ||
      nodePin.path !== `${prefix(header.binding.batchId)}-i${pageName(number)}.json`
    )
      throw new Error("Journal index is not contiguous");
    const acknowledgement = parseAcknowledgement(await read(node.acknowledgement, workspaceRoot));
    const pending = parsePending(await read(acknowledgement.pending, workspaceRoot, MAX_PENDING));
    checkPageIdentity(
      pending,
      node.acknowledgement,
      acknowledgement.pending,
      header,
      terminal.header,
      number,
      previous,
    );
    if (pending.head.evidenceBytes !== prefixBytes)
      throw new Error("Journal prefix byte accounting differs");
    prefixBytes += node.acknowledgement.byteSize + acknowledgement.pending.byteSize;
    budget(prefixBytes, header.maximumEvidenceBytes);
    used += nodePin.byteSize + node.acknowledgement.byteSize + acknowledgement.pending.byteSize;
    budget(used, header.maximumEvidenceBytes);
    yield {
      pageNumber: String(number),
      requestDocument: pending.requestDocument,
      requestSha256: pending.requestSha256,
      receiptSha256: acknowledgement.receiptSha256,
    };
    previous = node.acknowledgement;
    cursor = node.next;
    number += 1;
  }
  if (number !== terminal.pageCount || !samePin(previous, pendingTerminal.head.lastAcknowledgement))
    throw new Error("Journal index omits acknowledgement history");
  if (prefixBytes !== pendingTerminal.head.evidenceBytes)
    throw new Error("Journal terminal prefix byte accounting differs");
}

async function buildIndex(
  head: CatalogueJournalHeadV2,
  header: Header,
  workspaceRoot: string,
  publish: boolean,
) {
  let cursor = head.lastAcknowledgement;
  let next: CatalogueJournalPinV2 | null = null;
  let number = head.nextPageNumber;
  let bytes = 0;
  while (cursor) {
    number -= 1;
    if (number < 0) throw new Error("Journal acknowledgement chain exceeds count");
    const acknowledgement = parseAcknowledgement(await read(cursor, workspaceRoot));
    const pending = parsePending(await read(acknowledgement.pending, workspaceRoot, MAX_PENDING));
    checkPageIdentity(
      pending,
      cursor,
      acknowledgement.pending,
      header,
      head.header,
      number,
      pending.head.lastAcknowledgement,
    );
    const document: IndexNode = {
      schemaVersion: 2,
      kind: "catalogue-validation-index-v2",
      pageNumber: number,
      acknowledgement: cursor,
      next,
    };
    const pin = filePin(`${prefix(header.binding.batchId)}-i${pageName(number)}.json`, document);
    bytes += pin.byteSize;
    budget(head.evidenceBytes + bytes, header.maximumEvidenceBytes);
    if (publish) await publishExact(pin, document, workspaceRoot);
    next = pin;
    cursor = pending.head.lastAcknowledgement;
  }
  if (number !== 0) throw new Error("Journal acknowledgement chain is incomplete");
  return { first: next, bytes };
}

async function verifyHead(head: CatalogueJournalHeadV2, workspaceRoot: string): Promise<Header> {
  parseHead(head);
  const header = await readHeader(head.header, workspaceRoot);
  const prior = verifiedHeads.get(head);
  if (prior?.signature === headSignature(head)) {
    // Only objects produced by this process receive this fast path. Immutable
    // ancestors are fully reread at recovery/finalization and before reconciliation.
    if (head.lastAcknowledgement) await read(head.lastAcknowledgement, workspaceRoot);
    return header;
  }
  let cursor = head.lastAcknowledgement;
  let number = head.nextPageNumber;
  let total = head.header.byteSize;
  let remaining = head.evidenceBytes;
  while (cursor) {
    number -= 1;
    if (number < 0) throw new Error("Journal acknowledgement chain exceeds count");
    const ack = parseAcknowledgement(await read(cursor, workspaceRoot));
    const pending = parsePending(await read(ack.pending, workspaceRoot, MAX_PENDING));
    checkPageIdentity(
      pending,
      cursor,
      ack.pending,
      header,
      head.header,
      number,
      pending.head.lastAcknowledgement,
    );
    total += cursor.byteSize + ack.pending.byteSize;
    remaining -= cursor.byteSize + ack.pending.byteSize;
    if (remaining !== pending.head.evidenceBytes)
      throw new Error("Journal prefix byte accounting differs");
    budget(total, header.maximumEvidenceBytes);
    cursor = pending.head.lastAcknowledgement;
  }
  if (number !== 0 || total !== head.evidenceBytes)
    throw new Error("Journal history or byte accounting differs");
  verifiedHeads.set(head, { signature: headSignature(head), header });
  return header;
}

function checkPageIdentity(
  pending: Pending,
  ack: CatalogueJournalPinV2,
  request: CatalogueJournalPinV2,
  header: Header,
  headerPin: CatalogueJournalPinV2,
  number: number,
  previous: CatalogueJournalPinV2 | null,
) {
  if (
    pending.phase !== "page" ||
    pending.head.nextPageNumber !== number ||
    !samePin(pending.head.header, headerPin) ||
    !samePin(pending.head.lastAcknowledgement, previous) ||
    ack.path !== `${prefix(header.binding.batchId)}-p${pageName(number)}-ack.json` ||
    request.path !== `${prefix(header.binding.batchId)}-p${pageName(number)}-request.json`
  )
    throw new Error("Retained journal page identity differs");
}
async function readHeader(pin: CatalogueJournalPinV2, workspaceRoot: string): Promise<Header> {
  const value = object(await read(pin, workspaceRoot));
  keys(value, ["schemaVersion", "kind", "binding", "maximumEvidenceBytes"]);
  kind(value, "catalogue-validation-journal-v2");
  validateBinding(value.binding);
  positiveInteger(value.maximumEvidenceBytes);
  const header = value as unknown as Header;
  if (pin.path !== `${prefix(header.binding.batchId)}-header.json`)
    throw new Error("Journal header path differs from its identity");
  budget(pin.byteSize, header.maximumEvidenceBytes);
  return header;
}
async function read(
  pin: CatalogueJournalPinV2,
  workspaceRoot: string,
  maximum = MAX_METADATA,
): Promise<unknown> {
  parsePin(pin);
  if (pin.byteSize > maximum) throw new Error("Journal file exceeds its bounded read size");
  return readCatalogueValidationRequest(pin.path, pin, workspaceRoot);
}
async function publishExact(pin: CatalogueJournalPinV2, document: unknown, workspaceRoot: string) {
  try {
    await lstat(catalogueValidationRequestPath(pin.path, workspaceRoot));
    await read(pin, workspaceRoot, MAX_PENDING);
    return pin;
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "ENOENT"
    )
      throw error;
  }
  const actual = await writeCatalogueValidationRequest(pin.path, json(document), workspaceRoot);
  if (!samePin(actual, pin)) throw new Error("Retained journal publication identity differs");
  return actual;
}
function filePin(path: string, document: unknown): CatalogueJournalPinV2 {
  const hash = createHash("sha256");
  let byteSize = 1;
  for (const chunk of canonicalJsonChunks(json(document))) {
    hash.update(chunk, "utf8");
    byteSize += Buffer.byteLength(chunk, "utf8");
  }
  hash.update("\n");
  return { path, byteSize, sha256: hash.digest("hex") };
}
function parsePending(input: unknown): Pending {
  const value = object(input);
  keys(value, [
    "schemaVersion",
    "kind",
    "head",
    "phase",
    "requestDocument",
    "requestSha256",
    "contextDocument",
    "contextDocumentSha256",
  ]);
  kind(value, "catalogue-validation-pending-v2");
  parseHead(value.head);
  if (value.phase !== "page" && value.phase !== "terminal")
    throw new Error("Invalid pending phase");
  hash(value.requestSha256);
  hash(value.contextDocumentSha256);
  if (documentSha(value.contextDocument, 8192) !== value.contextDocumentSha256)
    throw new Error("Retained context byte identity differs");
  if (documentSha(value.requestDocument, MAX_REQUEST) !== value.requestSha256)
    throw new Error("Retained request byte identity differs");
  return value as unknown as Pending;
}
function parseAcknowledgement(input: unknown): Acknowledgement {
  const value = object(input);
  keys(value, ["schemaVersion", "kind", "pending", "receiptSha256"]);
  kind(value, "catalogue-validation-acknowledgement-v2");
  parsePin(value.pending);
  hash(value.receiptSha256);
  return value as unknown as Acknowledgement;
}
function parseIndex(input: unknown): IndexNode {
  const value = object(input);
  keys(value, ["schemaVersion", "kind", "pageNumber", "acknowledgement", "next"]);
  kind(value, "catalogue-validation-index-v2");
  count(value.pageNumber);
  parsePin(value.acknowledgement);
  if (value.next !== null) parsePin(value.next);
  return value as unknown as IndexNode;
}
function parseTerminal(input: unknown): Terminal {
  const value = object(input);
  keys(value, [
    "schemaVersion",
    "kind",
    "header",
    "firstIndex",
    "pageCount",
    "pendingTerminal",
    "validationTerminalSha256",
    "receiptDocument",
    "receiptDocumentSha256",
  ]);
  kind(value, "catalogue-validation-journal-terminal-v2");
  parsePin(value.header);
  parsePin(value.pendingTerminal);
  count(value.pageCount);
  if (value.firstIndex !== null) parsePin(value.firstIndex);
  hash(value.validationTerminalSha256);
  hash(value.receiptDocumentSha256);
  if (documentSha(value.receiptDocument, MAX_RECEIPT) !== value.receiptDocumentSha256)
    throw new Error("Journal terminal receipt changed");
  return value as unknown as Terminal;
}
function parseHead(input: unknown): void {
  const value = object(input);
  keys(value, ["header", "lastAcknowledgement", "nextPageNumber", "evidenceBytes"]);
  parsePin(value.header);
  count(value.nextPageNumber);
  positiveInteger(value.evidenceBytes);
  if (value.lastAcknowledgement !== null) parsePin(value.lastAcknowledgement);
}
function parsePin(input: unknown): void {
  const value = object(input);
  keys(value, ["path", "sha256", "byteSize"]);
  hash(value.sha256);
  positiveInteger(value.byteSize);
  if (typeof value.path !== "string" || !value.path.startsWith(`${ROOT}/`))
    throw new Error("Invalid journal pin path");
}
function validateBinding(input: unknown): asserts input is CatalogueJournalBindingV2 {
  const value = object(input);
  keys(value, [
    "batchId",
    "validatorDatabasePrincipal",
    "stagingSealSha256",
    "contextSha256",
    "admissionSha256",
  ]);
  if (
    typeof value.batchId !== "string" ||
    !UUID.test(value.batchId) ||
    typeof value.validatorDatabasePrincipal !== "string" ||
    Buffer.byteLength(value.validatorDatabasePrincipal) < 1 ||
    Buffer.byteLength(value.validatorDatabasePrincipal) > 63 ||
    value.validatorDatabasePrincipal.includes("\0")
  )
    throw new Error("Invalid journal binding identity");
  hash(value.stagingSealSha256);
  hash(value.contextSha256);
  hash(value.admissionSha256);
}
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Journal object required");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (Object.keys(value).sort().join("\0") !== [...expected].sort().join("\0"))
    throw new Error("Journal document shape differs");
}
function kind(value: Record<string, unknown>, expected: string): void {
  if (value.schemaVersion !== 2 || value.kind !== expected)
    throw new Error("Journal contract differs");
}
function hash(value: unknown): asserts value is string {
  if (typeof value !== "string" || !SHA.test(value)) throw new Error("Journal SHA-256 required");
}
function count(value: unknown): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    Object.is(value, -0)
  )
    throw new Error("Journal count must be an exact unsigned integer");
}
function positiveInteger(value: unknown): asserts value is number {
  count(value);
  if (value < 1) throw new Error("Journal positive integer required");
}
function documentSha(value: unknown, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > maximum
  )
    throw new Error("Journal document exceeds exact text boundary");
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (character.length === 1 && code >= 0xd800 && code <= 0xdfff)
      throw new Error("Journal document contains an unpaired surrogate");
  }
  return createHash("sha256").update(value, "utf8").digest("hex");
}
function prefix(batchId: string): string {
  return `${ROOT}/paged-${batchId}`;
}
function pageName(value: number): string {
  count(value);
  return String(value).padStart(16, "0");
}
function budget(used: number, maximum: number): void {
  if (!Number.isSafeInteger(used) || used > maximum)
    throw new Error("Journal evidence budget exhausted");
}
function samePin(left: CatalogueJournalPinV2 | null, right: CatalogueJournalPinV2 | null): boolean {
  return left === null || right === null
    ? left === right
    : left.path === right.path && left.sha256 === right.sha256 && left.byteSize === right.byteSize;
}
function json(value: unknown): JsonValue {
  return value as JsonValue;
}
function headSignature(head: CatalogueJournalHeadV2): string {
  return JSON.stringify([
    head.header.path,
    head.header.sha256,
    head.header.byteSize,
    head.lastAcknowledgement?.path ?? null,
    head.lastAcknowledgement?.sha256 ?? null,
    head.lastAcknowledgement?.byteSize ?? null,
    head.nextPageNumber,
    head.evidenceBytes,
  ]);
}
