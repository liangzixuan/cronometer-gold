import { describe, expect, it } from "vitest";

import {
  RELEASE_DEPLOYMENT_SCHEMA,
  validateReleaseApiUrl,
  validateReleaseDeployment,
  validateReleaseDeploymentRecord,
} from "./check-release-env.mjs";

describe("mobile release API preflight", () => {
  it("requires an explicit credential-free HTTPS origin", () => {
    expect(() => validateReleaseApiUrl(undefined)).toThrow(/required/u);
    expect(() => validateReleaseApiUrl("http://api.example.test")).toThrow(/HTTPS/u);
    expect(() => validateReleaseApiUrl("https://user:secret@api.example.test")).toThrow(
      /credential-free/u,
    );
    expect(() => validateReleaseApiUrl("https://api.github.com/v1")).toThrow(/credential-free/u);
  });

  it.each([
    "https://localhost",
    "https://api.localhost",
    "https://127.0.0.1",
    "https://127.10.20.30",
    "https://0.0.0.0",
    "https://10.0.2.2",
    "https://[::]",
    "https://[::1]",
    "https://[::127.0.0.1]",
    "https://[::ffff:127.0.0.1]",
    "https://[::ffff:0:127.0.0.1]",
  ])("rejects known local release target %s", (value) => {
    expect(() => validateReleaseApiUrl(value)).toThrow(/non-loopback/u);
  });

  it.each([
    "https://api.example.invalid",
    "https://api.example.test",
    "https://api.example",
    "https://example.com",
    "https://api.example.com",
    "https://example.net",
    "https://example.org",
    "https://192.0.2.1",
    "https://198.51.100.8",
    "https://203.0.113.9",
    "https://[2001:db8::1]",
    "https://[::ffff:192.0.2.1]",
  ])("rejects reserved documentation target %s", (value) => {
    expect(() => validateReleaseApiUrl(value)).toThrow(/non-documentation/u);
  });

  it.each([
    "https://10.0.0.1",
    "https://172.16.0.1",
    "https://192.168.1.1",
    "https://100.64.0.1",
    "https://169.254.169.254",
    "https://224.0.0.1",
    "https://240.0.0.1",
    "https://[fc00::1]",
    "https://[fd12:3456::1]",
    "https://[fe80::1]",
    "https://[ff02::1]",
    "https://[2606:4700:4700::1111]",
  ])("rejects numeric release target %s", (value) => {
    expect(() => validateReleaseApiUrl(value)).toThrow(/public-DNS/u);
  });

  it.each([
    "https://foo",
    "https://api.local",
    "https://api.internal",
    "https://api.home.arpa",
    "https://api_name.example.co",
    "https://-api.example.co",
    "https://api-.example.co",
    "https://api.example.1a",
    "https://api.github.com.",
    `https://${"a".repeat(64)}.example.co`,
  ])("rejects a hostname outside the owned public-DNS shape %s", (value) => {
    expect(() => validateReleaseApiUrl(value)).toThrow(/public-DNS/u);
  });

  it("accepts an explicit HTTPS origin", () => {
    expect(validateReleaseApiUrl("https://api.github.com").href).toBe("https://api.github.com/");
  });
});

describe("confirmed OCI release origin", () => {
  const unconfirmed = {
    schemaVersion: RELEASE_DEPLOYMENT_SCHEMA,
    ociDeploymentConfirmed: false,
    apiOrigin: null,
  };
  const confirmed = {
    schemaVersion: RELEASE_DEPLOYMENT_SCHEMA,
    ociDeploymentConfirmed: true,
    apiOrigin: "https://api.nutritionledger.app",
  };

  it("keeps an unconfirmed deployment null and blocks release", () => {
    expect(validateReleaseDeploymentRecord(unconfirmed)).toEqual({
      apiOrigin: null,
      ociDeploymentConfirmed: false,
    });
    expect(() => validateReleaseDeployment({}, unconfirmed)).toThrow(/must be confirmed/u);
  });

  it("requires the environment to exactly equal the checked-in OCI origin", () => {
    expect(
      validateReleaseDeployment({ EXPO_PUBLIC_API_URL: confirmed.apiOrigin }, confirmed).origin,
    ).toBe(confirmed.apiOrigin);
    expect(() =>
      validateReleaseDeployment({ EXPO_PUBLIC_API_URL: "https://api.github.com" }, confirmed),
    ).toThrow(/exactly match/u);
    expect(() =>
      validateReleaseDeployment({ EXPO_PUBLIC_API_URL: `${confirmed.apiOrigin}/` }, confirmed),
    ).toThrow(/exactly match/u);
  });

  it("rejects noncanonical or unreviewed deployment records", () => {
    expect(() =>
      validateReleaseDeploymentRecord({ ...confirmed, apiOrigin: `${confirmed.apiOrigin}/` }),
    ).toThrow(/canonical/u);
    expect(() =>
      validateReleaseDeploymentRecord({ ...unconfirmed, apiOrigin: confirmed.apiOrigin }),
    ).toThrow(/must not claim/u);
  });
});
