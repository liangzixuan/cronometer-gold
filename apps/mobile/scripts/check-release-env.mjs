import { isIP } from "node:net";
import process from "node:process";
import { pathToFileURL } from "node:url";

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
    isKnownLocalTarget(url.hostname)
  ) {
    throw new TypeError(
      "EXPO_PUBLIC_API_URL must be a credential-free, non-loopback HTTPS origin.",
    );
  }
  return url;
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  try {
    validateReleaseApiUrl(process.env.EXPO_PUBLIC_API_URL);
    process.stdout.write("Mobile release API configuration is valid.\n");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Mobile release configuration failed.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
