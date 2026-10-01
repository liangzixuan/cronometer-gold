import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  assertWebApiProfile,
  HOSTED_DEVELOPMENT_API_ORIGIN,
  HOSTED_DEVELOPMENT_PROFILE,
  HOSTED_DEVELOPMENT_WEB_ORIGIN,
} from "../packages/contracts/dist/index.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webDirectory = resolve(repositoryRoot, "apps/web");
const runtimeFields = Object.freeze([
  "APPDATA",
  "CI",
  "COLORTERM",
  "ComSpec",
  "FORCE_COLOR",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOCALAPPDATA",
  "NO_COLOR",
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "TZ",
  "USERPROFILE",
  "WINDIR",
]);

function parseArguments(arguments_) {
  const options = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (
      !["--https-key", "--https-cert", "--https-ca"].includes(flag) ||
      Object.hasOwn(options, flag) ||
      typeof value !== "string" ||
      !value ||
      value.startsWith("--")
    )
      throw new TypeError(
        "Hosted web development requires explicit HTTPS key, certificate and CA paths.",
      );
    options[flag] = value;
  }
  if (Object.keys(options).length !== 3) {
    throw new TypeError(
      "Hosted web development requires explicit HTTPS key, certificate and CA paths.",
    );
  }
  return options;
}

function trustFile(value, dependencies) {
  if (!isAbsolute(value)) throw new TypeError("HTTPS inputs must be absolute regular-file paths.");
  const canonical = (dependencies.realpath ?? realpathSync)(value);
  const metadata = (dependencies.lstat ?? lstatSync)(value);
  if (
    resolve(value) !== resolve(canonical) ||
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    metadata.size < 1 ||
    metadata.size > 1_048_576
  )
    throw new TypeError("HTTPS inputs must be bounded regular files without links.");
  return canonical;
}

export function prepareHostedWebDevelopment(arguments_, dependencies = {}) {
  const environment = dependencies.environment ?? process.env;
  const options = parseArguments(arguments_);
  if (
    Object.keys(environment).some((name) => name.toUpperCase() === "NODE_OPTIONS") ||
    environment.NODE_TLS_REJECT_UNAUTHORIZED !== undefined ||
    environment.GIT_SSL_NO_VERIFY !== undefined ||
    environment.CURL_INSECURE !== undefined ||
    [environment.NPM_CONFIG_STRICT_SSL, environment.npm_config_strict_ssl].some(
      (value) => value?.trim().toLowerCase() === "false",
    )
  )
    throw new TypeError("Hosted web development refuses runtime injection and TLS overrides.");
  for (const [field, expected] of Object.entries({
    API_INTERNAL_URL: HOSTED_DEVELOPMENT_API_ORIGIN,
    NOURISHING_WEB_PROFILE: HOSTED_DEVELOPMENT_PROFILE,
    WEB_PUBLIC_ORIGIN: HOSTED_DEVELOPMENT_WEB_ORIGIN,
  })) {
    if (Object.hasOwn(environment, field) && environment[field] !== expected) {
      throw new TypeError("Hosted web development refuses a conflicting " + field + ".");
    }
  }
  assertWebApiProfile(HOSTED_DEVELOPMENT_API_ORIGIN, HOSTED_DEVELOPMENT_PROFILE);
  const names = (dependencies.readdir ?? readdirSync)(webDirectory);
  if (names.some((name) => /^\.env(?:\.|$)/iu.test(name))) {
    throw new TypeError("Hosted web development refuses implicit web dotenv files.");
  }
  const key = trustFile(options["--https-key"], dependencies);
  const cert = trustFile(options["--https-cert"], dependencies);
  const ca = trustFile(options["--https-ca"], dependencies);
  if (new Set([key, cert, ca]).size !== 3) {
    throw new TypeError("HTTPS key, certificate and CA must be separate files.");
  }
  const runtime = {};
  for (const field of runtimeFields) {
    if (Object.hasOwn(environment, field) && typeof environment[field] === "string") {
      runtime[field] = environment[field];
    }
  }
  const requireWeb = createRequire(resolve(webDirectory, "package.json"));
  const nextEntry = (
    dependencies.resolveNext ?? (() => requireWeb.resolve("next/dist/bin/next"))
  )();
  const installed = dependencies.nextVersion ?? requireWeb("next/package.json").version;
  const expected = JSON.parse(
    (dependencies.readManifest ?? readFileSync)(resolve(webDirectory, "package.json"), "utf8"),
  ).dependencies.next;
  if (installed !== expected)
    throw new TypeError("The installed Next version must match its exact source pin.");
  return {
    cwd: webDirectory,
    nextEntry,
    arguments: [
      "dev",
      "--hostname",
      "127.0.0.1",
      "--port",
      "3443",
      "--experimental-https",
      "--experimental-https-key",
      key,
      "--experimental-https-cert",
      cert,
      "--experimental-https-ca",
      ca,
    ],
    environment: {
      ...runtime,
      API_INTERNAL_URL: HOSTED_DEVELOPMENT_API_ORIGIN,
      NOURISHING_WEB_PROFILE: HOSTED_DEVELOPMENT_PROFILE,
      WEB_PUBLIC_ORIGIN: HOSTED_DEVELOPMENT_WEB_ORIGIN,
      NEXT_TELEMETRY_DISABLED: "1",
      NODE_ENV: "development",
      NODE_EXTRA_CA_CERTS: ca,
    },
  };
}

async function enterNext(plan) {
  // Keep the supported Next CLI in this foreground process so console signals reach its handlers.
  process.chdir(plan.cwd);
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, plan.environment);
  process.argv = [process.execPath, plan.nextEntry, ...plan.arguments];
  await import(pathToFileURL(plan.nextEntry).href);
}

export async function runHostedWebDevelopment(arguments_, dependencies = {}) {
  const plan = prepareHostedWebDevelopment(arguments_, dependencies);
  await (dependencies.enterNext ?? enterNext)(plan);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await runHostedWebDevelopment(process.argv.slice(2));
  } catch {
    process.stderr.write(
      "Hosted web development could not start. Check the explicit profile and HTTPS inputs.\n",
    );
    process.exitCode = 1;
  }
}
