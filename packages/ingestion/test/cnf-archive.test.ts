import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdir, mkdtemp, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CNF_ARCHIVE_CSV_PATHS,
  type CnfArchiveCsvPath,
  parseCnfArchive,
  sha256CanonicalJson,
} from "../src/index.js";

const temporaryDirectories: string[] = [];
const GUIDE_PATH = "guides/CNF User Guide EN.txt";

const CSV_FIXTURES: Readonly<Record<CnfArchiveCsvPath, string>> = Object.freeze({
  "Food_Name.csv": [
    "Food_Code,Food_Description_EN,Food_Description_FR,Food_Last_Updated_Date",
    '101,"Milk, whole",Lait entier,2026-01-15',
    "102,Apple,,2026-01-15",
    "103,,Pomme,2026-01-15",
    "104,,,2026-01-15",
    "",
  ].join("\r\n"),
  "Food_Source.csv": "Food_Source_ID,Food_Source_Description_EN\r\n1,Calculated\r\n",
  "CNF_Food_Group.csv": "Food_Group_ID,Food_Group_Name_EN\r\n1,Dairy\r\n",
  "Nutrient_Amount.csv": [
    "Food_Code,Nutrient_Code,Nutrient_Amount,Nutrient_Source_ID,Observations",
    "101,208,61,1,4",
    "",
  ].join("\r\n"),
  "Nutrient_Name.csv": [
    "Nutrient_Code,Nutrient_Symbol,Nutrient_Unit,Nutrient_Name_EN,Tagname",
    "208,KCAL,kcal,Energy,ENERC_KCAL",
    "",
  ].join("\r\n"),
  "Nutrient_Source.csv": "Nutrient_Source_ID,Nutrient_Source_Description_EN\r\n1,Analytical\r\n",
  "Measure_Weight_Conversion.csv": [
    "Food_Code,Measure_Type_Code,Measure_Code,Measure_Weight_Conversion",
    "101,6,100,258",
    "",
  ].join("\r\n"),
  "Measure_Type.csv": "Measure_Type_Code,Measure_Type_Description_EN\r\n6,Serving\r\n",
  "Measure_Name.csv": [
    "Measure_Code,Measure_Description_and_Unit_EN",
    '100,"1 cup (250 mL)"',
    "",
  ].join("\r\n"),
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Health Canada CNF archive parser", () => {
  it("preflights guides, parses the exact nine tables, and emits deterministic evidence", async () => {
    const root = await temporaryDirectory();
    const archive = join(root, "cnf.zip");
    await writeFixtureZip(archive);
    const expectedFiles = [...CNF_ARCHIVE_CSV_PATHS, GUIDE_PATH];
    const first = await parseCnfArchive({
      archivePath: archive,
      destinationDirectory: join(root, "first"),
      expectedFiles,
      guideFiles: [GUIDE_PATH],
      context: { releaseKey: "cnf-synthetic" },
    });
    const second = await parseCnfArchive({
      archivePath: archive,
      destinationDirectory: join(root, "second"),
      expectedFiles: [...expectedFiles].reverse(),
      guideFiles: [GUIDE_PATH],
      context: { releaseKey: "cnf-synthetic" },
    });

    expect(second).toEqual(first);
    expect(first.archive).toEqual({
      expectedFiles: [...expectedFiles].sort(),
      inventoryCount: 10,
      inventorySha256: sha256CanonicalJson([...expectedFiles].sort()),
    });
    expect(first.tables.map((table) => table.archivePath)).toEqual(CNF_ARCHIVE_CSV_PATHS);
    expect(first.tables.map((table) => table.disposition)).toEqual([
      "adapter-input",
      "reference-only",
      "reference-only",
      "adapter-input",
      "adapter-input",
      "reference-only",
      "adapter-input",
      "reference-only",
      "adapter-input",
    ]);
    expect(first.tables.map((table) => table.referenceOnlyReason)).toEqual([
      null,
      "food_source_reference_not_materialized_v1",
      "upstream_food_group_taxonomy_not_materialized_v1",
      null,
      null,
      "nutrient_source_lookup_not_materialized_v1",
      null,
      "measure_type_lookup_not_materialized_v1",
      null,
    ]);
    const foodEvidence = first.tables[0];
    const foodBytes = Buffer.from(CSV_FIXTURES["Food_Name.csv"]);
    expect(foodEvidence).toMatchObject({
      byteSize: foodBytes.length,
      rawSha256: createHash("sha256").update(foodBytes).digest("hex"),
      headers: [
        "Food_Code",
        "Food_Description_EN",
        "Food_Description_FR",
        "Food_Last_Updated_Date",
      ],
      rowCount: 4,
      disposition: "adapter-input",
      referenceOnlyReason: null,
    });
    expect(foodEvidence?.headerSha256).toBe(sha256CanonicalJson(foodEvidence?.headers));
    expect(foodEvidence?.rowsSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(first.tableEvidenceSha256).toBe(sha256CanonicalJson(first.tables));
    expect(first.metrics).toMatchObject({
      tableCount: 9,
      adapterInputTableCount: 5,
      referenceOnlyTableCount: 4,
      bilingualDescriptionCount: 1,
      englishOnlyDescriptionCount: 1,
      frenchOnlyDescriptionCount: 1,
      missingBothDescriptionCount: 1,
    });
    expect(
      first.metrics.bilingualDescriptionCount +
        first.metrics.englishOnlyDescriptionCount +
        first.metrics.frenchOnlyDescriptionCount +
        first.metrics.missingBothDescriptionCount,
    ).toBe(foodEvidence?.rowCount);
    expect(first.metrics).toMatchObject({
      parsedDataRowCount: 12,
      adapterInputDataRowCount: 8,
      referenceOnlyDataRowCount: 4,
    });
    expect(first.parsed.records).toHaveLength(2);
    expect(first.parsed.quarantined).toHaveLength(2);
    expect(first.parsed.records[0]?.identity).toMatchObject({
      description: "Milk, whole",
      descriptionFr: "Lait entier",
    });
    expect(await readdir(join(root, "first"))).toEqual([...CNF_ARCHIVE_CSV_PATHS].sort());
    await expect(readFile(join(root, "first", GUIDE_PATH))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("removes every exact member when aborted immediately after extraction", async () => {
    const root = await temporaryDirectory();
    const archive = join(root, "post-extraction-abort.zip");
    await writeFixtureZip(archive);
    const output = join(root, "out");
    const signal = new AbortController().signal;
    let abortedAfterExtraction = false;
    Object.defineProperty(signal, "aborted", {
      configurable: true,
      get: () => {
        if (
          !abortedAfterExtraction &&
          CNF_ARCHIVE_CSV_PATHS.every((path) => existsSync(join(output, path))) &&
          !readdirSync(output).some((path) => path.endsWith(".partial"))
        ) {
          abortedAfterExtraction = true;
          return true;
        }
        return false;
      },
    });

    await expect(
      parseCnfArchive({
        archivePath: archive,
        destinationDirectory: output,
        expectedFiles: [...CNF_ARCHIVE_CSV_PATHS, GUIDE_PATH],
        guideFiles: [GUIDE_PATH],
        context: { releaseKey: "cnf-synthetic" },
        signal,
      }),
    ).rejects.toMatchObject({ code: "ABORTED" });
    expect(abortedAfterExtraction).toBe(true);
    expect(await readdir(output)).toEqual([]);
  });

  it("removes every exact member when aborted during final-table finalization", async () => {
    const root = await temporaryDirectory();
    const archive = join(root, "final-table-finalization-abort.zip");
    await writeFixtureZip(archive);
    const output = join(root, "out");
    const finalTablePath = join(output, "Measure_Name.csv");
    const signal = new AbortController().signal;
    let abortedDuringFinalization = false;
    Object.defineProperty(signal, "aborted", {
      configurable: true,
      get: () => abortedDuringFinalization,
    });
    const probe = await open(join(root, "probe-final-table"), "w+");
    const prototype = methodPrototype(probe, "stat") as { stat: typeof probe.stat };
    const originalStat = prototype.stat;
    await probe.close();
    const finalTableStatCounts = new WeakMap<object, number>();
    let finalTableHandleCount = 0;
    let abortedAtFinalTableHandleCount = 0;
    const statSpy = vi.spyOn(prototype, "stat").mockImplementation(function (this: typeof probe) {
      if (descriptorTarget(this.fd) === finalTablePath) {
        const priorCount = finalTableStatCounts.get(this) ?? 0;
        if (priorCount === 0) {
          finalTableHandleCount += 1;
        }
        const nextCount = priorCount + 1;
        finalTableStatCounts.set(this, nextCount);
        if (finalTableHandleCount === 2 && nextCount === 2) {
          abortedAtFinalTableHandleCount = finalTableHandleCount;
          abortedDuringFinalization = true;
        }
      }
      return originalStat.call(this);
    });
    try {
      await expect(
        parseCnfArchive({
          archivePath: archive,
          destinationDirectory: output,
          expectedFiles: [...CNF_ARCHIVE_CSV_PATHS, GUIDE_PATH],
          guideFiles: [GUIDE_PATH],
          context: { releaseKey: "cnf-synthetic" },
          signal,
        }),
      ).rejects.toMatchObject({ code: "ABORTED" });
    } finally {
      statSpy.mockRestore();
    }
    expect(finalTableHandleCount).toBeGreaterThanOrEqual(2);
    expect(abortedAtFinalTableHandleCount).toBe(2);
    expect(abortedDuringFinalization).toBe(true);
    expect(await readdir(output)).toEqual([]);
  });

  it("removes only exact selected members after parsing fails", async () => {
    const root = await temporaryDirectory();
    const archive = join(root, "malformed.zip");
    await writeFixtureZip(archive, {
      "Food_Source.csv": "Food_Source_ID,Food_Source_ID\n1,2\n",
    });
    const output = join(root, "out");
    const callerOwned = join(output, "caller-owned.txt");
    await mkdir(output, { mode: 0o700 });
    await writeFile(callerOwned, "preserve me");

    await expect(
      parseCnfArchive({
        archivePath: archive,
        destinationDirectory: output,
        expectedFiles: [...CNF_ARCHIVE_CSV_PATHS, GUIDE_PATH],
        guideFiles: [GUIDE_PATH],
        context: { releaseKey: "cnf-synthetic" },
      }),
    ).rejects.toMatchObject({ code: "DUPLICATE_KEY" });
    expect(await readdir(output)).toEqual(["caller-owned.txt"]);
    expect(await readFile(callerOwned, "utf8")).toBe("preserve me");
  });

  it("restores a quarantined CNF member when verification and handle close both fail", async () => {
    const root = await temporaryDirectory();
    const archive = join(root, "quarantine-verification-failure.zip");
    await writeFixtureZip(archive, {
      "Food_Source.csv": "Food_Source_ID,Food_Source_ID\n1,2\n",
    });
    const output = join(root, "out");
    const callerOwned = join(output, "caller-owned.txt");
    await mkdir(output, { mode: 0o700 });
    await writeFile(callerOwned, "preserve me");
    const probe = await open(join(root, "probe-quarantine"), "w+");
    const statPrototype = methodPrototype(probe, "stat") as { stat: typeof probe.stat };
    const originalStat = statPrototype.stat;
    await probe.close();
    let statInjected = false;
    let closeInjected = false;
    const statSpy = vi.spyOn(statPrototype, "stat").mockImplementation(function (
      this: typeof probe,
    ) {
      const target = descriptorTarget(this.fd);
      if (!statInjected && target.includes(".quarantine") && !target.includes(".partial")) {
        statInjected = true;
        const originalClose = this.close.bind(this);
        this.close = async () => {
          closeInjected = true;
          await originalClose();
          throw new Error("CNF quarantine close failure");
        };
        return Promise.reject(new Error("CNF quarantine fstat failure"));
      }
      return originalStat.call(this);
    });
    let failure: unknown;
    try {
      await parseCnfArchive({
        archivePath: archive,
        destinationDirectory: output,
        expectedFiles: [...CNF_ARCHIVE_CSV_PATHS, GUIDE_PATH],
        guideFiles: [GUIDE_PATH],
        context: { releaseKey: "cnf-synthetic" },
      });
    } catch (error) {
      failure = error;
    } finally {
      statSpy.mockRestore();
    }

    expect(statInjected).toBe(true);
    expect(closeInjected).toBe(true);
    expect(failure).toBeInstanceOf(AggregateError);
    const outer = failure as AggregateError;
    expect(outer.errors[0]).toMatchObject({ code: "DUPLICATE_KEY" });
    expect(outer.errors[1]).toMatchObject({
      code: "INVALID_ARCHIVE_ENTRY",
      message: "Unable to remove an exact extracted CNF member after parsing failed",
    });
    const verification = (outer.errors[1] as Error & { cause?: unknown }).cause;
    expect(verification).toBeInstanceOf(AggregateError);
    const verificationAggregate = verification as AggregateError;
    expect(verificationAggregate.cause).toBe(verificationAggregate.errors[0]);
    expect(verificationAggregate.errors[0]).toMatchObject({
      message: "CNF quarantine fstat failure",
    });
    expect(verificationAggregate.errors[1]).toMatchObject({
      code: "INVALID_ARCHIVE_ENTRY",
      message: "Unable to close an extracted CNF member after content verification",
    });
    expect((await readdir(output)).sort()).toEqual(["CNF_Food_Group.csv", "caller-owned.txt"]);
    expect(await readFile(callerOwned, "utf8")).toBe("preserve me");
  });

  it("rejects a same-size replacement and preserves the replacement during cleanup", async () => {
    const root = await temporaryDirectory();
    const archive = join(root, "cleanup-race.zip");
    await writeFixtureZip(archive, {
      "Food_Source.csv": "Food_Source_ID,Food_Source_ID\n1,2\n",
    });
    const output = join(root, "out");
    const replacedPath = join(output, "Food_Name.csv");
    const signal = new AbortController().signal;
    let replaced = false;
    Object.defineProperty(signal, "aborted", {
      configurable: true,
      get: () => {
        if (
          !replaced &&
          CNF_ARCHIVE_CSV_PATHS.every((path) => existsSync(join(output, path))) &&
          !readdirSync(output).some((path) => path.endsWith(".partial"))
        ) {
          unlinkSync(replacedPath);
          writeFileSync(replacedPath, CSV_FIXTURES["Food_Name.csv"], { mode: 0o600 });
          replaced = true;
        }
        return false;
      },
    });

    let failure: unknown;
    try {
      await parseCnfArchive({
        archivePath: archive,
        destinationDirectory: output,
        expectedFiles: [...CNF_ARCHIVE_CSV_PATHS, GUIDE_PATH],
        guideFiles: [GUIDE_PATH],
        context: { releaseKey: "cnf-synthetic" },
        signal,
      });
    } catch (error) {
      failure = error;
    }

    expect(replaced).toBe(true);
    expect(failure).toBeInstanceOf(AggregateError);
    const aggregate = failure as AggregateError;
    expect(aggregate.errors[0]).toMatchObject({
      code: "INVALID_ARCHIVE_ENTRY",
      message: "Extracted CNF member changed after extraction and before parsing",
    });
    expect(aggregate.errors.slice(1)).toEqual([
      expect.objectContaining({
        code: "INVALID_ARCHIVE_ENTRY",
        message: "Unable to remove an exact extracted CNF member after parsing failed",
      }),
    ]);
    expect(await readdir(output)).toEqual(["Food_Name.csv"]);
    expect(await readFile(replacedPath, "utf8")).toBe(CSV_FIXTURES["Food_Name.csv"]);
  });

  it("rejects a symlink replacement and never unlinks its target", async () => {
    const root = await temporaryDirectory();
    const archive = join(root, "symlink-race.zip");
    await writeFixtureZip(archive);
    const output = join(root, "out");
    const replacedPath = join(output, "Food_Name.csv");
    const targetPath = join(root, "caller-owned.csv");
    await writeFile(targetPath, CSV_FIXTURES["Food_Name.csv"], { mode: 0o600 });
    const signal = new AbortController().signal;
    let replaced = false;
    Object.defineProperty(signal, "aborted", {
      configurable: true,
      get: () => {
        if (
          !replaced &&
          CNF_ARCHIVE_CSV_PATHS.every((path) => existsSync(join(output, path))) &&
          !readdirSync(output).some((path) => path.endsWith(".partial"))
        ) {
          unlinkSync(replacedPath);
          symlinkSync(targetPath, replacedPath);
          replaced = true;
        }
        return false;
      },
    });

    let failure: unknown;
    try {
      await parseCnfArchive({
        archivePath: archive,
        destinationDirectory: output,
        expectedFiles: [...CNF_ARCHIVE_CSV_PATHS, GUIDE_PATH],
        guideFiles: [GUIDE_PATH],
        context: { releaseKey: "cnf-synthetic" },
        signal,
      });
    } catch (error) {
      failure = error;
    }

    expect(replaced).toBe(true);
    expect(failure).toBeInstanceOf(AggregateError);
    const aggregate = failure as AggregateError;
    expect(aggregate.errors[0]).toMatchObject({
      code: "INVALID_ARCHIVE_ENTRY",
      message: "Extracted CNF member changed after extraction and before parsing",
    });
    expect(aggregate.errors.slice(1)).toEqual([
      expect.objectContaining({
        code: "INVALID_ARCHIVE_ENTRY",
        message: "Unable to remove an exact extracted CNF member after parsing failed",
      }),
    ]);
    expect(await readFile(targetPath, "utf8")).toBe(CSV_FIXTURES["Food_Name.csv"]);
    expect(await readdir(output)).toEqual(["Food_Name.csv"]);
  });

  it("aggregates multiple post-extraction identity failures while cleaning every exact sibling", async () => {
    const root = await temporaryDirectory();
    const archive = join(root, "multiple-gap-replacements.zip");
    await writeFixtureZip(archive);
    const output = join(root, "out");
    const replacedPaths = ["Food_Name.csv", "Nutrient_Name.csv"] as const;
    const signal = new AbortController().signal;
    let replaced = false;
    Object.defineProperty(signal, "aborted", {
      configurable: true,
      get: () => {
        if (
          !replaced &&
          CNF_ARCHIVE_CSV_PATHS.every((path) => existsSync(join(output, path))) &&
          !readdirSync(output).some((path) => path.endsWith(".partial"))
        ) {
          for (const path of replacedPaths) {
            unlinkSync(join(output, path));
            writeFileSync(join(output, path), CSV_FIXTURES[path], { mode: 0o600 });
          }
          replaced = true;
        }
        return false;
      },
    });

    let failure: unknown;
    try {
      await parseCnfArchive({
        archivePath: archive,
        destinationDirectory: output,
        expectedFiles: [...CNF_ARCHIVE_CSV_PATHS, GUIDE_PATH],
        guideFiles: [GUIDE_PATH],
        context: { releaseKey: "cnf-synthetic" },
        signal,
      });
    } catch (error) {
      failure = error;
    }

    expect(replaced).toBe(true);
    expect(failure).toBeInstanceOf(AggregateError);
    const outer = failure as AggregateError;
    expect(outer.errors).toHaveLength(3);
    expect(outer.errors[0]).toBeInstanceOf(AggregateError);
    expect((outer.errors[0] as AggregateError).errors).toHaveLength(2);
    expect(await readdir(output)).toEqual([...replacedPaths].sort());
    for (const path of replacedPaths) {
      expect(await readFile(join(output, path), "utf8")).toBe(CSV_FIXTURES[path]);
    }
  });

  it("requires every extra inventory member to be an explicit non-CSV guide", async () => {
    const root = await temporaryDirectory();
    const archive = join(root, "cnf.zip");
    await writeFixtureZip(archive);
    const expectedFiles = [...CNF_ARCHIVE_CSV_PATHS, GUIDE_PATH];

    await expect(
      parseCnfArchive({
        archivePath: archive,
        destinationDirectory: join(root, "implicit-guide"),
        expectedFiles,
        context: { releaseKey: "cnf-synthetic" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARCHIVE_ENTRY" });
    await expect(
      parseCnfArchive({
        archivePath: archive,
        destinationDirectory: join(root, "csv-guide"),
        expectedFiles: [...CNF_ARCHIVE_CSV_PATHS, "Extra.csv"],
        guideFiles: ["Extra.csv"],
        context: { releaseKey: "cnf-synthetic" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARCHIVE_ENTRY" });
  });

  it("rejects unlisted or case-mismatched members during full preflight before extraction", async () => {
    const root = await temporaryDirectory();
    const archive = join(root, "cnf.zip");
    await writeFixtureZip(archive);
    const output = join(root, "unexpected-guide");
    await expect(
      parseCnfArchive({
        archivePath: archive,
        destinationDirectory: output,
        expectedFiles: CNF_ARCHIVE_CSV_PATHS,
        context: { releaseKey: "cnf-synthetic" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARCHIVE_ENTRY" });
    expect(await readdir(output)).toEqual([]);

    const wrongCaseArchive = join(root, "wrong-case.zip");
    await writeFixtureZip(wrongCaseArchive, {
      "Food_Name.csv": null,
      "food_name.csv": CSV_FIXTURES["Food_Name.csv"],
    });
    await expect(
      parseCnfArchive({
        archivePath: wrongCaseArchive,
        destinationDirectory: join(root, "wrong-case"),
        expectedFiles: [
          ...CNF_ARCHIVE_CSV_PATHS.filter((path) => path !== "Food_Name.csv"),
          "food_name.csv",
          GUIDE_PATH,
        ],
        guideFiles: [GUIDE_PATH],
        context: { releaseKey: "cnf-synthetic" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARCHIVE_ENTRY" });
  });

  it("fails closed on invalid UTF-8, duplicate headers, row-width drift, and row limits", async () => {
    const cases: readonly {
      readonly label: string;
      readonly path: CnfArchiveCsvPath;
      readonly data: Buffer | string;
      readonly expectedCode: string;
    }[] = [
      {
        label: "invalid UTF-8",
        path: "Nutrient_Name.csv",
        data: Buffer.concat([
          Buffer.from("Nutrient_Code,Nutrient_Name_EN\n208,"),
          Buffer.from([0xc3, 0x28]),
        ]),
        expectedCode: "INVALID_RECORD",
      },
      {
        label: "duplicate headers",
        path: "Food_Source.csv",
        data: "Food_Source_ID,Food_Source_ID\n1,2\n",
        expectedCode: "DUPLICATE_KEY",
      },
      {
        label: "non-exact header whitespace",
        path: "Food_Source.csv",
        data: " Food_Source_ID,Food_Source_Description_EN\n1,Calculated\n",
        expectedCode: "INVALID_RECORD",
      },
      {
        label: "row-width drift",
        path: "Measure_Type.csv",
        data: "Measure_Type_Code,Measure_Type_Description_EN\n6\n",
        expectedCode: "INVALID_RECORD",
      },
    ];
    for (const fixture of cases) {
      const root = await temporaryDirectory();
      const archive = join(root, `${fixture.label}.zip`);
      await writeFixtureZip(archive, { [fixture.path]: fixture.data });
      await expect(
        parseCnfArchive({
          archivePath: archive,
          destinationDirectory: join(root, "out"),
          expectedFiles: [...CNF_ARCHIVE_CSV_PATHS, GUIDE_PATH],
          guideFiles: [GUIDE_PATH],
          context: { releaseKey: "cnf-synthetic" },
        }),
      ).rejects.toMatchObject({ code: fixture.expectedCode });
    }

    const root = await temporaryDirectory();
    const archive = join(root, "row-limit.zip");
    await writeFixtureZip(archive);
    await expect(
      parseCnfArchive({
        archivePath: archive,
        destinationDirectory: join(root, "out"),
        expectedFiles: [...CNF_ARCHIVE_CSV_PATHS, GUIDE_PATH],
        guideFiles: [GUIDE_PATH],
        context: { releaseKey: "cnf-synthetic" },
        delimitedLimits: { maxRows: 1 },
      }),
    ).rejects.toMatchObject({ code: "INVALID_RECORD" });
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "nutrition-cnf-archive-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function descriptorTarget(fd: number): string {
  try {
    return readlinkSync(`/proc/self/fd/${fd}`);
  } catch {
    return "";
  }
}

function methodPrototype(value: object, method: string): object {
  let prototype = Object.getPrototypeOf(value);
  while (prototype !== null) {
    if (Object.hasOwn(prototype, method)) {
      return prototype;
    }
    prototype = Object.getPrototypeOf(prototype);
  }
  throw new Error(`Unable to locate prototype method ${method}`);
}

async function writeFixtureZip(
  archivePath: string,
  overrides: Readonly<Record<string, Buffer | string | null>> = {},
): Promise<void> {
  const files: { readonly name: string; readonly data: Buffer }[] = [];
  if (!Object.hasOwn(overrides, GUIDE_PATH)) {
    files.push({ name: GUIDE_PATH, data: Buffer.from("Synthetic non-data guide") });
  }
  for (const path of CNF_ARCHIVE_CSV_PATHS) {
    const override = overrides[path];
    if (override === null) continue;
    files.push({
      name: path,
      data: Buffer.isBuffer(override) ? override : Buffer.from(override ?? CSV_FIXTURES[path]),
    });
  }
  for (const [name, value] of Object.entries(overrides)) {
    if ((CNF_ARCHIVE_CSV_PATHS as readonly string[]).includes(name) || value === null) continue;
    files.push({ name, data: Buffer.isBuffer(value) ? value : Buffer.from(value) });
  }
  await writeFile(archivePath, makeStoredZip(files));
}

function makeStoredZip(files: readonly { readonly name: string; readonly data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name);
    const crc = crc32(file.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(file.data.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, file.data);

    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(0x0314, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(file.data.length, 20);
    directory.writeUInt32LE(file.data.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE((0o100600 << 16) >>> 0, 38);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, name);
    offset += local.length + name.length + file.data.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
