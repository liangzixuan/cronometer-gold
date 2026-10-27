"use strict";
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const {
  constants,
  openSync,
  fstatSync,
  readFileSync,
  closeSync,
  realpathSync,
} = require("node:fs");
const { isAbsolute } = require("node:path");
const { familySync, versionSync } = require("detect-libc");

const SCHEMA = "nutrition-tracker-appwrite-runtime-observation-v1";
const ENDPOINT = "https://nyc.cloud.appwrite.io/v1";
const PROJECT = "6abac02e002f10c31ac2";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hex = (value, length) =>
  typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`, "u").test(value);

function providerIdentity(env) {
  const values = [
    env.APPWRITE_SITE_API_ENDPOINT,
    env.APPWRITE_SITE_PROJECT_ID,
    env.APPWRITE_SITE_ID,
    env.APPWRITE_SITE_DEPLOYMENT,
  ];
  if (values.every((value) => value === undefined)) return null;
  assert(
    values[0] === ENDPOINT &&
      values[1] === PROJECT &&
      values
        .slice(2)
        .every(
          (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/u.test(value),
        ),
    "Invalid provider identity",
  );
  return { endpoint: values[0], projectId: values[1], siteId: values[2], deploymentId: values[3] };
}

function readRegular(path, limit) {
  assert(isAbsolute(path) && realpathSync(path) === path, "Invalid observation path");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    assert(before.isFile() && before.size > 0 && before.size <= limit, "Invalid observation file");
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    assert(
      bytes.length === before.size &&
        before.dev === after.dev &&
        before.ino === after.ino &&
        before.size === after.size &&
        before.mtimeMs === after.mtimeMs &&
        before.ctimeMs === after.ctimeMs,
      "Observation file changed",
    );
    return bytes;
  } finally {
    closeSync(fd);
  }
}

let cached;
function processFacts() {
  if (cached && Date.now() - cached.time >= 0 && Date.now() - cached.time < 30_000)
    return cached.value;
  assert(process.platform === "linux", "Unsupported observation platform");
  // The report also contains environment and process data. Read only sharedObjects;
  // never serialize the complete report.
  const sharedObjects = process.report.getReport().sharedObjects;
  assert(
    Array.isArray(sharedObjects) && sharedObjects.length <= 100,
    "Invalid shared library inventory",
  );
  const nonFileSharedObjects = sharedObjects.filter((path) => !isAbsolute(path));
  assert(
    nonFileSharedObjects.every(
      (path) => typeof path === "string" && /^[A-Za-z0-9_.+-]{1,128}$/u.test(path),
    ),
    "Invalid virtual library name",
  );
  const paths = [
    ...new Set(
      [process.execPath, ...sharedObjects.filter(isAbsolute)].map((path) => {
        assert(
          typeof path === "string" &&
            isAbsolute(path) &&
            path.length <= 512 &&
            Array.from(path).every(
              (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
            ),
          "Invalid native path",
        );
        return realpathSync(path);
      }),
    ),
  ].sort();
  assert(paths.length > 0 && paths.length <= 100, "Native inventory limit");
  let total = 0;
  const nativeInventory = paths.map((path) => {
    const bytes = readRegular(path, 128 * 1024 * 1024);
    total += bytes.length;
    assert(total <= 512 * 1024 * 1024, "Native byte limit");
    return { path, sha256: hash(bytes) };
  });
  const family = familySync();
  const version = versionSync();
  assert(
    ["glibc", "musl"].includes(family) &&
      typeof version === "string" &&
      /^\d+\.\d+(?:\.\d+)?$/u.test(version),
    "Unknown libc",
  );
  const value = {
    node: process.versions.node,
    openssl: process.versions.openssl,
    platform: process.platform,
    architecture: process.arch,
    libc: `${family}@${version}`,
    nativeInventory,
    nonFileSharedObjects: [...new Set(nonFileSharedObjects)].sort(),
    observedAt: new Date().toISOString(),
  };
  cached = { time: Date.now(), value };
  return value;
}

function observation(phase, identity, env) {
  assert(
    hex(identity.revision, 40) && hex(identity.tree, 40) && hex(identity.sourceManifestSha256, 64),
    "Invalid source identity",
  );
  assert(
    identity.outputTreeSha256 === null || hex(identity.outputTreeSha256, 64),
    "Invalid output identity",
  );
  const provider = providerIdentity(env);
  assert(
    phase === "build" || (phase === "ssr" && provider && identity.outputTreeSha256 !== null),
    "Missing server identity",
  );
  const value = {
    schemaVersion: SCHEMA,
    phase,
    sourceRevision: identity.revision,
    sourceTree: identity.tree,
    sourceManifestSha256: identity.sourceManifestSha256,
    outputTreeSha256: identity.outputTreeSha256,
    provider,
    ...processFacts(),
    qualificationPerformed: false,
  };
  assert(Buffer.byteLength(JSON.stringify(value)) <= 64 * 1024, "Observation byte limit");
  return value;
}

function observeBuild(identity, env = process.env) {
  return observation("build", { ...identity, outputTreeSha256: null }, env);
}

function observeServer(env = process.env) {
  assert(typeof env.NOURISHING_OUTPUT_MANIFEST === "string", "Missing output manifest");
  const manifest = JSON.parse(
    readRegular(env.NOURISHING_OUTPUT_MANIFEST, 32 * 1024 * 1024).toString("utf8"),
  );
  assert(
    manifest.schemaVersion === 1 &&
      manifest.entrypoint === "start-site.cjs" &&
      manifest.payloadEntrypoint === "payload/apps/web/server.js" &&
      Array.isArray(manifest.files) &&
      manifest.files.length > 0 &&
      manifest.files.length <= 20_000 &&
      hash(Buffer.from(JSON.stringify(manifest.files))) === manifest.outputTreeSha256,
    "Invalid output manifest",
  );
  return observation("ssr", manifest, env);
}

function validateBuildObservation(value, identity) {
  const keys = [
    "schemaVersion",
    "phase",
    "sourceRevision",
    "sourceTree",
    "sourceManifestSha256",
    "outputTreeSha256",
    "provider",
    "node",
    "openssl",
    "platform",
    "architecture",
    "libc",
    "nativeInventory",
    "nonFileSharedObjects",
    "observedAt",
    "qualificationPerformed",
  ];
  assert(
    value && typeof value === "object" && Object.keys(value).sort().join() === keys.sort().join(),
    "Invalid build observation fields",
  );
  assert(
    value.schemaVersion === SCHEMA &&
      value.phase === "build" &&
      value.sourceRevision === identity.revision &&
      value.sourceTree === identity.tree &&
      value.sourceManifestSha256 === identity.sourceManifestSha256 &&
      value.outputTreeSha256 === null &&
      value.qualificationPerformed === false,
    "Build observation identity mismatch",
  );
  assert(
    value.platform === "linux" &&
      ["x64", "arm64"].includes(value.architecture) &&
      typeof value.node === "string" &&
      /^\d+\.\d+\.\d+$/u.test(value.node) &&
      typeof value.openssl === "string" &&
      /^\d+\.\d+\.\d+(?:[+-][A-Za-z0-9.-]+)?$/u.test(value.openssl) &&
      typeof value.libc === "string" &&
      /^(?:glibc|musl)@\d+\.\d+(?:\.\d+)?$/u.test(value.libc),
    "Invalid build process facts",
  );
  assert(
    typeof value.observedAt === "string" &&
      Number.isFinite(Date.parse(value.observedAt)) &&
      new Date(value.observedAt).toISOString() === value.observedAt,
    "Invalid observation time",
  );
  assert(
    Array.isArray(value.nativeInventory) &&
      value.nativeInventory.length > 0 &&
      value.nativeInventory.length <= 100,
    "Invalid build native inventory",
  );
  assert(
    Array.isArray(value.nonFileSharedObjects) &&
      value.nonFileSharedObjects.length <= 100 &&
      value.nonFileSharedObjects.every(
        (name) => typeof name === "string" && /^[A-Za-z0-9_.+-]{1,128}$/u.test(name),
      ),
    "Invalid virtual library inventory",
  );
  let previous = "";
  for (const item of value.nativeInventory) {
    assert(
      item &&
        Object.keys(item).sort().join() === "path,sha256" &&
        typeof item.path === "string" &&
        item.path > previous &&
        isAbsolute(item.path) &&
        item.path.length <= 512 &&
        !item.path.split("/").includes("..") &&
        hex(item.sha256, 64),
      "Invalid native entry",
    );
    previous = item.path;
  }
  if (value.provider !== null) {
    const p = value.provider;
    assert(
      p && Object.keys(p).sort().join() === "deploymentId,endpoint,projectId,siteId",
      "Invalid build provider fields",
    );
    providerIdentity({
      APPWRITE_SITE_API_ENDPOINT: p.endpoint,
      APPWRITE_SITE_PROJECT_ID: p.projectId,
      APPWRITE_SITE_ID: p.siteId,
      APPWRITE_SITE_DEPLOYMENT: p.deploymentId,
    });
  }
  assert(Buffer.byteLength(JSON.stringify(value)) <= 64 * 1024, "Build observation size");
}

module.exports = { observeBuild, observeServer, providerIdentity, validateBuildObservation };
