import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, type JsonValue } from "@nutrition-tracker/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acknowledgeCatalogueValidationPageV2,
  type CatalogueJournalBindingV2,
  type CatalogueJournalPinV2,
  createCatalogueValidationJournalV2,
  finishCatalogueValidationJournalV2,
  readCatalogueValidationJournalV2,
  readRetainedCatalogueValidationRequestV2,
  retainCatalogueValidationRequestV2,
} from "../src/catalogue-paged-journal.js";
import * as requestFiles from "../src/catalogue-validation-request.js";

const workspaces: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const workspace of workspaces.splice(0))
    await rm(workspace, { recursive: true, force: true });
});
async function workspace() {
  const value = await mkdtemp(join(tmpdir(), "catalogue-journal-v2-"));
  workspaces.push(value);
  return value;
}
function binding(): CatalogueJournalBindingV2 {
  return {
    batchId: randomUUID(),
    validatorDatabasePrincipal: "synthetic-validator",
    stagingSealSha256: "a".repeat(64),
    contextSha256: "b".repeat(64),
    admissionSha256: "c".repeat(64),
  };
}
async function collected<T>(values: AsyncIterable<T>) {
  const output: T[] = [];
  for await (const value of values) output.push(value);
  return output;
}

type Pending = Awaited<ReturnType<typeof readRetainedCatalogueValidationRequestV2>>;
type Ack = {
  schemaVersion: 2;
  kind: "catalogue-validation-acknowledgement-v2";
  pending: CatalogueJournalPinV2;
  receiptSha256: string;
};
type Index = {
  schemaVersion: 2;
  kind: "catalogue-validation-index-v2";
  pageNumber: number;
  acknowledgement: CatalogueJournalPinV2;
  next: CatalogueJournalPinV2 | null;
};
type Terminal = {
  schemaVersion: 2;
  kind: "catalogue-validation-journal-terminal-v2";
  header: CatalogueJournalPinV2;
  firstIndex: CatalogueJournalPinV2 | null;
  pageCount: number;
  pendingTerminal: CatalogueJournalPinV2;
  validationTerminalSha256: string;
  receiptDocument: string;
  receiptDocumentSha256: string;
};
async function stored<T>(pin: CatalogueJournalPinV2, root: string): Promise<T> {
  return JSON.parse(await readFile(join(root, pin.path), "utf8")) as T;
}
async function repin(pin: CatalogueJournalPinV2, value: unknown, root: string) {
  const bytes = `${canonicalJson(value as JsonValue)}\n`;
  await writeFile(join(root, pin.path), bytes, { mode: 0o600 });
  return {
    ...pin,
    byteSize: Buffer.byteLength(bytes),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
async function journal(pageCount = 3) {
  const root = await workspace();
  const identity = binding();
  let head = await createCatalogueValidationJournalV2(identity, 1024 * 1024, root);
  const pages: { pending: CatalogueJournalPinV2; acknowledgement: CatalogueJournalPinV2 }[] = [];
  for (let page = 0; page < pageCount; page++) {
    const pending = await retainCatalogueValidationRequestV2(
      head,
      JSON.stringify({ page }),
      "page",
      root,
    );
    head = await acknowledgeCatalogueValidationPageV2(
      pending,
      String(page + 1).repeat(64),
      root,
      head,
    );
    if (!head.lastAcknowledgement) throw new Error("Fixture acknowledgement missing");
    pages.push({ pending, acknowledgement: head.lastAcknowledgement });
  }
  const pendingTerminal = await retainCatalogueValidationRequestV2(
    head,
    '{"finish":true}',
    "terminal",
    root,
  );
  const terminal = await finishCatalogueValidationJournalV2(
    pendingTerminal,
    "f".repeat(64),
    "{}",
    root,
    head,
  );
  return {
    root,
    identity,
    head,
    pages,
    pendingTerminal,
    terminal,
    expected: { binding: identity, validationTerminalSha256: "f".repeat(64) },
  };
}
// Re-pin every affected parent so corruption cases exercise history invariants,
// rather than stopping at an incidental file digest mismatch.
async function repinHistory(
  fixture: Awaited<ReturnType<typeof journal>>,
  change: {
    page?: (pending: Pending, number: number) => Pending;
    terminal?: (pending: Pending) => Pending;
    index?: (index: Index) => Index;
    maximumEvidenceBytes?: number;
  },
) {
  const { root } = fixture;
  let header = fixture.head.header;
  if (change.maximumEvidenceBytes !== undefined) {
    const document = await stored<Record<string, unknown>>(header, root);
    header = await repin(
      header,
      { ...document, maximumEvidenceBytes: change.maximumEvidenceBytes },
      root,
    );
  }
  let prefixBytes = header.byteSize;
  let previous: CatalogueJournalPinV2 | null = null;
  const acknowledgements: CatalogueJournalPinV2[] = [];
  for (const [number, page] of fixture.pages.entries()) {
    const original = await stored<Pending>(page.pending, root);
    const pending = {
      ...original,
      head: {
        ...original.head,
        header,
        nextPageNumber: number,
        lastAcknowledgement: previous,
        evidenceBytes: prefixBytes,
      },
    };
    const pendingPin = await repin(page.pending, change.page?.(pending, number) ?? pending, root);
    const ack = await stored<Ack>(page.acknowledgement, root);
    previous = await repin(page.acknowledgement, { ...ack, pending: pendingPin }, root);
    acknowledgements.push(previous);
    prefixBytes += pendingPin.byteSize + previous.byteSize;
  }
  const original = await stored<Pending>(fixture.pendingTerminal, root);
  const pending = {
    ...original,
    head: { ...original.head, header, lastAcknowledgement: previous, evidenceBytes: prefixBytes },
  };
  const pendingTerminal = await repin(
    fixture.pendingTerminal,
    change.terminal?.(pending) ?? pending,
    root,
  );
  let next: CatalogueJournalPinV2 | null = null;
  for (let number = acknowledgements.length - 1; number >= 0; number--) {
    const pin = {
      ...header,
      path: header.path.replace("-header.json", `-i${String(number).padStart(16, "0")}.json`),
    };
    const acknowledgement = acknowledgements[number];
    if (!acknowledgement) throw new Error("Fixture index acknowledgement missing");
    const index: Index = {
      schemaVersion: 2,
      kind: "catalogue-validation-index-v2",
      pageNumber: number,
      acknowledgement,
      next,
    };
    next = await repin(pin, change.index?.(index) ?? index, root);
  }
  const terminal = await stored<Terminal>(fixture.terminal, root);
  return repin(fixture.terminal, { ...terminal, header, firstIndex: next, pendingTerminal }, root);
}

describe("paged retained validation journals", () => {
  it("retains exact requests before acknowledgements and streams all pinned pages in order", async () => {
    const root = await workspace();
    const identity = binding();
    let head = await createCatalogueValidationJournalV2(identity, 1024 * 1024, root);
    const documents = ['{"page":0,"text":"é:𐐀"}', '{ "page": 1 }', '{"page":2}'];
    for (const [index, document] of documents.entries()) {
      const pending = await retainCatalogueValidationRequestV2(head, document, "page", root);
      const restored = await readRetainedCatalogueValidationRequestV2(pending, root, head);
      expect(restored.requestDocument).toBe(document);
      expect(restored.contextDocument).toBe("{}");
      expect(restored.head.nextPageNumber).toBe(index);
      head = await acknowledgeCatalogueValidationPageV2(
        pending,
        String(index + 1).repeat(64),
        root,
        head,
      );
    }
    const pendingTerminal = await retainCatalogueValidationRequestV2(
      head,
      '{"finish":true}',
      "terminal",
      root,
    );
    const terminal = await finishCatalogueValidationJournalV2(
      pendingTerminal,
      "f".repeat(64),
      '{"completed":true}',
      root,
      head,
    );
    const reads = vi.spyOn(requestFiles, "readCatalogueValidationRequest");
    const result = await collected(
      readCatalogueValidationJournalV2(
        terminal,
        { binding: identity, validationTerminalSha256: "f".repeat(64) },
        root,
      ),
    );
    const pendingReads = reads.mock.calls.filter(([path]) => /-p\d{16}-request\.json$/u.test(path));
    expect(pendingReads).toHaveLength(documents.length);
    expect(new Set(pendingReads.map(([path]) => path)).size).toBe(documents.length);
    expect(result.map((page) => page.pageNumber)).toEqual(["0", "1", "2"]);
    expect(result.map((page) => page.requestDocument)).toEqual(documents);
    expect(result.map((page) => page.receiptSha256)).toEqual([
      "1".repeat(64),
      "2".repeat(64),
      "3".repeat(64),
    ]);
    // Exact finalization retry reuses identical files and admission, without overwrites.
    await expect(
      finishCatalogueValidationJournalV2(
        pendingTerminal,
        "f".repeat(64),
        '{"completed":true}',
        root,
      ),
    ).resolves.toEqual(terminal);
  });
  it("recovers a pinned uncertain page after process state is lost without regenerating its bytes", async () => {
    const root = await workspace();
    const identity = binding();
    let head = await createCatalogueValidationJournalV2(identity, 1024 * 1024, root);
    const first = await retainCatalogueValidationRequestV2(head, '{"page":0}', "page", root);
    head = await acknowledgeCatalogueValidationPageV2(first, "1".repeat(64), root, head);
    const pending = await retainCatalogueValidationRequestV2(
      head,
      '{"page":1,"uncertain":true}',
      "page",
      root,
    );
    const restored = await readRetainedCatalogueValidationRequestV2(
      JSON.parse(JSON.stringify(pending)),
      root,
    );
    expect(restored.requestDocument).toBe('{"page":1,"uncertain":true}');
    const resumed = await acknowledgeCatalogueValidationPageV2(pending, "2".repeat(64), root);
    expect(resumed.nextPageNumber).toBe(2);
    await expect(
      acknowledgeCatalogueValidationPageV2(pending, "2".repeat(64), root),
    ).resolves.toEqual(resumed);
    await expect(
      acknowledgeCatalogueValidationPageV2(pending, "3".repeat(64), root),
    ).rejects.toThrow();
  });
  it("rejects changed requests, wrong header identity and attempts to reset the batch journal", async () => {
    const root = await workspace();
    const identity = binding();
    const head = await createCatalogueValidationJournalV2(identity, 1024 * 1024, root);
    const pending = await retainCatalogueValidationRequestV2(head, '{"page":0}', "page", root);
    await expect(
      retainCatalogueValidationRequestV2(head, '{"page":1}', "page", root),
    ).rejects.toThrow();
    await expect(
      createCatalogueValidationJournalV2(identity, 2 * 1024 * 1024, root),
    ).rejects.toThrow();
    await expect(
      readRetainedCatalogueValidationRequestV2({ ...pending, sha256: "e".repeat(64) }, root),
    ).rejects.toThrow();
    const path = join(root, pending.path);
    const before = await readFile(path, "utf8");
    await writeFile(path, before.replace('\\"page\\":0', '\\"page\\":9'));
    await expect(readRetainedCatalogueValidationRequestV2(pending, root)).rejects.toThrow();
  });
  it("rejects changed earlier evidence even when an in-process head had already been verified", async () => {
    const root = await workspace();
    const identity = binding();
    let head = await createCatalogueValidationJournalV2(identity, 1024 * 1024, root);
    const first = await retainCatalogueValidationRequestV2(head, '{"page":0}', "page", root);
    head = await acknowledgeCatalogueValidationPageV2(first, "1".repeat(64), root, head);
    const second = await retainCatalogueValidationRequestV2(head, '{"page":1}', "page", root);
    head = await acknowledgeCatalogueValidationPageV2(second, "2".repeat(64), root, head);
    const terminalRequest = await retainCatalogueValidationRequestV2(
      head,
      '{"finish":true}',
      "terminal",
      root,
    );
    await writeFile(join(root, first.path), "{}\n");
    await expect(
      finishCatalogueValidationJournalV2(terminalRequest, "f".repeat(64), "{}", root, head),
    ).rejects.toThrow();
  });
  it("enforces evidence admission before publication and refuses a foreign binding at consumption", async () => {
    const root = await workspace();
    const identity = binding();
    const head = await createCatalogueValidationJournalV2(identity, 2048, root);
    await expect(
      retainCatalogueValidationRequestV2(
        head,
        JSON.stringify({ text: "x".repeat(2048) }),
        "page",
        root,
      ),
    ).rejects.toThrow(/budget/u);
    const terminalRequest = await retainCatalogueValidationRequestV2(head, "{}", "terminal", root);
    await expect(
      finishCatalogueValidationJournalV2(
        terminalRequest,
        "f".repeat(64),
        JSON.stringify({ text: "x".repeat(1500) }),
        root,
        head,
      ),
    ).rejects.toThrow(/budget/u);
    const otherRoot = await workspace();
    const otherHead = await createCatalogueValidationJournalV2(identity, 1024 * 1024, otherRoot);
    const request = await retainCatalogueValidationRequestV2(
      otherHead,
      "{}",
      "terminal",
      otherRoot,
    );
    const terminal = await finishCatalogueValidationJournalV2(
      request,
      "f".repeat(64),
      "{}",
      otherRoot,
      otherHead,
    );
    await expect(
      collected(
        readCatalogueValidationJournalV2(
          terminal,
          {
            binding: { ...identity, validatorDatabasePrincipal: "other" },
            validationTerminalSha256: "f".repeat(64),
          },
          otherRoot,
        ),
      ),
    ).rejects.toThrow(/binding/u);
  });
  it("reads an empty journal without pending pages", async () => {
    const fixture = await journal(0);
    const reads = vi.spyOn(requestFiles, "readCatalogueValidationRequest");
    await expect(
      collected(readCatalogueValidationJournalV2(fixture.terminal, fixture.expected, fixture.root)),
    ).resolves.toEqual([]);
    expect(reads.mock.calls.filter(([path]) => /-p\d{16}-request\.json$/u.test(path))).toHaveLength(
      0,
    );
  });
  it("keeps generic terminal retry recovery eager", async () => {
    const fixture = await journal();
    const reads = vi.spyOn(requestFiles, "readCatalogueValidationRequest");
    await readRetainedCatalogueValidationRequestV2(fixture.pendingTerminal, fixture.root);
    expect(reads.mock.calls.filter(([path]) => /-p\d{16}-request\.json$/u.test(path))).toHaveLength(
      3,
    );
    const first = fixture.pages[0];
    if (!first) throw new Error("Fixture first page missing");
    await writeFile(join(fixture.root, first.pending.path), "{}\n");
    await expect(
      readRetainedCatalogueValidationRequestV2(fixture.pendingTerminal, fixture.root),
    ).rejects.toThrow(/byte size/u);
  });
  it.each([0, 1, 2])("rejects a re-pinned wrong prefix counter at page %i", async (changedPage) => {
    const fixture = await journal();
    const terminal = await repinHistory(fixture, {
      page: (pending, page) =>
        page === changedPage
          ? { ...pending, head: { ...pending.head, evidenceBytes: pending.head.evidenceBytes + 1 } }
          : pending,
    });
    const stream = readCatalogueValidationJournalV2(terminal, fixture.expected, fixture.root);
    for (let page = 0; page < changedPage; page++)
      expect((await stream.next()).value?.pageNumber).toBe(String(page));
    await expect(stream.next()).rejects.toThrow(/prefix byte accounting/u);
  });
  it.each([0, 3])(
    "rejects the re-pinned terminal prefix counter after %i pages",
    async (pageCount) => {
      const fixture = await journal(pageCount);
      const terminal = await repinHistory(fixture, {
        terminal: (pending) => ({
          ...pending,
          head: { ...pending.head, evidenceBytes: pending.head.evidenceBytes + 1 },
        }),
      });
      const stream = readCatalogueValidationJournalV2(terminal, fixture.expected, fixture.root);
      for (let page = 0; page < pageCount; page++)
        expect((await stream.next()).value?.pageNumber).toBe(String(page));
      await expect(stream.next()).rejects.toThrow(/terminal prefix byte accounting/u);
    },
  );
  it("authenticates the deterministic terminal request path directly", async () => {
    const fixture = await journal();
    const document = await stored<Pending>(fixture.pendingTerminal, fixture.root);
    const moved = await repin(
      {
        ...fixture.pendingTerminal,
        path: fixture.pendingTerminal.path.replace("-terminal-request.json", "-other-request.json"),
      },
      document,
      fixture.root,
    );
    const terminalDocument = await stored<Terminal>(fixture.terminal, fixture.root);
    const terminal = await repin(
      fixture.terminal,
      { ...terminalDocument, pendingTerminal: moved },
      fixture.root,
    );
    await expect(
      collected(readCatalogueValidationJournalV2(terminal, fixture.expected, fixture.root)),
    ).rejects.toThrow(/terminal request differs/u);
  });
  it("rejects a terminal head referring to a different authenticated header", async () => {
    const fixture = await journal();
    const headerDocument = await stored<Record<string, unknown>>(fixture.head.header, fixture.root);
    const header = await repin(
      fixture.head.header,
      { ...headerDocument, maximumEvidenceBytes: 2 * 1024 * 1024 },
      fixture.root,
    );
    const document = await stored<Terminal>(fixture.terminal, fixture.root);
    const terminal = await repin(fixture.terminal, { ...document, header }, fixture.root);
    await expect(
      collected(readCatalogueValidationJournalV2(terminal, fixture.expected, fixture.root)),
    ).rejects.toThrow(/terminal request differs/u);
  });
  it("detects late tampering after earlier pages have been yielded", async () => {
    const fixture = await journal();
    const stream = readCatalogueValidationJournalV2(
      fixture.terminal,
      fixture.expected,
      fixture.root,
    );
    expect((await stream.next()).value?.pageNumber).toBe("0");
    expect((await stream.next()).value?.pageNumber).toBe("1");
    const third = fixture.pages[2];
    if (!third) throw new Error("Fixture third page missing");
    await writeFile(join(fixture.root, third.pending.path), "{}\n");
    await expect(stream.next()).rejects.toThrow(/byte size/u);
  });
  it("rejects a re-pinned broken previous acknowledgement", async () => {
    const fixture = await journal();
    const terminal = await repinHistory(fixture, {
      page: (pending, page) =>
        page === 1 ? { ...pending, head: { ...pending.head, lastAcknowledgement: null } } : pending,
    });
    await expect(
      collected(readCatalogueValidationJournalV2(terminal, fixture.expected, fixture.root)),
    ).rejects.toThrow(/page identity/u);
  });
  it("rejects a re-pinned wrong final acknowledgement", async () => {
    const fixture = await journal();
    const terminal = await repinHistory(fixture, {
      terminal: (pending) => ({ ...pending, head: { ...pending.head, lastAcknowledgement: null } }),
    });
    await expect(
      collected(readCatalogueValidationJournalV2(terminal, fixture.expected, fixture.root)),
    ).rejects.toThrow(/omits acknowledgement/u);
  });
  it.each(["order", "omission", "cycle"] as const)("rejects broken index %s", async (fault) => {
    const fixture = await journal();
    const original = await stored<Terminal>(fixture.terminal, fixture.root);
    const terminal = await repinHistory(fixture, {
      index: (index) => {
        if (fault === "order" && index.pageNumber === 1) return { ...index, pageNumber: 0 };
        if (fault === "omission" && index.pageNumber === 1) return { ...index, next: null };
        if (fault === "cycle" && index.pageNumber === 1)
          return { ...index, next: original.firstIndex };
        return index;
      },
    });
    await expect(
      collected(readCatalogueValidationJournalV2(terminal, fixture.expected, fixture.root)),
    ).rejects.toThrow(
      fault === "order"
        ? /contiguous/u
        : fault === "omission"
          ? /omits acknowledgement/u
          : /SHA-256/u,
    );
  });
  it.each([0, 3])(
    "counts terminal and index files against the physical budget with %i pages",
    async (pageCount) => {
      const fixture = await journal(pageCount);
      const terminal = await repinHistory(fixture, {
        maximumEvidenceBytes: fixture.head.evidenceBytes + fixture.pendingTerminal.byteSize,
      });
      await expect(
        collected(readCatalogueValidationJournalV2(terminal, fixture.expected, fixture.root)),
      ).rejects.toThrow(/budget/u);
    },
  );
});
