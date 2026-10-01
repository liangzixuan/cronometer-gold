import { describe, expect, it } from "vitest";
import {
  assertWebApiProfile,
  HOSTED_DEVELOPMENT_API_ORIGIN as origin,
  HOSTED_DEVELOPMENT_PROFILE as profile,
  webCredentialCookieName,
} from "./web-development-profile.js";

describe("hosted web development origin", () => {
  it("reserves exactly one distinct development API", () => {
    expect(() => assertWebApiProfile(origin, profile)).not.toThrow();
    expect(origin).not.toBe("https://api.nourishing.app");
  });
  it.each([
    undefined,
    "",
    " ",
    "http://127.0.0.1:4000",
    "https://api.nourishing.app",
    "https://other.example.test",
    origin + "/",
    origin + ":443",
    origin + "/v1",
    origin + "?debug=1",
    origin + "#x",
    "https://user@dev-api.nourishing.app",
    "https://DEV-API.nourishing.app",
    " " + origin,
  ])("rejects an absent or different configured origin: %s", (value) => {
    expect(() => assertWebApiProfile(value, profile)).toThrow(TypeError);
  });
  it.each(["", "production", "local", "HOSTED-DEVELOPMENT"])(
    "rejects unknown profile %s",
    (value) => {
      expect(() => assertWebApiProfile(origin, value)).toThrow(TypeError);
    },
  );
  it("leaves the separately selected local profile to its existing URL parser", () => {
    expect(() => assertWebApiProfile(undefined)).not.toThrow();
    expect(() => assertWebApiProfile("http://127.0.0.1:4000")).not.toThrow();
  });
  it.each([
    "__Host-nutrition_session",
    "__Secure-nutrition_erasure_pending",
    "__Secure-nutrition_erasure_status",
  ])("binds %s to the exact development origin while retaining local names", (name) => {
    expect(webCredentialCookieName(name)).toBe(name);
    expect(webCredentialCookieName(name, profile)).toBe(name + "_" + encodeURIComponent(origin));
    expect(webCredentialCookieName(name, profile)).not.toBe(
      name + "_" + encodeURIComponent("https://api.nourishing.app"),
    );
  });
});
