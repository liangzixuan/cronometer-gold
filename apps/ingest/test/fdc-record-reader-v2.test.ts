import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { JsonObject, JsonValue } from "@nutrition-tracker/db";
import {
  canonicalJson,
  createStagedFood,
  type StagedFoodRecord,
} from "@nutrition-tracker/ingestion";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type FdcRecordExportHeader,
  type FdcStagingPage,
  openVerifiedFdcRecordExportV2,
  postgresJsonTextByteUpperBound,
  type VerifiedFdcRecordExportV2,
} from "../src/fdc-record-reader-v2.js";

type MutableJsonObject = { [key: string]: JsonValue };

const hooks = vi.hoisted(() => ({
  afterOpen: undefined as undefined | ((path: string, handle: FileHandle) => Promise<void>),
  beforeRead: undefined as
    | undefined
    | ((path: string, position: number | bigint | null | undefined) => Promise<void>),
  beforeWrite: undefined as undefined | ((path: string) => Promise<void>),
  beforeClose: undefined as undefined | ((path: string) => Promise<void>),
  beforeUnlink: undefined as undefined | ((path: string) => Promise<void>),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const path = String(args[0]);
      const read = handle.read.bind(handle);
      const write = handle.writeFile.bind(handle);
      const close = handle.close.bind(handle);
      handle.read = (async (
        buffer: Buffer,
        offset: number,
        length: number,
        position: number | null,
      ) => {
        await hooks.beforeRead?.(path, position);
        return read(buffer, offset, length, position);
      }) as FileHandle["read"];
      handle.writeFile = async (...values: Parameters<FileHandle["writeFile"]>) => {
        await hooks.beforeWrite?.(path);
        return write(...values);
      };
      handle.close = async () => {
        await hooks.beforeClose?.(path);
        return close();
      };
      await hooks.afterOpen?.(path, handle);
      return handle;
    },
    unlink: async (path: string) => {
      await hooks.beforeUnlink?.(path);
      await actual.unlink(path);
    },
  };
});

const roots: string[] = [];
const readers: VerifiedFdcRecordExportV2[] = [];
const HEADER: FdcRecordExportHeader = {
  recordType: "header",
  format: "usda-fdc-csv-normalized-record-export-v1",
  schemaVersion: 1,
  authority: {
    acquisition: false,
    review: false,
    staging: false,
    promotion: false,
    activation: false,
  },
  artifactByteSize: 1024,
  artifactSha256: "a".repeat(64),
  manifestSha256: "b".repeat(64),
  parserBuildSha256: "c".repeat(64),
  parserPackage: "@nutrition-tracker/ingestion",
  parserVersion: "0.1.0",
  releaseKey: "synthetic-release",
  sourceCode: "USDA_FDC",
  ordering: "sha256-partition-then-fdc-id-v1",
};

afterEach(async () => {
  for (const key of Object.keys(hooks) as (keyof typeof hooks)[]) hooks[key] = undefined;
  await Promise.all(readers.splice(0).map((reader) => reader.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("V2 admitted streaming FDC record reader", () => {
  it("verifies before exposing deterministic numeric-sequence pages and exact request byte sizes", async () => {
    const fixture = await createFixture(records(501));
    const reader = await accept(fixture);
    expect(fixture.verifyInspection).toHaveBeenCalledTimes(1);
    expect(reader.evidence).toMatchObject({
      ...fixture.expectedExport,
      path: fixture.inputPath,
      recordCount: 501,
      nutrientCount: 0,
      servingCount: 0,
    });
    const pages = await collect(reader.pages({ nextOffset: 0 }));
    expect(
      pages.map((page) => [page.expectedNextOffset, page.nextOffset, page.records.length]),
    ).toEqual([
      [0, 250, 250],
      [250, 500, 250],
      [500, 501, 1],
    ]);
    for (const page of pages) {
      expect(page.recordsDocumentBytes).toBe(Buffer.byteLength(pageDocument(page)));
      expect(page.recordsDocumentBytes).toBeLessThanOrEqual(16_777_216);
      expect(page.records[0]?.sequenceNumber).toBe(page.expectedNextOffset);
    }
    expect(await readdir(fixture.parent)).toEqual(["records.ndjson"]);
  });

  it("resumes at streamed deterministic boundaries and requires explicit whole-chain replay", async () => {
    const reader = await accept(await createFixture(records(501)));
    expect(
      (await collect(reader.pages({ nextOffset: 500 }))).map((page) => page.expectedNextOffset),
    ).toEqual([500]);
    expect(() => reader.pages({ nextOffset: 500, replayPreviousPage: true })).toThrow(
      "complete pinned receipt chain",
    );
    expect(await collect(reader.pages({ nextOffset: 501 }))).toEqual([]);
    for (const offset of [-1, 502, 1.5, Number.NaN])
      expect(() => reader.pages({ nextOffset: offset })).toThrow("outside its verified");
    for (const offset of [1, 249, 251])
      await expect(collect(reader.pages({ nextOffset: offset }))).rejects.toThrow(
        "deterministic page boundary",
      );
  });

  it("verifies 12500 records under an explicit admission without retaining an all-page index", async () => {
    const reader = await accept(await createFixture(records(12500)));
    expect(reader.protocolVersion).toBe(2);
    let total = 0;
    let pages = 0;
    for await (const page of reader.pages({ nextOffset: 0 })) {
      expect(page.expectedNextOffset).toBe(total);
      expect(page.records.length).toBeLessThanOrEqual(250);
      total += page.records.length;
      pages += 1;
    }
    expect(total).toBe(12500);
    expect(pages).toBe(50);
  }, 20000);

  it.each(["maxRecords", "maxPayloadTextBytes", "maxSnapshotBytes"] as const)(
    "requires an accepted positive %s limit",
    async (field) => {
      const fixture = await createFixture(records(1));
      fixture.admission[field] = 0;
      await expect(openVerifiedFdcRecordExportV2(fixture)).rejects.toThrow(
        "explicit positive accepted",
      );
      expect(fixture.verifyInspection).not.toHaveBeenCalled();
      expect(await readdir(fixture.parent)).toEqual(["records.ndjson"]);
    },
  );

  it("checks snapshot allocation against accepted bytes before opening it", async () => {
    const fixture = await createFixture(records(1));
    fixture.admission.maxSnapshotBytes = fixture.expectedExport.byteSize - 1;
    await expect(openVerifiedFdcRecordExportV2(fixture)).rejects.toThrow("snapshot budget");
    expect(await readdir(fixture.parent)).toEqual(["records.ndjson"]);
  });

  it("uses encoded byte limits to split large rows before 250 records", async () => {
    const large = '"'.repeat(180_000);
    const fixture = await createFixture(records(30, large));
    const reader = await accept(fixture);
    const pages = await collect(reader.pages({ nextOffset: 0 }));
    expect(pages.length).toBeGreaterThan(1);
    expect(pages[0]?.records.length).toBeLessThan(30);
    expect(pages.flatMap((page) => page.records).length).toBe(30);
    for (const page of pages)
      expect(page.recordsDocumentBytes).toBe(Buffer.byteLength(pageDocument(page)));
    const checkpoint = pages[0]?.nextOffset ?? 0;
    expect((await collect(reader.pages({ nextOffset: checkpoint })))[0]?.expectedNextOffset).toBe(
      checkpoint,
    );
  });

  it("retains verified bytes in an anonymous read-only snapshot when the input is replaced", async () => {
    const fixture = await createFixture(records(2));
    const reader = await accept(fixture);
    await rename(fixture.inputPath, `${fixture.inputPath}.old`);
    await writeFile(fixture.inputPath, "unrelated replacement", { mode: 0o600 });
    const page = (await collect(reader.pages({ nextOffset: 0 })))[0];
    expect(page?.records.map((record) => record.sourceRecordKey)).toEqual([
      record(0).idempotencyKey,
      record(1).idempotencyKey,
    ]);
    expect(await readFile(fixture.inputPath, "utf8")).toBe("unrelated replacement");
    await reader.close();
    await reader.close();
    expect(() => reader.pages({ nextOffset: 0 })).toThrow("closed");
  });

  it("counts preserved nutrient and serving entries including derived label servings", async () => {
    const row = {
      ...record(0),
      nutrients: [
        {
          sourceNutrientId: "1008",
          sourceName: "Energy",
          originalUnit: "KCAL",
          canonicalNutrientId: null,
          canonicalUnit: null,
          provenance: { derivationCode: null, dataPoints: 0 },
          value: { state: "known" as const, amount: "0", quality: "measured" as const },
        },
      ],
      servings: [
        {
          sourceServingId: "label",
          description: "label serving",
          amount: "1",
          unit: "g",
          gramWeight: "30",
        },
      ],
    };
    const fixture = await createFixture([row]);
    await mutateLine(fixture, -1, (footer) => {
      const inspection = footer.inspection as MutableJsonObject;
      const metrics = inspection.metrics as MutableJsonObject;
      metrics.stagedPortionCount = 0;
      metrics.derivedLabelServingCount = 1;
    });
    const reader = await accept(fixture);
    expect(reader.evidence).toMatchObject({ nutrientCount: 1, servingCount: 1 });
  });

  it.each(["hash", "size"])(
    "rejects wrong whole-export %s before any accepted inspection",
    async (kind) => {
      const fixture = await createFixture(records(2));
      if (kind === "hash") fixture.expectedExport.sha256 = "0".repeat(64);
      else fixture.expectedExport.byteSize += 1;
      await expect(openVerifiedFdcRecordExportV2(fixture)).rejects.toThrow();
      expect(fixture.verifyInspection).not.toHaveBeenCalled();
      expect(await readdir(fixture.parent)).toEqual(["records.ndjson"]);
    },
  );

  it.each(["authority", "unknown-header", "manifest", "build", "artifact", "ordering"])(
    "rejects changed %s header",
    async (change) => {
      const fixture = await createFixture(records(1));
      await mutateLine(fixture, 0, (header) => {
        if (change === "authority") (header.authority as MutableJsonObject).staging = true;
        if (change === "unknown-header") header.unexpected = true;
        if (change === "manifest") header.manifestSha256 = "d".repeat(64);
        if (change === "build") header.parserBuildSha256 = "d".repeat(64);
        if (change === "artifact") header.artifactSha256 = "d".repeat(64);
        if (change === "ordering") header.ordering = "fdc-id";
      });
      await expect(openVerifiedFdcRecordExportV2(fixture)).rejects.toThrow();
      expect(fixture.verifyInspection).not.toHaveBeenCalled();
    },
  );

  it.each([
    "baseline",
    "review",
    "semantic-count",
    "semantic-hash",
    "nutrients",
    "servings",
    "unknown-footer",
  ])("rejects %s footer mismatch", async (change) => {
    const fixture = await createFixture(records(2));
    await mutateLine(fixture, -1, (footer) => {
      const inspection = footer.inspection as MutableJsonObject;
      const semantic = inspection.semanticEvidence as MutableJsonObject;
      if (change === "baseline") (inspection.baseline as MutableJsonObject).unexpected = 1;
      if (change === "review")
        (inspection.baselineReview as MutableJsonObject).qualifiesAsAcquisitionOrApprovalEvidence =
          true;
      if (change === "semantic-count")
        (semantic.canonicalAcceptedRecords as MutableJsonObject).count = 1;
      if (change === "semantic-hash")
        (semantic.canonicalAcceptedRecords as MutableJsonObject).sha256 = "0".repeat(64);
      if (change === "nutrients") (inspection.metrics as MutableJsonObject).stagedNutrientCount = 1;
      if (change === "servings")
        (inspection.metrics as MutableJsonObject).derivedLabelServingCount = 1;
      if (change === "unknown-footer") footer.unexpected = true;
    });
    await expect(openVerifiedFdcRecordExportV2(fixture)).rejects.toThrow();
    expect(fixture.verifyInspection).not.toHaveBeenCalled();
  });

  it.each(["reordered", "missing", "changed", "extra"])(
    "rejects %s records even with a newly pinned whole-file hash",
    async (change) => {
      const fixture = await createFixture(records(3));
      const entries = (await readFile(fixture.inputPath, "utf8")).trimEnd().split("\n");
      if (change === "reordered") [entries[1], entries[2]] = [entries[2] ?? "", entries[1] ?? ""];
      if (change === "missing") entries.splice(2, 1);
      if (change === "extra") entries.splice(2, 0, entries[1] ?? "");
      if (change === "changed") entries[1] = canonicalJson(record(99));
      await replaceBytes(fixture, Buffer.from(`${entries.join("\n")}\n`));
      await expect(openVerifiedFdcRecordExportV2(fixture)).rejects.toThrow();
      expect(fixture.verifyInspection).not.toHaveBeenCalled();
    },
  );

  it.each([
    "missing-footer",
    "trailing-record",
    "missing-lf",
    "blank",
    "noncanonical",
    "duplicate-key",
    "invalid-utf8",
  ])("rejects %s framing", async (change) => {
    const fixture = await createFixture(records(1));
    let bytes = await readFile(fixture.inputPath);
    const entries = bytes.toString("utf8").trimEnd().split("\n");
    if (change === "missing-footer") bytes = Buffer.from(`${entries.slice(0, -1).join("\n")}\n`);
    if (change === "trailing-record")
      bytes = Buffer.concat([bytes, Buffer.from(`${canonicalJson(record(0))}\n`)]);
    if (change === "missing-lf") bytes = bytes.subarray(0, -1);
    if (change === "blank") bytes = Buffer.concat([bytes, Buffer.from("\n")]);
    if (change === "noncanonical") bytes = Buffer.from(` ${bytes.toString("utf8")}`);
    if (change === "duplicate-key")
      bytes = Buffer.from(
        bytes.toString("utf8").replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
      );
    if (change === "invalid-utf8") {
      bytes = Buffer.from(bytes);
      bytes[1] = 0xff;
    }
    await replaceBytes(fixture, bytes);
    await expect(openVerifiedFdcRecordExportV2(fixture)).rejects.toThrow();
    expect(fixture.verifyInspection).not.toHaveBeenCalled();
  });

  it("rejects source identity mismatch and unsupported PostgreSQL text", async () => {
    for (const description of ["nul\0text", "unpaired\ud800"]) {
      const fixture = await createFixture([
        { ...record(0), identity: { ...record(0).identity, description } },
      ]);
      await expect(openVerifiedFdcRecordExportV2(fixture)).rejects.toThrow("NUL or unpaired");
      expect(fixture.verifyInspection).not.toHaveBeenCalled();
    }
    const fixture = await createFixture([
      { ...record(0), source: { ...record(0).source, releaseKey: "different" } },
    ]);
    await expect(openVerifiedFdcRecordExportV2(fixture)).rejects.toThrow("identity differs");
  });

  it("rejects counts above accepted admission and records above 1 MiB", async () => {
    const countFixture = await createFixture(records(0));
    countFixture.expectedBaseline.parserBaselineCsvAcceptedFoodCount = 25_001;
    await expect(openVerifiedFdcRecordExportV2(countFixture)).rejects.toThrow(
      "accepted record budget",
    );
    const sizeFixture = await createFixture(records(1, "x".repeat(1_048_576)));
    await expect(openVerifiedFdcRecordExportV2(sizeFixture)).rejects.toThrow(
      "1-MiB canonical payload cap",
    );
  });

  it("preflights the conservative PostgreSQL whole-batch cap before acceptance", async () => {
    // Numeric values can expand in jsonb text. The conservative 400-byte bound
    // makes this under-1-MiB synthetic payload exceed 64 MiB over two rows.
    const expanded = Array.from({ length: 90_000 }, () => 0.1);
    const first = { ...record(0), identity: { ...record(0).identity, testExpansion: expanded } };
    const second = { ...record(1), identity: { ...record(1).identity, testExpansion: expanded } };
    const fixture = await createFixture([first, second]);
    fixture.admission.maxPayloadTextBytes = 67108864;
    await expect(openVerifiedFdcRecordExportV2(fixture)).rejects.toThrow(
      "accepted conservative PostgreSQL payload bound",
    );
    expect(fixture.verifyInspection).not.toHaveBeenCalled();
  });

  it.each(["symlink", "public", "hardlink"])("rejects a %s input", async (kind) => {
    const fixture = await createFixture(records(1));
    if (kind === "public") await chmod(fixture.inputPath, 0o644);
    if (kind === "hardlink") await link(fixture.inputPath, `${fixture.inputPath}.alias`);
    if (kind === "symlink") {
      await rename(fixture.inputPath, `${fixture.inputPath}.real`);
      await symlink(`${fixture.inputPath}.real`, fixture.inputPath);
    }
    await expect(openVerifiedFdcRecordExportV2(fixture)).rejects.toThrow();
    expect(fixture.verifyInspection).not.toHaveBeenCalled();
  });

  it("rejects parent symlinks and unsafe input namespaces", async () => {
    const fixture = await createFixture(records(1));
    for (const inputPath of [
      `${fixture.parent}/../records.ndjson`,
      `${fixture.parent}/nested/records.ndjson`,
      fixture.inputPath.replace("records.ndjson", "records.json"),
    ])
      await expect(openVerifiedFdcRecordExportV2({ ...fixture, inputPath })).rejects.toThrow(
        "canonical private Linux",
      );
    await rename(fixture.parent, `${fixture.parent}-real`);
    await symlink(`${fixture.parent}-real`, fixture.parent);
    await expect(openVerifiedFdcRecordExportV2(fixture)).rejects.toThrow("private directories");
  });

  it.each(["source", "parent"])(
    "rejects %s replacement during final verification and preserves unrelated paths",
    async (target) => {
      const fixture = await createFixture(records(2));
      fixture.verifyInspection.mockImplementation(async () => {
        if (target === "source") {
          await rename(fixture.inputPath, `${fixture.inputPath}.old`);
          await writeFile(fixture.inputPath, "replacement", { mode: 0o600 });
        } else {
          await rename(fixture.parent, `${fixture.parent}-old`);
          await mkdir(fixture.parent, { mode: 0o700 });
          await writeFile(join(fixture.parent, "keep"), "replacement");
        }
      });
      await expect(openVerifiedFdcRecordExportV2(fixture)).rejects.toThrow("identity changed");
      expect(
        await readFile(
          target === "source" ? fixture.inputPath : join(fixture.parent, "keep"),
          "utf8",
        ),
      ).toBe("replacement");
    },
  );

  it("preserves a substituted snapshot name and accepts no input", async () => {
    const fixture = await createFixture(records(1));
    let replacementPath = "";
    hooks.afterOpen = async (path) => {
      if (!path.includes(".fdc-record-snapshot-")) return;
      hooks.afterOpen = undefined;
      replacementPath = join(fixture.parent, basename(path));
      await rename(path, `${path}.old`);
      await writeFile(path, "replacement", { mode: 0o600 });
    };
    await expect(openVerifiedFdcRecordExportV2(fixture)).rejects.toThrow(
      "verification and required cleanup failed",
    );
    expect(await readFile(replacementPath, "utf8")).toBe("replacement");
    expect(fixture.verifyInspection).not.toHaveBeenCalled();
  });

  it.each(["write", "unlink", "source-close", "inspection"])(
    "does not return a reader on %s failure",
    async (operation) => {
      const fixture = await createFixture(records(1));
      const fail = async () => {
        throw new Error(`injected ${operation} failure`);
      };
      if (operation === "write")
        hooks.beforeWrite = async (path) => {
          if (path.includes(".fdc-record-snapshot-")) await fail();
        };
      if (operation === "unlink")
        hooks.beforeUnlink = async () => {
          hooks.beforeUnlink = undefined;
          await fail();
        };
      if (operation === "source-close")
        hooks.beforeClose = async (path) => {
          if (path.endsWith("records.ndjson")) {
            hooks.beforeClose = undefined;
            await fail();
          }
        };
      if (operation === "inspection") fixture.verifyInspection.mockImplementation(fail);
      await expect(openVerifiedFdcRecordExportV2(fixture)).rejects.toThrow(
        `injected ${operation} failure`,
      );
    },
  );

  it("honors cancellation during copying and paging", async () => {
    const fixture = await createFixture(records(300));
    const controller = new AbortController();
    hooks.beforeRead = async (path, position) => {
      if (path.endsWith("records.ndjson") && Number(position) > 0)
        controller.abort(new Error("copy cancelled"));
    };
    await expect(
      openVerifiedFdcRecordExportV2({ ...fixture, signal: controller.signal }),
    ).rejects.toThrow("copy cancelled");
    expect(fixture.verifyInspection).not.toHaveBeenCalled();
    hooks.beforeRead = undefined;
    const second = new AbortController();
    const reader = await openVerifiedFdcRecordExportV2({ ...fixture, signal: second.signal });
    readers.push(reader);
    const pages = reader.pages({ nextOffset: 0 })[Symbol.asyncIterator]();
    expect((await pages.next()).value?.records).toHaveLength(250);
    second.abort(new Error("paging cancelled"));
    await expect(pages.next()).rejects.toThrow("paging cancelled");
  });

  it("forbids overlapping page streams and makes descriptor close idempotent", async () => {
    const reader = await accept(await createFixture(records(2)));
    const stream = reader.pages({ nextOffset: 0 });
    expect(() => reader.pages({ nextOffset: 0 })).toThrow("already being read");
    await collect(stream);
    await Promise.all([reader.close(), reader.close()]);
    expect(() => reader.pages({ nextOffset: 0 })).toThrow("closed");
  });
});

describe("PostgreSQL jsonb text byte upper bound", () => {
  it("includes UTF-8 strings, escaped keys and PostgreSQL separator spaces", () => {
    const value = { 'a"b': ["é", true, null, 123], z: { a: false } };
    const postgres = '{"z": {"a": false}, "a\\"b": ["é", true, null, 123]}';
    expect(postgresJsonTextByteUpperBound(value)).toBe(Buffer.byteLength(postgres));
  });
  it("bounds exponent expansion without treating compact JSON bytes as PostgreSQL bytes", () => {
    for (const value of [
      Number.MIN_VALUE,
      -Number.MIN_VALUE,
      Number.MAX_VALUE,
      -Number.MAX_VALUE,
      0.1,
      1e-200,
    ])
      expect(postgresJsonTextByteUpperBound(value)).toBe(400);
    expect(postgresJsonTextByteUpperBound(Number.MAX_SAFE_INTEGER)).toBe(16);
    expect(() => postgresJsonTextByteUpperBound(Number.POSITIVE_INFINITY)).toThrow("non-finite");
  });
});

function record(index: number): StagedFoodRecord {
  return createStagedFood({
    sourceCode: HEADER.sourceCode,
    releaseKey: HEADER.releaseKey,
    sourceRecordId: String(index),
    sourceDataType: "Foundation",
    languageTag: "en",
    marketCode: "US",
    description: `Synthetic pear ${index}`,
    rawSourceRecord: { id: index },
    nutrients: [],
  });
}
function* records(length: number, description?: string): Generator<StagedFoodRecord> {
  for (let index = 0; index < length; index += 1) {
    const row = record(index);
    yield description === undefined ? row : { ...row, identity: { ...row.identity, description } };
  }
}

async function createFixture(rows: Iterable<StagedFoodRecord>) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "fdc-record-reader-test-"));
  roots.push(workspaceRoot);
  const parent = join(workspaceRoot, ".local-data/evidence/fdc-csv-records");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const inputPath = join(parent, "records.ndjson");
  const handle = await open(inputPath, "wx", 0o600);
  const hash = createHash("sha256");
  const recordsHash = createHash("sha256");
  let byteSize = 0;
  let recordCount = 0;
  let nutrientCount = 0;
  let servingCount = 0;
  const append = async (value: unknown) => {
    const bytes = Buffer.from(`${canonicalJson(value)}\n`);
    hash.update(bytes);
    byteSize += bytes.length;
    await handle.writeFile(bytes);
  };
  await append(HEADER);
  for (const row of rows) {
    recordsHash.update(`${canonicalJson(row)}\n`);
    recordCount += 1;
    nutrientCount += row.nutrients.length;
    servingCount += row.servings.length;
    await append(row);
  }
  const recordsSha256 = recordsHash.digest("hex");
  const expectedBaseline: Record<string, number | string> = {
    parserBaselineCsvAcceptedFoodCount: recordCount,
    parserBaselineCsvCanonicalAcceptedRecordsDigest: recordsSha256,
  };
  const inspection = {
    schemaVersion: 1,
    reportKind: "usda-fdc-full-csv-inspection-v1",
    manifestSha256: HEADER.manifestSha256,
    parserBuildSha256: HEADER.parserBuildSha256,
    parserPackage: HEADER.parserPackage,
    parserVersion: HEADER.parserVersion,
    releaseKey: HEADER.releaseKey,
    baseline: { ...expectedBaseline },
    baselineReview: {
      kind: "non-qualifying-local-baseline-comparison-v1",
      manifestExpectationsMatched: true,
      mismatches: [],
      qualifiesAsAcquisitionOrApprovalEvidence: false,
      status: "matched-manifest-expectations",
    },
    localVerification: {
      artifactByteSize: HEADER.artifactByteSize,
      artifactSha256: HEADER.artifactSha256,
      kind: "non-qualifying-local-artifact-verification-v1",
      qualifiesAsAcquisitionObservation: false,
      status: "verified-against-manifest-pins",
    },
    semanticEvidence: {
      schemaVersion: 1,
      ordering: HEADER.ordering,
      canonicalAcceptedRecords: { count: recordCount, sha256: recordsSha256 },
    },
    metrics: {
      acceptedFoodCount: recordCount,
      stagedNutrientCount: nutrientCount,
      stagedPortionCount: servingCount,
      derivedLabelServingCount: 0,
    },
  };
  await append({ recordType: "footer", format: HEADER.format, schemaVersion: 1, inspection });
  await handle.close();
  return {
    workspaceRoot,
    inputPath,
    parent,
    expectedExport: { sha256: hash.digest("hex"), byteSize },
    expectedHeader: HEADER,
    admission: { maxRecords: 25000, maxPayloadTextBytes: 134217728, maxSnapshotBytes: 536870912 },
    expectedBaseline,
    verifyInspection: vi.fn<(inspection: JsonObject) => void | Promise<void>>(),
  };
}
type Fixture = Awaited<ReturnType<typeof createFixture>>;
async function accept(fixture: Fixture) {
  const reader = await openVerifiedFdcRecordExportV2(fixture);
  readers.push(reader);
  return reader;
}
async function collect(stream: AsyncIterable<FdcStagingPage>) {
  const pages: FdcStagingPage[] = [];
  for await (const page of stream) pages.push(page);
  return pages;
}
function pageDocument(page: FdcStagingPage) {
  return canonicalJson({
    schemaVersion: 1,
    records: page.records.map((row) => ({
      canonicalPayloadDocument: canonicalJson(row.canonicalPayload),
      canonicalPayloadSha256: row.canonicalPayloadSha256,
      sequenceNumber: row.sequenceNumber,
      sourcePayloadSha256: row.sourcePayloadSha256,
      sourceRecordKey: row.sourceRecordKey,
      sourceRecordType: row.sourceRecordType,
    })),
  });
}
async function mutateLine(
  fixture: Fixture,
  index: number,
  mutate: (value: MutableJsonObject) => void,
) {
  const lines = (await readFile(fixture.inputPath, "utf8")).trimEnd().split("\n");
  const actualIndex = index < 0 ? lines.length + index : index;
  const row = JSON.parse(lines[actualIndex] ?? "") as MutableJsonObject;
  mutate(row);
  lines[actualIndex] = canonicalJson(row);
  await replaceBytes(fixture, Buffer.from(`${lines.join("\n")}\n`));
}
async function replaceBytes(fixture: Fixture, bytes: Buffer) {
  await writeFile(fixture.inputPath, bytes);
  fixture.expectedExport.sha256 = createHash("sha256").update(bytes).digest("hex");
  fixture.expectedExport.byteSize = bytes.length;
}
