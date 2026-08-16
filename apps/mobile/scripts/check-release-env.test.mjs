import { describe, expect, it } from "vitest";

import { validateReleaseApiUrl } from "./check-release-env.mjs";

describe("mobile release API preflight", () => {
  it("requires an explicit credential-free HTTPS origin", () => {
    expect(() => validateReleaseApiUrl(undefined)).toThrow(/required/u);
    expect(() => validateReleaseApiUrl("http://api.example.test")).toThrow(/HTTPS/u);
    expect(() => validateReleaseApiUrl("https://user:secret@api.example.test")).toThrow(
      /credential-free/u,
    );
    expect(() => validateReleaseApiUrl("https://api.example.test/v1")).toThrow(/credential-free/u);
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

  it("accepts an explicit HTTPS origin", () => {
    expect(validateReleaseApiUrl("https://api.example.test").href).toBe(
      "https://api.example.test/",
    );
  });
});
