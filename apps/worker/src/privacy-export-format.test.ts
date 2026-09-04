import { createHash, randomBytes } from "node:crypto";
import { readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalJson } from "@nutrition-tracker/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertPrivacyExportArtifactSizeBounds,
  assertPrivacyExportSizeBounds,
  csvCell,
  MAX_PRIVACY_EXPORT_ROW_BYTES,
  materializePrivacyExportArtifacts,
  PRIVACY_EXPORT_ENTITIES,
  PrivacyExportCapacityError,
  PrivacyExportFormatError,
  type PrivacyExportRow,
  planCsvChunkSizes,
  spoolPrivacyExportSnapshot,
} from "./privacy-export-format.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (path) => rm(path, { force: true, recursive: true })),
  );
});

function payloadSha256(payload: PrivacyExportRow["payload"]): string {
  return createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");
}

function row(
  entityType: PrivacyExportRow["entityType"],
  ordinal: number,
  payload: PrivacyExportRow["payload"],
  overrides: Partial<PrivacyExportRow> = {},
): PrivacyExportRow {
  return {
    deleted: false,
    entityId: `${entityType}-${ordinal}`,
    entityType,
    ordinal: String(ordinal),
    payload,
    payloadSha256: payloadSha256(payload),
    revision: "1",
    watermark: `watermark-${entityType}`,
    ...overrides,
  };
}

function evidence(rows: readonly PrivacyExportRow[]) {
  return PRIVACY_EXPORT_ENTITIES.map((entity) => ({
    entity,
    sourceCount: rows.filter((item) => item.entityType === entity).length,
    sourceRecordSetSha256: createHash("sha256")
      .update(
        rows
          .filter((item) => item.entityType === entity)
          .map(
            (item) =>
              `${canonicalJson({
                deleted: item.deleted,
                entityId: item.entityId,
                entityType: item.entityType,
                ordinal: item.ordinal,
                payload: item.payload,
                payloadSha256: item.payloadSha256,
                revision: item.revision,
                watermark: item.watermark,
              })}\n`,
          )
          .join(""),
        "utf8",
      )
      .digest("hex"),
    watermark: `watermark-${entity}`,
  }));
}

function semanticEvidence() {
  const facts = {
    biometricEventCount: "1",
    biometricRevisionCount: "1",
    diaryDailyNutrientGroupCount: "0",
    diaryDailyTotalsSha256: createHash("sha256").digest("hex"),
    platformImportCount: "0",
    platformImportRevisionCount: "0",
    version: "retention-export-semantic-v1" as const,
  };
  return {
    ...facts,
    digest: createHash("sha256").update(canonicalJson(facts), "utf8").digest("hex"),
  };
}

async function* records(rows: readonly PrivacyExportRow[]) {
  yield* rows;
}

function storedZipEntries(bytes: Buffer): Map<string, Buffer> {
  const result = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 30 <= bytes.byteLength && bytes.readUInt32LE(offset) === 0x04034b50) {
    expect(bytes.readUInt16LE(offset + 8)).toBe(0);
    expect(bytes.readUInt16LE(offset + 10)).toBe(0);
    expect(bytes.readUInt16LE(offset + 12)).toBe(0x21);
    const size = bytes.readUInt32LE(offset + 18);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = bytes.subarray(nameStart, nameStart + nameLength).toString("utf8");
    result.set(name, Buffer.from(bytes.subarray(dataStart, dataStart + size)));
    offset = dataStart + size;
  }
  return result;
}

function requiredArtifact(
  artifacts: readonly {
    readonly format: "csv" | "json";
    readonly path: string;
    readonly sha256: string;
  }[],
  format: "csv" | "json",
) {
  const artifact = artifacts.find((candidate) => candidate.format === format);
  if (!artifact) throw new Error(`Missing ${format} artifact`);
  return artifact;
}

function requiredZipEntry(entries: ReadonlyMap<string, Buffer>, path: string): Buffer {
  const entry = entries.get(path);
  if (!entry) throw new Error(`Missing ZIP entry: ${path}`);
  return entry;
}

async function buildFixture(root: string) {
  const rows = [
    row("account", 1, {
      email: "owner@example.invalid",
      status: "active",
    }),
    row("biometric_event", 2, {
      provenance: { kind: "manual" },
      unit: "kg",
      value: "72.125000",
    }),
    row("custom_food_nutrient", 3, {
      amountPer100Grams: null,
      reason: "not_analyzed",
      state: "unknown",
    }),
    row(
      "diary_entry_revision",
      4,
      {
        foodProvenance: {
          customFoodId: "10000000-0000-4000-8000-000000000001",
          customFoodVersionNumber: 2,
          kind: "private_custom",
        },
        note: "private historical diary note",
        operation: "delete",
      },
      { deleted: true },
    ),
  ].sort(
    (left, right) =>
      PRIVACY_EXPORT_ENTITIES.indexOf(left.entityType) -
      PRIVACY_EXPORT_ENTITIES.indexOf(right.entityType),
  );
  const spool = await spoolPrivacyExportSnapshot({
    maximumBytes: MAX_PRIVACY_EXPORT_ROW_BYTES,
    snapshot: {
      capturedAt: "2026-08-16T12:00:00.000Z",
      entities: evidence(rows),
      records: records(rows),
      semanticEvidence: semanticEvidence(),
      snapshotWatermark: "user-watermark-42",
    },
    temporaryDirectory: root,
  });
  const artifacts = await materializePrivacyExportArtifacts({
    formats: ["json", "csv"],
    spool,
  });
  return { artifacts, rows, spool };
}

describe("privacy export formatting", () => {
  it("neutralizes spreadsheet formulas and applies exact RFC 4180 quoting", () => {
    expect(csvCell("=SUM(A1:A2)")).toBe("'=SUM(A1:A2)");
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("-1")).toBe("'-1");
    expect(csvCell("@cmd")).toBe("'@cmd");
    expect(csvCell("\tformula")).toBe("'\tformula");
    expect(csvCell("\rformula")).toBe('"\'\rformula"');
    expect(csvCell('a,"b"\r\nnext')).toBe('"a,""b""\r\nnext"');
  });

  it("emits canonical JSON and a deterministic timestamp-free ZIP with every explicit entity CSV", async () => {
    const rootOne = join(tmpdir(), `privacy-export-test-${randomBytes(8).toString("hex")}`);
    const rootTwo = join(tmpdir(), `privacy-export-test-${randomBytes(8).toString("hex")}`);
    roots.push(rootOne, rootTwo);
    await import("node:fs/promises").then(({ mkdir }) =>
      Promise.all([mkdir(rootOne, { mode: 0o700 }), mkdir(rootTwo, { mode: 0o700 })]),
    );
    const first = await buildFixture(rootOne);
    const second = await buildFixture(rootTwo);
    const firstJson = requiredArtifact(first.artifacts.artifacts, "json");
    const firstZip = requiredArtifact(first.artifacts.artifacts, "csv");
    const secondJson = requiredArtifact(second.artifacts.artifacts, "json");
    const secondZip = requiredArtifact(second.artifacts.artifacts, "csv");
    const jsonBytes = await readFile(firstJson.path);
    const parsed = JSON.parse(jsonBytes.toString("utf8")) as Record<string, unknown>;
    expect(jsonBytes.toString("utf8")).toBe(`${canonicalJson(parsed)}\n`);
    const exportedDiaryRevisions = (
      parsed.entities as {
        diary_entry_revision: readonly {
          readonly payload: Readonly<Record<string, unknown>>;
        }[];
      }
    ).diary_entry_revision;
    expect(exportedDiaryRevisions).toMatchObject([
      { payload: { note: "private historical diary note" } },
    ]);
    expect(jsonBytes).toEqual(await readFile(secondJson.path));
    expect(await readFile(firstZip.path)).toEqual(await readFile(secondZip.path));
    expect(firstJson.sha256).toBe(secondJson.sha256);
    expect(firstZip.sha256).toBe(secondZip.sha256);

    const entries = storedZipEntries(await readFile(firstZip.path));
    expect([...entries.keys()]).toEqual(
      [
        ...PRIVACY_EXPORT_ENTITIES.map((entity) => `entities/${entity}/part-000001.csv`),
        "files.json",
        "manifest.json",
      ].sort(),
    );
    expect(entries).toHaveLength(PRIVACY_EXPORT_ENTITIES.length + 2);
    const logicalManifest = JSON.parse(
      requiredZipEntry(entries, "manifest.json").toString("utf8"),
    ) as {
      semanticEvidence: { digest: string };
    };
    expect(logicalManifest.semanticEvidence.digest).toBe(semanticEvidence().digest);
    const deliveredManifest = JSON.parse(
      requiredZipEntry(entries, "files.json").toString("utf8"),
    ) as {
      logicalManifestSha256: string;
      files: { path: string; byteLength: number; sha256: string; recordCount: number }[];
    };
    expect(deliveredManifest.logicalManifestSha256).toBe(first.artifacts.manifestSha256);
    expect(deliveredManifest.files).toHaveLength(PRIVACY_EXPORT_ENTITIES.length);
    expect(
      deliveredManifest.files.every(
        (file) =>
          file.byteLength > 0 &&
          /^[0-9a-f]{64}$/.test(file.sha256) &&
          entries.get(file.path)?.byteLength === file.byteLength,
      ),
    ).toBe(true);
    const biometricCsv =
      entries.get("entities/biometric_event/part-000001.csv")?.toString("utf8") ?? "";
    expect(biometricCsv).toContain('""value"":""72.125000""');
    const nutrientCsv =
      entries.get("entities/custom_food_nutrient/part-000001.csv")?.toString("utf8") ?? "";
    expect(nutrientCsv).toContain('""reason"":""not_analyzed""');
    const tombstoneCsv =
      entries.get("entities/diary_entry_revision/part-000001.csv")?.toString("utf8") ?? "";
    expect(tombstoneCsv).toContain(",true,");
    expect(tombstoneCsv).toContain('""kind"":""private_custom""');
    expect(tombstoneCsv).toContain('""note"":""private historical diary note""');
    expect(
      first.spool.manifestBase.entities.every((item) => item.sourceCount === item.exportedCount),
    ).toBe(true);
    await first.spool.dispose();
    await second.spool.dispose();
  }, 30_000);

  it("does not stage or claim absent CSV members for a JSON-only export", async () => {
    const root = join(tmpdir(), `privacy-export-json-only-${randomBytes(8).toString("hex")}`);
    roots.push(root);
    await import("node:fs/promises").then(({ mkdir }) => mkdir(root, { mode: 0o700 }));
    const rows = [row("account", 1, { exactDecimal: "72.125000" })];
    const spool = await spoolPrivacyExportSnapshot({
      maximumBytes: MAX_PRIVACY_EXPORT_ROW_BYTES,
      snapshot: {
        capturedAt: "2026-08-16T12:00:00.000Z",
        entities: evidence(rows),
        records: records(rows),
        semanticEvidence: semanticEvidence(),
        snapshotWatermark: "user-watermark-json-only",
      },
      temporaryDirectory: root,
    });
    const materialized = await materializePrivacyExportArtifacts({ formats: ["json"], spool });
    const artifact = materialized.artifacts[0];
    expect(artifact?.format).toBe("json");
    if (!artifact) throw new Error("Missing JSON artifact");
    const parsed = JSON.parse(await readFile(artifact.path, "utf8")) as {
      manifest: Record<string, unknown>;
    };
    expect(parsed.manifest).not.toHaveProperty("files");
    expect(materialized.manifest).not.toHaveProperty("files");
    expect(await readdir(spool.directory)).not.toContain("csv");
    await spool.dispose();
  });

  it("enforces one cumulative workspace budget across the snapshot and generated files", async () => {
    const root = join(tmpdir(), `privacy-export-workspace-${randomBytes(8).toString("hex")}`);
    roots.push(root);
    await import("node:fs/promises").then(({ mkdir }) => mkdir(root, { mode: 0o700 }));
    const rows = [row("account", 1, { exactDecimal: "72.125000" })];
    const spool = await spoolPrivacyExportSnapshot({
      maximumBytes: MAX_PRIVACY_EXPORT_ROW_BYTES,
      snapshot: {
        capturedAt: "2026-08-16T12:00:00.000Z",
        entities: evidence(rows),
        records: records(rows),
        semanticEvidence: semanticEvidence(),
        snapshotWatermark: "workspace-budget",
      },
      temporaryDirectory: root,
    });
    await expect(
      materializePrivacyExportArtifacts({
        formats: ["json"],
        maximumArtifactBytes: MAX_PRIVACY_EXPORT_ROW_BYTES,
        maximumWorkspaceBytes: MAX_PRIVACY_EXPORT_ROW_BYTES,
        spool: { ...spool, byteLength: MAX_PRIVACY_EXPORT_ROW_BYTES - 1 },
      }),
    ).rejects.toBeInstanceOf(PrivacyExportCapacityError);
    await spool.dispose();
  });

  it("rejects privacy export artifact ciphertext when upstream redaction is missing", async () => {
    const root = join(tmpdir(), `privacy-export-credential-${randomBytes(8).toString("hex")}`);
    roots.push(root);
    await import("node:fs/promises").then(({ mkdir }) => mkdir(root, { mode: 0o700 }));
    const rows = [row("privacy_export_artifact", 1, { ciphertext_bytes: "1" })];
    await expect(
      spoolPrivacyExportSnapshot({
        maximumBytes: MAX_PRIVACY_EXPORT_ROW_BYTES,
        snapshot: {
          capturedAt: "2026-08-16T12:00:00.000Z",
          entities: evidence(rows),
          records: records(rows),
          semanticEvidence: semanticEvidence(),
          snapshotWatermark: "artifact-credential-guard",
        },
        temporaryDirectory: root,
      }),
    ).rejects.toThrow("Credential material is not exportable account data");
  });

  it("fails reconciliation for wrong counts, watermarks, payload digests, ordering, and fractional JSON numerics", async () => {
    const root = join(tmpdir(), `privacy-export-test-${randomBytes(8).toString("hex")}`);
    roots.push(root);
    await import("node:fs/promises").then(({ mkdir }) => mkdir(root, { mode: 0o700 }));
    const good = row("account", 1, { exactDecimal: "1.25" });
    const cases: {
      readonly rows: readonly PrivacyExportRow[];
      readonly source: ReturnType<typeof evidence>;
    }[] = [
      { rows: [good], source: evidence([]) },
      { rows: [{ ...good, watermark: "wrong" }], source: evidence([good]) },
      { rows: [{ ...good, payloadSha256: "0".repeat(64) }], source: evidence([good]) },
      { rows: [row("profile", 2, {}), good], source: evidence([row("profile", 2, {}), good]) },
      {
        rows: [row("account", 1, { lossyDecimal: 1.25 } as unknown as PrivacyExportRow["payload"])],
        source: evidence([good]),
      },
      {
        rows: [row("account", 1, { tokenHash: "must-not-export" })],
        source: evidence([good]),
      },
    ];
    for (const [index, value] of cases.entries()) {
      const failure = await spoolPrivacyExportSnapshot({
        maximumBytes: MAX_PRIVACY_EXPORT_ROW_BYTES,
        snapshot: {
          capturedAt: "2026-08-16T12:00:00.000Z",
          entities: value.source,
          records: records(value.rows),
          semanticEvidence: semanticEvidence(),
          snapshotWatermark: `watermark-${index}`,
        },
        temporaryDirectory: root,
      }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(PrivacyExportFormatError);
      expect(failure).not.toBeInstanceOf(PrivacyExportCapacityError);
    }
  });

  it("rejects same-count row corruption against the DB source record-set digest", async () => {
    const root = join(tmpdir(), `privacy-export-record-set-${randomBytes(8).toString("hex")}`);
    roots.push(root);
    await import("node:fs/promises").then(({ mkdir }) => mkdir(root, { mode: 0o700 }));
    const source = row("diary_entry_nutrient", 1, { known_amount: "10.000000" });
    const corrupted = row("diary_entry_nutrient", 1, { known_amount: "11.000000" });
    await expect(
      spoolPrivacyExportSnapshot({
        maximumBytes: MAX_PRIVACY_EXPORT_ROW_BYTES,
        snapshot: {
          capturedAt: "2026-08-16T12:00:00.000Z",
          entities: evidence([source]),
          records: records([corrupted]),
          semanticEvidence: semanticEvidence(),
          snapshotWatermark: "same-count-corruption",
        },
        temporaryDirectory: root,
      }),
    ).rejects.toThrow("record-set reconciliation");
  });

  it("enforces the exact 100 MiB row and configured total-byte boundaries without allocating an oversized fixture", () => {
    expect(() =>
      assertPrivacyExportSizeBounds({
        maximumBytes: MAX_PRIVACY_EXPORT_ROW_BYTES,
        rowBytes: MAX_PRIVACY_EXPORT_ROW_BYTES,
        totalBytes: MAX_PRIVACY_EXPORT_ROW_BYTES,
      }),
    ).not.toThrow();
    for (const mutation of [
      { rowBytes: MAX_PRIVACY_EXPORT_ROW_BYTES + 1 },
      { totalBytes: MAX_PRIVACY_EXPORT_ROW_BYTES + 1 },
    ]) {
      expect(() =>
        assertPrivacyExportSizeBounds({
          maximumBytes: MAX_PRIVACY_EXPORT_ROW_BYTES,
          rowBytes: MAX_PRIVACY_EXPORT_ROW_BYTES,
          totalBytes: MAX_PRIVACY_EXPORT_ROW_BYTES,
          ...mutation,
        }),
      ).toThrow(PrivacyExportCapacityError);
    }
    expect(() =>
      assertPrivacyExportArtifactSizeBounds({
        artifactBytes: MAX_PRIVACY_EXPORT_ROW_BYTES,
        maximumBytes: MAX_PRIVACY_EXPORT_ROW_BYTES,
      }),
    ).not.toThrow();
    expect(() =>
      assertPrivacyExportArtifactSizeBounds({
        artifactBytes: MAX_PRIVACY_EXPORT_ROW_BYTES + 1,
        maximumBytes: MAX_PRIVACY_EXPORT_ROW_BYTES,
      }),
    ).toThrow(PrivacyExportCapacityError);
  });

  it("deterministically splits a logical entity above 4 GiB into classic-size ZIP members", () => {
    const rowBytes = Array.from({ length: 50 }, () => 100 * 1_024 * 1_024);
    const plan = planCsvChunkSizes({
      headerBytes: 100,
      maximumMemberBytes: 400 * 1_024 * 1_024,
      rowBytes,
    });
    expect(rowBytes.reduce((total, value) => total + value, 0)).toBeGreaterThan(0xffffffff);
    expect(plan).toHaveLength(17);
    expect(plan.every((chunk) => chunk.byteLength <= 400 * 1_024 * 1_024)).toBe(true);
    expect(plan.reduce((total, chunk) => total + chunk.recordCount, 0)).toBe(50);
  });
});
