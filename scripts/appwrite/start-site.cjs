"use strict";
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { lstatSync, readFileSync, realpathSync } = require("node:fs");
const { join } = require("node:path");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function validateStartup(directory, env) {
  assert(
    typeof env.PORT === "string" &&
      /^[1-9][0-9]{0,4}$/u.test(env.PORT) &&
      Number(env.PORT) <= 65535,
    "Invalid provider port",
  );
  assert(realpathSync(directory) === directory, "Invalid output directory");
  const manifestPath = join(directory, "output-manifest.json");
  const state = lstatSync(manifestPath);
  assert(
    state.isFile() && !state.isSymbolicLink() && state.size <= 32 * 1024 * 1024,
    "Invalid output manifest",
  );
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert(
    manifest.schemaVersion === 1 &&
      typeof manifest.revision === "string" &&
      /^[a-f0-9]{40}$/u.test(manifest.revision) &&
      typeof manifest.tree === "string" &&
      /^[a-f0-9]{40}$/u.test(manifest.tree) &&
      typeof manifest.sourceManifestSha256 === "string" &&
      /^[a-f0-9]{64}$/u.test(manifest.sourceManifestSha256) &&
      typeof manifest.buildId === "string" &&
      /^[A-Za-z0-9_-]{1,100}$/u.test(manifest.buildId),
    "Invalid source identity",
  );
  assert(
    manifest.entrypoint === "start-site.cjs" &&
      manifest.payloadEntrypoint === "payload/apps/web/server.js" &&
      Array.isArray(manifest.files) &&
      manifest.files.length > 0 &&
      manifest.files.length <= 20_000 &&
      digest(Buffer.from(JSON.stringify(manifest.files))) === manifest.outputTreeSha256,
    "Invalid output identity",
  );
  for (const relative of [
    "start-site.cjs",
    "payload/apps/web/server.js",
    "payload/apps/web/.next/BUILD_ID",
  ]) {
    const entries = manifest.files.filter((entry) => entry.path === relative);
    assert(entries.length === 1, "Missing launch input");
    const entry = entries[0];
    const path = join(directory, relative);
    const stat = lstatSync(path);
    assert(
      entry.type === "file" &&
        ["100644", "100755"].includes(entry.mode) &&
        Number.isSafeInteger(entry.size) &&
        entry.size > 0 &&
        entry.size <= 128 * 1024 * 1024 &&
        stat.isFile() &&
        !stat.isSymbolicLink() &&
        stat.size === entry.size &&
        (stat.mode & 0o7777) === (entry.mode === "100755" ? 0o755 : 0o644) &&
        realpathSync(path) === path,
      "Invalid launch input",
    );
    const bytes = readFileSync(path);
    assert(digest(bytes) === entry.sha256, "Launch input identity mismatch");
    if (relative.endsWith("/BUILD_ID"))
      assert(bytes.toString("utf8").trim() === manifest.buildId, "Build identity mismatch");
  }
  return join(directory, manifest.payloadEntrypoint);
}

function startSite(directory = __dirname) {
  const entrypoint = validateStartup(directory, process.env);
  process.env.HOSTNAME = "0.0.0.0";
  // Provider-injected NODE_OPTIONS is deliberately retained for its runtime hook.
  require(entrypoint);
}

module.exports = { startSite, validateStartup };
if (require.main === module) {
  try {
    startSite();
  } catch {
    console.error("Appwrite application startup rejected its output contract.");
    process.exitCode = 1;
  }
}
