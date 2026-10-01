// @ts-check
const {
  HOSTED_DEVELOPMENT_API_ORIGIN,
  HOSTED_DEVELOPMENT_PROFILE,
} = require("@nutrition-tracker/contracts");

const PRODUCTION_MOBILE_ID = "com.nutritionledger.app";
const DEVELOPMENT_MOBILE_ID = "com.nutritionledger.app.development";
const MOBILE_EXPO_PROJECT_ID = "14022636-ab56-468c-94f6-d6106addde42";

/** @typedef {{ readonly selector?: string | undefined, readonly apiUrl?: string | undefined, readonly platform: "android" | "ios" | "web" }} MobileProfileInput */
/** @typedef {{ readonly name: "ordinary" | "hosted-development", readonly apiOrigin: string, readonly namespace: string, readonly nativeId: string }} MobileProfile */

/** @param {string | undefined} configuredValue @param {"android" | "ios" | "web"} platform @returns {URL} */
function resolveMobileApiBase(configuredValue, platform) {
  const localDefault = platform === "android" ? "http://10.0.2.2:4000" : "http://127.0.0.1:4000";
  const base = new URL(configuredValue?.trim() || localDefault);
  const isLocalHost = ["127.0.0.1", "localhost", "10.0.2.2"].includes(base.hostname);
  if (
    (base.protocol !== "https:" && !(base.protocol === "http:" && isLocalHost)) ||
    base.username !== "" ||
    base.password !== "" ||
    base.search !== "" ||
    base.hash !== "" ||
    (base.pathname !== "/" && base.pathname !== "")
  ) {
    throw new TypeError("EXPO_PUBLIC_API_URL must be a safe API origin.");
  }
  return base;
}

/** @param {MobileProfileInput} input @returns {MobileProfile} */
function resolveMobileProfile(input) {
  for (const field of ["selector", "apiUrl"]) {
    if (field in input && !Object.hasOwn(input, field)) {
      throw new TypeError("Mobile profile inputs must use own properties.");
    }
  }
  if (input.selector !== undefined && input.selector !== HOSTED_DEVELOPMENT_PROFILE) {
    throw new TypeError("Unknown mobile profile.");
  }
  if (
    input.selector === HOSTED_DEVELOPMENT_PROFILE &&
    input.apiUrl !== HOSTED_DEVELOPMENT_API_ORIGIN
  ) {
    throw new TypeError("Hosted development requires its exact reserved HTTPS API origin.");
  }
  if (
    input.apiUrl !== undefined &&
    (input.apiUrl.length === 0 || input.apiUrl.trim() !== input.apiUrl || input.apiUrl.length > 512)
  ) {
    throw new TypeError("The mobile API origin is invalid.");
  }
  const apiOrigin = resolveMobileApiBase(input.apiUrl, input.platform).origin;
  if (input.selector === undefined && apiOrigin === HOSTED_DEVELOPMENT_API_ORIGIN)
    throw new TypeError("The reserved development origin requires its explicit mobile profile.");
  // Fixed-width hexadecimal preserves exact ASCII URL origins and uses only
  // characters accepted by SecureStore and native signing-key aliases.
  const originId = [...apiOrigin]
    .map((character) => character.charCodeAt(0).toString(16).padStart(2, "0"))
    .join("");
  return Object.freeze({
    name: input.selector ?? "ordinary",
    apiOrigin,
    namespace: `nutrition-origin.${originId}`,
    nativeId:
      input.selector === HOSTED_DEVELOPMENT_PROFILE ? DEVELOPMENT_MOBILE_ID : PRODUCTION_MOBILE_ID,
  });
}

/** @param {MobileProfile} profile @param {string} key @returns {string} */
function mobileProfileKey(profile, key) {
  if (!/^[A-Za-z0-9._-]+$/u.test(key)) throw new TypeError("Invalid protected mobile key.");
  return `${profile.namespace}.${key}`;
}

/** @type {MobileProfile | undefined} */
let boundProfile;
/** @param {MobileProfileInput} input @returns {MobileProfile} */
function bindMobileProfile(input) {
  const profile = resolveMobileProfile(input);
  if (
    boundProfile &&
    (boundProfile.name !== profile.name || boundProfile.apiOrigin !== profile.apiOrigin)
  ) {
    throw new TypeError("The running mobile profile cannot change.");
  }
  boundProfile ??= profile;
  return boundProfile;
}
/** @returns {MobileProfile} */
function getMobileProfile() {
  if (!boundProfile) throw new Error("Validate and bind the mobile profile before protected I/O.");
  return boundProfile;
}

module.exports = {
  PRODUCTION_MOBILE_ID,
  DEVELOPMENT_MOBILE_ID,
  MOBILE_EXPO_PROJECT_ID,
  resolveMobileApiBase,
  resolveMobileProfile,
  mobileProfileKey,
  bindMobileProfile,
  getMobileProfile,
};
