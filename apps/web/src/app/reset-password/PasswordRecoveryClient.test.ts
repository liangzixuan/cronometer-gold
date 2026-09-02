import { describe, expect, it } from "vitest";

import { passwordRecoveryHeading, type RecoveryState } from "./PasswordRecoveryClient";

describe("password-recovery accessibility heading", () => {
  it("describes every recovery state instead of implying that the reset form is always ready", () => {
    const headings = {
      checking: "Checking your recovery link.",
      expired: "Recovery link expired.",
      invalid: "Recovery link invalid.",
      missing: "Recovery link required.",
      rate_limited: "Try again shortly.",
      ready: "Choose a new password.",
      success: "Password reset.",
      unavailable: "Password reset interrupted.",
    } satisfies Record<RecoveryState, string>;

    for (const [state, heading] of Object.entries(headings)) {
      expect(passwordRecoveryHeading(state as RecoveryState)).toBe(heading);
    }
  });
});
