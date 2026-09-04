import { createHash } from "node:crypto";
import {
  existsSync,
  fstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdir, mkdtemp, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import yauzl, { type Options as YauzlOptions, type ZipFile } from "yauzl";
import {
  acquireArtifact,
  extractZipArchive,
  planArchiveExtraction,
  withExtractedZipArchive,
} from "../src/index.js";

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

  it("requires reading the source before reusing a pinned cache object", async () => {
    const root = await temporaryDirectory();
    const source = join(root, "source.bin");
    const cacheDirectory = join(root, "cache");
    const bytes = Buffer.from("canonical source-read fixture");
    await writeFile(source, bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const common = {
      cacheDirectory,
      operatorPrincipalId: "operator.source-read@example.test",
      source,
      sourceMode: "local-test" as const,
      tool: "ingestion-test/1",
      verification: {
        mode: "verified" as const,
        expected: { byteSize: bytes.length, provenance: "pinned fixture", sha256 },
      },
    };
    const seeded = await acquireArtifact(common);

    await rm(source);
    await expect(
      acquireArtifact({ ...common, sourceReadMode: "require-source-read" }),
    ).rejects.toMatchObject({ code: "ENOENT" });

    await writeFile(source, Buffer.alloc(bytes.length, 0x78));
    await expect(
      acquireArtifact({ ...common, sourceReadMode: "require-source-read" }),
    ).rejects.toMatchObject({ code: "CHECKSUM_MISMATCH" });
    expect(await readFile(seeded.path)).toEqual(bytes);
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

  it("extracts from the exact verified descriptor and closes it on success", async () => {
    const root = await temporaryDirectory();
    const archive = join(root, "descriptor-bound-success.zip");
    const archiveBytes = makeStoredZip([{ name: "only.csv", data: Buffer.from("trusted") }]);
    await writeFile(archive, archiveBytes);
    const destinationDirectory = join(root, "success-out");
    const originalFromFd = yauzl.fromFd.bind(yauzl) as (
      fd: number,
      options: YauzlOptions,
      callback: (error: Error | null, zipfile: ZipFile) => void,
    ) => void;
    let descriptor: number | undefined;
    const fromFdSpy = vi.spyOn(yauzl, "fromFd").mockImplementation(((
      fd: number,
      options: YauzlOptions,
      callback: (error: Error | null, zipfile: ZipFile) => void,
    ) => {
      descriptor = fd;
      originalFromFd(fd, options, callback);
    }) as typeof yauzl.fromFd);
    try {
      const extracted = await extractZipArchive({
        archiveExpectation: {
          byteSize: archiveBytes.byteLength,
          sha256: createHash("sha256").update(archiveBytes).digest("hex"),
        },
        archivePath: archive,
        destinationDirectory,
        expectedFiles: ["only.csv"],
      });
      expect(extracted).toHaveLength(1);
      expect(descriptor).toBeTypeOf("number");
      expect(() => fstatSync(descriptor ?? -1)).toThrowError(
        expect.objectContaining({ code: "EBADF" }),
      );
      expect(await readFile(join(destinationDirectory, "only.csv"), "utf8")).toBe("trusted");
    } finally {
      fromFdSpy.mockRestore();
    }
  });

  it("closes the exact descriptor when yauzl initialization fails", async () => {
    const root = await temporaryDirectory();
    const archive = join(root, "descriptor-initialization-failure.zip");
    const archiveBytes = makeStoredZip([{ name: "only.csv", data: Buffer.from("trusted") }]);
    await writeFile(archive, archiveBytes);
    const destinationDirectory = join(root, "initialization-failure-out");
    let descriptor: number | undefined;
    const fromFdSpy = vi.spyOn(yauzl, "fromFd").mockImplementation(((
      fd: number,
      _options: YauzlOptions,
      callback: (error: Error | null, zipfile: ZipFile) => void,
    ) => {
      descriptor = fd;
      callback(
        new Error("injected descriptor initialization failure"),
        undefined as unknown as ZipFile,
      );
    }) as typeof yauzl.fromFd);
    try {
      await expect(
        extractZipArchive({
          archiveExpectation: {
            byteSize: archiveBytes.byteLength,
            sha256: createHash("sha256").update(archiveBytes).digest("hex"),
          },
          archivePath: archive,
          destinationDirectory,
          expectedFiles: ["only.csv"],
        }),
      ).rejects.toMatchObject({
        cause: expect.objectContaining({
          message: "injected descriptor initialization failure",
        }),
        message: "Unable to open the descriptor-bound ZIP archive",
      });
      expect(descriptor).toBeTypeOf("number");
      expect(() => fstatSync(descriptor ?? -1)).toThrowError(
        expect.objectContaining({ code: "EBADF" }),
      );
      expect(await readdir(destinationDirectory)).toEqual([]);
    } finally {
      fromFdSpy.mockRestore();
    }
  });

  it("fails closed if the verified archive pathname is replaced after descriptor binding", async () => {
    const root = await temporaryDirectory();
    const archive = join(root, "descriptor-bound-replacement.zip");
    const displaced = join(root, "displaced.zip");
    const originalBytes = makeStoredZip([{ name: "only.csv", data: Buffer.from("trusted") }]);
    const replacementBytes = makeStoredZip([{ name: "only.csv", data: Buffer.from("altered") }]);
    await writeFile(archive, originalBytes);
    const destinationDirectory = join(root, "replacement-out");
    const originalFromFd = yauzl.fromFd.bind(yauzl) as (
      fd: number,
      options: YauzlOptions,
      callback: (error: Error | null, zipfile: ZipFile) => void,
    ) => void;
    let replaced = false;
    const fromFdSpy = vi.spyOn(yauzl, "fromFd").mockImplementation(((
      fd: number,
      options: YauzlOptions,
      callback: (error: Error | null, zipfile: ZipFile) => void,
    ) => {
      if (!replaced) {
        replaced = true;
        renameSync(archive, displaced);
        writeFileSync(archive, replacementBytes);
      }
      originalFromFd(fd, options, callback);
    }) as typeof yauzl.fromFd);
    try {
      await expect(
        extractZipArchive({
          archiveExpectation: {
            byteSize: originalBytes.byteLength,
            sha256: createHash("sha256").update(originalBytes).digest("hex"),
          },
          archivePath: archive,
          destinationDirectory,
          expectedFiles: ["only.csv"],
        }),
      ).rejects.toThrow(/Verified ZIP archive (?:path )?changed during extraction/);
      expect(await readdir(destinationDirectory)).toEqual([]);
    } finally {
      fromFdSpy.mockRestore();
    }
  });

  it("rejects in-place mutation after verification and closes the descriptor on failure", async () => {
    const root = await temporaryDirectory();
    const archive = join(root, "descriptor-bound-mutation.zip");
    const originalBytes = makeStoredZip([{ name: "only.csv", data: Buffer.from("trusted") }]);
    const replacementBytes = makeStoredZip([{ name: "only.csv", data: Buffer.from("altered") }]);
    expect(replacementBytes.byteLength).toBe(originalBytes.byteLength);
    await writeFile(archive, originalBytes);
    const destinationDirectory = join(root, "mutation-out");
    const originalFromFd = yauzl.fromFd.bind(yauzl) as (
      fd: number,
      options: YauzlOptions,
      callback: (error: Error | null, zipfile: ZipFile) => void,
    ) => void;
    let descriptor: number | undefined;
    let mutated = false;
    const fromFdSpy = vi.spyOn(yauzl, "fromFd").mockImplementation(((
      fd: number,
      options: YauzlOptions,
      callback: (error: Error | null, zipfile: ZipFile) => void,
    ) => {
      descriptor = fd;
      if (!mutated) {
        mutated = true;
        writeFileSync(archive, replacementBytes);
      }
      originalFromFd(fd, options, callback);
    }) as typeof yauzl.fromFd);
    try {
      await expect(
        extractZipArchive({
          archiveExpectation: {
            byteSize: originalBytes.byteLength,
            sha256: createHash("sha256").update(originalBytes).digest("hex"),
          },
          archivePath: archive,
          destinationDirectory,
          expectedFiles: ["only.csv"],
        }),
      ).rejects.toThrow(/Verified ZIP archive (?:changed|content changed) during extraction/);
      expect(descriptor).toBeTypeOf("number");
      expect(() => fstatSync(descriptor ?? -1)).toThrowError(
        expect.objectContaining({ code: "EBADF" }),
      );
      expect(await readdir(destinationDirectory)).toEqual([]);
    } finally {
      fromFdSpy.mockRestore();
    }
  });

  it("awaits an asynchronous successful ZIP reader close and removes iteration listeners", async () => {
    const root = await temporaryDirectory();
    const archive = join(root, "awaited-close.zip");
    await writeFile(archive, makeStoredZip([{ name: "only.csv", data: Buffer.from("await") }]));
    const destinationDirectory = join(root, "out");
    const prototype = yauzl.ZipFile.prototype;
    const originalClose = prototype.close;
    let closeCalled = false;
    let errorListenerCountAtClose = -1;
    let closingZip: ZipFile | undefined;
    let releaseClose: (() => void) | undefined;
    const closeSpy = vi.spyOn(prototype, "close").mockImplementation(function (this: ZipFile) {
      closeCalled = true;
      closingZip = this;
      errorListenerCountAtClose = this.listenerCount("error");
      releaseClose = () => {
        if (this.isOpen) {
          originalClose.call(this);
        }
      };
    });
    const extraction = extractZipArchive({
      archivePath: archive,
      destinationDirectory,
      expectedFiles: ["only.csv"],
    });
    try {
      await vi.waitFor(() => expect(closeCalled).toBe(true));
      let settled = false;
      void extraction.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(errorListenerCountAtClose).toBe(1);
      releaseClose?.();
      const extracted = await extraction;
      expect(extracted).toHaveLength(1);
      expect(await readFile(join(destinationDirectory, "only.csv"), "utf8")).toBe("await");
      expect(closingZip?.listenerCount("error")).toBe(0);
    } finally {
      releaseClose?.();
      closeSpy.mockRestore();
    }
  });

  it("never invokes a scoped consumer when the ZIP reader cannot close", async () => {
    const root = await temporaryDirectory();
    const archive = join(root, "scoped-close-failure.zip");
    await writeFile(archive, makeStoredZip([{ name: "only.csv", data: Buffer.from("fault") }]));
    const destinationDirectory = join(root, "scoped-close-failure-out");
    const prototype = yauzl.ZipFile.prototype;
    const originalClose = prototype.close;
    let closeInjected = false;
    let consumerCalls = 0;
    const closeSpy = vi.spyOn(prototype, "close").mockImplementation(function (this: ZipFile) {
      injectYauzlReaderCloseFailure(this, "injected scoped ZIP reader close failure", () => {
        closeInjected = true;
      });
      originalClose.call(this);
    });
    try {
      await expect(
        withExtractedZipArchive(
          {
            archivePath: archive,
            destinationDirectory,
            expectedFiles: ["only.csv"],
          },
          () => {
            consumerCalls += 1;
            return "unreachable";
          },
        ),
      ).rejects.toMatchObject({
        code: "INVALID_ARCHIVE_ENTRY",
        message: "Unable to close the ZIP archive after extraction completed",
      });
    } finally {
      closeSpy.mockRestore();
    }

    expect(closeInjected).toBe(true);
    expect(consumerCalls).toBe(0);
    expect(await readdir(destinationDirectory)).toEqual([]);
  });

  it("preserves an iteration error before an asynchronous ZIP reader close fault", async () => {
    const root = await temporaryDirectory();
    const archive = join(root, "iteration-and-close-failure.zip");
    await writeFile(archive, makeStoredZip([{ name: "only.csv", data: Buffer.from("fault") }]));
    const destinationDirectory = join(root, "out");
    const prototype = yauzl.ZipFile.prototype;
    const originalClose = prototype.close;
    const originalReadEntry = prototype.readEntry;
    let iterationInjected = false;
    let closeInjected = false;
    let errorListenerCountAtClose = -1;
    let closingZip: ZipFile | undefined;
    const readEntrySpy = vi.spyOn(prototype, "readEntry").mockImplementation(function (
      this: ZipFile,
    ) {
      if (!iterationInjected) {
        iterationInjected = true;
        this.emittedError = true;
        this.emit("error", new Error("injected ZIP iteration failure"));
        return;
      }
      originalReadEntry.call(this);
    });
    const closeSpy = vi.spyOn(prototype, "close").mockImplementation(function (this: ZipFile) {
      closingZip = this;
      errorListenerCountAtClose = this.listenerCount("error");
      injectYauzlReaderCloseFailure(this, "injected ZIP reader close failure", () => {
        closeInjected = true;
      });
      originalClose.call(this);
    });
    let failure: unknown;
    try {
      await extractZipArchive({
        archivePath: archive,
        destinationDirectory,
        expectedFiles: ["only.csv"],
      });
    } catch (error) {
      failure = error;
    } finally {
      closeSpy.mockRestore();
      readEntrySpy.mockRestore();
    }

    expect(iterationInjected).toBe(true);
    expect(closeInjected).toBe(true);
    expect(errorListenerCountAtClose).toBe(1);
    expect(failure).toBeInstanceOf(AggregateError);
    const aggregate = failure as AggregateError;
    expect(aggregate.cause).toBe(aggregate.errors[0]);
    expect(aggregate.errors[0]).toMatchObject({
      code: "INVALID_ARCHIVE_ENTRY",
      message: "ZIP archive iteration failed",
    });
    expect(aggregate.errors[1]).toMatchObject({
      code: "INVALID_ARCHIVE_ENTRY",
      message: "Unable to close the ZIP archive after extraction failed",
    });
    expect((aggregate.errors[1] as Error & { cause?: unknown }).cause).toMatchObject({
      message: "injected ZIP reader close failure",
    });
    expect(closingZip?.emittedError).toBe(true);
    expect(closingZip?.listenerCount("error")).toBe(0);
    expect(await readdir(destinationDirectory)).toEqual([]);
  });

  it("validates an exact inventory while extracting only selected data members", async () => {
    const root = await temporaryDirectory();
    const archive = join(root, "fixture.zip");
    const guide = Buffer.from("read this guide before importing");
    await writeFile(
      archive,
      makeStoredZip([
        { name: "release/data.csv", data: Buffer.from("id,name\n1,apple\n") },
        { name: "documentation/guide.txt", data: guide },
      ]),
    );
    const destinationDirectory = join(root, "out");
    const extracted = await extractZipArchive({
      archivePath: archive,
      destinationDirectory,
      expectedFiles: ["release/data.csv", "documentation/guide.txt"],
      selectedFiles: ["release/data.csv"],
    });
    expect(extracted).toHaveLength(1);
    expect(await readFile(extracted[0]?.path ?? "", "utf8")).toBe("id,name\n1,apple\n");
    await expect(
      readFile(join(destinationDirectory, "documentation/guide.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    await expect(
      extractZipArchive({
        archivePath: archive,
        destinationDirectory: join(root, "missing-out"),
        expectedFiles: ["release/data.csv", "documentation/guide.txt", "release/missing.csv"],
        selectedFiles: ["release/data.csv"],
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARCHIVE_ENTRY" });

    await expect(
      extractZipArchive({
        archivePath: archive,
        destinationDirectory: join(root, "limited-out"),
        expectedFiles: ["release/data.csv", "documentation/guide.txt"],
        selectedFiles: ["release/data.csv"],
        limits: { maxFileBytes: guide.length - 1 },
      }),
    ).rejects.toMatchObject({ code: "ARCHIVE_LIMIT_EXCEEDED" });
    await expect(readFile(join(root, "limited-out", "release/data.csv"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses unexpected members unless required-subset compatibility is explicit", async () => {
    const root = await temporaryDirectory();
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

  it("rejects duplicate inventories, duplicate selections, and selections outside inventory", async () => {
    const root = await temporaryDirectory();
    const archive = join(root, "fixture.zip");
    await writeFile(
      archive,
      makeStoredZip([
        { name: "release/data.csv", data: Buffer.from("ok") },
        { name: "documentation/guide.txt", data: Buffer.from("guide") },
      ]),
    );
    const invalidOptions = [
      {
        expectedFiles: ["release/data.csv", "release/data.csv"],
      },
      {
        expectedFiles: ["release/data.csv", "documentation/guide.txt"],
        selectedFiles: ["release/data.csv", "release/data.csv"],
      },
      {
        expectedFiles: ["release/data.csv"],
        selectedFiles: ["documentation/guide.txt"],
      },
    ] as const;
    for (const [index, invalid] of invalidOptions.entries()) {
      await expect(
        extractZipArchive({
          archivePath: archive,
          destinationDirectory: join(root, `invalid-out-${index}`),
          ...invalid,
        }),
      ).rejects.toMatchObject({ code: "INVALID_ARCHIVE_ENTRY" });
    }
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

  it("requires a private current-user extraction boundary", async () => {
    const root = await temporaryDirectory();
    const archive = join(root, "fixture.zip");
    await writeFile(
      archive,
      makeStoredZip([{ name: "release/data.csv", data: Buffer.from("private") }]),
    );
    const destinationDirectory = join(root, "shared-out");
    await mkdir(destinationDirectory, { mode: 0o755 });

    await expect(
      extractZipArchive({
        archivePath: archive,
        destinationDirectory,
        expectedFiles: ["release/data.csv"],
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARCHIVE_ENTRY",
      message: "ZIP destination root is not trusted",
    });
    expect(await readdir(destinationDirectory)).toEqual([]);
  });

  it("preserves root validation failure before destination-directory close failure", async () => {
    const root = await temporaryDirectory();
    const archive = join(root, "root-directory-close.zip");
    await writeFile(archive, makeStoredZip([{ name: "only.csv", data: Buffer.from("root") }]));
    const destinationDirectory = join(root, "out");
    await mkdir(destinationDirectory, { mode: 0o700 });
    const callerOwned = join(destinationDirectory, "caller-owned.txt");
    await writeFile(callerOwned, "preserve", { mode: 0o600 });
    const probe = await open(join(root, "probe-root-directory"), "w+");
    const prototype = methodPrototype(probe, "stat") as { stat: typeof probe.stat };
    const originalStat = prototype.stat;
    await probe.close();
    let validationInjected = false;
    let closeInjected = false;
    const statSpy = vi.spyOn(prototype, "stat").mockImplementation(function (this: typeof probe) {
      if (!validationInjected && descriptorTarget(this.fd) === destinationDirectory) {
        validationInjected = true;
        injectCloseFailure(this, "root directory close failure", () => {
          closeInjected = true;
        });
        return Promise.reject(new Error("root directory validation failure"));
      }
      return originalStat.call(this);
    });
    let failure: unknown;
    try {
      await extractZipArchive({
        archivePath: archive,
        destinationDirectory,
        expectedFiles: ["only.csv"],
      });
    } catch (error) {
      failure = error;
    } finally {
      statSpy.mockRestore();
    }

    expect(validationInjected).toBe(true);
    expect(closeInjected).toBe(true);
    expect(failure).toBeInstanceOf(AggregateError);
    const aggregate = failure as AggregateError;
    expect(aggregate.cause).toBe(aggregate.errors[0]);
    expect(aggregate.errors[0]).toMatchObject({ message: "root directory validation failure" });
    expect(aggregate.errors[1]).toMatchObject({
      code: "INVALID_ARCHIVE_ENTRY",
      message: "Unable to close an invalid ZIP destination root directory",
    });
    expect(await readdir(destinationDirectory)).toEqual(["caller-owned.txt"]);
    expect(await readFile(callerOwned, "utf8")).toBe("preserve");
  });

  it("preserves nested-parent validation failure before directory close failure", async () => {
    const root = await temporaryDirectory();
    const archive = join(root, "parent-directory-close.zip");
    await writeFile(
      archive,
      makeStoredZip([{ name: "nested/only.csv", data: Buffer.from("nested") }]),
    );
    const destinationDirectory = join(root, "out");
    await mkdir(destinationDirectory, { mode: 0o700 });
    const callerOwned = join(destinationDirectory, "caller-owned.txt");
    await writeFile(callerOwned, "preserve", { mode: 0o600 });
    const nestedDirectory = join(destinationDirectory, "nested");
    const probe = await open(join(root, "probe-parent-directory"), "w+");
    const prototype = methodPrototype(probe, "stat") as { stat: typeof probe.stat };
    const originalStat = prototype.stat;
    await probe.close();
    let validationInjected = false;
    let closeInjected = false;
    const statSpy = vi.spyOn(prototype, "stat").mockImplementation(function (this: typeof probe) {
      if (!validationInjected && descriptorTarget(this.fd) === nestedDirectory) {
        validationInjected = true;
        injectCloseFailure(this, "parent directory close failure", () => {
          closeInjected = true;
        });
        return Promise.reject(new Error("parent directory validation failure"));
      }
      return originalStat.call(this);
    });
    let failure: unknown;
    try {
      await extractZipArchive({
        archivePath: archive,
        destinationDirectory,
        expectedFiles: ["nested/only.csv"],
      });
    } catch (error) {
      failure = error;
    } finally {
      statSpy.mockRestore();
    }

    expect(validationInjected).toBe(true);
    expect(closeInjected).toBe(true);
    expect(failure).toBeInstanceOf(AggregateError);
    const aggregate = failure as AggregateError;
    expect(aggregate.cause).toBe(aggregate.errors[0]);
    expect(aggregate.errors[0]).toMatchObject({ message: "parent directory validation failure" });
    expect(aggregate.errors[1]).toMatchObject({
      code: "INVALID_ARCHIVE_ENTRY",
      message: "Unable to close an invalid ZIP destination parent directory",
    });
    expect(await readdir(destinationDirectory)).toEqual(["caller-owned.txt", "nested"]);
    expect(await readdir(nestedDirectory)).toEqual([]);
    expect(await readFile(callerOwned, "utf8")).toBe("preserve");
  });

  it("collects every rebound-directory close failure without masking rebind validation", async () => {
    const root = await temporaryDirectory();
    const archive = join(root, "rebind-directory-close.zip");
    await writeFile(
      archive,
      makeStoredZip([
        { name: "a/one.csv", data: Buffer.from("one") },
        { name: "b/two.csv", data: Buffer.from("two") },
      ]),
    );
    const destinationDirectory = join(root, "out");
    await mkdir(destinationDirectory, { mode: 0o700 });
    const callerOwned = join(destinationDirectory, "caller-owned.txt");
    await writeFile(callerOwned, "preserve", { mode: 0o600 });
    const aDirectory = join(destinationDirectory, "a");
    const bDirectory = join(destinationDirectory, "b");
    const probe = await open(join(root, "probe-rebind-directory"), "w+");
    const prototype = methodPrototype(probe, "stat") as { stat: typeof probe.stat };
    const originalStat = prototype.stat;
    await probe.close();
    let originalRoot: typeof probe | undefined;
    let originalA: typeof probe | undefined;
    let originalB: typeof probe | undefined;
    let initialCloseInjected = false;
    let rebindValidationInjected = false;
    let invalidRebindCloseInjected = false;
    let priorRebindCloseInjected = false;
    const statSpy = vi.spyOn(prototype, "stat").mockImplementation(function (this: typeof probe) {
      const target = descriptorTarget(this.fd);
      if (target === destinationDirectory && !originalRoot) {
        originalRoot = this;
        injectCloseFailure(this, "initial root close failure", () => {
          initialCloseInjected = true;
        });
      } else if (target === aDirectory && !originalA) {
        originalA = this;
      } else if (target === aDirectory && this !== originalA) {
        injectCloseFailure(this, "prior rebound close failure", () => {
          priorRebindCloseInjected = true;
        });
      } else if (target === bDirectory && !originalB) {
        originalB = this;
      } else if (target === bDirectory && this !== originalB && !rebindValidationInjected) {
        rebindValidationInjected = true;
        injectCloseFailure(this, "invalid rebound close failure", () => {
          invalidRebindCloseInjected = true;
        });
        return Promise.reject(new Error("rebind validation failure"));
      }
      return originalStat.call(this);
    });
    let failure: unknown;
    try {
      await extractZipArchive({
        archivePath: archive,
        destinationDirectory,
        expectedFiles: ["a/one.csv", "b/two.csv"],
      });
    } catch (error) {
      failure = error;
    } finally {
      statSpy.mockRestore();
    }

    expect(initialCloseInjected).toBe(true);
    expect(rebindValidationInjected).toBe(true);
    expect(invalidRebindCloseInjected).toBe(true);
    expect(priorRebindCloseInjected).toBe(true);
    expect(failure).toBeInstanceOf(AggregateError);
    const outer = failure as AggregateError;
    const rebindWrapper = outer.errors.find(
      (error) =>
        error instanceof Error &&
        error.message === "Unable to rebind ZIP outputs after destination-handle close failed",
    ) as (Error & { cause?: unknown }) | undefined;
    expect(rebindWrapper).toBeDefined();
    expect(rebindWrapper?.cause).toBeInstanceOf(AggregateError);
    const cleanupAggregate = rebindWrapper?.cause as AggregateError;
    expect(cleanupAggregate.cause).toBe(cleanupAggregate.errors[0]);
    expect(cleanupAggregate.message).toBe(
      "ZIP output rebinding failed and rebound-directory cleanup was incomplete",
    );
    expect(cleanupAggregate.errors[1]).toMatchObject({
      code: "INVALID_ARCHIVE_ENTRY",
      message: "Unable to close a rebound ZIP destination directory after rebinding failed",
    });
    const validationAggregate = cleanupAggregate.errors[0] as AggregateError;
    expect(validationAggregate.cause).toBe(validationAggregate.errors[0]);
    expect(validationAggregate.errors[0]).toMatchObject({ message: "rebind validation failure" });
    expect(validationAggregate.errors[1]).toMatchObject({
      code: "INVALID_ARCHIVE_ENTRY",
      message: "Unable to close an invalid rebound ZIP destination directory",
    });
    expect(await readFile(callerOwned, "utf8")).toBe("preserve");
  });

  it("rolls back an earlier final when a later destination already exists", async () => {
    const root = await temporaryDirectory();
    const archive = join(root, "two-members.zip");
    await writeFile(
      archive,
      makeStoredZip([
        { name: "first.csv", data: Buffer.from("first") },
        { name: "second.csv", data: Buffer.from("second") },
      ]),
    );
    const destinationDirectory = join(root, "out");
    await mkdir(destinationDirectory, { mode: 0o700 });
    const callerOwned = join(destinationDirectory, "second.csv");
    await writeFile(callerOwned, "caller-owned", { mode: 0o600 });

    await expect(
      extractZipArchive({
        archivePath: archive,
        destinationDirectory,
        expectedFiles: ["first.csv", "second.csv"],
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARCHIVE_ENTRY",
      message: "ZIP extraction refuses to overwrite an existing destination",
    });
    expect(await readdir(destinationDirectory)).toEqual(["second.csv"]);
    expect(await readFile(callerOwned, "utf8")).toBe("caller-owned");
  });

  it("runs a scoped consumer before releasing bound directories and returns its result", async () => {
    const root = await temporaryDirectory();
    const archive = join(root, "scoped-success.zip");
    await writeFile(
      archive,
      makeStoredZip([
        { name: "z.csv", data: Buffer.from("last") },
        { name: "nested/a.csv", data: Buffer.from("first") },
      ]),
    );
    const destinationDirectory = join(root, "scoped-success-out");
    const result = Object.freeze({ status: "parsed" as const });

    const consumed = await withExtractedZipArchive(
      {
        archivePath: archive,
        destinationDirectory,
        expectedFiles: ["z.csv", "nested/a.csv"],
      },
      async (files) => {
        expect(Object.isFrozen(files)).toBe(true);
        expect(files.map((file) => file.archivePath)).toEqual(["nested/a.csv", "z.csv"]);
        expect(Object.isFrozen(files[0])).toBe(true);
        expect(await readFile(files[0]?.path ?? "", "utf8")).toBe("first");
        expect(await readFile(files[1]?.path ?? "", "utf8")).toBe("last");
        return result;
      },
    );

    expect(consumed).toBe(result);
    expect(await readFile(join(destinationDirectory, "nested/a.csv"), "utf8")).toBe("first");
    expect(await readFile(join(destinationDirectory, "z.csv"), "utf8")).toBe("last");
  });

  it("rolls back through the bound parent when a scoped consumer swaps the public root", async () => {
    const root = await temporaryDirectory();
    const archive = join(root, "scoped-root-swap.zip");
    await writeFile(archive, makeStoredZip([{ name: "only.csv", data: Buffer.from("owned") }]));
    const destinationDirectory = join(root, "scoped-root-swap-out");
    const displacedDirectory = join(root, "scoped-root-swap-displaced");
    const consumerError = new Error("scoped consumer failure");

    await expect(
      withExtractedZipArchive(
        {
          archivePath: archive,
          destinationDirectory,
          expectedFiles: ["only.csv"],
        },
        () => {
          renameSync(destinationDirectory, displacedDirectory);
          mkdirSync(destinationDirectory, { mode: 0o700 });
          writeFileSync(join(destinationDirectory, "sentinel.txt"), "replacement", {
            mode: 0o600,
          });
          throw consumerError;
        },
      ),
    ).rejects.toBe(consumerError);

    expect(await readdir(displacedDirectory)).toEqual([]);
    expect(await readdir(destinationDirectory)).toEqual(["sentinel.txt"]);
    expect(await readFile(join(destinationDirectory, "sentinel.txt"), "utf8")).toBe("replacement");
  });

  it("rejects a successful scoped consumer after a nested parent becomes a symlink alias", async () => {
    const root = await temporaryDirectory();
    const archive = join(root, "scoped-nested-swap.zip");
    await writeFile(
      archive,
      makeStoredZip([{ name: "nested/only.csv", data: Buffer.from("owned") }]),
    );
    const destinationDirectory = join(root, "scoped-nested-swap-out");
    const publicParent = join(destinationDirectory, "nested");
    const displacedParent = join(destinationDirectory, "nested.displaced");

    await expect(
      withExtractedZipArchive(
        {
          archivePath: archive,
          destinationDirectory,
          expectedFiles: ["nested/only.csv"],
        },
        () => {
          renameSync(publicParent, displacedParent);
          symlinkSync(displacedParent, publicParent, "dir");
          return "parsed";
        },
      ),
    ).rejects.toMatchObject({ code: "INVALID_ARCHIVE_ENTRY" });

    expect(await readdir(displacedParent)).toEqual([]);
    expect(readlinkSync(publicParent)).toBe(displacedParent);
  });

  it("preserves a scoped consumer failure before exact rollback evidence", async () => {
    const root = await temporaryDirectory();
    const archive = join(root, "scoped-replacement.zip");
    await writeFile(archive, makeStoredZip([{ name: "only.csv", data: Buffer.from("owned") }]));
    const destinationDirectory = join(root, "scoped-replacement-out");
    const consumerError = new Error("scoped replacement failure");
    let failure: unknown;

    try {
      await withExtractedZipArchive(
        {
          archivePath: archive,
          destinationDirectory,
          expectedFiles: ["only.csv"],
        },
        (files) => {
          const output = files[0]?.path ?? "";
          unlinkSync(output);
          writeFileSync(output, "caller-owned", { mode: 0o600 });
          throw consumerError;
        },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    const aggregate = failure as AggregateError;
    expect(aggregate.message).toBe("ZIP extraction failed and rollback was incomplete");
    expect(aggregate.cause).toBe(consumerError);
    expect(aggregate.errors[0]).toBe(consumerError);
    expect(aggregate.errors[1]).toMatchObject({
      code: "INVALID_ARCHIVE_ENTRY",
      message: "Unable to remove an exact ZIP extraction output during rollback",
    });
    expect((aggregate.errors[1] as Error & { cause?: unknown }).cause).toMatchObject({
      code: "INVALID_ARCHIVE_ENTRY",
      message: "Refusing to remove a replaced ZIP extraction output",
    });
    expect(await readFile(join(destinationDirectory, "only.csv"), "utf8")).toBe("caller-owned");
  });

  it("rolls back a linked final when temporary-link cleanup fails", async () => {
    const root = await temporaryDirectory();
    const archive = join(root, "post-link.zip");
    await writeFile(archive, makeStoredZip([{ name: "only.csv", data: Buffer.from("linked") }]));
    const destinationDirectory = join(root, "out");
    const signal = new AbortController().signal;
    let removedTemporary = false;
    Object.defineProperty(signal, "aborted", {
      configurable: true,
      get: () => {
        if (removedTemporary || !existsSync(join(destinationDirectory, "only.csv"))) {
          return false;
        }
        const temporary = readdirSync(destinationDirectory).find((name) =>
          name.endsWith(".partial"),
        );
        if (temporary) {
          unlinkSync(join(destinationDirectory, temporary));
          removedTemporary = true;
        }
        return false;
      },
    });

    await expect(
      extractZipArchive({
        archivePath: archive,
        destinationDirectory,
        expectedFiles: ["only.csv"],
        signal,
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(removedTemporary).toBe(true);
    expect(await readdir(destinationDirectory)).toEqual([]);
  });

  it("preserves a caller replacement installed at the temporary path after publication", async () => {
    const root = await temporaryDirectory();
    const archive = join(root, "temporary-replacement.zip");
    await writeFile(archive, makeStoredZip([{ name: "only.csv", data: Buffer.from("linked") }]));
    const destinationDirectory = join(root, "out");
    const signal = new AbortController().signal;
    let replacementPath: string | undefined;
    Object.defineProperty(signal, "aborted", {
      configurable: true,
      get: () => {
        if (replacementPath || !existsSync(join(destinationDirectory, "only.csv"))) {
          return false;
        }
        const temporary = readdirSync(destinationDirectory).find((name) =>
          name.endsWith(".partial"),
        );
        if (temporary) {
          replacementPath = join(destinationDirectory, temporary);
          unlinkSync(replacementPath);
          writeFileSync(replacementPath, "caller-owned", { mode: 0o600 });
        }
        return false;
      },
    });

    await expect(
      extractZipArchive({
        archivePath: archive,
        destinationDirectory,
        expectedFiles: ["only.csv"],
        signal,
      }),
    ).rejects.toBeInstanceOf(AggregateError);
    expect(replacementPath).toBeDefined();
    expect(await readFile(replacementPath ?? "", "utf8")).toBe("caller-owned");
    await expect(readFile(join(destinationDirectory, "only.csv"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects a same-size in-place mutation before publishing extractor evidence", async () => {
    const root = await temporaryDirectory();
    const archive = join(root, "in-place-mutation.zip");
    await writeFile(archive, makeStoredZip([{ name: "only.csv", data: Buffer.from("linked") }]));
    const destinationDirectory = join(root, "out");
    const signal = new AbortController().signal;
    let mutated = false;
    Object.defineProperty(signal, "aborted", {
      configurable: true,
      get: () => {
        const finalPath = join(destinationDirectory, "only.csv");
        if (!mutated && existsSync(finalPath)) {
          const temporary = readdirSync(destinationDirectory).find((name) =>
            name.endsWith(".partial"),
          );
          if (temporary) {
            writeFileSync(finalPath, "caller");
            mutated = true;
          }
        }
        return false;
      },
    });

    await expect(
      extractZipArchive({
        archivePath: archive,
        destinationDirectory,
        expectedFiles: ["only.csv"],
        signal,
      }),
    ).rejects.toBeInstanceOf(AggregateError);
    expect(mutated).toBe(true);
    expect(await readFile(join(destinationDirectory, "only.csv"), "utf8")).toBe("caller");
  });

  it("keeps nested writes bound to the opened parent when its public path is swapped", async () => {
    const root = await temporaryDirectory();
    const archive = join(root, "parent-swap.zip");
    await writeFile(
      archive,
      makeStoredZip([{ name: "release/data.csv", data: Buffer.from("bound") }]),
    );
    const destinationDirectory = join(root, "out");
    const signal = new AbortController().signal;
    const attackerDirectory = join(root, "attacker");
    const originalDirectory = join(destinationDirectory, "release-original");
    let swapped = false;
    Object.defineProperty(signal, "aborted", {
      configurable: true,
      get: () => {
        const releaseDirectory = join(destinationDirectory, "release");
        if (
          !swapped &&
          existsSync(join(releaseDirectory, "data.csv")) &&
          readdirSync(releaseDirectory).some((name) => name.endsWith(".partial"))
        ) {
          mkdirSync(attackerDirectory, { mode: 0o700 });
          renameSync(releaseDirectory, originalDirectory);
          symlinkSync(attackerDirectory, releaseDirectory, "dir");
          swapped = true;
        }
        return false;
      },
    });

    await expect(
      extractZipArchive({
        archivePath: archive,
        destinationDirectory,
        expectedFiles: ["release/data.csv"],
        signal,
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARCHIVE_ENTRY" });
    expect(swapped).toBe(true);
    expect(await readdir(attackerDirectory)).toEqual([]);
    expect(await readdir(originalDirectory)).toEqual([]);
  });

  it("tracks and removes a post-open temporary whose private-mode assertion fails", async () => {
    const root = await temporaryDirectory();
    const archive = join(root, "mode-failure.zip");
    await writeFile(archive, makeStoredZip([{ name: "only.csv", data: Buffer.from("mode") }]));
    const destinationDirectory = join(root, "out");
    await mkdir(destinationDirectory, { mode: 0o700 });
    const previousUmask = process.umask(0o777);
    try {
      await expect(
        extractZipArchive({
          archivePath: archive,
          destinationDirectory,
          expectedFiles: ["only.csv"],
        }),
      ).rejects.toMatchObject({
        code: "INVALID_ARCHIVE_ENTRY",
        message: "New ZIP temporary output is not a private empty single-link regular file",
      });
    } finally {
      process.umask(previousUmask);
    }
    expect(await readdir(destinationDirectory)).toEqual([]);
  });

  it("retries handle identity after an injected initial fstat failure without leaking the fd or partial", async () => {
    const root = await temporaryDirectory();
    const archive = join(root, "fstat-failure.zip");
    await writeFile(archive, makeStoredZip([{ name: "only.csv", data: Buffer.from("fstat") }]));
    const destinationDirectory = join(root, "out");
    const probe = await open(join(root, "probe"), "w+");
    const prototype = methodPrototype(probe, "stat") as { stat: typeof probe.stat };
    const originalStat = prototype.stat;
    await probe.close();
    let injected = false;
    const statSpy = vi.spyOn(prototype, "stat").mockImplementation(function (this: typeof probe) {
      let target = "";
      try {
        target = readlinkSync(`/proc/self/fd/${this.fd}`);
      } catch {
        // A concurrently closing descriptor is not the temporary target.
      }
      if (!injected && target.endsWith(".partial")) {
        injected = true;
        return Promise.reject(new Error("injected initial fstat failure"));
      }
      return originalStat.call(this);
    });
    try {
      await expect(
        extractZipArchive({
          archivePath: archive,
          destinationDirectory,
          expectedFiles: ["only.csv"],
        }),
      ).rejects.toThrow("injected initial fstat failure");
    } finally {
      statSpy.mockRestore();
    }
    expect(injected).toBe(true);
    expect(await readdir(destinationDirectory)).toEqual([]);
  });

  it("preserves primary fstat failure before close and rollback cleanup evidence", async () => {
    const root = await temporaryDirectory();
    const archive = join(root, "fstat-close-failure.zip");
    await writeFile(archive, makeStoredZip([{ name: "only.csv", data: Buffer.from("ordered") }]));
    const destinationDirectory = join(root, "out");
    await mkdir(destinationDirectory, { mode: 0o700 });
    const callerOwned = join(destinationDirectory, "caller-owned.txt");
    await writeFile(callerOwned, "preserve", { mode: 0o600 });
    const probe = await open(join(root, "probe-close"), "w+");
    const statPrototype = methodPrototype(probe, "stat") as { stat: typeof probe.stat };
    const originalStat = statPrototype.stat;
    await probe.close();
    let statInjected = false;
    let closeInjected = false;
    const statSpy = vi.spyOn(statPrototype, "stat").mockImplementation(function (
      this: typeof probe,
    ) {
      const target = descriptorTarget(this.fd);
      if (!statInjected && target.endsWith(".partial")) {
        statInjected = true;
        const originalClose = this.close.bind(this);
        this.close = async () => {
          closeInjected = true;
          await originalClose();
          throw new Error("secondary close failure");
        };
        return Promise.reject(new Error("primary fstat failure"));
      }
      return originalStat.call(this);
    });
    let failure: unknown;
    try {
      await extractZipArchive({
        archivePath: archive,
        destinationDirectory,
        expectedFiles: ["only.csv"],
      });
    } catch (error) {
      failure = error;
    } finally {
      statSpy.mockRestore();
    }

    expect(statInjected).toBe(true);
    expect(closeInjected).toBe(true);
    expect(failure).toBeInstanceOf(AggregateError);
    const aggregate = failure as AggregateError;
    expect(aggregate.cause).toBe(aggregate.errors[0]);
    expect(aggregate.errors[0]).toMatchObject({ message: "primary fstat failure" });
    expect(aggregate.errors[1]).toMatchObject({
      code: "INVALID_ARCHIVE_ENTRY",
      message: "Unable to close a ZIP temporary output after extraction failed",
    });
    expect(await readdir(destinationDirectory)).toEqual(["caller-owned.txt"]);
    expect(await readFile(callerOwned, "utf8")).toBe("preserve");
  });

  it("preserves an unbound partial and reports cleanup when fstat persistently fails", async () => {
    const root = await temporaryDirectory();
    const archive = join(root, "persistent-fstat-failure.zip");
    await writeFile(
      archive,
      makeStoredZip([{ name: "only.csv", data: Buffer.from("persistent") }]),
    );
    const destinationDirectory = join(root, "out");
    await mkdir(destinationDirectory, { mode: 0o700 });
    const callerOwned = join(destinationDirectory, "caller-owned.txt");
    await writeFile(callerOwned, "preserve", { mode: 0o600 });
    const probe = await open(join(root, "probe-persistent"), "w+");
    const prototype = methodPrototype(probe, "stat") as { stat: typeof probe.stat };
    const originalStat = prototype.stat;
    await probe.close();
    let injectedCount = 0;
    const statSpy = vi.spyOn(prototype, "stat").mockImplementation(function (this: typeof probe) {
      if (descriptorTarget(this.fd).endsWith(".partial")) {
        injectedCount += 1;
        return Promise.reject(new Error(`persistent fstat failure ${injectedCount}`));
      }
      return originalStat.call(this);
    });
    let failure: unknown;
    try {
      await extractZipArchive({
        archivePath: archive,
        destinationDirectory,
        expectedFiles: ["only.csv"],
      });
    } catch (error) {
      failure = error;
    } finally {
      statSpy.mockRestore();
    }

    expect(injectedCount).toBeGreaterThanOrEqual(2);
    expect(failure).toBeInstanceOf(AggregateError);
    const aggregate = failure as AggregateError;
    expect(aggregate.errors[0]).toMatchObject({ message: "persistent fstat failure 1" });
    expect(aggregate.errors[1]).toMatchObject({
      code: "INVALID_ARCHIVE_ENTRY",
      message: "Unable to register a ZIP temporary output after post-open validation failed",
    });
    const entries = await readdir(destinationDirectory);
    expect(entries).toContain("caller-owned.txt");
    expect(entries.some((name) => name.endsWith(".partial"))).toBe(true);
    expect(await readFile(callerOwned, "utf8")).toBe("preserve");
  });

  it("restores a quarantined ZIP path when verification and handle close both fail", async () => {
    const root = await temporaryDirectory();
    const archive = join(root, "quarantine-verification-failure.zip");
    await writeFile(
      archive,
      makeStoredZip([{ name: "only.csv", data: Buffer.from("quarantine") }]),
    );
    const destinationDirectory = join(root, "out");
    await mkdir(destinationDirectory, { mode: 0o700 });
    const callerOwned = join(destinationDirectory, "caller-owned.txt");
    await writeFile(callerOwned, "preserve", { mode: 0o600 });
    const probe = await open(join(root, "probe-quarantine"), "w+");
    const statPrototype = methodPrototype(probe, "stat") as { stat: typeof probe.stat };
    const originalStat = statPrototype.stat;
    await probe.close();
    let statInjected = false;
    let closeInjected = false;
    const statSpy = vi.spyOn(statPrototype, "stat").mockImplementation(function (
      this: typeof probe,
    ) {
      if (!statInjected && descriptorTarget(this.fd).includes(".quarantine")) {
        statInjected = true;
        const originalClose = this.close.bind(this);
        this.close = async () => {
          closeInjected = true;
          await originalClose();
          throw new Error("quarantine close failure");
        };
        return Promise.reject(new Error("quarantine fstat failure"));
      }
      return originalStat.call(this);
    });
    let failure: unknown;
    try {
      await extractZipArchive({
        archivePath: archive,
        destinationDirectory,
        expectedFiles: ["only.csv"],
      });
    } catch (error) {
      failure = error;
    } finally {
      statSpy.mockRestore();
    }

    expect(statInjected).toBe(true);
    expect(closeInjected).toBe(true);
    expect(failure).toBeInstanceOf(AggregateError);
    const aggregate = failure as AggregateError;
    expect(aggregate.cause).toBe(aggregate.errors[0]);
    expect(aggregate.errors[0]).toMatchObject({ message: "quarantine fstat failure" });
    expect(aggregate.errors[1]).toMatchObject({
      code: "INVALID_ARCHIVE_ENTRY",
      message: "Unable to close a ZIP output after content verification",
    });
    expect(await readdir(destinationDirectory)).toEqual(["caller-owned.txt"]);
    expect(await readFile(callerOwned, "utf8")).toBe("preserve");
  });
});

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

function injectCloseFailure(
  handle: Awaited<ReturnType<typeof open>>,
  message: string,
  onFailure: () => void,
): void {
  const originalClose = handle.close.bind(handle);
  let injected = false;
  handle.close = async () => {
    if (injected) {
      return;
    }
    injected = true;
    await originalClose();
    onFailure();
    throw new Error(message);
  };
}

function injectYauzlReaderCloseFailure(zip: ZipFile, message: string, onFailure: () => void): void {
  const reader = (
    zip as ZipFile & {
      readonly reader: {
        emit(eventName: string | symbol, ...args: unknown[]): boolean;
      };
    }
  ).reader;
  const originalEmit = reader.emit.bind(reader);
  let injected = false;
  reader.emit = (eventName, ...args) => {
    if (!injected && eventName === "close") {
      injected = true;
      onFailure();
      return originalEmit("error", new Error(message));
    }
    return originalEmit(eventName, ...args);
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
