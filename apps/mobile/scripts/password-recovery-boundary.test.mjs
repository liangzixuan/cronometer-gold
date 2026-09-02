import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import appConfig from "../app.json";
import { authenticatedRouteNames } from "../src/navigation/routes";

const appSource = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
const authScreenSource = readFileSync(
  new URL("../src/auth/AuthScreen.tsx", import.meta.url),
  "utf8",
);

describe("mobile password-recovery boundary", () => {
  it("has no native recovery screen, token route, or deep-link registration", () => {
    expect(authenticatedRouteNames).not.toContain("PasswordRecovery");
    expect(authenticatedRouteNames).not.toContain("ResetPassword");
    expect(appSource).not.toMatch(/PasswordRecovery|ResetPassword|reset-password|#token=/u);
    expect(appSource).not.toMatch(/\blinking\s*=/u);
    expect(appConfig.expo).not.toHaveProperty("scheme");
    expect(appConfig.expo.android).not.toHaveProperty("intentFilters");
    expect(appConfig.expo.ios).not.toHaveProperty("associatedDomains");
  });

  it("clears the submitted email after the exact accepted request", () => {
    expect(authScreenSource).toMatch(
      /await requestPasswordRecovery\(apiBase, email\);\s*setEmail\(""\);/u,
    );
  });

  it("visibly and semantically disables recovery navigation while a request is in flight", () => {
    const backControl = authScreenSource.match(
      /<Pressable\s+accessibilityRole="button"\s+accessibilityState=\{\{ disabled: busy \}\}\s+disabled=\{busy\}[\s\S]*?<Text style=\{styles\.secondaryActionText\}>Back to sign in<\/Text>\s*<\/Pressable>/u,
    );
    expect(backControl).not.toBeNull();
    expect(backControl?.[0]).toMatch(/busy && styles\.disabledAction/u);
    expect(backControl?.[0]).toMatch(/pressed && !busy && styles\.pressed/u);
  });
});
