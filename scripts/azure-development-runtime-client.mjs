import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { publicIp } from "./azure-development-runtime-host.mjs";

export function admitRuntimeClientAccess(value) {
  if (value === null) return null;
  assert(
    value &&
      Object.getPrototypeOf(value) === Object.prototype &&
      Object.keys(value).sort().join(",") === "adminIpv4Cidr,notAfterUtc,notBeforeUtc",
  );
  assert(
    typeof value.adminIpv4Cidr === "string" &&
      value.adminIpv4Cidr.endsWith("/32") &&
      publicIp(value.adminIpv4Cidr.slice(0, -3)),
  );
  assert(typeof value.notBeforeUtc === "string" && typeof value.notAfterUtc === "string");
  const start = Date.parse(value.notBeforeUtc),
    end = Date.parse(value.notAfterUtc);
  assert(Number.isFinite(start) && Number.isFinite(end));
  assert(
    new Date(start).toISOString() === value.notBeforeUtc &&
      new Date(end).toISOString() === value.notAfterUtc,
  );
  assert(start % 1000 === 0 && end % 1000 === 0 && end - start >= 60_000 && end - start <= 900_000);
  return Object.freeze({ ...value });
}

/** Bind once to the controller's original clocks. Recovery and API restart retain these bytes. */
export function runtimeClientDeadline(access, original) {
  access = admitRuntimeClientAccess(access);
  if (!access) return undefined;
  const start = Date.parse(original.startedAtUtc),
    end = Date.parse(access.notAfterUtc);
  assert(
    new Date(start).toISOString() === original.startedAtUtc &&
      /^[1-9][0-9]{0,24}$/u.test(original.monotonicStartNs),
  );
  assert(
    Date.parse(access.notBeforeUtc) >= start && end <= Date.parse(original.notAfterUtc) - 1_800_000,
  );
  assert(end > start && end - start <= 14_400_000);
  return (BigInt(original.monotonicStartNs) + BigInt(end - start - 15_000) * 1_000_000n).toString();
}

/** Parse held public bytes before creation. Chain trust and key pairing require actual TLS acceptance. */
export function admitRuntimeClientCertificate(pem, access) {
  access = admitRuntimeClientAccess(access);
  assert(access && typeof pem === "string" && Buffer.byteLength(pem) <= 65_536);
  const certificate = new X509Certificate(pem);
  assert(
    !certificate.ca &&
      certificate.checkHost("dev-api.nourishing.app", { wildcards: false }) ===
        "dev-api.nourishing.app",
  );
  assert(
    Date.parse(certificate.validFrom) <= Date.now() &&
      Date.parse(certificate.validFrom) <= Date.parse(access.notBeforeUtc),
  );
  assert(Date.parse(certificate.validTo) >= Date.parse(access.notAfterUtc));
}

export function runtimeClientEnvironment(access, apiDeadlineNs) {
  access = admitRuntimeClientAccess(access);
  assert(access && /^[1-9][0-9]{0,24}$/u.test(apiDeadlineNs));
  return {
    RUNTIME_CLIENT_IP: access.adminIpv4Cidr,
    RUNTIME_CLIENT_START: String(Date.parse(access.notBeforeUtc) / 1000),
    RUNTIME_CLIENT_END: String(Date.parse(access.notAfterUtc) / 1000 - 30),
    RUNTIME_API_END: new Date(Date.parse(access.notAfterUtc) - 15_000).toISOString(),
    RUNTIME_API_DEADLINE_NS: apiDeadlineNs,
  };
}
