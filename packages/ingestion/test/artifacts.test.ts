import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireArtifact, extractZipArchive, planArchiveExtraction } from "../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "nutrition-ingestion-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("artifact acquisition", () => {
  it("streams, verifies, atomically caches, and labels cache replay as non-fresh", async () => {
    const root = await temporaryDirectory();
    const source = join(root, "source.bin");
    const cache = join(root, "cache");
    const bytes = Buffer.from("canonical artifact bytes");
    await writeFile(source, bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const common = {
      source,
      cacheDirectory: cache,
      verification: {
        mode: "verified" as const,
        expected: { sha256, byteSize: bytes.length, provenance: "independent pinned manifest" },
      },
      operatorPrincipalId: "operator.one@example.test",
      tool: "ingestion-test/1",
      sourceMode: "local-test" as const,
      now: () => new Date("2026-08-15T12:00:00.000Z"),
    };
    const first = await acquireArtifact(common);
    const second = await acquireArtifact(common);
    expect(await readFile(first.path)).toEqual(bytes);
    expect(first).toMatchObject({
      cacheHit: false,
      observation: { transport: "file", freshDownload: true, sha256, byteSize: bytes.length },
    });
    expect(second).toMatchObject({
      cacheHit: true,
      observation: { transport: "cache", freshDownload: false, sha256, byteSize: bytes.length },
    });
    expect(second.observation.acquisitionId).not.toBe(first.observation.acquisitionId);
  });

  it("rejects a checksum mismatch without promoting partial bytes", async () => {
    const root = await temporaryDirectory();
    const source = join(root, "source.bin");
    const cache = join(root, "cache");
    await writeFile(source, "wrong");
    await expect(
      acquireArtifact({
        source,
        cacheDirectory: cache,
        verification: {
          mode: "verified",
          expected: { sha256: "a".repeat(64), byteSize: 5, provenance: "fixture" },
        },
        operatorPrincipalId: "operator.one",
        tool: "test/1",
        sourceMode: "local-test",
      }),
    ).rejects.toMatchObject({ code: "CHECKSUM_MISMATCH" });
    expect(await readdir(join(cache, ".tmp"))).toEqual([]);
    await expect(readdir(join(cache, "sha256"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cleans up an interrupted network acquisition", async () => {
    const root = await temporaryDirectory();
    const controller = new AbortController();
    let pulled = false;
    const fetchFixture: typeof fetch = async () =>
      new Response(
        new ReadableStream({
          pull(stream) {
            if (!pulled) {
              pulled = true;
              stream.enqueue(new TextEncoder().encode("first chunk"));
              controller.abort(new Error("simulated interruption"));
            }
          },
        }),
        { status: 200 },
      );
    await expect(
      acquireArtifact({
        source: "https://data.example.test/releases/file.zip?secret=redacted",
        cacheDirectory: join(root, "cache"),
        verification: { mode: "observe-only" },
        operatorPrincipalId: "operator.two",
        tool: "test/1",
        sourceMode: "local-test",
        freshness: "require-fresh-network",
        fetch: fetchFixture,
        remotePolicy: {
          allowedSources: [{ host: "data.example.test", pathPrefix: "/releases/" }],
          allowPrivateNetworkForTesting: true,
        },
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "ABORTED" });
    expect(await readdir(join(root, "cache", ".tmp"))).toEqual([]);
  });

  it("redacts signed URL data and rejects redirect downgrades", async () => {
    const root = await temporaryDirectory();
    const okFetch: typeof fetch = async () => new Response("safe", { status: 200 });
    const result = await acquireArtifact({
      source: "https://data.example.test/releases/file.zip?signature=secret#fragment",
      cacheDirectory: join(root, "ok-cache"),
      verification: { mode: "observe-only" },
      operatorPrincipalId: "operator.three",
      tool: "test/1",
      sourceMode: "local-test",
      freshness: "require-fresh-network",
      fetch: okFetch,
      remotePolicy: {
        allowedSources: [{ host: "data.example.test", pathPrefix: "/releases/" }],
        allowPrivateNetworkForTesting: true,
      },
    });
    expect(result.observation.downloadUrl).toBe("https://data.example.test/releases/file.zip");
    expect(JSON.stringify(result.observation)).not.toContain("secret");

    const redirectFetch: typeof fetch = async () =>
      new Response(null, {
        status: 302,
        headers: { location: "http://data.example.test/releases/file.zip" },
      });
    await expect(
      acquireArtifact({
        source: "https://data.example.test/releases/file.zip",
        cacheDirectory: join(root, "redirect-cache"),
        verification: { mode: "observe-only" },
        operatorPrincipalId: "operator.three",
        tool: "test/1",
        sourceMode: "local-test",
        freshness: "require-fresh-network",
        fetch: redirectFetch,
        remotePolicy: {
          allowedSources: [{ host: "data.example.test", pathPrefix: "/releases/" }],
          allowInsecureHttpForTesting: true,
          allowPrivateNetworkForTesting: true,
        },
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_SOURCE" });
  });

  it("allows only an exact reviewed signed-redirect resource and redacts its query", async () => {
    const root = await temporaryDirectory();
    const sourceUrl = "https://catalogue.example.test/release/cnf.zip";
    const resolvedUrl =
      "https://storage.example.test/resources/release-id/cnf.zip?se=temporary&sig=secret";
    const requested: string[] = [];
    const redirectFetch: typeof fetch = async (input) => {
      requested.push(String(input));
      return requested.length === 1
        ? new Response(null, { status: 302, headers: { location: resolvedUrl } })
        : new Response("canonical-bytes", { status: 200 });
    };

    const result = await acquireArtifact({
      source: sourceUrl,
      cacheDirectory: join(root, "redirect-cache"),
      verification: { mode: "observe-only" },
      operatorPrincipalId: "operator.four",
      tool: "test/1",
      sourceMode: "local-test",
      freshness: "require-fresh-network",
      fetch: redirectFetch,
      remotePolicy: {
        allowedSources: [
          { host: "catalogue.example.test", pathExact: "/release/cnf.zip" },
          {
            host: "storage.example.test",
            pathExact: "/resources/release-id/cnf.zip",
          },
        ],
        allowPrivateNetworkForTesting: true,
      },
    });

    expect(requested).toEqual([sourceUrl, resolvedUrl]);
    expect(result.observation).toMatchObject({
      downloadUrl: sourceUrl,
      resolvedUrl: "https://storage.example.test/resources/release-id/cnf.zip",
    });
    expect(JSON.stringify(result.observation)).not.toContain("secret");

    await expect(
      acquireArtifact({
        source: sourceUrl,
        cacheDirectory: join(root, "wrong-resource-cache"),
        verification: { mode: "observe-only" },
        operatorPrincipalId: "operator.four",
        tool: "test/1",
        sourceMode: "local-test",
        freshness: "require-fresh-network",
        fetch: async () =>
          new Response(null, {
            status: 302,
            headers: {
              location: "https://storage.example.test/resources/other-release/cnf.zip?sig=secret",
            },
          }),
        remotePolicy: {
          allowedSources: [
            { host: "catalogue.example.test", pathExact: "/release/cnf.zip" },
            {
              host: "storage.example.test",
              pathExact: "/resources/release-id/cnf.zip",
            },
          ],
          allowPrivateNetworkForTesting: true,
        },
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_SOURCE" });
  });
});

describe("archive safety and ZIP extraction", () => {
  it("rejects traversal, ambiguous separators, links, duplicates, and bombs in preflight", () => {
    const base = { compressedSize: 10, uncompressedSize: 10, type: "file" as const };
    for (const path of ["../escape", "/absolute", "C:/drive", "a\\b", "a//b", "a/./b"]) {
      expect(() => planArchiveExtraction([{ ...base, path }], "/tmp/safe")).toThrowError(
        expect.objectContaining({ code: "INVALID_ARCHIVE_ENTRY" }),
      );
    }
    expect(() =>
      planArchiveExtraction([{ ...base, path: "link", type: "symlink" }], "/tmp/safe"),
    ).toThrowError(expect.objectContaining({ code: "INVALID_ARCHIVE_ENTRY" }));
    expect(() =>
      planArchiveExtraction(
        [
          { ...base, path: "Food.csv" },
          { ...base, path: "food.csv" },
        ],
        "/tmp/safe",
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_ARCHIVE_ENTRY" }));
    expect(() =>
      planArchiveExtraction(
        [{ path: "bomb", type: "file", compressedSize: 1, uncompressedSize: 10_000 }],
        "/tmp/safe",
        { maxCompressionRatio: 20 },
      ),
    ).toThrowError(expect.objectContaining({ code: "ARCHIVE_LIMIT_EXCEEDED" }));
  });

  it("streams an exact expected member and refuses unexpected members", async () => {
    const root = await temporaryDirectory();
    const archive = join(root, "fixture.zip");
    await writeFile(
      archive,
      makeStoredZip([{ name: "release/data.csv", data: Buffer.from("id,name\n1,apple\n") }]),
    );
    const extracted = await extractZipArchive({
      archivePath: archive,
      destinationDirectory: join(root, "out"),
      expectedFiles: ["release/data.csv"],
    });
    expect(extracted).toHaveLength(1);
    expect(await readFile(extracted[0]?.path ?? "", "utf8")).toBe("id,name\n1,apple\n");

    const extraArchive = join(root, "extra.zip");
    await writeFile(
      extraArchive,
      makeStoredZip([
        { name: "release/data.csv", data: Buffer.from("ok") },
        { name: "unexpected.txt", data: Buffer.from("no") },
      ]),
    );
    await expect(
      extractZipArchive({
        archivePath: extraArchive,
        destinationDirectory: join(root, "extra-out"),
        expectedFiles: ["release/data.csv"],
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARCHIVE_ENTRY" });
    const subset = await extractZipArchive({
      archivePath: extraArchive,
      destinationDirectory: join(root, "subset-out"),
      expectedFiles: ["release/data.csv"],
      memberPolicy: "required-subset",
    });
    expect(subset.map((file) => file.archivePath)).toEqual(["release/data.csv"]);
  });

  it("rejects a traversal member before writing files", async () => {
    const root = await temporaryDirectory();
    const archive = join(root, "traversal.zip");
    await writeFile(
      archive,
      makeStoredZip([{ name: "../escape.txt", data: Buffer.from("escape") }]),
    );
    await expect(
      extractZipArchive({
        archivePath: archive,
        destinationDirectory: join(root, "out"),
        expectedFiles: ["../escape.txt"],
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARCHIVE_ENTRY" });
    await expect(readFile(join(root, "escape.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

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
