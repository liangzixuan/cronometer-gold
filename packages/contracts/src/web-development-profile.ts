/** Reserved development destination; this policy does not attest to a deployed host. */
export const HOSTED_DEVELOPMENT_API_ORIGIN = "https://dev-api.nourishing.app";
export const HOSTED_DEVELOPMENT_WEB_ORIGIN = "https://localhost:3443";
export const HOSTED_DEVELOPMENT_PROFILE = "hosted-development";

/** Keep the profile policy portable; each existing client retains its normal URL parser. */
export function assertWebApiProfile(value: string | undefined, profile?: string): void {
  if (profile !== undefined && profile !== HOSTED_DEVELOPMENT_PROFILE) {
    throw new TypeError("The web development profile is invalid.");
  }
  if (profile === HOSTED_DEVELOPMENT_PROFILE && value !== HOSTED_DEVELOPMENT_API_ORIGIN) {
    throw new TypeError("Hosted development requires its exact configured API origin.");
  }
}

/** The encoded origin is a reversible, collision-free cookie-name component, not a secret. */
export function webCredentialCookieName(name: string, profile?: string): string {
  if (profile === undefined) return name;
  assertWebApiProfile(HOSTED_DEVELOPMENT_API_ORIGIN, profile);
  return name + "_" + encodeURIComponent(HOSTED_DEVELOPMENT_API_ORIGIN);
}
