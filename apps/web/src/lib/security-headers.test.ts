import { describe, expect, it } from "vitest";

import { browserSecurityHeaders } from "../../next.config";
import { contentSecurityPolicy } from "./content-security";

describe("browser security headers", () => {
  it("keeps the minimum browser isolation policy enabled", () => {
    const headers = new Map(browserSecurityHeaders.map((header) => [header.key, header.value]));

    expect(headers.get("Permissions-Policy")).toContain("camera=()");
    expect(headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("uses a request nonce and never permits inline scripts", () => {
    const production = contentSecurityPolicy("MDEyMzQ1Njc4OWFiY2RlZg==", true);
    expect(production).toContain(
      "script-src 'self' 'nonce-MDEyMzQ1Njc4OWFiY2RlZg==' 'strict-dynamic'",
    );
    expect(production).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(production).not.toContain("'unsafe-eval'");
    expect(production).toContain("frame-ancestors 'none'");
    expect(production).toContain("object-src 'none'");
  });
});
