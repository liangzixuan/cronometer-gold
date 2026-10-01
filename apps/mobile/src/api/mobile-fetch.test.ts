import { describe, expect, it, vi } from "vitest";
import { resolveMobileProfile } from "../config/mobile-profile";
import { createMobileFetch } from "./mobile-fetch";

const profile = resolveMobileProfile({
  selector: "hosted-development",
  apiUrl: "https://dev-api.nourishing.app",
  platform: "android",
});
describe("mobile API transport", () => {
  it.each([
    "https://api.nourishing.app/auth/me",
    "http://127.0.0.1:4000/auth/me",
    "https://other.invalid/erasure",
    "https://user:pass@dev-api.nourishing.app/auth/me",
    "https://dev-api.nourishing.app/auth/me#fragment",
  ])("denies %s before invoking native transport", async (url) => {
    const transport = vi.fn();
    await expect(
      createMobileFetch(profile, transport)(url, {
        headers: { authorization: "Bearer synthetic" },
      }),
    ).rejects.toThrow(/bound API origin/u);
    expect(transport).not.toHaveBeenCalled();
  });
  it("forces native redirect denial and no ambient cookies while retaining explicit request data and abort", async () => {
    const transport = vi.fn(async () => new Response("ok"));
    const signal = new AbortController().signal;
    await createMobileFetch(profile, transport)(new URL("/v1/account/erasure", profile.apiOrigin), {
      method: "POST",
      body: "synthetic",
      headers: { authorization: "Bearer synthetic", "x-reauthentication-token": "synthetic" },
      signal,
      redirect: "follow",
      credentials: "include",
    });
    expect(transport).toHaveBeenCalledWith("https://dev-api.nourishing.app/v1/account/erasure", {
      method: "POST",
      body: "synthetic",
      headers: { authorization: "Bearer synthetic", "x-reauthentication-token": "synthetic" },
      signal,
      redirect: "error",
      credentials: "omit",
    });
  });
  it("propagates transport failure with no alternate origin or retry", async () => {
    const transport = vi.fn(async () => {
      throw new Error("redirect refused");
    });
    await expect(
      createMobileFetch(profile, transport)(`${profile.apiOrigin}/auth/me`),
    ).rejects.toThrow("redirect refused");
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
