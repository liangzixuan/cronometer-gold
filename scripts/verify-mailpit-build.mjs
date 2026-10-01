import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { evaluateLicensePolicy } from "./license-policy.mjs";

export const MAILPIT_INPUTS = JSON.parse(
  readFileSync(new URL("../infra/docker/mailpit-build-inputs.json", import.meta.url), "utf8"),
);
const sha = (bytes, algorithm = "sha256") => createHash(algorithm).update(bytes).digest("hex");
const fail = (message) => {
  throw new Error(message);
};
const equal = (actual, expected, message) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(message);
};

export function verifySource(root, inputs = MAILPIT_INPUTS) {
  for (const [file, digest] of Object.entries(inputs.upstream.files)) {
    if (sha(readFileSync(join(root, file))) !== digest) fail(`Mailpit source changed: ${file}`);
  }
  return Object.keys(inputs.upstream.files).length;
}

export function verifyNpmLock(lock, inputs = MAILPIT_INPUTS, now = Date.now()) {
  if (lock.lockfileVersion !== 3 || inputs.minimumReleaseAgeMinutes !== 1440)
    fail("Unsupported Mailpit lock or release-age policy.");
  const paths = Object.keys(lock.packages)
    .filter((path) => path !== "")
    .sort();
  equal(paths, Object.keys(inputs.npm).sort(), "Mailpit npm dependency set changed.");
  const report = {};
  for (const path of paths) {
    const actual = lock.packages[path];
    const expected = inputs.npm[path];
    for (const key of ["version", "integrity", "resolved"]) {
      if (actual[key] !== expected[key]) fail(`Mailpit npm ${key} changed: ${path}`);
    }
    if (
      !expected.resolved.startsWith("https://registry.npmjs.org/") ||
      !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(expected.integrity)
    )
      fail("Mailpit dependencies require official registry integrity.");
    const published = Date.parse(expected.publishedAt);
    if (!Number.isFinite(published) || now - published < 1440 * 60_000)
      fail(`Mailpit dependency is too young: ${path}`);
    if (actual.license !== expected.registryLicense)
      fail(`Mailpit license metadata changed: ${path}`);
    report[actual.license] ??= [];
    report[actual.license].push({ name: expected.name, versions: [actual.version] });
  }
  return report;
}

export function verifyMailpitLicenses(report, policy, notices, inputs = MAILPIT_INPUTS) {
  const result = evaluateLicensePolicy(
    { ...policy, reviewedExceptions: inputs.reviewedExceptions },
    notices,
    report,
  );
  if (result.violations.length)
    fail(`Mailpit license policy rejected: ${JSON.stringify(result.violations)}`);
  return result;
}

export function verifyNativeArtifacts(root, cache, arch = process.arch, inputs = MAILPIT_INPUTS) {
  if (process.platform !== "linux" || !["arm64", "x64"].includes(arch))
    fail("Mailpit native artifact verification requires Linux ARM64 or AMD64.");
  const candidates = [
    [`@esbuild/linux-${arch}`, ["bin/esbuild"]],
    [`sass-embedded-linux-${arch}`, ["dart-sass/src/dart", "dart-sass/sass"]],
    [`sass-embedded-linux-musl-${arch}`, ["dart-sass/src/dart", "dart-sass/sass"]],
    [`@parcel/watcher-linux-${arch}-glibc`, ["watcher.node"]],
    [`@parcel/watcher-linux-${arch}-musl`, ["watcher.node"]],
  ];
  const evidence = [];
  for (const [name, files] of candidates) {
    const directory = join(root, "node_modules", name);
    if (!existsSync(directory)) fail(`Missing expected native optional package: ${name}`);
    const entry = inputs.npm[`node_modules/${name}`];
    const integrity = Buffer.from(entry.integrity.slice(7), "base64").toString("hex");
    const archive = join(
      cache,
      "_cacache/content-v2/sha512",
      integrity.slice(0, 2),
      integrity.slice(2, 4),
      integrity.slice(4),
    );
    if (sha(readFileSync(archive), "sha512") !== integrity)
      fail(`Native npm archive integrity changed: ${name}`);
    for (const file of files) {
      const original = execFileSync("tar", ["-xOzf", archive, `package/${file}`], {
        timeout: 30_000,
        maxBuffer: 32_000_000,
      });
      const installed = readFileSync(join(directory, file));
      if (!original.equals(installed))
        fail(`Native npm artifact differs from authenticated archive: ${name}/${file}`);
      evidence.push({ name, version: entry.version, file, sha256: sha(installed) });
    }
  }
  return evidence;
}

export function verifyModuleGraph(text, versions, main) {
  const actual = new Map();
  for (const line of text.trim().split("\n")) {
    const [name, version, ...extra] = line.trim().split(/\s+/u);
    if (!name || extra.length || actual.has(name)) fail("Malformed or duplicate Go module record.");
    actual.set(name, version ?? "");
  }
  if (actual.get(main) !== "") fail("Go main module changed.");
  actual.delete(main);
  equal([...actual].sort(), Object.entries(versions).sort(), "Selected Go module graph changed.");
  return actual.size;
}

export function verifyProductionImports(text, expected) {
  const actual = text.trim().split("\n").sort();
  equal(actual, [...expected].sort(), "Go production package import graph changed.");
  return actual.length;
}

export function verifyGoNotices(bytes, inputs = MAILPIT_INPUTS) {
  if (
    sha(bytes) !== inputs.goNotices.sha256 ||
    bytes.length !== inputs.goNotices.bytes ||
    (bytes.toString().match(/^## .+ \(.+\)$/gmu) ?? []).length !== inputs.goNotices.headings
  )
    fail("Generated Go notices differ or are incomplete.");
  return inputs.goNotices.headings;
}

function fileMap(directory) {
  const result = {};
  function visit(relative) {
    for (const name of readdirSync(join(directory, relative)).sort()) {
      const file = join(relative, name);
      const stat = lstatSync(join(directory, file));
      if (stat.isSymbolicLink()) fail("Unexpected generated asset link.");
      if (stat.isDirectory()) visit(file);
      else if (stat.isFile()) result[file] = sha(readFileSync(join(directory, file)));
      else fail("Unexpected generated asset type.");
    }
  }
  visit("");
  return result;
}

export async function verifyFrontend(root, evidence, inputs = MAILPIT_INPUTS) {
  const before = fileMap(join(root, "server/ui/dist"));
  if (!Object.keys(before).length) fail("Upstream frontend build produced no assets.");
  const require = createRequire(join(root, "package.json"));
  const esbuild = await import(pathToFileURL(require.resolve("esbuild")).href);
  const { default: pluginVue } = await import(
    pathToFileURL(require.resolve("esbuild-plugin-vue-next")).href
  );
  const { sassPlugin } = await import(pathToFileURL(require.resolve("esbuild-sass-plugin")).href);
  // Exact upstream options; the only addition records esbuild's standard input metadata.
  const result = await esbuild.build({
    absWorkingDir: root,
    entryPoints: ["server/ui-src/app.js", "server/ui-src/docs.js"],
    bundle: true,
    minify: true,
    sourcemap: false,
    define: {
      __VUE_OPTIONS_API__: "true",
      __VUE_PROD_DEVTOOLS__: "false",
      __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false",
    },
    outdir: "server/ui/dist/",
    plugins: [pluginVue(), sassPlugin({ silenceDeprecations: ["import"], quietDeps: true })],
    loader: { ".svg": "file", ".woff": "file", ".woff2": "file" },
    logLevel: "info",
    metafile: true,
  });
  equal(
    fileMap(join(root, "server/ui/dist")),
    before,
    "Metadata-only frontend build changed asset bytes.",
  );
  const packages = [
    ...new Set(
      Object.keys(result.metafile.inputs)
        .filter((file) => file.includes("node_modules/"))
        .map((file) => {
          const parts = file.split("node_modules/").at(-1).split("/");
          return parts[0].startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
        }),
    ),
  ].sort();
  equal(packages, inputs.browserDirectPackages, "Direct browser package inputs changed.");
  for (const item of inputs.browserNoticeFiles) {
    if (sha(readFileSync(join(root, item.file))) !== item.sha256)
      fail(`Browser notice source changed: ${item.file}`);
    const target = join(evidence, "browser-notices", item.file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(root, item.file), target);
  }
  verifySource(root, inputs);
  writeFileSync(
    join(evidence, "frontend-metafile.json"),
    `${JSON.stringify(result.metafile, null, 2)}\n`,
  );
  writeFileSync(join(evidence, "frontend-assets.json"), `${JSON.stringify(before, null, 2)}\n`);
  // MPL source is distributed with the image, not just linked from a notice.
  const ical = inputs.npm["node_modules/ical.js"];
  const integrity = Buffer.from(ical.integrity.slice(7), "base64").toString("hex");
  const archive = join(
    process.env.NPM_CONFIG_CACHE,
    "_cacache/content-v2/sha512",
    integrity.slice(0, 2),
    integrity.slice(2, 4),
    integrity.slice(4),
  );
  if (sha(readFileSync(archive), "sha512") !== integrity)
    fail("ical.js source archive integrity differs.");
  copyFileSync(archive, join(evidence, "ical.js-2.2.1.tgz"));
  return { directPackages: packages.length, assetCount: Object.keys(before).length };
}

async function main(args) {
  const [mode, rootArgument, evidenceArgument] = args;
  if (args.length !== 3 || !["source", "npm", "frontend", "graph", "notices"].includes(mode))
    fail("Expected source|npm|frontend|graph|notices, root and evidence directory.");
  const root = resolve(rootArgument);
  const evidence = resolve(evidenceArgument);
  mkdirSync(evidence, { recursive: true });
  let result;
  if (mode === "source") result = { sourceFiles: verifySource(root) };
  if (mode === "npm") {
    const report = verifyNpmLock(JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")));
    const policy = JSON.parse(
      readFileSync(new URL("../config/license-policy.json", import.meta.url), "utf8"),
    );
    const notices = readFileSync(
      new URL("../infra/docker/mailpit-NOTICES.txt", import.meta.url),
      "utf8",
    );
    if (sha(notices) !== MAILPIT_INPUTS.noticesSha256) fail("Mailpit notice bundle changed.");
    result = {
      ...verifyMailpitLicenses(report, policy, notices),
      native: verifyNativeArtifacts(root, process.env.NPM_CONFIG_CACHE),
    };
  }
  if (mode === "frontend") result = await verifyFrontend(root, evidence);
  if (mode === "graph") {
    verifySource(join(root, "source"));
    for (const [file, digest] of Object.entries(MAILPIT_INPUTS.licenseTool.files)) {
      if (sha(readFileSync(join(root, "tool", file))) !== digest)
        fail(`License tool source changed: ${file}`);
    }
    result = {
      modules: verifyModuleGraph(
        readFileSync(join(root, "mailpit-modules.txt"), "utf8"),
        MAILPIT_INPUTS.goSelectedVersions,
        "github.com/axllent/mailpit",
      ),
      imports: verifyProductionImports(
        readFileSync(join(root, "mailpit-imports.txt"), "utf8"),
        MAILPIT_INPUTS.goProductionImports,
      ),
      toolModules: verifyModuleGraph(
        readFileSync(join(root, "tool-modules.txt"), "utf8"),
        MAILPIT_INPUTS.licenseTool.selectedVersions,
        "github.com/google/go-licenses/v2",
      ),
      toolImports: verifyProductionImports(
        readFileSync(join(root, "tool-imports.txt"), "utf8"),
        MAILPIT_INPUTS.licenseTool.productionImports,
      ),
    };
  }
  if (mode === "notices")
    result = { headings: verifyGoNotices(readFileSync(join(root, "go-notices.txt"))) };
  writeFileSync(
    join(evidence, `${mode}-verification.json`),
    `${JSON.stringify(result, null, 2)}\n`,
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
