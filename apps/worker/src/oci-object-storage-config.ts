const OCI_NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,99}$/;
const OCI_REGION_PATTERN = /^[a-z]{2}(?:-[a-z0-9]+)+-[1-9][0-9]*$/;

/** Returns the current OCI dedicated path-style S3 compatibility origin. */
export function ociS3CompatibilityOrigin(input: {
  readonly namespace: string;
  readonly region: string;
}): string {
  if (!OCI_NAMESPACE_PATTERN.test(input.namespace)) {
    throw new Error("Invalid OCI Object Storage namespace");
  }
  if (input.region.length > 64 || !OCI_REGION_PATTERN.test(input.region)) {
    throw new Error("Invalid OCI Object Storage region");
  }
  return `https://${input.namespace}.compat.objectstorage.${input.region}.oci.customer-oci.com`;
}

/** Binds restore S3 reads to the same namespace and region as native version inventory. */
export function assertOciS3CompatibilityEndpoint(input: {
  readonly endpoint: string;
  readonly namespace: string;
  readonly region: string;
}): void {
  const expected = ociS3CompatibilityOrigin(input);
  if (input.endpoint !== expected && input.endpoint !== `${expected}/`) {
    throw new Error(
      "OCI restore S3 endpoint must exactly match its native inventory namespace and region",
    );
  }
  const endpoint = new URL(input.endpoint);
  if (
    endpoint.origin !== expected ||
    endpoint.pathname !== "/" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error(
      "OCI restore S3 endpoint must exactly match its native inventory namespace and region",
    );
  }
}

export function isOciS3CompatibilityEndpoint(endpoint: string): boolean {
  try {
    const parsed = new URL(endpoint);
    return (
      parsed.protocol === "https:" &&
      /^[a-z0-9][a-z0-9_-]{0,99}\.compat\.objectstorage\.[a-z]{2}(?:-[a-z0-9]+)+-[1-9][0-9]*\.(?:oraclecloud\.com|oci\.customer-oci\.com)$/.test(
        parsed.hostname,
      )
    );
  } catch {
    return false;
  }
}
