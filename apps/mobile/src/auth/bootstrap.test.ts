import { describe, expect, it } from "vitest";

import { clearSessionFailClosed, sessionBootstrapDecision } from "./bootstrap";

describe("mobile session bootstrap", () => {
  it("clears credentials only after a definitive unauthorized response", () => {
    expect(sessionBootstrapDecision(401)).toBe("clear");
    expect(sessionBootstrapDecision(503)).toBe("retry");
    expect(sessionBootstrapDecision(500)).toBe("retry");
    expect(sessionBootstrapDecision(429)).toBe("retry");
    expect(sessionBootstrapDecision(200)).toBe("accept");
  });

  it("clears memory even when secure credential deletion fails", async () => {
    const events: string[] = [];
    const cleared = await clearSessionFailClosed(
      async () => {
        events.push("delete");
        throw new Error("secure-store-unavailable");
      },
      () => events.push("memory"),
    );
    expect(cleared).toBe(false);
    expect(events).toEqual(["memory", "delete"]);
  });
});
