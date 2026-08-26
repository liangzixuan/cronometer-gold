import { validatePublicHttpsApiUrl } from "./check-release-env.mjs";

const FORBIDDEN_BACKEND_HOST_TOKENS = new Set([
  "localstack",
  "meilisearch",
  "postgres",
  "postgresql",
]);

function assert(condition, message) {
  if (!condition) throw new TypeError(message);
}

export function validatePhysicalDeviceApiUrl(value) {
  const url = validatePublicHttpsApiUrl(value);
  const configured = value.trim();

  assert(
    url.port === "",
    "Physical-device API origin must use the default HTTPS port; never expose an API or backend service port.",
  );
  assert(
    configured === url.origin,
    "Physical-device API origin must be an exact canonical HTTPS origin.",
  );

  const hostname = url.hostname.toLowerCase();
  const labels = hostname.split(".");
  assert(
    labels.length === 4 && labels.at(-2) === "ts" && labels.at(-1) === "net",
    "Physical-device API origin must be the reviewed <machine>.<tailnet>.ts.net private origin.",
  );
  assert(
    ![...FORBIDDEN_BACKEND_HOST_TOKENS].some((token) => hostname.includes(token)),
    "Physical-device API origin must identify the authenticated API, never LocalStack, Postgres, or Meilisearch.",
  );
  return url;
}
