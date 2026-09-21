import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  destroy: vi.fn(),
  prepare: vi.fn(),
  parse: vi.fn(),
  submit: vi.fn(),
}));
vi.mock("@nutrition-tracker/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@nutrition-tracker/db")>()),
  createDatabaseFromEnvironment: mocks.create,
  prepareCatalogueValidation: mocks.prepare,
  parsePreparedCatalogueValidationRequest: mocks.parse,
  submitCatalogueValidation: mocks.submit,
}));

import { parseArguments } from "../src/arguments.js";
import { runCatalogueValidationCommand } from "../src/catalogue-validation-command.js";
import { writeCatalogueValidationRequest } from "../src/catalogue-validation-request.js";
import { type CommandIo, runCommand } from "../src/run.js";

const BATCH = "11111111-1111-4111-8111-111111111111";
const PATH = ".local-data/evidence/catalogue-validation/request.json";
const PREPARED = {
  batchId: BATCH,
  validationDigest: "d".repeat(64),
  validatorDatabasePrincipal: "independent-validator",
  validationDocument: '{"original":"exact request"}',
  observationSha256: "o".repeat(64),
};
function prepareArgs(): string[] {
  return [
    "catalogue",
    "prepare-validation",
    BATCH,
    "--staging-seal-sha256",
    "a".repeat(64),
    "--nutrient-mapping-sha256",
    "b".repeat(64),
    "--maximum-excluded-nutrient-fraction",
    "0",
    "--maximum-quarantine-fraction",
    "0",
    "--maximum-quarantined-records",
    "0",
    "--require-distinct-approval-principals",
    "true",
    "--require-at-least-one-valid-record",
    "true",
    "--require-materialized-nutrient-per-valid-record",
    "true",
    "--request-out",
    PATH,
  ];
}
function io(): CommandIo & { output: string[] } {
  const output: string[] = [];
  return {
    environment: {},
    output,
    writeOutput: (text) => output.push(text),
    writeError: () => undefined,
  };
}
async function invoke(args: string[], output: CommandIo, root: string) {
  const parsed = parseArguments(args);
  const command = parsed.command[1];
  if (command !== "prepare-validation" && command !== "submit-validation")
    throw new Error("test command");
  await runCatalogueValidationCommand(
    command,
    args,
    parsed.positionals,
    parsed.options,
    output,
    root,
  );
}
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "catalogue-command-"));
  vi.clearAllMocks();
  mocks.destroy.mockReset().mockResolvedValue(undefined);
  mocks.create.mockReturnValue({ destroy: mocks.destroy });
  mocks.prepare.mockReset().mockResolvedValue(PREPARED);
  mocks.parse.mockReset().mockImplementation((value: unknown) => value);
  mocks.submit
    .mockReset()
    .mockResolvedValue({ wasAlreadyValidated: false, validationDigest: PREPARED.validationDigest });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("catalogue validation command lifecycle", () => {
  it("publishes only after preparation and required database cleanup", async () => {
    mocks.destroy.mockImplementation(async () => {
      expect(await readdir(join(root, dirname(PATH)))).toEqual([]);
    });
    const output = io();
    await invoke(prepareArgs(), output, root);
    expect(mocks.prepare).toHaveBeenCalledOnce();
    expect(mocks.destroy).toHaveBeenCalledOnce();
    const result = JSON.parse(output.output[0] ?? "null");
    expect(result).toMatchObject({
      batchId: BATCH,
      request: { path: PATH },
      validationDigest: PREPARED.validationDigest,
    });
    expect(JSON.parse(await readFile(join(root, PATH), "utf8"))).toEqual(PREPARED);
  });

  it("retains no published request and reports no success after cleanup failure", async () => {
    mocks.destroy.mockRejectedValue(new Error("cleanup did not finish"));
    const output = io();
    await expect(invoke(prepareArgs(), output, root)).rejects.toThrow("cleanup did not finish");
    expect(await readdir(join(root, dirname(PATH)))).toEqual([]);
    expect(output.output).toEqual([]);
  });

  it("preserves preparation and cleanup errors together without publication", async () => {
    const operation = new Error("sealed observation rejected");
    const cleanup = new Error("cleanup rejected");
    mocks.prepare.mockRejectedValue(operation);
    mocks.destroy.mockRejectedValue(cleanup);
    const output = io();
    await expect(invoke(prepareArgs(), output, root)).rejects.toMatchObject({
      errors: [operation, cleanup],
    });
    expect(output.output).toEqual([]);
    expect(await readdir(join(root, dirname(PATH)))).toEqual([]);
  });

  it("refuses to replace a prepared request before database access", async () => {
    await writeCatalogueValidationRequest(PATH, PREPARED, root);
    await expect(invoke(prepareArgs(), io(), root)).rejects.toThrow("already exists");
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("resubmits identical retained input after a lost success output without preparing again", async () => {
    const file = await writeCatalogueValidationRequest(PATH, PREPARED, root);
    const original = await readFile(join(root, PATH));
    const args = [
      "catalogue",
      "submit-validation",
      BATCH,
      "--request",
      PATH,
      "--request-sha256",
      file.sha256,
      "--request-bytes",
      String(file.byteSize),
    ];
    const first: CommandIo = {
      ...io(),
      writeOutput: () => {
        throw new Error("lost output");
      },
    };
    await expect(invoke(args, first, root)).rejects.toThrow("lost output");
    const retry = io();
    mocks.submit.mockResolvedValue({
      wasAlreadyValidated: true,
      validationDigest: PREPARED.validationDigest,
    });
    await invoke(args, retry, root);
    expect(mocks.submit.mock.calls.map((call) => call[1])).toEqual([PREPARED, PREPARED]);
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.destroy).toHaveBeenCalledTimes(2);
    expect(await readFile(join(root, PATH))).toEqual(original);
    expect(JSON.parse(retry.output[0] ?? "null")).toMatchObject({
      validation: { wasAlreadyValidated: true },
    });
  });

  it.each(["digest", "size", "batch", "schema"] as const)(
    "rejects a mismatched request %s before connection",
    async (kind) => {
      const file = await writeCatalogueValidationRequest(PATH, PREPARED, root);
      const args = [
        "catalogue",
        "submit-validation",
        kind === "batch" ? "22222222-2222-4222-8222-222222222222" : BATCH,
        "--request",
        PATH,
        "--request-sha256",
        kind === "digest" ? "f".repeat(64) : file.sha256,
        "--request-bytes",
        String(file.byteSize + (kind === "size" ? 1 : 0)),
      ];
      if (kind === "schema")
        mocks.parse.mockImplementation(() => {
          throw new Error("strict request schema rejected");
        });
      await expect(invoke(args, io(), root)).rejects.toThrow();
      expect(mocks.create).not.toHaveBeenCalled();
      expect(mocks.submit).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["maximum-excluded-nutrient-fraction", "1.1"],
    ["maximum-quarantine-fraction", "NaN"],
    ["maximum-quarantined-records", "-1"],
    ["maximum-quarantined-records", "01"],
    ["require-distinct-approval-principals", "false"],
    ["require-at-least-one-valid-record", "false"],
    ["require-materialized-nutrient-per-valid-record", "false"],
    ["staging-seal-sha256", "A".repeat(64)],
    ["request-out", "/tmp/request.json"],
  ])("rejects invalid explicit --%s before connection", async (name, value) => {
    const args = prepareArgs();
    args[args.indexOf(`--${name}`) + 1] = value;
    await expect(invoke(args, io(), root)).rejects.toThrow();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it.each(["actor", "__proto__", "approve"])(
    "rejects unrecognized --%s in the real CLI",
    async (name) => {
      const errors: string[] = [];
      const output: CommandIo = {
        ...io(),
        writeError: (value) => {
          errors.push(value);
        },
      };
      expect(await runCommand([...prepareArgs(), `--${name}=forged`], output)).toBe(1);
      expect(errors.join("\n")).toContain("Unknown catalogue prepare-validation option");
      expect(mocks.create).not.toHaveBeenCalled();
    },
  );

  it("requires the complete policy, rejects duplicate options and honors abort before connection", async () => {
    const missing = prepareArgs();
    missing.splice(missing.indexOf("--maximum-quarantine-fraction"), 2);
    await expect(invoke(missing, io(), root)).rejects.toThrow("requires a non-blank");
    expect(() => parseArguments([...prepareArgs(), "--request-out", PATH])).toThrow(
      "repeated option",
    );
    await expect(
      invoke(prepareArgs(), { ...io(), signal: AbortSignal.abort() }, root),
    ).rejects.toThrow();
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
