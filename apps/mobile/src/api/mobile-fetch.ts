import { getMobileProfile, type MobileProfile } from "../config/mobile-profile";

type MobileFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export function createMobileFetch(profile: MobileProfile, transport: MobileFetch): MobileFetch {
  return async (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== profile.apiOrigin || url.username || url.password || url.hash) {
      throw new TypeError("Mobile requests must use the bound API origin.");
    }
    return transport(url.toString(), { ...init, redirect: "error", credentials: "omit" });
  };
}

export const mobileFetch: MobileFetch = async (input, init) => {
  const profile = getMobileProfile();
  // Explicit import selects the pinned native transport even when an ambient
  // React Native fetch override is present. Native redirect denial is required.
  return createMobileFetch(profile, async (url, options) => {
    const { fetch } = await import("expo/fetch");
    return fetch(String(url), options);
  })(input, init);
};
