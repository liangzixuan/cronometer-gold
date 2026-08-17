import { isIP } from "node:net";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const RELEASE_DEPLOYMENT_SCHEMA = "nutrition-tracker-release-deployment-v1";
export const RELEASE_DEPLOYMENT_UNCONFIRMED_MESSAGE =
  "The exact OCI API deployment origin must be confirmed before release.";

const PUBLIC_DNS_NAME = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/u;
const PRIVATE_DNS_SUFFIXES = ["corp", "home", "home.arpa", "internal", "lan", "local"];

function isKnownLocalTarget(hostname) {
  const normalized = hostname.toLowerCase().replace(/\.$/u, "");
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "10.0.2.2"
  ) {
    return true;
  }

  const unbracketed = normalized.startsWith("[") ? normalized.slice(1, -1) : normalized;
  if (isIP(unbracketed) === 4) {
    const octets = unbracketed.split(".").map(Number);
    return octets[0] === 127 || unbracketed === "0.0.0.0";
  }
  if (isIP(unbracketed) === 6) {
    return (
      unbracketed === "::" ||
      unbracketed === "::1" ||
      unbracketed.startsWith("::7f") ||
      unbracketed.startsWith("::ffff:7f") ||
      unbracketed.startsWith("::ffff:0:7f") ||
      unbracketed === "::ffff:0:0"
    );
  }
  return false;
}

function isReservedDocumentationTarget(hostname) {
  const normalized = hostname.toLowerCase().replace(/\.$/u, "");
  if (
    ["example.com", "example.net", "example.org"].some(
      (domain) => normalized === domain || normalized.endsWith(`.${domain}`),
    )
  ) {
    return true;
  }
  return ["example", "invalid", "test"].some(
    (suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`),
  );
}

function isNumericTarget(hostname) {
  const normalized = hostname.toLowerCase().replace(/\.$/u, "");
  const unbracketed = normalized.startsWith("[") ? normalized.slice(1, -1) : normalized;
  return isIP(unbracketed) !== 0;
}

function isPublicDnsTarget(hostname) {
  const normalized = hostname.toLowerCase();
  if (normalized.length > 253 || normalized.endsWith(".") || !PUBLIC_DNS_NAME.test(normalized)) {
    return false;
  }
  return !PRIVATE_DNS_SUFFIXES.some(
    (suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`),
  );
}

export function validateReleaseApiUrl(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError("EXPO_PUBLIC_API_URL is required for a mobile release build.");
  }

  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new TypeError("EXPO_PUBLIC_API_URL must be an absolute HTTPS origin.");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.pathname !== "/" && url.pathname !== "") ||
    isKnownLocalTarget(url.hostname) ||
    isNumericTarget(url.hostname) ||
    !isPublicDnsTarget(url.hostname) ||
    isReservedDocumentationTarget(url.hostname)
  ) {
    throw new TypeError(
      "EXPO_PUBLIC_API_URL must be a credential-free, public-DNS, non-loopback, non-documentation HTTPS origin.",
    );
  }
  return url;
}

export function validateReleaseDeploymentRecord(record) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    throw new TypeError("Release deployment record must be an object.");
  }
  const expectedKeys = ["apiOrigin", "ociDeploymentConfirmed", "schemaVersion"];
  const actualKeys = Object.keys(record).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new TypeError(
      `Release deployment record must contain exactly: ${expectedKeys.join(", ")}.`,
    );
  }
  if (record.schemaVersion !== RELEASE_DEPLOYMENT_SCHEMA) {
    throw new TypeError(`Release deployment record must use ${RELEASE_DEPLOYMENT_SCHEMA}.`);
  }
  if (typeof record.ociDeploymentConfirmed !== "boolean") {
    throw new TypeError("Release deployment confirmation must be an explicit boolean.");
  }
  if (!record.ociDeploymentConfirmed) {
    if (record.apiOrigin !== null) {
      throw new TypeError("An unconfirmed OCI deployment must not claim an API origin.");
    }
    return { apiOrigin: null, ociDeploymentConfirmed: false };
  }
  const url = validateReleaseApiUrl(record.apiOrigin);
  if (record.apiOrigin !== url.origin) {
    throw new TypeError("The confirmed OCI API origin must be a canonical HTTPS origin.");
  }
  return { apiOrigin: url.origin, ociDeploymentConfirmed: true };
}

export function validateReleaseDeployment(environment, record) {
  const deployment = validateReleaseDeploymentRecord(record);
  if (!deployment.ociDeploymentConfirmed) {
    throw new TypeError(RELEASE_DEPLOYMENT_UNCONFIRMED_MESSAGE);
  }
  const configured = validateReleaseApiUrl(environment.EXPO_PUBLIC_API_URL);
  if (
    environment.EXPO_PUBLIC_API_URL.trim() !== deployment.apiOrigin ||
    configured.origin !== deployment.apiOrigin
  ) {
    throw new TypeError(
      "EXPO_PUBLIC_API_URL must exactly match the checked-in confirmed OCI API origin.",
    );
  }
  return configured;
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  try {
    const { default: deploymentRecord } = await import("../config/release-deployment.json", {
      with: { type: "json" },
    });
    validateReleaseDeployment(process.env, deploymentRecord);
    process.stdout.write("Mobile release API configuration is valid.\n");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Mobile release configuration failed.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
