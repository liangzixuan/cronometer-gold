import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  destroy: vi.fn(),
  submit: vi.fn(),
  read: vi.fn(),
}));
vi.mock("@nutrition-tracker/db", async (original) => ({
  ...(await original<typeof import("@nutrition-tracker/db")>()),
  createDatabaseFromEnvironment: mocks.create,
  submitCataloguePublicationRequestV2: mocks.submit,
  readCataloguePublicationV2: mocks.read,
}));

import { parseArguments } from "../src/arguments.js";
import {
  type CataloguePublicationCommand,
  retainedPublicationDocument,
  runCataloguePublicationCommand,
} from "../src/catalogue-publication-command.js";
import { writeCatalogueValidationRequest } from "../src/catalogue-validation-request.js";
import { runCommand } from "../src/run.js";

const BATCH = "12345678-1234-4234-8234-123456789abc";
const HASH = "a".repeat(64);
const REQUEST = ".local-data/evidence/catalogue-validation/publication-request.json";
const RECEIPT = ".local-data/evidence/catalogue-validation/publication-receipt.json";
let root: string;
let events: string[];
let outputs: unknown[];
function io(signal?: AbortSignal) {
  return {
    environment: {},
    now: () => new Date("2026-09-23T00:00:00Z"),
    writeOutput: (value: string) => {
      events.push("output");
      outputs.push(JSON.parse(value));
    },
    writeError: () => {},
    ...(signal ? { signal } : {}),
  };
}
async function run(command: CataloguePublicationCommand, args: string[], signal?: AbortSignal) {
  const argv = ["catalogue", command, ...args];
  const parsed = parseArguments(argv);
  await runCataloguePublicationCommand(
    command,
    argv,
    parsed.positionals,
    parsed.options,
    io(signal),
    root,
  );
}
async function prepare() {
  await run("prepare-publication", [
    "begin",
    "--batch-id",
    BATCH,
    "--admission-sha256",
    HASH,
    "--request-out",
    REQUEST,
  ]);
  const bytes = await readFile(join(root, REQUEST));
  return {
    path: REQUEST,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteSize: bytes.length,
  };
}
function submitArgs(pin: Awaited<ReturnType<typeof prepare>>) {
  return [
    "begin",
    "--request",
    pin.path,
    "--request-sha256",
    pin.sha256,
    "--request-bytes",
    String(pin.byteSize),
    "--receipt-out",
    RECEIPT,
  ];
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "catalogue-publication-cli-"));
  events = [];
  outputs = [];
  vi.resetAllMocks();
  mocks.create.mockImplementation(() => {
    events.push("create");
    return { destroy: mocks.destroy };
  });
  mocks.destroy.mockImplementation(async () => {
    events.push("destroy");
  });
  mocks.submit.mockImplementation(async () => {
    events.push("submit");
    return { receiptSha256: HASH };
  });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("retained publication commands", () => {
  it("prepares private exact bytes without opening a database", async () => {
    const pin = await prepare();
    const envelope = JSON.parse(await readFile(join(root, REQUEST), "utf8"));
    expect(retainedPublicationDocument("begin", envelope)).toBe(envelope.requestDocument);
    expect(pin.byteSize).toBeLessThan(262144);
    expect((await stat(join(root, REQUEST))).mode & 0o777).toBe(0o600);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("submits retained bytes and publishes its receipt only after cleanup", async () => {
    const pin = await prepare();
    const request = JSON.parse(await readFile(join(root, REQUEST), "utf8"));
    events = [];
    await run("submit-publication", submitArgs(pin));
    expect(mocks.submit.mock.calls[0]?.slice(1, 3)).toEqual(["begin", request.requestDocument]);
    expect(events).toEqual(["create", "submit", "destroy", "output"]);
    expect(JSON.parse(await readFile(join(root, RECEIPT), "utf8"))).toMatchObject({
      kind: "catalogue-publication-receipt",
      operation: "begin",
      requestSha256: request.requestSha256,
    });
    expect((await stat(join(root, RECEIPT))).mode & 0o777).toBe(0o600);
  });
  it("retains the same request after an uncertain result and retries it explicitly", async () => {
    const pin = await prepare();
    const before = await readFile(join(root, REQUEST));
    mocks.submit.mockRejectedValueOnce(new Error("acknowledgement lost"));
    await expect(run("submit-publication", submitArgs(pin))).rejects.toThrow(
      "acknowledgement lost",
    );
    await expect(stat(join(root, RECEIPT))).rejects.toMatchObject({ code: "ENOENT" });
    await run("submit-publication", submitArgs(pin));
    expect(mocks.submit.mock.calls[0]?.slice(1)).toEqual(mocks.submit.mock.calls[1]?.slice(1));
    expect(await readFile(join(root, REQUEST))).toEqual(before);
    expect(mocks.destroy).toHaveBeenCalledTimes(2);
  });
  it("withholds receipt publication when database cleanup fails", async () => {
    const pin = await prepare();
    outputs = [];
    mocks.destroy.mockRejectedValueOnce(new Error("cleanup failed"));
    await expect(run("submit-publication", submitArgs(pin))).rejects.toThrow("cleanup failed");
    expect(outputs).toEqual([]);
    await expect(stat(join(root, RECEIPT))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(root, REQUEST))).toBeDefined();
  });
  it("rejects a replaced request or operation before connecting", async () => {
    const pin = await prepare();
    const args = submitArgs({ ...pin, sha256: "b".repeat(64) });
    await expect(run("submit-publication", args)).rejects.toThrow("SHA-256");
    args[0] = "activate";
    args[args.indexOf("--request-sha256") + 1] = pin.sha256;
    await expect(run("submit-publication", args)).rejects.toThrow("binding differs");
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("refuses an existing receipt destination before a mutation", async () => {
    const pin = await prepare();
    await writeCatalogueValidationRequest(RECEIPT, { occupied: true }, root);
    await expect(run("submit-publication", submitArgs(pin))).rejects.toThrow("already exists");
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it.each(["--generation", "--__proto__", "--constructor"])(
    "rejects unrecognized request authority option %s",
    async (option) => {
      await expect(
        run("prepare-publication", [
          "begin",
          "--batch-id",
          BATCH,
          "--admission-sha256",
          HASH,
          "--request-out",
          REQUEST,
          option,
          "1",
        ]),
      ).rejects.toThrow("Unknown publication option");
      expect(mocks.create).not.toHaveBeenCalled();
    },
  );
  it("rejects oversized pin, missing nullable destination and unknown operation", async () => {
    const pin = await prepare();
    await expect(
      run("submit-publication", submitArgs({ ...pin, byteSize: 262145 })),
    ).rejects.toThrow("byte limit");
    await expect(
      run("prepare-publication", [
        "rollback",
        "--source-code",
        "USDA_FDC",
        "--reason",
        "Approved rollback",
        "--request-id",
        BATCH,
        "--request-out",
        RECEIPT,
      ]),
    ).rejects.toThrow("requires a non-blank value");
    await expect(run("prepare-publication", ["promote_and_skip_checks"])).rejects.toThrow(
      "Unknown catalogue publication operation",
    );
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("does not connect or publish after cancellation", async () => {
    const pin = await prepare();
    outputs = [];
    const abort = new AbortController();
    abort.abort(new Error("cancelled"));
    await expect(run("submit-publication", submitArgs(pin), abort.signal)).rejects.toThrow(
      "cancelled",
    );
    expect(mocks.create).not.toHaveBeenCalled();
    expect(outputs).toEqual([]);
  });
  it("cleans up an actual dispatched read command", async () => {
    mocks.read.mockResolvedValue({ schemaVersion: 2, batchId: BATCH });
    expect(
      await runCommand(["catalogue", "read-publication", BATCH, "--authority", "publisher"], io()),
    ).toBe(0);
    expect(mocks.read.mock.calls[0]?.slice(1)).toEqual([BATCH, "publisher"]);
    expect(events).toEqual(["create", "destroy", "output"]);
  });
});
