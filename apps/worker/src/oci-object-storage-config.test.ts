import { describe, expect, it } from "vitest";

import {
  assertOciS3CompatibilityEndpoint,
  isOciS3CompatibilityEndpoint,
  ociS3CompatibilityOrigin,
} from "./oci-object-storage-config.js";

const namespace = "axaxnpcrorw5";
const region = "us-ashburn-1";
const origin = "https://axaxnpcrorw5.compat.objectstorage.us-ashburn-1.oci.customer-oci.com";

describe("OCI Object Storage endpoint binding", () => {
  it("derives and accepts only the normalized root of the current path-style origin", () => {
    expect(ociS3CompatibilityOrigin({ namespace, region })).toBe(origin);
    expect(() =>
      assertOciS3CompatibilityEndpoint({ endpoint: origin, namespace, region }),
    ).not.toThrow();
    expect(() =>
      assertOciS3CompatibilityEndpoint({ endpoint: `${origin}/`, namespace, region }),
    ).not.toThrow();
  });

  it.each([
    `http://axaxnpcrorw5.compat.objectstorage.${region}.oci.customer-oci.com`,
    `https://othernamespace.compat.objectstorage.${region}.oci.customer-oci.com`,
    "https://axaxnpcrorw5.compat.objectstorage.us-phoenix-1.oci.customer-oci.com",
    `https://axaxnpcrorw5.compat.objectstorage.${region}.oraclecloud.com`,
    `${origin}/bucket-a`,
    `${origin}/?bucket=bucket-a`,
    `${origin}/#fragment`,
    `https://user:password@axaxnpcrorw5.compat.objectstorage.${region}.oci.customer-oci.com`,
    ` ${origin}`,
  ])("rejects a nonmatching or non-root endpoint: %s", (endpoint) => {
    expect(() => assertOciS3CompatibilityEndpoint({ endpoint, namespace, region })).toThrow(
      "must exactly match",
    );
  });

  it("identifies OCI compatibility endpoints for production delete-policy enforcement", () => {
    expect(isOciS3CompatibilityEndpoint(origin)).toBe(true);
    expect(
      isOciS3CompatibilityEndpoint(
        `https://${namespace}.compat.objectstorage.${region}.oraclecloud.com`,
      ),
    ).toBe(true);
    expect(isOciS3CompatibilityEndpoint("https://objects.internal.example")).toBe(false);
  });
});
