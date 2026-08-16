import { describe, expect, it } from "vitest";

import { parseSessionEnvelope, serializeSessionEnvelope } from "./session-envelope";

describe("mobile secure session envelope", () => {
  it("round-trips only a bounded bearer token and expiry", () => {
    const session = {
      accessToken: "t".repeat(43),
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
    expect(parseSessionEnvelope(serializeSessionEnvelope(session), new Date("2026-01-01"))).toEqual(
      session,
    );
  });

  it("rejects expired, malformed, or extra session data", () => {
    expect(parseSessionEnvelope("not-json")).toBeNull();
    expect(
      parseSessionEnvelope(
        JSON.stringify({ accessToken: "short", expiresAt: "2099-01-01T00:00:00Z" }),
      ),
    ).toBeNull();
    expect(
      parseSessionEnvelope(
        JSON.stringify({ accessToken: "t".repeat(43), expiresAt: "2020-01-01T00:00:00Z" }),
      ),
    ).toBeNull();
    expect(
      parseSessionEnvelope(
        JSON.stringify({
          accessToken: "t".repeat(43),
          expiresAt: "2099-01-01T00:00:00Z",
          notes: "must-not-persist",
        }),
      ),
    ).toBeNull();
    expect(
      parseSessionEnvelope(
        JSON.stringify({ accessToken: `${"t".repeat(42)}.`, expiresAt: "2099-01-01T00:00:00Z" }),
      ),
    ).toBeNull();
    expect(
      parseSessionEnvelope(
        JSON.stringify({ accessToken: "t".repeat(129), expiresAt: "2099-01-01T00:00:00Z" }),
      ),
    ).toBeNull();
  });
});
