import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { FoodSourceManifestV4 } from "@nutrition-tracker/ingestion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveFdcCsvInspectionPaths, runCommand } from "../src/run.js";

const databaseOpenAttempt = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("DATABASE_OPEN_CALLED");
  }),
);
vi.mock("@nutrition-tracker/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@nutrition-tracker/db")>()),
  createDatabaseFromEnvironment: databaseOpenAttempt,
}));

const WORKSPACE_ROOT = resolve(import.meta.dirname, "../../..");
const CANDIDATE = join(
  WORKSPACE_ROOT,
  "data/manifests/usda-fdc-full-csv-2026-04-30.candidate.json",
);
const PREFIX = "synthetic-full-fdc";
const PATHS = Object.freeze({
  food: `${PREFIX}/food.csv`,
  branded: `${PREFIX}/branded_food.csv`,
  foodNutrient: `${PREFIX}/food_nutrient.csv`,
  nutrient: `${PREFIX}/nutrient.csv`,
  derivation: `${PREFIX}/food_nutrient_derivation.csv`,
  portion: `${PREFIX}/food_portion.csv`,
  measureUnit: `${PREFIX}/measure_unit.csv`,
  reference: `${PREFIX}/food_category.csv`,
  guide: `${PREFIX}/Download_Field_Descriptions.pdf`,
});
const CSV: Readonly<Record<string, string | Buffer>> = Object.freeze({
  [PATHS.food]: [
    "fdc_id,data_type,description,publication_date",
    "100,source_foundation,Synthetic pear,2026-04-30",
    "200,source_branded,Synthetic oats,2026-04-30",
    "",
  ].join("\n"),
  [PATHS.branded]: [
    "fdc_id,brand_owner,gtin_upc,serving_size,serving_size_unit,household_serving_fulltext,market_country",
    "200,Example Foods,,30,g,1 packet (30 g),New Zealand",
    "",
  ].join("\n"),
  [PATHS.foodNutrient]: [
    "id,fdc_id,nutrient_id,amount,data_points,derivation_id,loq",
    "1,100,1008,0,3,49,",
    "2,200,1003,0,1,49,0.05",
    "",
  ].join("\n"),
  [PATHS.nutrient]: "id,name,unit_name\n1008,Energy,KCAL\n1003,Protein,G\n",
  [PATHS.derivation]: "id,code,description,source_id\n49,A,Analytical,1\n",
  [PATHS.portion]:
    "id,fdc_id,amount,measure_unit_id,portion_description,modifier,gram_weight\n10,100,1,1,100 g,,100\n",
  [PATHS.measureUnit]: "id,name\n1,gram\n",
  [PATHS.reference]: "id,description\n1,Fruit\n",
  [PATHS.guide]: Buffer.from("%PDF synthetic guide\n"),
});

const cleanupPaths: string[] = [];

beforeEach(() => {
  databaseOpenAttempt.mockClear();
});

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("fdc inspect-csv", () => {
  it("emits a non-authoritative baseline proposal, then passes the exact reviewed baseline", async () => {
    const fixture = await createFixture();
    const first = captureIo();
    const firstExit = await runCommand(command(fixture, "first"), first.io);

    expect(firstExit).toBe(1);
    expect(databaseOpenAttempt).not.toHaveBeenCalled();
    expect(first.outputs).toHaveLength(1);
    const proposal = first.outputs[0] as InspectionOutput;
    expect(proposal).toMatchObject({
      reportKind: "usda-fdc-full-csv-inspection-v1",
      schemaVersion: 1,
      baselineReview: {
        kind: "non-qualifying-local-baseline-comparison-v1",
        manifestExpectationsMatched: false,
        qualifiesAsAcquisitionOrApprovalEvidence: false,
        status: "review-required",
      },
      localVerification: {
        kind: "non-qualifying-local-artifact-verification-v1",
        qualifiesAsAcquisitionObservation: false,
        status: "verified-against-manifest-pins",
      },
      metrics: { acceptedFoodCount: 2, quarantinedFoodCount: 0 },
    });
    expect(first.errors.join("\n")).toContain("non-qualifying baseline proposal");
    expect(JSON.stringify(proposal)).not.toMatch(
      /"(?:actor|operatorPrincipalId|artifact|acquisitionId|observedAt|freshDownload|downloadUrl|resolvedUrl|approval|approved|promotionEligible)"/u,
    );

    const manifest = await readManifest(fixture.manifestPath);
    manifest.validation.releaseSpecificExpectations = {
      ...manifest.validation.releaseSpecificExpectations,
      ...proposal.baseline,
    };
    await writeFile(fixture.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const second = captureIo();
    const secondExit = await runCommand(command(fixture, "second"), second.io);

    expect(secondExit).toBe(0);
    expect(second.errors).toEqual([]);
    expect(second.outputs).toHaveLength(1);
    expect(second.outputs[0]).toMatchObject({
      baseline: proposal.baseline,
      baselineReview: {
        manifestExpectationsMatched: true,
        mismatches: [],
        qualifiesAsAcquisitionOrApprovalEvidence: false,
        status: "matched-manifest-expectations",
      },
    });
    expect(databaseOpenAttempt).not.toHaveBeenCalled();

    const changedContextManifest = await readManifest(fixture.manifestPath);
    changedContextManifest.validation.releaseSpecificExpectations[
      "fdcCsvDataTypeMapping:__proto__"
    ] = "Experimental";
    await writeFile(fixture.manifestPath, `${JSON.stringify(changedContextManifest, null, 2)}\n`);
    const changedContext = captureIo();
    expect(await runCommand(command(fixture, "changed-context"), changedContext.io)).toBe(1);
    expect((changedContext.outputs[0] as BaselineOutput).baselineReview.mismatches).toContainEqual(
      expect.objectContaining({ key: "parserBaselineCsvContextDigest" }),
    );

    const staleManifest = await readManifest(fixture.manifestPath);
    staleManifest.validation.releaseSpecificExpectations["fdcCsvDataTypeMapping:__proto__"] =
      "Foundation";
    staleManifest.validation.releaseSpecificExpectations.parserBaselineCsvStaleSynthetic = 1;
    await writeFile(fixture.manifestPath, `${JSON.stringify(staleManifest, null, 2)}\n`);
    const stale = captureIo();
    expect(await runCommand(command(fixture, "stale-baseline"), stale.io)).toBe(1);
    expect((stale.outputs[0] as BaselineOutput).baselineReview.mismatches).toContainEqual(
      expect.objectContaining({ issue: "unexpected", key: "parserBaselineCsvStaleSynthetic" }),
    );
  });

  it("rejects authority-shaped options and Windows paths before reading a manifest", async () => {
    const fixture = await createFixture();
    const actorAttempt = captureIo();
    expect(
      await runCommand([...command(fixture, "actor"), "--actor", "owner"], actorAttempt.io),
    ).toBe(1);
    expect(actorAttempt.errors.join("\n")).toContain("Unknown fdc inspect-csv option: --actor");

    const windowsAttempt = captureIo();
    const argv = command(fixture, "windows");
    argv[2] = "C:\\Users\\example\\manifest.json";
    expect(await runCommand(argv, windowsAttempt.io)).toBe(1);
    expect(windowsAttempt.errors.join("\n")).toContain(
      "FDC CSV manifest must be a relative Linux path",
    );

    const mountAttempt = captureIo();
    const mountArgv = command(fixture, "mount");
    mountArgv[2] = "/mnt/c/Users/example/manifest.json";
    expect(await runCommand(mountArgv, mountAttempt.io)).toBe(1);
    expect(mountAttempt.errors.join("\n")).toContain(
      "FDC CSV manifest must be a relative Linux path",
    );

    const prototypeOption = captureIo();
    expect(
      await runCommand([...command(fixture, "prototype"), "--__proto__", "x"], prototypeOption.io),
    ).toBe(1);
    expect(prototypeOption.errors.join("\n")).toContain("Unknown fdc inspect-csv option");

    const root = join(WORKSPACE_ROOT, fixture.rootRelative);
    const escapeLink = join(root, "escape-link");
    await symlink(join(WORKSPACE_ROOT, "packages"), escapeLink, "dir");
    const escapeAttempt = captureIo();
    const escapeArgv = command(fixture, "escape");
    escapeArgv[6] = `${fixture.rootRelative}/escape-link`;
    expect(await runCommand(escapeArgv, escapeAttempt.io)).toBe(1);
    expect(escapeAttempt.errors.join("\n")).toContain(
      "resolves outside its required repository subtree",
    );

    const shared = join(root, "shared");
    await mkdir(shared, { mode: 0o700 });
    await symlink(shared, join(root, "cache-alias"), "dir");
    await symlink(shared, join(root, "extract-alias"), "dir");
    const aliasAttempt = captureIo();
    const aliasArgv = command(fixture, "aliases");
    aliasArgv[6] = `${fixture.rootRelative}/cache-alias`;
    aliasArgv[8] = `${fixture.rootRelative}/extract-alias`;
    expect(await runCommand(aliasArgv, aliasAttempt.io)).toBe(1);
    expect(aliasAttempt.errors.join("\n")).toContain(
      "cache and extraction directories must be disjoint",
    );

    const artifactOverlap = captureIo();
    const overlapArgv = command(fixture, "artifact-overlap");
    overlapArgv[6] = fixture.artifactRelative;
    expect(await runCommand(overlapArgv, artifactOverlap.io)).toBe(1);
    expect(artifactOverlap.errors.join("\n")).toContain(
      "artifact, cache, and extraction paths must be disjoint",
    );
    expect(databaseOpenAttempt).not.toHaveBeenCalled();
  });

  it("rejects incomplete mapping coverage and oversized pins before acquisition", async () => {
    const fixture = await createFixture();
    const incomplete = await readManifest(fixture.manifestPath);
    delete incomplete.validation.releaseSpecificExpectations["fdcCsvDataTypeMapping:source_fndds"];
    await writeFile(fixture.manifestPath, `${JSON.stringify(incomplete, null, 2)}\n`);
    const incompleteAttempt = captureIo();
    expect(await runCommand(command(fixture, "incomplete-map"), incompleteAttempt.io)).toBe(1);
    expect(incompleteAttempt.errors.join("\n")).toContain(
      "data-type mappings must cover every reviewed manifest data type",
    );

    const oversized = await readManifest(fixture.manifestPath);
    oversized.validation.releaseSpecificExpectations["fdcCsvDataTypeMapping:source_fndds"] =
      "FNDDS";
    oversized.artifact.byteSize = 1_000_000_001;
    await writeFile(fixture.manifestPath, `${JSON.stringify(oversized, null, 2)}\n`);
    const oversizedAttempt = captureIo();
    expect(await runCommand(command(fixture, "oversized"), oversizedAttempt.io)).toBe(1);
    expect(oversizedAttempt.errors.join("\n")).toContain("exceeds maxBytes");
    expect(databaseOpenAttempt).not.toHaveBeenCalled();
  });

  it("rejects symlinked manifest and local-data authority roots", async () => {
    const options = Object.freeze({
      artifact: ".local-data/release.zip",
      "cache-dir": ".local-data/cache",
      "extract-dir": ".local-data/extract",
    });

    const localDataRoot = join(
      WORKSPACE_ROOT,
      ".local-data",
      `fdc-csv-root-test-${process.pid}-${randomUUID()}`,
    );
    cleanupPaths.push(localDataRoot);
    await mkdir(join(localDataRoot, "data/manifests"), { mode: 0o700, recursive: true });
    await mkdir(join(localDataRoot, "redirected-local-data"), { mode: 0o700 });
    await symlink(
      join(localDataRoot, "redirected-local-data"),
      join(localDataRoot, ".local-data"),
      "dir",
    );
    await expect(
      resolveFdcCsvInspectionPaths(["data/manifests/release.json"], options, localDataRoot),
    ).rejects.toThrow("FDC CSV local-data root must be a real directory");

    const manifestRoot = join(
      WORKSPACE_ROOT,
      ".local-data",
      `fdc-csv-root-test-${process.pid}-${randomUUID()}`,
    );
    cleanupPaths.push(manifestRoot);
    await mkdir(join(manifestRoot, "data/redirected-manifests"), {
      mode: 0o700,
      recursive: true,
    });
    await mkdir(join(manifestRoot, ".local-data"), { mode: 0o700 });
    await symlink(
      join(manifestRoot, "data/redirected-manifests"),
      join(manifestRoot, "data/manifests"),
      "dir",
    );
    await expect(
      resolveFdcCsvInspectionPaths(["data/manifests/release.json"], options, manifestRoot),
    ).rejects.toThrow("FDC CSV manifest root must be a real directory");
  });
});

interface MutableManifest
  extends Omit<FoodSourceManifestV4, "artifact" | "ingestion" | "validation"> {
  artifact: Omit<FoodSourceManifestV4["artifact"], "byteSize" | "sha256"> & {
    byteSize: number | null;
    sha256: string | null;
  };
  ingestion: Omit<FoodSourceManifestV4["ingestion"], "parserBuildSha256" | "parserVersion"> & {
    parserBuildSha256: string | null;
    parserVersion: string | null;
  };
  validation: {
    rules: string[];
    expectedFiles: string[];
    releaseSpecificExpectations: Record<string, boolean | number | string>;
  };
}

interface InspectionOutput {
  readonly baseline: Readonly<Record<string, number | string>>;
  readonly [key: string]: unknown;
}

interface BaselineOutput {
  readonly baselineReview: {
    readonly mismatches: readonly {
      readonly issue: string;
      readonly key: string;
    }[];
  };
}

interface Fixture {
  readonly artifactRelative: string;
  readonly manifestPath: string;
  readonly manifestRelative: string;
  readonly rootRelative: string;
}

async function createFixture(): Promise<Fixture> {
  const identifier = `${process.pid}-${randomUUID()}`;
  const rootRelative = `.local-data/fdc-csv-cli-test-${identifier}`;
  const root = join(WORKSPACE_ROOT, rootRelative);
  await mkdir(root, { mode: 0o700, recursive: true });
  cleanupPaths.push(root);
  const artifactRelative = `${rootRelative}/release.zip`;
  const artifactPath = join(WORKSPACE_ROOT, artifactRelative);
  const bytes = makeStoredZip(
    Object.entries(CSV).map(([name, value]) => ({
      name,
      data: Buffer.isBuffer(value) ? value : Buffer.from(value),
    })),
  );
  await writeFile(artifactPath, bytes, { mode: 0o600 });

  const manifestRelative = `data/manifests/.fdc-csv-cli-test-${identifier}.json`;
  const manifestPath = join(WORKSPACE_ROOT, manifestRelative);
  cleanupPaths.push(manifestPath);
  const manifest = await readManifest(CANDIDATE);
  manifest.artifact.sha256 = createHash("sha256").update(bytes).digest("hex");
  manifest.artifact.byteSize = bytes.length;
  manifest.ingestion.parserVersion = "0.1.0";
  manifest.ingestion.parserBuildSha256 = "b".repeat(64);
  manifest.validation.expectedFiles = Object.keys(CSV);
  manifest.validation.releaseSpecificExpectations = {
    fdcCsvDefaultMarketCode: "US",
    "fdcCsvDataTypeMapping:__proto__": "Foundation",
    "fdcCsvDataTypeMapping:constructor": "Experimental",
    "fdcCsvDataTypeMapping:source_branded": "Branded",
    "fdcCsvDataTypeMapping:source_experimental": "Experimental",
    "fdcCsvDataTypeMapping:source_fndds": "FNDDS",
    "fdcCsvDataTypeMapping:source_foundation": "Foundation",
    "fdcCsvDataTypeMapping:source_sr_legacy": "SR Legacy",
    "fdcCsvMarketMapping:New Zealand": "NZ",
    "fdcCsvMarketMapping:constructor": "NZ",
    "fdcCsvMarketMapping:toString": "US",
    "fdcCsvMarketMapping:United States": "US",
    ...fileDispositionExpectations(),
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  return { artifactRelative, manifestPath, manifestRelative, rootRelative };
}

async function readManifest(path: string): Promise<MutableManifest> {
  return JSON.parse(await readFile(path, "utf8")) as MutableManifest;
}

function fileDispositionExpectations(): Record<string, string> {
  return {
    [`fdcCsvDisposition:${PATHS.food}`]: "adapter-input:food-v1",
    [`fdcCsvDisposition:${PATHS.branded}`]: "adapter-input:branded-food-v1",
    [`fdcCsvDisposition:${PATHS.foodNutrient}`]: "adapter-input:food-nutrient-v1",
    [`fdcCsvDisposition:${PATHS.nutrient}`]: "adapter-input:nutrient-v1",
    [`fdcCsvDisposition:${PATHS.derivation}`]: "adapter-input:food-nutrient-derivation-v1",
    [`fdcCsvDisposition:${PATHS.portion}`]: "adapter-input:food-portion-v1",
    [`fdcCsvDisposition:${PATHS.measureUnit}`]: "adapter-input:measure-unit-v1",
    [`fdcCsvDisposition:${PATHS.reference}`]: "reference-only:unmaterialized-supporting-table-v1",
    [`fdcCsvDisposition:${PATHS.guide}`]: "guide:publisher-documentation-v1",
  };
}

function command(fixture: Fixture, label: string): string[] {
  return [
    "fdc",
    "inspect-csv",
    fixture.manifestRelative,
    "--artifact",
    fixture.artifactRelative,
    "--cache-dir",
    `${fixture.rootRelative}/cache-${label}`,
    "--extract-dir",
    `${fixture.rootRelative}/extract-${label}`,
  ];
}

function captureIo() {
  const outputs: unknown[] = [];
  const errors: string[] = [];
  return {
    errors,
    outputs,
    io: {
      environment: { INGEST_PARSER_BUILD_SHA256: "b".repeat(64) },
      writeError: (value: string) => errors.push(value),
      writeOutput: (value: string) => outputs.push(JSON.parse(value) as unknown),
    },
  };
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
