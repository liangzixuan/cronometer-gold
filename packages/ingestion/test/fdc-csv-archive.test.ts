import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertFdcCsvSpoolIdentityContinuity,
  type FdcCsvFileContract,
  IngestionError,
  parseFdcCsvArchive,
  sha256CanonicalJson,
} from "../src/index.js";

const temporaryDirectories: string[] = [];
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
  guide: `${PREFIX}/synthetic-publisher-guide.pdf`,
});

const CONTRACTS: readonly FdcCsvFileContract[] = Object.freeze([
  adapter(PATHS.food, "food"),
  adapter(PATHS.branded, "branded-food"),
  adapter(PATHS.foodNutrient, "food-nutrient"),
  adapter(PATHS.nutrient, "nutrient"),
  adapter(PATHS.derivation, "food-nutrient-derivation"),
  adapter(PATHS.portion, "food-portion"),
  adapter(PATHS.measureUnit, "measure-unit"),
  Object.freeze({
    archivePath: PATHS.reference,
    role: "reference-only",
    referenceOnlyReason: "unmaterialized-supporting-table-v1",
  }),
  Object.freeze({
    archivePath: PATHS.guide,
    role: "guide",
    referenceOnlyReason: "publisher-documentation-v1",
  }),
]);

const CSV: Readonly<Record<string, string | Buffer>> = Object.freeze({
  [PATHS.food]: [
    "fdc_id,data_type,description,publication_date",
    "300,source_branded,Rejected market cereal,2026-04-30",
    "100,source_foundation,Synthetic pear,2026-04-30",
    "200,source_branded,Synthetic oats,2026-04-30",
    "",
  ].join("\r\n"),
  [PATHS.branded]: [
    "fdc_id,brand_owner,gtin_upc,serving_size,serving_size_unit,household_serving_fulltext,market_country",
    "300,Example Foods,,45,g,1 bowl (45 g),Atlantis",
    "200,Example Foods,00012345600012,30,g,1 packet (30 g),New Zealand",
    "",
  ].join("\r\n"),
  [PATHS.foodNutrient]: [
    "id,fdc_id,nutrient_id,amount,data_points,derivation_id,loq",
    "3,300,1003,2,1,49,",
    "1,100,1008,0,3,49,0",
    "2,200,1003,0,1,49,0.05",
    "",
  ].join("\r\n"),
  [PATHS.nutrient]: [
    "id,name,unit_name,nutrient_nbr",
    "1008,Energy,KCAL,208",
    "1003,Protein,G,203",
    "",
  ].join("\r\n"),
  [PATHS.derivation]: ["id,code,description,source_id", "49,A,Analytical,1", ""].join("\r\n"),
  [PATHS.portion]: [
    "id,fdc_id,amount,measure_unit_id,portion_description,modifier,gram_weight",
    "30,300,1,1,serving,,45",
    "20,200,1,1,invalid source portion,,0",
    "10,100,1,1,100 g,,100",
    "",
  ].join("\r\n"),
  [PATHS.measureUnit]: "id,name,abbreviation\r\n1,gram,g\r\n",
  [PATHS.reference]: "id,code,description\r\n1,100,Fruit\r\n",
  [PATHS.guide]: Buffer.from("%PDF synthetic guide\n"),
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("full FDC CSV archive inspection", () => {
  it("rejects a different inode at the creation-to-seal boundary", () => {
    const created = {
      birthtimeMs: 1_700_000_000_000,
      device: 7,
      inode: 11,
      mode: 0o600,
      nlink: 1,
      uid: 1000,
    };
    expect(() =>
      assertFdcCsvSpoolIdentityContinuity(created, { ...created, inode: 12 }),
    ).toThrowError("FDC spool file identity changed between creation and sealing");
    expect(() =>
      assertFdcCsvSpoolIdentityContinuity(created, {
        ...created,
        birthtimeMs: created.birthtimeMs + 1,
      }),
    ).toThrowError("FDC spool file identity changed between creation and sealing");
  });

  it("rejects public archive-limit overrides that exceed the inspector hard bounds", async () => {
    const root = await temporaryDirectory();
    const archive = join(root, "archive-limit-overrides.zip");
    await writeFixtureZip(archive);
    const bytes = await readFile(archive);
    const unsafeLimits = [
      { maxEntries: Number.POSITIVE_INFINITY },
      { maxEntries: 257 },
      { maxFileBytes: 4_000_000_001 },
      { maxTotalBytes: 5_000_000_001 },
      { maxCompressionRatio: Number.POSITIVE_INFINITY },
      { maxCompressionRatio: 250.1 },
      { expectedFiles: ["attacker-controlled.csv"] },
    ] as const;

    for (const [index, archiveLimits] of unsafeLimits.entries()) {
      await expect(
        parseFdcCsvArchive({
          archiveExpectation: expectation(bytes),
          archiveLimits,
          archivePath: archive,
          context: context(),
          destinationDirectory: join(root, `archive-limit-${index}`),
          expectedFiles: Object.keys(CSV),
          fileContracts: CONTRACTS,
          processingLimits: { partitionCount: 2 },
        }),
      ).rejects.toMatchObject({ code: "INVALID_RECORD" });
    }

    await expect(
      parseFdcCsvArchive({
        archiveExpectation: expectation(bytes),
        archivePath: archive,
        context: context(),
        destinationDirectory: join(root, "excessive-partition-count"),
        expectedFiles: Object.keys(CSV),
        fileContracts: CONTRACTS,
        processingLimits: { partitionCount: 256 },
      }),
    ).rejects.toMatchObject({ code: "INVALID_RECORD" });
  });

  it("joins through bounded partitions and emits deterministic conservation evidence", async () => {
    const root = await temporaryDirectory();
    const firstArchive = join(root, "first.zip");
    const secondArchive = join(root, "second.zip");
    await writeFixtureZip(firstArchive);
    await writeFixtureZip(secondArchive, {}, [...Object.keys(CSV)].reverse());

    const first = await inspect(firstArchive, join(root, "first"), CONTRACTS);
    const second = await inspect(
      secondArchive,
      join(root, "second"),
      [...CONTRACTS].reverse(),
      [...Object.keys(CSV)].reverse(),
    );

    expect(second).toEqual(first);
    expect(first.archive).toMatchObject({
      expectedFiles: [...Object.keys(CSV)].sort(),
      inventoryCount: 9,
      inventorySha256: sha256CanonicalJson([...Object.keys(CSV)].sort()),
    });
    expect(first.metrics).toEqual({
      acceptedFoodCount: 2,
      adapterInputDataRowCount: 15,
      derivedLabelServingCount: 1,
      excludedAttributeCount: 0,
      excludedNutrientCount: 0,
      excludedPortionCount: 1,
      guideCount: 1,
      parsedCsvRowCount: 16,
      quarantinedFoodCount: 1,
      referenceOnlyDataRowCount: 1,
      stagedNutrientCount: 2,
      stagedPortionCount: 1,
    });
    expect(first.conservation).toEqual({
      brandedFoods: { acceptedParentCount: 1, quarantinedParentCount: 1, sourceCount: 2 },
      foodNutrients: {
        emittedCount: 2,
        excludedCount: 0,
        quarantinedParentCount: 1,
        sourceCount: 3,
      },
      foodPortions: {
        emittedCount: 1,
        excludedCount: 1,
        quarantinedParentCount: 1,
        sourceCount: 3,
      },
      foods: { acceptedCount: 2, quarantinedCount: 1, sourceCount: 3 },
      foodNutrientDerivations: { referencedCount: 1, sourceCount: 1, unreferencedCount: 0 },
      measureUnits: { referencedCount: 1, sourceCount: 1, unreferencedCount: 0 },
      nutrients: { referencedCount: 2, sourceCount: 2, unreferencedCount: 0 },
    });
    expect(first.exclusionReasonCounts).toEqual({ INVALID_RECORD: 2 });
    expect(first.processing).toMatchObject({
      algorithm: "sha256-prefix-mod-v1",
      partitionCount: 2,
      spoolByteSize: expect.any(Number),
    });
    expect(first.processing.spoolByteSize).toBeGreaterThan(0);
    expect(first.processing.maximumObservedPartitionRows).toBeGreaterThan(0);
    expect(first.semanticEvidence.canonicalAcceptedRecords).toMatchObject({
      count: 2,
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(first.contextSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(first.sourceMixEvidence).toMatchObject({
      acceptedDataTypeCounts: { Branded: 1, Foundation: 1 },
      acceptedMarketCounts: { NZ: 1, US: 1 },
      mappedDataTypeCounts: { Branded: 2, Foundation: 1 },
      mappedMarketCounts: { NZ: 1, US: 1 },
      rawDataTypeCounts: { source_branded: 2, source_foundation: 1 },
      rawMarketCounts: {
        "<invalid-or-unmapped>": 1,
        "<non-branded-default>": 1,
        "New Zealand": 1,
      },
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(first.gtinEvidence).toMatchObject({
      assignmentCount: 1,
      collisionAssignmentCount: 0,
      collisionCount: 0,
      uniqueCount: 1,
    });
    expect(first.tableEvidenceSha256).toBe(sha256CanonicalJson(first.tables));
    expect(first.tables.map((table) => table.archivePath)).toEqual(
      Object.keys(CSV)
        .filter((path) => path !== PATHS.guide)
        .sort(),
    );
    expect(await readdir(join(root, "first", PREFIX))).toEqual(
      Object.keys(CSV)
        .filter((path) => path !== PATHS.guide)
        .map((path) => path.slice(PREFIX.length + 1))
        .sort(),
    );
    await expect(readFile(join(root, "first", PATHS.guide))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await readdir(join(root, "first"))).filter((name) => name.startsWith(".fdc"))).toEqual(
      [],
    );
  });

  it("rejects incomplete or ambiguous explicit file contracts before extraction", async () => {
    const root = await temporaryDirectory();
    const archive = join(root, "release.zip");
    await writeFixtureZip(archive);

    await expect(
      inspect(
        archive,
        join(root, "missing-role"),
        CONTRACTS.filter((contract) => contract.role !== "measure-unit"),
      ),
    ).rejects.toMatchObject({ code: "INVALID_ARCHIVE_ENTRY" });
    await expect(
      inspect(archive, join(root, "csv-guide"), [
        ...CONTRACTS.filter((contract) => contract.archivePath !== PATHS.reference),
        {
          archivePath: PATHS.reference,
          role: "guide",
          referenceOnlyReason: "publisher-documentation-v1",
        },
      ]),
    ).rejects.toMatchObject({ code: "INVALID_ARCHIVE_ENTRY" });
  });

  it("fails closed on orphan relations and removes only extracted parser inputs", async () => {
    const root = await temporaryDirectory();
    const archive = join(root, "orphan.zip");
    await writeFixtureZip(archive, {
      [PATHS.foodNutrient]: [
        "id,fdc_id,nutrient_id,amount,data_points,derivation_id,loq",
        "1,999,1008,10,1,49,",
        "",
      ].join("\n"),
    });
    const destination = join(root, "out");

    await expect(inspect(archive, destination)).rejects.toMatchObject({
      code: "INVALID_RECORD",
      message: "FDC food-nutrient row has no food parent",
    });
    expect(await readdir(destination)).toEqual([PREFIX]);
    expect(await readdir(join(destination, PREFIX))).toEqual([]);
  });

  it("isolates missing child lookups without discarding a valid parent", async () => {
    const root = await temporaryDirectory();
    const archive = join(root, "child-isolation.zip");
    await writeFixtureZip(archive, {
      [PATHS.foodNutrient]: [
        "id,fdc_id,nutrient_id,amount,data_points,derivation_id,loq",
        "3,300,1003,2,1,49,",
        "1,100,1008,0,3,49,",
        "4,100,9999,1,1,,",
        "2,200,1003,0,1,49,0.05",
        "",
      ].join("\n"),
      [PATHS.portion]: [
        "id,fdc_id,amount,measure_unit_id,portion_description,modifier,gram_weight",
        "30,300,1,1,serving,,45",
        "20,200,1,1,invalid source portion,,0",
        "10,100,1,1,100 g,,100",
        "40,100,1,999,missing measure,,25",
        "",
      ].join("\n"),
    });

    const result = await inspect(archive, join(root, "out"));
    expect(result.metrics).toMatchObject({
      acceptedFoodCount: 2,
      excludedNutrientCount: 1,
      excludedPortionCount: 2,
      quarantinedFoodCount: 1,
      stagedNutrientCount: 2,
      stagedPortionCount: 1,
    });
    expect(result.conservation.foodNutrients).toEqual({
      emittedCount: 2,
      excludedCount: 1,
      quarantinedParentCount: 1,
      sourceCount: 4,
    });
    expect(result.conservation.foodPortions).toEqual({
      emittedCount: 1,
      excludedCount: 2,
      quarantinedParentCount: 1,
      sourceCount: 4,
    });
  });

  it("fails fast on operational adapter errors instead of quarantining them", async () => {
    const root = await temporaryDirectory();
    const archive = join(root, "operational-error.zip");
    await writeFixtureZip(archive);
    const bytes = await readFile(archive);

    await expect(
      parseFdcCsvArchive({
        archiveExpectation: expectation(bytes),
        archivePath: archive,
        context: {
          ...context(),
          mappingResolver: () => {
            throw new IngestionError("ARCHIVE_LIMIT_EXCEEDED", "synthetic resolver limit");
          },
        },
        destinationDirectory: join(root, "out"),
        expectedFiles: Object.keys(CSV),
        fileContracts: CONTRACTS,
        processingLimits: { partitionCount: 2 },
      }),
    ).rejects.toMatchObject({
      code: "ARCHIVE_LIMIT_EXCEEDED",
      message: "synthetic resolver limit",
    });
  });

  it("canonicalizes GTIN aliases while keeping markets separate", async () => {
    const root = await temporaryDirectory();
    const archive = join(root, "gtin-collision.zip");
    await writeFixtureZip(archive, {
      [PATHS.food]: [
        "fdc_id,data_type,description,publication_date",
        "300,source_branded,Rejected market cereal,2026-04-30",
        "100,source_foundation,Synthetic pear,2026-04-30",
        "200,source_branded,Synthetic oats,2026-04-30",
        "201,source_branded,Synthetic oats duplicate,2026-04-30",
        "202,source_branded,Synthetic US oats,2026-04-30",
        "",
      ].join("\n"),
      [PATHS.branded]: [
        "fdc_id,brand_owner,gtin_upc,serving_size,serving_size_unit,household_serving_fulltext,market_country",
        "300,Example Foods,,45,g,1 bowl (45 g),Atlantis",
        "200,Example Foods,036000291452,30,g,1 packet (30 g),New Zealand",
        "201,Example Foods,00036000291452,30,g,1 packet (30 g),New Zealand",
        "202,Example Foods,036000291452,30,g,1 packet (30 g),United States",
        "",
      ].join("\n"),
    });

    const result = await inspect(archive, join(root, "out"));
    expect(result.gtinEvidence).toMatchObject({
      assignmentCount: 3,
      collisionAssignmentCount: 2,
      collisionCount: 1,
      uniqueCount: 2,
    });
    expect(result.sourceMixEvidence.acceptedMarketCounts).toEqual({ NZ: 2, US: 2 });
  });

  it("covers every data type and scopes documented portion fallbacks", async () => {
    const root = await temporaryDirectory();
    const archive = join(root, "all-data-types.zip");
    await writeFixtureZip(archive, {
      [PATHS.food]: [
        "fdc_id,data_type,description,publication_date",
        "300,source_branded,Rejected market cereal,2026-04-30",
        "100,source_foundation,Synthetic pear,2026-04-30",
        "110,source_experimental,Synthetic experiment,2026-04-30",
        "120,source_fndds,Synthetic survey food,2024-10-31",
        "130,source_sr_legacy,Synthetic legacy food,2018-04-30",
        "200,source_branded,Synthetic oats,2026-04-30",
        "",
      ].join("\n"),
      [PATHS.portion]: [
        "id,fdc_id,amount,measure_unit_id,portion_description,modifier,gram_weight",
        "30,300,1,1,serving,,45",
        "20,200,1,1,invalid source portion,,0",
        "10,100,1,1,100 g,,100",
        "11,100,,1,blank amount must be excluded,,85",
        "12,120,,9999,1 cup synthetic,,240",
        "13,130,1,9999,,1 legacy measure,85",
        "",
      ].join("\n"),
      [PATHS.measureUnit]: "id,name,abbreviation\n1,gram,g\n9999,undetermined,\n",
    });

    const result = await inspect(archive, join(root, "out"));
    expect(result.sourceMixEvidence.acceptedDataTypeCounts).toEqual({
      Branded: 1,
      Experimental: 1,
      FNDDS: 1,
      Foundation: 1,
      "SR Legacy": 1,
    });
    expect(result.metrics).toMatchObject({
      acceptedFoodCount: 5,
      excludedPortionCount: 2,
      stagedPortionCount: 3,
    });
  });

  it("rejects a spool replacement before sealing and preserves the replacement", async () => {
    const root = await temporaryDirectory();
    const archive = join(root, "pre-seal-spool-replacement.zip");
    const identifiers = identifiersInSamePartition(140, 2);
    const description = "x".repeat(1024);
    await writeFixtureZip(archive, {
      [PATHS.food]: [
        "fdc_id,data_type,description,publication_date",
        ...identifiers.map(
          (identifier) => `${identifier},source_foundation,${description},2026-04-30`,
        ),
        "",
      ].join("\n"),
      [PATHS.branded]:
        "fdc_id,brand_owner,gtin_upc,serving_size,serving_size_unit,household_serving_fulltext,market_country\n",
      [PATHS.foodNutrient]: "id,fdc_id,nutrient_id,amount,data_points,derivation_id,loq\n",
      [PATHS.portion]:
        "id,fdc_id,amount,measure_unit_id,portion_description,modifier,gram_weight\n",
    });
    const destination = join(root, "out");
    const signal = new AbortController().signal;
    let replacementPath: string | null = null;
    Object.defineProperty(signal, "aborted", {
      configurable: true,
      get: () => {
        if (replacementPath !== null || !existsSync(destination)) return false;
        const spoolName = readdirSync(destination).find((name) =>
          name.startsWith(".fdc-csv-spool-"),
        );
        if (!spoolName) return false;
        const spoolRoot = join(destination, spoolName);
        const targetName = readdirSync(spoolRoot).find((name) => /^food-\d/u.test(name));
        if (!targetName) return false;
        const target = join(spoolRoot, targetName);
        const bytes = readFileSync(target);
        if (bytes.byteLength <= 64 * 1024) return false;
        unlinkSync(target);
        writeFileSync(target, bytes, { mode: 0o600 });
        replacementPath = target;
        return false;
      },
    });

    await expect(
      parseFdcCsvArchive({
        archiveExpectation: expectation(await readFile(archive)),
        archivePath: archive,
        context: context(),
        destinationDirectory: destination,
        expectedFiles: Object.keys(CSV),
        fileContracts: CONTRACTS,
        processingLimits: { partitionCount: 2 },
        signal,
      }),
    ).rejects.toBeDefined();
    expect(replacementPath).not.toBeNull();
    expect(existsSync(replacementPath as unknown as string)).toBe(true);
  });

  it("rejects a replaced sealed spool inode and preserves the replacement", async () => {
    const root = await temporaryDirectory();
    const archive = join(root, "spool-replacement.zip");
    await writeFixtureZip(archive);
    const destination = join(root, "out");
    const signal = new AbortController().signal;
    let replacementPath: string | null = null;
    Object.defineProperty(signal, "aborted", {
      configurable: true,
      get: () => {
        if (replacementPath !== null || !existsSync(destination)) return false;
        const spoolName = readdirSync(destination).find((name) =>
          name.startsWith(".fdc-csv-spool-"),
        );
        if (!spoolName) return false;
        const spoolRoot = join(destination, spoolName);
        const names = readdirSync(spoolRoot);
        if (
          !names.some((name) => name.startsWith("branded-food-")) ||
          !names.some((name) => name.startsWith("food-nutrient-")) ||
          !names.some((name) => name.startsWith("food-portion-")) ||
          !names.some((name) => /^food-\d/u.test(name))
        ) {
          return false;
        }
        const targetName = names.find((name) => /^food-\d/u.test(name));
        if (!targetName) return false;
        const target = join(spoolRoot, targetName);
        const bytes = readFileSync(target);
        unlinkSync(target);
        writeFileSync(target, bytes, { mode: 0o600 });
        replacementPath = target;
        return false;
      },
    });

    let failure: unknown;
    try {
      await parseFdcCsvArchive({
        archiveExpectation: expectation(await readFile(archive)),
        archivePath: archive,
        context: context(),
        destinationDirectory: destination,
        expectedFiles: Object.keys(CSV),
        fileContracts: CONTRACTS,
        processingLimits: { partitionCount: 2 },
        signal,
      });
    } catch (error) {
      failure = error;
    }
    expect(replacementPath).not.toBeNull();
    expect(failure).toBeInstanceOf(AggregateError);
    expect(existsSync(replacementPath as unknown as string)).toBe(true);
  });

  it("pins the spool root and preserves a same-name replacement directory", async () => {
    const root = await temporaryDirectory();
    const archive = join(root, "spool-root-replacement.zip");
    await writeFixtureZip(archive);
    const destination = join(root, "out");
    const signal = new AbortController().signal;
    let movedRoot: string | null = null;
    let replacementRoot: string | null = null;
    Object.defineProperty(signal, "aborted", {
      configurable: true,
      get: () => {
        if (replacementRoot !== null || !existsSync(destination)) return false;
        const spoolName = readdirSync(destination).find((name) =>
          name.startsWith(".fdc-csv-spool-"),
        );
        if (!spoolName) return false;
        const spoolRoot = join(destination, spoolName);
        if (readdirSync(spoolRoot).length === 0) return false;
        movedRoot = `${spoolRoot}.moved`;
        renameSync(spoolRoot, movedRoot);
        mkdirSync(spoolRoot, { mode: 0o700 });
        writeFileSync(join(spoolRoot, "sentinel.txt"), "preserve me", { mode: 0o600 });
        replacementRoot = spoolRoot;
        return false;
      },
    });

    await expect(
      parseFdcCsvArchive({
        archiveExpectation: expectation(await readFile(archive)),
        archivePath: archive,
        context: context(),
        destinationDirectory: destination,
        expectedFiles: Object.keys(CSV),
        fileContracts: CONTRACTS,
        processingLimits: { partitionCount: 2 },
        signal,
      }),
    ).rejects.toBeDefined();
    expect(replacementRoot).not.toBeNull();
    expect(existsSync(join(replacementRoot as unknown as string, "sentinel.txt"))).toBe(true);
    expect(movedRoot).not.toBeNull();
    const movedNames = readdirSync(movedRoot as unknown as string);
    expect(movedNames.some((name) => /^food-\d/u.test(name))).toBe(true);
    expect(movedNames.some((name) => name.startsWith("branded-food-"))).toBe(true);
    expect(movedNames.some((name) => name.startsWith("food-nutrient-"))).toBe(true);
    expect(movedNames.some((name) => name.startsWith("food-portion-"))).toBe(true);
  });

  const boundedFailureCases = [
    {
      label: "duplicate-definition",
      overrides: {
        [PATHS.nutrient]: "id,name,unit_name\n1003,Protein,G\n1003,Protein duplicate,G\n",
      },
      options: {},
      code: "DUPLICATE_KEY",
    },
    {
      label: "header-whitespace",
      overrides: {
        [PATHS.measureUnit]: "id, name,abbreviation\n1,gram,g\n",
      },
      options: {},
      code: "INVALID_RECORD",
    },
    {
      label: "row-limit",
      overrides: {},
      options: { delimitedLimits: { maxRows: 2 } },
      code: "INVALID_RECORD",
    },
    {
      label: "spool-limit",
      overrides: {},
      options: { processingLimits: { maxSpoolBytes: 32 } },
      code: "ARCHIVE_LIMIT_EXCEEDED",
    },
    {
      label: "combined-partition-limit",
      overrides: {},
      options: { processingLimits: { maxCombinedPartitionBytes: 32 } },
      code: "ARCHIVE_LIMIT_EXCEEDED",
    },
    {
      label: "definition-row-limit",
      overrides: {},
      options: { processingLimits: { maxDefinitionRows: 1 } },
      code: "ARCHIVE_LIMIT_EXCEEDED",
    },
    {
      label: "definition-byte-limit",
      overrides: {},
      options: { processingLimits: { maxDefinitionBytes: 1 } },
      code: "ARCHIVE_LIMIT_EXCEEDED",
    },
    {
      label: "partition-row-limit",
      overrides: {},
      options: { processingLimits: { maxPartitionRows: 1 } },
      code: "ARCHIVE_LIMIT_EXCEEDED",
    },
    {
      label: "partition-byte-limit",
      overrides: {},
      options: { processingLimits: { maxPartitionBytes: 32 } },
      code: "ARCHIVE_LIMIT_EXCEEDED",
    },
    {
      label: "combined-partition-row-limit",
      overrides: {},
      options: { processingLimits: { maxCombinedPartitionRows: 1 } },
      code: "ARCHIVE_LIMIT_EXCEEDED",
    },
    {
      label: "nutrient-fanout-limit",
      overrides: {
        [PATHS.foodNutrient]: [
          "id,fdc_id,nutrient_id,amount,data_points,derivation_id,loq",
          "3,300,1003,2,1,49,",
          "1,100,1008,0,3,49,0",
          "4,100,1003,1,1,49,",
          "2,200,1003,0,1,49,0.05",
          "",
        ].join("\n"),
      },
      options: { processingLimits: { maxNutrientsPerFood: 1 } },
      code: "ARCHIVE_LIMIT_EXCEEDED",
    },
    {
      label: "portion-fanout-limit",
      overrides: {
        [PATHS.portion]: [
          "id,fdc_id,amount,measure_unit_id,portion_description,modifier,gram_weight",
          "30,300,1,1,serving,,45",
          "10,100,1,1,100 g,,100",
          "11,100,1,1,second serving,,50",
          "20,200,1,1,invalid source portion,,0",
          "",
        ].join("\n"),
      },
      options: { processingLimits: { maxPortionsPerFood: 1 } },
      code: "ARCHIVE_LIMIT_EXCEEDED",
    },
    {
      label: "gtin-assignment-fanout-limit",
      overrides: {
        [PATHS.food]: [
          "fdc_id,data_type,description,publication_date",
          "300,source_branded,Rejected market cereal,2026-04-30",
          "100,source_foundation,Synthetic pear,2026-04-30",
          "200,source_branded,Synthetic oats,2026-04-30",
          "201,source_branded,Synthetic alias oats,2026-04-30",
          "",
        ].join("\n"),
        [PATHS.branded]: [
          "fdc_id,brand_owner,gtin_upc,serving_size,serving_size_unit,household_serving_fulltext,market_country",
          "300,Example Foods,,45,g,1 bowl (45 g),Atlantis",
          "200,Example Foods,036000291452,30,g,1 packet (30 g),New Zealand",
          "201,Example Foods,00036000291452,30,g,1 packet (30 g),New Zealand",
          "",
        ].join("\n"),
      },
      options: { processingLimits: { maxGtinAssignmentsPerKey: 1 } },
      code: "ARCHIVE_LIMIT_EXCEEDED",
    },
  ] as const;

  it.each(boundedFailureCases)("rejects the $label fixture", async (fixture) => {
    const root = await temporaryDirectory();
    const archive = join(root, `${fixture.label}.zip`);
    await writeFixtureZip(archive, fixture.overrides);
    const bytes = await readFile(archive);
    await expect(
      parseFdcCsvArchive({
        archiveExpectation: expectation(bytes),
        archivePath: archive,
        context: context(),
        destinationDirectory: join(root, "out"),
        expectedFiles: Object.keys(CSV),
        fileContracts: CONTRACTS,
        ...("delimitedLimits" in fixture.options
          ? { delimitedLimits: fixture.options.delimitedLimits }
          : {}),
        processingLimits: {
          partitionCount: 2,
          ...("processingLimits" in fixture.options ? fixture.options.processingLimits : {}),
        },
      }),
    ).rejects.toMatchObject({ code: fixture.code });
  });

  it("streams repeated partition spool flushes successfully", async () => {
    const root = await temporaryDirectory();
    const archive = join(root, "repeated-flushes.zip");
    const identifiers = identifiersInSamePartition(140, 2);
    const description = "x".repeat(1024);
    await writeFixtureZip(archive, {
      [PATHS.food]: [
        "fdc_id,data_type,description,publication_date",
        ...identifiers.map(
          (identifier) => `${identifier},source_foundation,${description},2026-04-30`,
        ),
        "",
      ].join("\n"),
      [PATHS.branded]:
        "fdc_id,brand_owner,gtin_upc,serving_size,serving_size_unit,household_serving_fulltext,market_country\n",
      [PATHS.foodNutrient]: "id,fdc_id,nutrient_id,amount,data_points,derivation_id,loq\n",
      [PATHS.portion]:
        "id,fdc_id,amount,measure_unit_id,portion_description,modifier,gram_weight\n",
    });

    const result = await inspect(archive, join(root, "out"));
    expect(result.metrics.acceptedFoodCount).toBe(140);
    expect(result.processing.spoolByteSize).toBeGreaterThan(140 * 1024);
    expect(result.processing.maximumObservedPartitionRows).toBe(140);
  });

  it("aborts during processing and preserves files outside parser-owned output", async () => {
    const root = await temporaryDirectory();
    const archive = join(root, "abort.zip");
    const destination = join(root, "out");
    const sentinel = join(root, "outside-sentinel.txt");
    await writeFixtureZip(archive);
    await writeFile(sentinel, "keep\n");
    const bytes = await readFile(archive);
    const signal = new AbortController().signal;
    Object.defineProperty(signal, "aborted", {
      configurable: true,
      get: () =>
        existsSync(destination) &&
        readdirSync(destination).some((name) => name.startsWith(".fdc-csv-spool-")),
    });

    await expect(
      parseFdcCsvArchive({
        archiveExpectation: expectation(bytes),
        archivePath: archive,
        context: context(),
        destinationDirectory: destination,
        expectedFiles: Object.keys(CSV),
        fileContracts: CONTRACTS,
        processingLimits: { partitionCount: 2 },
        signal,
      }),
    ).rejects.toMatchObject({ code: "ABORTED" });
    await expect(readFile(sentinel, "utf8")).resolves.toBe("keep\n");
    expect(readdirSync(destination).filter((name) => name.startsWith(".fdc"))).toEqual([]);
  });

  it("binds parsing to the caller's exact archive expectation", async () => {
    const root = await temporaryDirectory();
    const archive = join(root, "release.zip");
    await writeFixtureZip(archive);
    const bytes = await readFile(archive);
    await expect(
      parseFdcCsvArchive({
        archiveExpectation: { byteSize: bytes.length, sha256: "0".repeat(64) },
        archivePath: archive,
        context: context(),
        destinationDirectory: join(root, "out"),
        expectedFiles: Object.keys(CSV),
        fileContracts: CONTRACTS,
        processingLimits: { partitionCount: 2 },
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARCHIVE_ENTRY" });
  });
});

async function inspect(
  archive: string,
  destinationDirectory: string,
  contracts: readonly FdcCsvFileContract[] = CONTRACTS,
  expectedFiles: readonly string[] = Object.keys(CSV),
) {
  const bytes = await readFile(archive);
  return parseFdcCsvArchive({
    archiveExpectation: expectation(bytes),
    archivePath: archive,
    context: context(),
    destinationDirectory,
    expectedFiles,
    fileContracts: contracts,
    processingLimits: { partitionCount: 2 },
  });
}

function context() {
  return {
    releaseKey: "fdc-full-csv-synthetic",
    allowedDataTypes: ["Foundation", "Experimental", "FNDDS", "SR Legacy", "Branded"],
    allowedMarketCodes: ["US", "NZ"],
    dataTypeMappings: {
      source_branded: "Branded",
      source_experimental: "Experimental",
      source_fndds: "FNDDS",
      source_foundation: "Foundation",
      source_sr_legacy: "SR Legacy",
    },
    defaultMarketCode: "US",
    marketMappings: { "New Zealand": "NZ", "United States": "US" },
  } as const;
}

function adapter(
  archivePath: string,
  role: Exclude<FdcCsvFileContract["role"], "guide" | "reference-only">,
): FdcCsvFileContract {
  return Object.freeze({ archivePath, role, referenceOnlyReason: null });
}

function expectation(bytes: Buffer) {
  return {
    byteSize: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function identifiersInSamePartition(required: number, partitions: number): string[] {
  const buckets = Array.from({ length: partitions }, () => [] as string[]);
  for (let candidate = 1; candidate <= 10_000; candidate += 1) {
    const identifier = String(candidate);
    const partition = createHash("sha256").update(identifier).digest().readUInt32BE(0) % partitions;
    const bucket = buckets[partition];
    if (!bucket) continue;
    bucket.push(identifier);
    if (bucket.length === required) return bucket;
  }
  throw new Error("Unable to construct deterministic same-partition identifiers");
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "nutrition-fdc-csv-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeFixtureZip(
  archivePath: string,
  overrides: Readonly<Record<string, string | Buffer | null>> = {},
  order: readonly string[] = Object.keys(CSV),
): Promise<void> {
  const files = order.flatMap((name) => {
    const value = Object.hasOwn(overrides, name) ? overrides[name] : CSV[name];
    return value === null || value === undefined
      ? []
      : [{ name, data: Buffer.isBuffer(value) ? value : Buffer.from(value) }];
  });
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
