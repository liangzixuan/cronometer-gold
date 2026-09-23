import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  begin: vi.fn(),
  prepare: vi.fn(),
  submit: vi.fn(),
  terminal: vi.fn(),
  advance: vi.fn(),
  parse: vi.fn(),
  create: vi.fn(),
  destroy: vi.fn(),
}));
vi.mock("@nutrition-tracker/db", async (original) => ({
  ...(await original<typeof import("@nutrition-tracker/db")>()),
  beginCatalogueValidationV2: mocks.begin,
  prepareCatalogueValidationPageV2: mocks.prepare,
  submitCatalogueValidationPageV2: mocks.submit,
  submitCatalogueValidationTerminalV2: mocks.terminal,
  advanceCatalogueValidationContextV2: mocks.advance,
  parsePreparedCatalogueValidationPageV2: mocks.parse,
  createDatabaseFromEnvironment: mocks.create,
}));

import { type CatalogueValidationContextV2 as Context, canonicalJson } from "@nutrition-tracker/db";
import { parseArguments } from "../src/arguments.js";
import {
  type CataloguePagedCommand,
  runCataloguePagedCommand,
} from "../src/catalogue-paged-command.js";
import {
  type CatalogueJournalPinV2,
  readRetainedCatalogueValidationRequestV2,
} from "../src/catalogue-paged-journal.js";
import type { CommandIo } from "../src/run.js";

const BATCH = randomUUID(),
  HASH = "a".repeat(64);
const policy = {
  maximumExcludedNutrientFraction: 0,
  maximumQuarantineFraction: 0,
  maximumQuarantinedRecords: 0,
  requireAtLeastOneValidRecord: true,
  requireDistinctApprovalPrincipals: true,
  requireMaterializedNutrientPerValidRecord: true,
};
function context(): Context {
  return {
    schemaVersion: 2,
    kind: "catalogue-validation-context-v2",
    batchId: BATCH,
    contextSha256: HASH,
    admissionSha256: HASH,
    maximumValidationEvidenceBytes: "1048576",
    validatorDatabasePrincipal: "fixture_validator",
    stagingSealSha256: HASH,
    generation: "1",
    baselineReleaseId: null,
    policyDocument: canonicalJson(policy),
    phase: "observing",
    nextSequence: "0",
    pageCount: "0",
    stagedCount: "1",
    lastPageReceiptSha256: HASH,
    validationCommitmentSha256: HASH,
    semanticCommitmentSha256: HASH,
  };
}
function prepared(document: string) {
  const parsed = JSON.parse(document);
  return {
    requestDocument: document,
    requestSha256: createHash("sha256").update(document).digest("hex"),
    requestByteSize: Buffer.byteLength(document),
    ...parsed,
  };
}
const document = canonicalJson({
  batchId: BATCH,
  contextSha256: HASH,
  pageNumber: "0",
  startSequence: "0",
  endSequence: "1",
  text: "exact é bytes",
});
const request = prepared(document);
let root: string;
let checkpoints: CatalogueJournalPinV2[];
let outputs: unknown[];
let io: CommandIo;
function args(command = "validate-paged") {
  return [
    "catalogue",
    command,
    BATCH,
    "--staging-seal-sha256",
    HASH,
    "--maximum-excluded-nutrient-fraction",
    "0",
    "--maximum-quarantine-fraction",
    "0",
    "--maximum-quarantined-records",
    "0",
    "--require-at-least-one-valid-record",
    "true",
    "--require-distinct-approval-principals",
    "true",
    "--require-materialized-nutrient-per-valid-record",
    "true",
  ];
}
function retry(pin: CatalogueJournalPinV2) {
  return [
    "catalogue",
    "retry-paged-validation",
    BATCH,
    "--request",
    pin.path,
    "--request-sha256",
    pin.sha256,
    "--request-bytes",
    String(pin.byteSize),
  ];
}
async function invoke(values: string[], target = io) {
  const parsed = parseArguments(values);
  await runCataloguePagedCommand(
    parsed.command[1] as CataloguePagedCommand,
    values,
    parsed.positionals,
    parsed.options,
    target,
    root,
  );
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "paged-flow-"));
  checkpoints = [];
  outputs = [];
  vi.resetAllMocks();
  io = {
    environment: {},
    writeError: () => {},
    writeOutput: (value) => {
      const parsed = JSON.parse(value);
      outputs.push(parsed);
      if (parsed.kind === "retained-validation-checkpoint-v2")
        checkpoints.push(parsed.value.request);
    },
  };
  mocks.create.mockReturnValue({ destroy: mocks.destroy });
  mocks.destroy.mockResolvedValue(undefined);
  mocks.begin.mockResolvedValue(context());
  mocks.prepare.mockResolvedValue(request);
  mocks.parse.mockImplementation(prepared);
  mocks.submit.mockImplementation(async (_db, input) => {
    const pin = checkpoints.at(-1);
    if (!pin) throw new Error("No durable checkpoint");
    expect((await readRetainedCatalogueValidationRequestV2(pin, root)).requestDocument).toBe(
      input.requestDocument,
    );
    return { receiptSha256: "b".repeat(64) };
  });
  mocks.advance.mockImplementation((value) => ({
    ...value,
    nextSequence: "1",
    pageCount: "1",
    lastPageReceiptSha256: "b".repeat(64),
  }));
  mocks.terminal.mockImplementation(async (_db, value, terminal) => ({
    schemaVersion: 2,
    kind: "catalogue-validation-terminal-receipt-v2",
    batchId: value.batchId,
    contextSha256: value.contextSha256,
    terminalRequestSha256: terminal.terminalRequestSha256,
    summaryDocument: "{}",
    terminalSha256: "f".repeat(64),
  }));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
describe("paged validation command recovery and cleanup", () => {
  it("retains a request and context before submission, then publishes success only after cleanup", async () => {
    mocks.destroy.mockImplementation(async () => {
      expect(
        outputs.every(
          (row) => (row as { kind?: string }).kind === "retained-validation-checkpoint-v2",
        ),
      ).toBe(true);
      expect(
        (await readdir(join(root, ".local-data/evidence/catalogue-validation"))).some((name) =>
          name.endsWith("-terminal.json"),
        ),
      ).toBe(false);
    });
    await invoke(args());
    expect(mocks.submit).toHaveBeenCalledOnce();
    expect(mocks.destroy).toHaveBeenCalledOnce();
    const pin = checkpoints[0];
    if (!pin) throw new Error("missing checkpoint");
    expect(
      JSON.parse((await readRetainedCatalogueValidationRequestV2(pin, root)).contextDocument),
    ).toEqual(context());
    expect(outputs.at(-1)).toMatchObject({
      batchId: BATCH,
      validationTerminalSha256: "f".repeat(64),
      journal: { sha256: expect.any(String) },
    });
  });
  it("stops after lost page response and explicitly retries the retained bytes without observing again", async () => {
    mocks.submit.mockRejectedValueOnce(new Error("lost response"));
    await expect(invoke(args())).rejects.toThrow("lost response");
    expect(mocks.prepare).toHaveBeenCalledOnce();
    expect(mocks.terminal).not.toHaveBeenCalled();
    const pin = checkpoints[0];
    if (!pin) throw new Error("missing checkpoint");
    const before = await readFile(join(root, pin.path));
    await invoke(retry(pin));
    expect(mocks.prepare).toHaveBeenCalledOnce();
    expect(mocks.begin).toHaveBeenCalledOnce();
    expect(mocks.submit.mock.calls.map((call) => call[1].requestDocument)).toEqual([
      document,
      document,
    ]);
    expect(await readFile(join(root, pin.path))).toEqual(before);
  });
  it("retains a terminal for explicit replay after cleanup failure and publishes no false completion", async () => {
    mocks.destroy.mockRejectedValueOnce(new Error("cleanup failed"));
    await expect(invoke(args())).rejects.toThrow("cleanup failed");
    expect(
      outputs.every(
        (row) => (row as { kind?: string }).kind === "retained-validation-checkpoint-v2",
      ),
    ).toBe(true);
    const pin = checkpoints.at(-1);
    if (!pin) throw new Error("missing terminalcheckpoint");
    await invoke(retry(pin));
    expect(mocks.terminal).toHaveBeenCalledTimes(2);
    expect(mocks.terminal.mock.calls[0]?.[2]).toEqual(mocks.terminal.mock.calls[1]?.[2]);
  });
  it("rejects invalid retained pins before opening a database connection", async () => {
    await expect(
      invoke(
        retry({
          path: ".local-data/evidence/catalogue-validation/missing.json",
          sha256: HASH,
          byteSize: 15,
        }),
      ),
    ).rejects.toThrow();
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("rejects already advanced initialization and requires its retained retry", async () => {
    mocks.begin.mockResolvedValue({ ...context(), nextSequence: "1", pageCount: "1" });
    await expect(invoke(args())).rejects.toThrow("retained pending request");
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.destroy).toHaveBeenCalledOnce();
  });
  it("honors cancellation after observation before any SQL submission", async () => {
    const controller = new AbortController();
    mocks.prepare.mockImplementation(async () => {
      controller.abort();
      return request;
    });
    await expect(invoke(args(), { ...io, signal: controller.signal })).rejects.toThrow();
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.destroy).toHaveBeenCalledOnce();
  });
  it.each([
    ["--maximum-quarantine-fraction", "1.5"],
    ["--require-distinct-approval-principals", "false"],
    ["--staging-seal-sha256", "A".repeat(64)],
  ])("rejects invalid policy or identity %s before a connection", async (key, value) => {
    const values = args();
    values[values.indexOf(key) + 1] = value;
    await expect(invoke(values)).rejects.toThrow();
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("rejects hidden or unknown CLI options", async () => {
    await expect(invoke([...args(), "--approve=true"])).rejects.toThrow("Unknown");
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
