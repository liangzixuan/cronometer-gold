import { createHash, createPublicKey, generateKeyPairSync, verify } from "node:crypto";

import { describe, expect, it } from "vitest";
import {
  assertOciObjectVersionListStatus,
  createOciSignedGetAuthorization,
  OciNativeObjectVersionResolver,
  OciObjectStorageError,
  parseOciSingletonObjectVersion,
} from "./oci-native-object-version-resolver.js";
import { S3ArtifactStoreVersionConflictError } from "./s3-raw-artifact-store.js";

const objectKey = `erasure-ledger/v1/locator-v1/${"a".repeat(64)}.json.enc`;

function body(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), "utf8");
}

function version(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    isDeleteMarker: false,
    name: objectKey,
    timeModified: "2026-08-16T12:00:00.000Z",
    versionId: "c0a8012e-0000-4000-8000-0123456789ab",
    ...overrides,
  };
}

describe("OCI native restore-only object version inventory", () => {
  it("accepts only a fingerprint-matched RSA API signing key of sufficient strength", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2_048 });
    const fingerprint = createHash("md5")
      .update(createPublicKey(privateKey).export({ format: "der", type: "spki" }))
      .digest("hex")
      .match(/.{2}/g)
      ?.join(":");
    expect(fingerprint).toBeDefined();
    const options = {
      bucket: "nutrition-erasure-ledger",
      fingerprint: fingerprint ?? "",
      namespace: "axaxnpcrorw5",
      privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      region: "us-ashburn-1",
      tenancyOcid: "ocid1.tenancy.oc1..aaaaaaaaaaaaaaaa",
      userOcid: "ocid1.user.oc1..bbbbbbbbbbbbbbbb",
    } as const;
    expect(() => new OciNativeObjectVersionResolver(options)).not.toThrow();
    expect(
      () =>
        new OciNativeObjectVersionResolver({
          ...options,
          fingerprint: "00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00",
        }),
    ).toThrow("fingerprint does not match");

    const { privateKey: nonRsaKey } = generateKeyPairSync("ed25519");
    expect(
      () =>
        new OciNativeObjectVersionResolver({
          ...options,
          privateKeyPem: nonRsaKey.export({ format: "pem", type: "pkcs8" }).toString(),
        }),
    ).toThrow("requires a 2048-bit or stronger RSA key");
  });

  it("requires exactly HTTP 200 for ListObjectVersions", () => {
    expect(() => assertOciObjectVersionListStatus(200)).not.toThrow();
    expect(() => assertOciObjectVersionListStatus(206)).toThrow(OciObjectStorageError);
  });

  it("creates a deterministic RSA-SHA256 Signature v1 authorization value", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2_048 });
    const requestTarget =
      "/n/example/b/nutrition-erasure-ledger/objectversions?prefix=erasure-ledger%2Fv1%2Fabc.enc&limit=2&fields=name";
    const input = {
      date: "Sun, 16 Aug 2026 12:00:00 GMT",
      host: "objectstorage.us-ashburn-1.oraclecloud.com",
      keyId:
        "ocid1.tenancy.oc1..aaaaaaaaaaaaaaaa/ocid1.user.oc1..bbbbbbbbbbbbbbbb/00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff",
      privateKey,
      requestTarget,
    } as const;
    const authorization = createOciSignedGetAuthorization(input);
    expect(createOciSignedGetAuthorization(input)).toBe(authorization);
    expect(authorization).toMatch(
      /^Signature version="1",keyId="[^"\r\n]+",algorithm="rsa-sha256",headers="\(request-target\) host date",signature="[A-Za-z0-9+/]+=*"$/,
    );
    const encodedSignature = /signature="([A-Za-z0-9+/]+=*)"$/.exec(authorization)?.[1];
    expect(encodedSignature).toBeDefined();
    expect(
      verify(
        "RSA-SHA256",
        Buffer.from(
          `(request-target): get ${requestTarget}\n` +
            "host: objectstorage.us-ashburn-1.oraclecloud.com\n" +
            "date: Sun, 16 Aug 2026 12:00:00 GMT",
          "utf8",
        ),
        publicKey,
        Buffer.from(encodedSignature ?? "", "base64"),
      ),
    ).toBe(true);
  });

  it("accepts only one complete exact non-delete version and treats a complete empty page as absent", () => {
    expect(
      parseOciSingletonObjectVersion({
        body: body({ items: [version()], prefixes: [] }),
        exactObjectKey: objectKey,
      }),
    ).toEqual({ versionId: "c0a8012e-0000-4000-8000-0123456789ab" });
    expect(
      parseOciSingletonObjectVersion({
        body: body({ items: [], prefixes: [] }),
        exactObjectKey: objectKey,
      }),
    ).toBeNull();
  });

  it.each([
    {
      label: "pagination",
      value: { body: body({ items: [version()] }), opcNextPage: "next-page" },
    },
    {
      label: "empty pagination marker",
      value: { body: body({ items: [version()] }), opcNextPage: "" },
    },
    {
      label: "multiple historical versions",
      value: {
        body: body({
          items: [version(), version({ versionId: "d0a8012e-0000-4000-8000-0123456789ab" })],
        }),
      },
    },
    {
      label: "committed delete marker",
      value: { body: body({ items: [version({ isDeleteMarker: true })] }) },
    },
    {
      label: "prefix collision",
      value: { body: body({ items: [version({ name: `${objectKey}.other` })] }) },
    },
    {
      label: "server-side common prefix",
      value: { body: body({ items: [], prefixes: [objectKey] }) },
    },
    {
      label: "truncated JSON",
      value: { body: Buffer.from('{"items":[', "utf8") },
    },
    {
      label: "invalid UTF-8",
      value: { body: Buffer.from([0xc3, 0x28]) },
    },
  ])("fails closed on $label", ({ value }) => {
    expect(() =>
      parseOciSingletonObjectVersion({
        exactObjectKey: objectKey,
        ...value,
      }),
    ).toThrow(S3ArtifactStoreVersionConflictError);
  });

  it("rejects duplicate JSON properties instead of accepting last-write-wins ambiguity", () => {
    const duplicate = Buffer.from(
      `{"items":[{"name":${JSON.stringify(objectKey)},"versionId":"one","versionId":"two","isDeleteMarker":false}]}`,
      "utf8",
    );
    expect(() =>
      parseOciSingletonObjectVersion({ body: duplicate, exactObjectKey: objectKey }),
    ).toThrow(S3ArtifactStoreVersionConflictError);
  });
});
