import { describe, expect, it } from "vitest";

import { browserSecurityHeaders } from "../../next.config";

describe("browser security headers", () => {
  it("keeps the minimum browser isolation policy enabled", () => {
    const headers = new Map(browserSecurityHeaders.map((header) => [header.key, header.value]));

    expect(headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(headers.get("Content-Security-Policy")).toContain("object-src 'none'");
    expect(headers.get("Permissions-Policy")).toContain("camera=()");
    expect(headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(headers.get("X-Frame-Options")).toBe("DENY");
  });
});
