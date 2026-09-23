import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  catalogueFramedSha256V2 as frame,
  type CataloguePagedReconciliationPage as Page,
  type CataloguePagedReconciliationTerminal as Terminal,
} from "@nutrition-tracker/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCataloguePagedReportSink } from "../src/catalogue-paged-report.js";

let root: string;
const BATCH = randomUUID(),
  CONTEXT = "b".repeat(64),
  VALIDATION = "c".repeat(64);
const REPORT = "nutrition-tracker.catalogue-reconciliation";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "paged-report-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
function pages() {
  let previous = frame("reconciliation-start", [BATCH, CONTEXT]);
  return (["metadata", "candidate", "removed"] as const).map((stream, index): Page => {
    const pageNumber = String(index + 1),
      complete = index === 2;
    const document = JSON.stringify(
      {
        schemaVersion: 3,
        reportType: REPORT,
        batchId: BATCH,
        contextSha256: CONTEXT,
        pageNumber,
        stream,
        records: stream === "candidate" ? [{ change: "added", text: "é:𐐀" }] : [],
      },
      null,
      1,
    );
    const documentSha256 = createHash("sha256").update(document).digest("hex");
    const startSequence = "0",
      endSequence = stream === "candidate" ? "1" : "0";
    const commitmentSha256 = frame("reconciliation-page", [
      CONTEXT,
      pageNumber,
      stream,
      startSequence,
      endSequence,
      documentSha256,
      previous,
      String(complete),
    ]);
    const page = {
      batchId: BATCH,
      contextSha256: CONTEXT,
      pageNumber,
      stream,
      startSequence,
      endSequence,
      document,
      documentSha256,
      previousCommitmentSha256: previous,
      commitmentSha256,
      complete,
    };
    previous = commitmentSha256;
    return page;
  });
}
function terminal(input: Page[]): Terminal {
  const last = input.at(-1);
  if (!last) throw new Error("fixture missing page");
  const counts = {
    baselineRecords: "0",
    candidateRecords: "1",
    added: "1",
    changed: "0",
    unchanged: "0",
    removed: "0",
    quarantined: "0",
  };
  return {
    schemaVersion: 3,
    reportType: REPORT,
    batchId: BATCH,
    contextSha256: CONTEXT,
    validationTerminalSha256: VALIDATION,
    pageCount: String(input.length),
    pageCommitmentSha256: last.commitmentSha256,
    counts,
    promotionAvailable: false,
    reportSha256: frame("reconciliation-terminal", [
      BATCH,
      CONTEXT,
      VALIDATION,
      String(input.length),
      last.commitmentSha256,
      ...Object.values(counts),
    ]),
  };
}
function sink(maximumEvidenceBytes = 1024 * 1024) {
  return createCataloguePagedReportSink({
    batchId: BATCH,
    maximumEvidenceBytes,
    workspaceRoot: root,
  });
}
describe("private paged reconciliation output", () => {
  it("retains exact SQL bytes and publishes a pinned complete terminal only after all pages", async () => {
    const output = sink(),
      input = pages();
    for (const page of input) await output.consumePage(page);
    const directory = join(root, ".local-data/evidence/catalogue-validation");
    expect((await readdir(directory)).some((file) => file.endsWith("terminal.json"))).toBe(false);
    const pin = await output.publishTerminal(terminal(input));
    expect(
      createHash("sha256")
        .update(await readFile(join(root, pin.path)))
        .digest("hex"),
    ).toBe(pin.sha256);
    const manifest = JSON.parse(await readFile(join(root, pin.path), "utf8"));
    const final = JSON.parse(await readFile(join(root, manifest.lastPage.path), "utf8"));
    expect(final.page.document).toBe(input[2]?.document);
    expect(manifest.terminal.promotionAvailable).toBe(false);
    await expect(output.consumePage(input[0] as Page)).rejects.toThrow();
  });
  it("allows an exact restarted report to reuse private files without overwriting", async () => {
    const input = pages();
    const first = sink();
    for (const page of input) await first.consumePage(page);
    const pin = await first.publishTerminal(terminal(input));
    const again = sink();
    for (const page of input) await again.consumePage(page);
    await expect(again.publishTerminal(terminal(input))).resolves.toEqual(pin);
  });
  it("rejects skipped, reordered and foreign pages before publishing their files", async () => {
    const input = pages();
    await expect(sink().consumePage(input[1] as Page)).rejects.toThrow();
    await expect(
      sink().consumePage({ ...input[0], batchId: randomUUID() } as Page),
    ).rejects.toThrow();
    const output = sink();
    await output.consumePage(input[0] as Page);
    await expect(output.consumePage(input[0] as Page)).rejects.toThrow();
  });
  it("leaves partial reports provisional after a missing page or mismatched terminal", async () => {
    const input = pages(),
      output = sink();
    await output.consumePage(input[0] as Page);
    await expect(output.publishTerminal(terminal(input))).rejects.toThrow();
    expect(
      (await readdir(join(root, ".local-data/evidence/catalogue-validation"))).some((file) =>
        file.endsWith("terminal.json"),
      ),
    ).toBe(false);
  });
  it("rereads old private evidence before terminal publication and rejects tampering", async () => {
    const input = pages(),
      output = sink();
    for (const page of input) await output.consumePage(page);
    const directory = join(root, ".local-data/evidence/catalogue-validation");
    const file = (await readdir(directory)).find((path) => path.endsWith("0000000000000001.json"));
    if (!file) throw new Error("fixture missing file");
    await writeFile(join(directory, file), "{}\n");
    await expect(output.publishTerminal(terminal(input))).rejects.toThrow();
  });
  it("enforces an approved budget before private page allocation", async () => {
    await expect(sink(100).consumePage(pages()[0] as Page)).rejects.toThrow(/budget/u);
    await expect(
      readdir(join(root, ".local-data/evidence/catalogue-validation")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("refuses changed exact report bytes even with the same batch and output filename", async () => {
    const input = pages();
    await sink().consumePage(input[0] as Page);
    const directory = join(root, ".local-data/evidence/catalogue-validation");
    const file = (await readdir(directory))[0];
    if (!file) throw new Error("fixture missing file");
    await writeFile(join(directory, file), "{}\n");
    await expect(sink().consumePage(input[0] as Page)).rejects.toThrow();
  });
});
