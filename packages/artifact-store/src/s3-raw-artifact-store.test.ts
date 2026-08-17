import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { EncryptedArtifactStore } from "./artifact-encryption.js";
import {
  assertS3ExactVersionResponse,
  S3ArtifactStoreTimeoutError,
  S3ArtifactStoreVersionConflictError,
  S3RawArtifactStore,
} from "./s3-raw-artifact-store.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolvePromise, reject) =>
            server.close((error) => (error ? reject(error) : resolvePromise())),
          ),
      ),
  );
});

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

function required<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

describe("S3-compatible encrypted artifact hook", () => {
  it("uses signed bounded PUT/GET/DELETE operations while the object server sees ciphertext only", async () => {
    const objects = new Map<string, Buffer>();
    const authorizations: string[] = [];
    const server = createServer(async (request, response) => {
      const authorization = request.headers.authorization;
      if (
        !authorization?.startsWith("AWS4-HMAC-SHA256 Credential=test-access/") ||
        request.headers["x-amz-content-sha256"] !== "UNSIGNED-PAYLOAD" ||
        request.headers["x-amz-date"] !== "20260816T120000Z"
      ) {
        response.statusCode = 403;
        response.end();
        return;
      }
      authorizations.push(authorization);
      const path = request.url ?? "";
      if (request.method === "PUT") {
        if (request.headers["if-none-match"] !== "*" || objects.has(path)) {
          response.statusCode = 412;
          response.end();
          return;
        }
        const body = await collect(request);
        if (Number(request.headers["content-length"]) !== body.byteLength) {
          response.statusCode = 400;
          response.end();
          return;
        }
        objects.set(path, body);
        response.statusCode = 200;
        response.end();
        return;
      }
      if (request.method === "GET") {
        const value = objects.get(path);
        if (!value) {
          response.statusCode = 404;
          response.end();
          return;
        }
        response.statusCode = 200;
        response.setHeader("content-length", value.byteLength);
        response.end(value);
        return;
      }
      if (request.method === "DELETE") {
        objects.delete(path);
        response.statusCode = 204;
        response.end();
        return;
      }
      response.statusCode = 405;
      response.end();
    });
    servers.push(server);
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    const port = (server.address() as AddressInfo).port;
    const rawStore = new S3RawArtifactStore({
      accessKeyId: "test-access",
      bucket: "private-exports",
      clock: () => new Date("2026-08-16T12:00:00.000Z"),
      endpoint: `http://127.0.0.1:${port}`,
      region: "us-east-1",
      secretAccessKey: "test-secret",
    });
    const encryptedStore = new EncryptedArtifactStore({
      keyRing: {
        currentKeyId: "key-v1",
        keys: new Map([["key-v1", Buffer.alloc(32, 8)]]),
        purpose: "export",
      },
      nonce: () => Buffer.alloc(12, 6),
      rawStore,
    });
    const plaintext = Buffer.from('{"healthDetail":"must remain encrypted"}\n');
    const metadata = await encryptedStore.put({
      mediaType: "application/json",
      objectKey: "exports/user-one/job.json.enc",
      plaintextBytes: plaintext.byteLength,
      source: Readable.from([plaintext]),
    });
    const stored = objects.get("/private-exports/exports/user-one/job.json.enc");
    expect(stored).toBeDefined();
    expect(stored?.includes(Buffer.from("healthDetail"))).toBe(false);

    const opened = required(
      await encryptedStore.openAuthenticated(metadata),
      "Missing authenticated export artifact",
    );
    expect(await collect(opened.stream)).toEqual(plaintext);
    await opened.dispose();
    await rawStore.delete({ objectKey: metadata.objectKey });
    expect(objects).toHaveLength(0);
    expect(authorizations).toHaveLength(3);
    expect(new Set(authorizations).size).toBe(3);
  });

  it("aborts a storage endpoint that does not produce response bytes within the bound", async () => {
    const server = createServer(() => undefined);
    servers.push(server);
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    const port = (server.address() as AddressInfo).port;
    const store = new S3RawArtifactStore({
      accessKeyId: "test-access",
      bucket: "private-exports",
      endpoint: `http://127.0.0.1:${port}`,
      region: "us-east-1",
      requestTimeoutMs: 100,
      secretAccessKey: "test-secret",
    });
    await expect(store.open({ objectKey: "exports/slow.enc" })).rejects.toBeInstanceOf(
      S3ArtifactStoreTimeoutError,
    );
  });

  it("restore-only reads an exact version and fails closed on version or delete-marker ambiguity", async () => {
    let state: "good" | "not_latest" | "ambiguous" = "good";
    const ciphertext = Buffer.from("singleton-version-ciphertext");
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://s3.test");
      if (url.searchParams.has("versions")) {
        response.statusCode = 200;
        response.setHeader("content-type", "application/xml");
        response.end(
          `<ListVersionsResult><IsTruncated>false</IsTruncated>` +
            `<Version><Key>erasure-ledger/v1/key/abc.enc</Key><VersionId>version-one</VersionId><IsLatest>${state === "good" ? "true" : "false"}</IsLatest></Version>` +
            (state === "ambiguous"
              ? `<DeleteMarker><Key>erasure-ledger/v1/key/abc.enc</Key><VersionId>delete-two</VersionId><IsLatest>true</IsLatest></DeleteMarker>`
              : "") +
            `</ListVersionsResult>`,
        );
        return;
      }
      if (url.searchParams.get("versionId") !== "version-one") {
        response.statusCode = 400;
        response.end();
        return;
      }
      response.statusCode = 200;
      response.setHeader("content-length", ciphertext.byteLength);
      response.setHeader("x-amz-version-id", "version-one");
      response.end(ciphertext);
    });
    servers.push(server);
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    const port = (server.address() as AddressInfo).port;
    const store = new S3RawArtifactStore({
      accessKeyId: "restore-access",
      bucket: "erasure-ledger",
      endpoint: `http://127.0.0.1:${port}`,
      readVersionPolicy: "require_singleton",
      region: "us-east-1",
      secretAccessKey: "restore-secret",
    });
    const opened = required(
      await store.open({ objectKey: "erasure-ledger/v1/key/abc.enc" }),
      "Missing versioned ledger object",
    );
    expect(await collect(opened.stream)).toEqual(ciphertext);
    state = "not_latest";
    await expect(store.open({ objectKey: "erasure-ledger/v1/key/abc.enc" })).rejects.toBeInstanceOf(
      S3ArtifactStoreVersionConflictError,
    );
    state = "ambiguous";
    await expect(store.open({ objectKey: "erasure-ledger/v1/key/abc.enc" })).rejects.toBeInstanceOf(
      S3ArtifactStoreVersionConflictError,
    );
  });

  it("fails closed when a listed singleton version disappears before its exact read", async () => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://s3.test");
      if (url.searchParams.has("versions")) {
        response.statusCode = 200;
        response.end(
          `<ListVersionsResult><IsTruncated>false</IsTruncated>` +
            `<Version><Key>erasure-ledger/v1/key/abc.enc</Key><VersionId>version-one</VersionId><IsLatest>true</IsLatest></Version>` +
            `</ListVersionsResult>`,
        );
        return;
      }
      expect(url.searchParams.get("versionId")).toBe("version-one");
      response.statusCode = 404;
      response.end();
    });
    servers.push(server);
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    const port = (server.address() as AddressInfo).port;
    const store = new S3RawArtifactStore({
      accessKeyId: "restore-access",
      bucket: "erasure-ledger",
      endpoint: `http://127.0.0.1:${port}`,
      readVersionPolicy: "require_singleton",
      region: "us-east-1",
      secretAccessKey: "restore-secret",
    });
    await expect(store.open({ objectKey: "erasure-ledger/v1/key/abc.enc" })).rejects.toBeInstanceOf(
      S3ArtifactStoreVersionConflictError,
    );
  });

  it("uses an injected native inventory only for resolution and keeps the exact read on S3 compatibility", async () => {
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(request.url ?? "");
      response.statusCode = 404;
      response.end();
    });
    servers.push(server);
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    const port = (server.address() as AddressInfo).port;
    const store = new S3RawArtifactStore({
      accessKeyId: "restore-access",
      bucket: "erasure-ledger",
      endpoint: `http://127.0.0.1:${port}`,
      readVersionPolicy: "require_singleton",
      region: "us-east-1",
      secretAccessKey: "restore-secret",
      singletonVersionResolver: {
        resolveSingletonVersion: async () => ({ versionId: "oci-version-one" }),
      },
    });
    await expect(store.open({ objectKey: "erasure-ledger/v1/key/abc.enc" })).rejects.toBeInstanceOf(
      S3ArtifactStoreVersionConflictError,
    );
    expect(requests).toEqual([
      "/erasure-ledger/erasure-ledger/v1/key/abc.enc?versionId=oci-version-one",
    ]);
  });

  it("accepts only an exact 200 response bound to the requested live version", () => {
    expect(() =>
      assertS3ExactVersionResponse({
        requestedVersionId: "version-one",
        statusCode: 200,
        versionIdHeader: "version-one",
      }),
    ).not.toThrow();
    expect(() =>
      assertS3ExactVersionResponse({
        deleteMarkerHeader: "false",
        requestedVersionId: "version-one",
        statusCode: 200,
        versionIdHeader: "version-one",
      }),
    ).not.toThrow();
  });

  it.each([
    { label: "missing version header", statusCode: 200 },
    { label: "mismatched version", statusCode: 200, versionIdHeader: "version-two" },
    {
      label: "multiple version headers",
      statusCode: 200,
      versionIdHeader: ["version-one", "version-two"],
    },
    {
      deleteMarkerHeader: "true",
      label: "delete marker",
      statusCode: 200,
      versionIdHeader: "version-one",
    },
    {
      deleteMarkerHeader: ["false", "true"],
      label: "multiple delete-marker headers",
      statusCode: 200,
      versionIdHeader: "version-one",
    },
    { label: "partial response", statusCode: 206, versionIdHeader: "version-one" },
  ])("rejects exact-version response with $label", (input) => {
    expect(() =>
      assertS3ExactVersionResponse({
        requestedVersionId: "version-one",
        ...input,
      }),
    ).toThrow(S3ArtifactStoreVersionConflictError);
  });

  it("rejects incomplete, ambiguous, and noncanonical version-list XML", async () => {
    let document = "";
    const server = createServer((_request, response) => {
      response.statusCode = 200;
      response.setHeader("content-type", "application/xml");
      response.end(document);
    });
    servers.push(server);
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    const port = (server.address() as AddressInfo).port;
    const store = new S3RawArtifactStore({
      accessKeyId: "restore-access",
      bucket: "erasure-ledger",
      endpoint: `http://127.0.0.1:${port}`,
      readVersionPolicy: "require_singleton",
      region: "us-east-1",
      secretAccessKey: "restore-secret",
    });
    const malformedDocuments = [
      "<ListVersionsResult><IsTruncated>false</IsTruncated>",
      "<ListVersionsResult></ListVersionsResult>",
      "<ListVersionsResult><IsTruncated>false</IsTruncated><IsTruncated>false</IsTruncated></ListVersionsResult>",
      "<ListVersionsResult><IsTruncated> false </IsTruncated></ListVersionsResult>",
      "<ListVersionsResult><IsTruncated>true</IsTruncated></ListVersionsResult>",
      "<ListVersionsResult><Container><IsTruncated>false</IsTruncated></Container></ListVersionsResult>",
      `<ListVersionsResult><IsTruncated>false</IsTruncated>` +
        `<Version><Key>erasure-ledger/v1/key/abc.enc</Key><VersionId>version-one</VersionId><IsLatest>true</IsLatest>` +
        `</ListVersionsResult>`,
      `<?xml version="1.1" encoding="UTF-8"?><ListVersionsResult><IsTruncated>false</IsTruncated></ListVersionsResult>`,
    ];
    for (const candidate of malformedDocuments) {
      document = candidate;
      await expect(
        store.open({ objectKey: "erasure-ledger/v1/key/abc.enc" }),
      ).rejects.toBeInstanceOf(S3ArtifactStoreVersionConflictError);
    }
  });
});
