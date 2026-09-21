import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  destroy: vi.fn(),
  reconcile: vi.fn(),
  parse: vi.fn(),
  submitApproval: vi.fn(),
  legacyApproval: vi.fn(),
}));
vi.mock("@nutrition-tracker/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@nutrition-tracker/db")>()),
  createDatabaseFromEnvironment: mocks.create,
  reconcileCatalogueBatch: mocks.reconcile,
  parsePreparedCatalogueValidationRequest: mocks.parse,
  submitCatalogueApproval: mocks.submitApproval,
  approveBatch: mocks.legacyApproval,
}));

import { parseArguments } from "../src/arguments.js";
import { writeCatalogueValidationRequest } from "../src/catalogue-validation-request.js";
import {
  type CommandIo,
  runCatalogueApprovalCommand,
  runCatalogueReconcileCommand,
  runCommand,
} from "../src/run.js";

const BATCH = "11111111-1111-4111-8111-111111111111";
const DIGEST = "a".repeat(64);
const MANIFEST = "b".repeat(64);
const REQUEST_PATH = ".local-data/evidence/catalogue-validation/retained.json";
const REPORT_PATH = ".local-data/evidence/catalogue-reconciliation/review.json";
// These command tests isolate the DB schema parser while exercising the actual
// owner-private canonical request reader and exclusive reconciliation writer.
const REQUEST = { batchId: BATCH, validationDigest: DIGEST, validationDocument: "retained bytes" };
const REPORT = { reconciliationSha256: "c".repeat(64), source: "synthetic-command" };
const PRINCIPAL = "reviewer_data";
const REFERENCE = "urn:nutrition:review:fixture-1";
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "catalogue-review-command-"));
  vi.clearAllMocks();
  mocks.destroy.mockReset().mockResolvedValue(undefined);
  mocks.create.mockReset().mockReturnValue({ destroy: mocks.destroy });
  mocks.reconcile.mockReset().mockResolvedValue(REPORT);
  mocks.parse.mockReset().mockImplementation((value: unknown) => value);
  mocks.submitApproval.mockReset().mockImplementation(async (_database, input) => ({
    approvalRole: input.approvalRole,
    wasAlreadyApproved: false,
  }));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
function capture(environment: NodeJS.ProcessEnv = {}) {
  const output: string[] = [];
  const errors: string[] = [];
  const io: CommandIo = {
    environment,
    writeOutput: (value) => output.push(value),
    writeError: (value) => errors.push(value),
  };
  return { io, output, errors };
}
function reconcileArgs(extra: readonly string[] = []): string[] {
  return [
    "catalogue",
    "reconcile",
    "--batch-id",
    BATCH,
    "--expected-current-release-id",
    "none",
    "--expected-validation-digest",
    DIGEST,
    "--report-out",
    REPORT_PATH,
    ...extra,
  ];
}
function approvalArgs(): string[] {
  return [
    "catalogue",
    "submit-approval",
    "--batch-id",
    BATCH,
    "--role",
    "data",
    "--manifest-sha256",
    MANIFEST,
    "--validation-digest",
    DIGEST,
    "--approval-reference",
    REFERENCE,
    "--external-principal-id",
    PRINCIPAL,
  ];
}
function replace(args: readonly string[], option: string, value: string): string[] {
  const result = [...args];
  const index = result.indexOf(`--${option}`);
  if (index < 0) throw new Error("Missing test option");
  result[index + 1] = value;
  return result;
}
async function invoke(args: readonly string[], io: CommandIo) {
  const parsed = parseArguments(args);
  if (parsed.command[1] === "reconcile") {
    await runCatalogueReconcileCommand(args, parsed.positionals, parsed.options, io, root);
  } else {
    await runCatalogueApprovalCommand(args, parsed.positionals, parsed.options, io);
  }
}
async function retainedArgs() {
  const file = await writeCatalogueValidationRequest(REQUEST_PATH, REQUEST, root);
  return reconcileArgs([
    "--validation-request",
    REQUEST_PATH,
    "--validation-request-sha256",
    file.sha256,
    "--validation-request-bytes",
    String(file.byteSize),
  ]);
}
async function expectNoReport() {
  await expect(readFile(join(root, REPORT_PATH))).rejects.toMatchObject({ code: "ENOENT" });
}

describe("capability reconciliation command", () => {
  it("passes the exact retained request and publishes only after database cleanup", async () => {
    const args = await retainedArgs();
    const original = await readFile(join(root, REQUEST_PATH));
    const captured = capture();
    mocks.destroy.mockImplementation(expectNoReport);
    await invoke(args, captured.io);
    expect(mocks.reconcile).toHaveBeenCalledWith(expect.anything(), {
      batchId: BATCH,
      expectedCurrentReleaseId: null,
      expectedValidationDigest: DIGEST,
      validationRequest: REQUEST,
    });
    expect(mocks.parse).toHaveBeenCalledWith(REQUEST);
    expect(mocks.destroy).toHaveBeenCalledOnce();
    expect(captured.output).toHaveLength(1);
    expect(JSON.parse(captured.output[0] ?? "null")).toMatchObject({
      batchId: BATCH,
      reconciliationSha256: REPORT.reconciliationSha256,
    });
    expect(JSON.parse(await readFile(join(root, REPORT_PATH), "utf8"))).toEqual(REPORT);
    expect(await readFile(join(root, REQUEST_PATH))).toEqual(original);
  });
  it("preserves the legacy reconciliation input without a validation request", async () => {
    const currentReleaseId = "22222222-2222-4222-8222-222222222222";
    await invoke(
      replace(reconcileArgs(), "expected-current-release-id", currentReleaseId),
      capture().io,
    );
    expect(mocks.reconcile).toHaveBeenCalledWith(expect.anything(), {
      batchId: BATCH,
      expectedCurrentReleaseId: currentReleaseId,
      expectedValidationDigest: DIGEST,
    });
    expect(mocks.parse).not.toHaveBeenCalled();
  });
  it.each([1, 2, 3, 4, 5, 6])(
    "rejects incomplete request option group %s before connection",
    async (mask) => {
      const pairs = [
        ["--validation-request", REQUEST_PATH],
        ["--validation-request-sha256", DIGEST],
        ["--validation-request-bytes", "100"],
      ];
      const args = reconcileArgs(pairs.flatMap((pair, index) => (mask & (1 << index) ? pair : [])));
      await expect(invoke(args, capture().io)).rejects.toThrow("requires a non-blank value");
      expect(mocks.create).not.toHaveBeenCalled();
    },
  );
  it.each(["0", "01", "-1", "1.5", "9007199254740992", "268435457"])(
    "rejects noncanonical or oversized request bytes %s",
    async (bytes) => {
      const args = replace(await retainedArgs(), "validation-request-bytes", bytes);
      await expect(invoke(args, capture().io)).rejects.toThrow();
      expect(mocks.create).not.toHaveBeenCalled();
    },
  );
  it.each(["sha", "size", "batch", "digest", "schema", "path", "tamper"] as const)(
    "rejects request %s mismatch before connection",
    async (kind) => {
      let args = await retainedArgs();
      if (kind === "sha") args = replace(args, "validation-request-sha256", "f".repeat(64));
      if (kind === "size") args = replace(args, "validation-request-bytes", "1");
      if (kind === "path") args = replace(args, "validation-request", "/tmp/request.json");
      if (kind === "batch")
        mocks.parse.mockReturnValue({
          ...REQUEST,
          batchId: "22222222-2222-4222-8222-222222222222",
        });
      if (kind === "digest")
        mocks.parse.mockReturnValue({ ...REQUEST, validationDigest: "f".repeat(64) });
      if (kind === "schema")
        mocks.parse.mockImplementation(() => {
          throw new Error("invalid request schema");
        });
      if (kind === "tamper") await writeFile(join(root, REQUEST_PATH), "{}\n");
      await expect(invoke(args, capture().io)).rejects.toThrow();
      expect(mocks.create).not.toHaveBeenCalled();
      expect(mocks.reconcile).not.toHaveBeenCalled();
      await expectNoReport();
    },
  );
  it("retains request and suppresses report/output if required cleanup fails", async () => {
    const args = await retainedArgs();
    const original = await readFile(join(root, REQUEST_PATH));
    mocks.destroy.mockRejectedValue(new Error("cleanup failed"));
    const captured = capture();
    await expect(invoke(args, captured.io)).rejects.toThrow("cleanup failed");
    await expectNoReport();
    expect(captured.output).toEqual([]);
    expect(await readFile(join(root, REQUEST_PATH))).toEqual(original);
  });
  it("honors cancellation before connection and before report publication", async () => {
    const args = await retainedArgs();
    const captured = capture();
    await expect(invoke(args, { ...captured.io, signal: AbortSignal.abort() })).rejects.toThrow();
    expect(mocks.create).not.toHaveBeenCalled();
    const controller = new AbortController();
    mocks.destroy.mockImplementation(async () => controller.abort());
    await expect(invoke(args, { ...captured.io, signal: controller.signal })).rejects.toThrow();
    await expectNoReport();
    expect(captured.output).toEqual([]);
  });
});

describe("restricted catalogue submit-approval command", () => {
  it.each(["data", "quality", "rights"])(
    "passes explicit %s reviewer inputs without legacy actor fallback",
    async (role) => {
      const captured = capture({ INGEST_AUTHENTICATED_PRINCIPAL_ID: "forged_environment_actor" });
      mocks.destroy.mockImplementation(async () => {
        expect(captured.output).toEqual([]);
      });
      const args = replace(approvalArgs(), "role", role);
      expect(await runCommand(args, captured.io)).toBe(0);
      expect(mocks.submitApproval).toHaveBeenCalledWith(expect.anything(), {
        batchId: BATCH,
        approvalRole: role,
        rightsManifestSha256: MANIFEST,
        validationDigest: DIGEST,
        principalId: PRINCIPAL,
        approvalReference: REFERENCE,
      });
      expect(mocks.legacyApproval).not.toHaveBeenCalled();
      expect(mocks.destroy).toHaveBeenCalledOnce();
      expect(JSON.parse(captured.output[0] ?? "null")).toEqual({
        batchId: BATCH,
        approvalRole: role,
        wasAlreadyApproved: false,
      });
    },
  );
  it.each([
    "batch-id",
    "role",
    "manifest-sha256",
    "validation-digest",
    "approval-reference",
    "external-principal-id",
  ])("requires explicit --%s despite trusted-runner environment", async (name) => {
    const args = approvalArgs();
    args.splice(args.indexOf(`--${name}`), 2);
    const captured = capture({
      INGEST_AUTHENTICATION_METHOD: "oidc",
      INGEST_AUTHENTICATED_PRINCIPAL_ID: PRINCIPAL,
      INGEST_AUTHENTICATION_RUN_REFERENCE: REFERENCE,
    });
    expect(await runCommand(args, captured.io)).toBe(1);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(captured.output).toEqual([]);
  });
  it.each([
    ["batch-id", "00000000-0000-0000-0000-000000000000"],
    ["role", "owner"],
    ["manifest-sha256", "B".repeat(64)],
    ["validation-digest", "bad"],
    ["external-principal-id", "Uppercase"],
    ["external-principal-id", "a".repeat(64)],
    ["approval-reference", " leading"],
    ["approval-reference", "trailing "],
    ["approval-reference", "line\nbreak"],
    ["approval-reference", "control\u007f"],
    ["approval-reference", "é".repeat(1025)],
  ])("rejects invalid --%s=%s before connection", async (name, value) => {
    await expect(invoke(replace(approvalArgs(), name, value), capture().io)).rejects.toThrow();
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("preserves the exact UTF-8 reference at its byte limit", async () => {
    const reference = "é".repeat(1024);
    await invoke(replace(approvalArgs(), "approval-reference", reference), capture().io);
    expect(mocks.submitApproval.mock.calls[0]?.[1].approvalReference).toBe(reference);
  });
  it.each([
    ["--actor", "forged"],
    ["--__proto__=forged"],
    ["--role", "rights"],
    ["unexpected-positional"],
  ])("rejects extra or repeated arguments %s", async (...extra) => {
    const captured = capture();
    expect(await runCommand([...approvalArgs(), ...extra], captured.io)).toBe(1);
    expect(captured.output).toEqual([]);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("does not fall back after restricted authority rejection and preserves cleanup failure", async () => {
    const rejection = new Error("non-owner singleton reviewer required");
    const cleanup = new Error("database cleanup failed");
    mocks.submitApproval.mockRejectedValue(rejection);
    mocks.destroy.mockRejectedValue(cleanup);
    const captured = capture();
    await expect(invoke(approvalArgs(), captured.io)).rejects.toMatchObject({
      errors: [rejection, cleanup],
    });
    expect(mocks.legacyApproval).not.toHaveBeenCalled();
    expect(mocks.destroy).toHaveBeenCalledOnce();
    expect(captured.output).toEqual([]);
  });
  it("reports no success if approval committed but database cleanup failed", async () => {
    mocks.destroy.mockRejectedValue(new Error("cleanup failed"));
    const captured = capture();
    await expect(invoke(approvalArgs(), captured.io)).rejects.toThrow("cleanup failed");
    expect(mocks.submitApproval).toHaveBeenCalledOnce();
    expect(captured.output).toEqual([]);
  });
  it("retries unchanged explicit approval after lost output and returns replay receipt", async () => {
    const captured = capture();
    await expect(
      invoke(approvalArgs(), {
        ...captured.io,
        writeOutput: () => {
          throw new Error("lost acknowledgement");
        },
      }),
    ).rejects.toThrow("lost acknowledgement");
    mocks.submitApproval.mockResolvedValue({ approvalRole: "data", wasAlreadyApproved: true });
    await invoke(approvalArgs(), captured.io);
    expect(mocks.submitApproval.mock.calls[0]?.[1]).toEqual(
      mocks.submitApproval.mock.calls[1]?.[1],
    );
    expect(mocks.destroy).toHaveBeenCalledTimes(2);
    expect(JSON.parse(captured.output[0] ?? "null")).toEqual({
      batchId: BATCH,
      approvalRole: "data",
      wasAlreadyApproved: true,
    });
  });
  it("does not admit a cancelled approval and suppresses receipt after cleanup cancellation", async () => {
    const captured = capture();
    await expect(
      invoke(approvalArgs(), { ...captured.io, signal: AbortSignal.abort() }),
    ).rejects.toThrow();
    expect(mocks.create).not.toHaveBeenCalled();
    const controller = new AbortController();
    mocks.destroy.mockImplementation(async () => controller.abort());
    await expect(
      invoke(approvalArgs(), { ...captured.io, signal: controller.signal }),
    ).rejects.toThrow();
    expect(captured.output).toEqual([]);
  });
});
