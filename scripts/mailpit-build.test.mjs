import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MAILPIT_INPUTS,
  verifyGoNotices,
  verifyMailpitLicenses,
  verifyModuleGraph,
  verifyNpmLock,
  verifyProductionImports,
  verifySource,
} from "./verify-mailpit-build.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const clone = () => structuredClone(MAILPIT_INPUTS);
const lock = () => ({
  lockfileVersion: 3,
  packages: {
    "": {},
    ...Object.fromEntries(
      Object.entries(MAILPIT_INPUTS.npm).map(([path, item]) => [
        path,
        {
          version: item.version,
          resolved: item.resolved,
          integrity: item.integrity,
          license: item.registryLicense,
        },
      ]),
    ),
  },
});
const policy = JSON.parse(readFileSync(new URL("../config/license-policy.json", import.meta.url)));
const notices = readFileSync(
  new URL("../infra/docker/mailpit-NOTICES.txt", import.meta.url),
  "utf8",
);
const now = Date.parse("2026-10-01T10:00:00Z");
test("complete frozen 360-entry npm inventory satisfies unchanged policy with three scoped exceptions", () => {
  const report = verifyNpmLock(lock(), MAILPIT_INPUTS, now);
  const result = verifyMailpitLicenses(report, policy, notices);
  assert.equal(result.packageCount, 360);
  assert.equal(result.reviewedExceptionCount, 3);
  assert.equal(hash(notices), MAILPIT_INPUTS.noticesSha256);
  assert.equal(
    policy.reviewedExceptions.some((item) => item.packageName === "ical.js"),
    false,
  );
});
for (const [name, mutate] of [
  ["version", (x) => (x.version = "99.0.0")],
  ["integrity", (x) => (x.integrity = "sha512-AA==")],
  ["registry", (x) => (x.resolved = "https://example.com/package.tgz")],
  ["license", (x) => (x.license = "AGPL-3.0")],
])
  test(`frozen npm admission rejects changed ${name}`, () => {
    const value = lock();
    mutate(Object.values(value.packages)[1]);
    assert.throws(() => verifyNpmLock(value, MAILPIT_INPUTS, now));
  });
test("npm admission rejects additions and omissions", () => {
  const value = lock();
  value.packages["node_modules/unreviewed"] = {};
  assert.throws(() => verifyNpmLock(value, MAILPIT_INPUTS, now));
  delete value.packages["node_modules/unreviewed"];
  delete value.packages[Object.keys(value.packages)[1]];
  assert.throws(() => verifyNpmLock(value, MAILPIT_INPUTS, now));
});
for (const [name, mutate] of [
  ["release age", (x) => (Object.values(x.npm)[0].publishedAt = "2026-10-01T09:59:00Z")],
  ["invalid publication", (x) => (Object.values(x.npm)[0].publishedAt = "unknown")],
  ["lower age policy", (x) => (x.minimumReleaseAgeMinutes = 1)],
])
  test(`npm admission rejects ${name}`, () => {
    const value = clone();
    mutate(value);
    assert.throws(() => verifyNpmLock(lock(), value, now));
  });
test("scoped license review never bypasses the unconditional deny list", () => {
  const report = verifyNpmLock(lock(), MAILPIT_INPUTS, now);
  report["AGPL-3.0"] = [{ name: "ical.js", versions: ["2.2.1"] }];
  assert.throws(() => verifyMailpitLicenses(report, policy, notices), /denied identifier/);
});
test("scoped license exceptions require their exact notices", () => {
  const report = verifyNpmLock(lock(), MAILPIT_INPUTS, now);
  assert.throws(() => verifyMailpitLicenses(report, policy, ""), /omit exception token/);
});
test("source admission detects changed, missing and extra bytes in expected files", () => {
  const root = mkdtempSync(join(tmpdir(), "mailpit-source-test-"));
  try {
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "nested/file"), "original");
    const inputs = { upstream: { files: { "nested/file": hash("original") } } };
    assert.equal(verifySource(root, inputs), 1);
    writeFileSync(join(root, "nested/file"), "original plus extra");
    assert.throws(() => verifySource(root, inputs), /source changed/);
    rmSync(join(root, "nested/file"));
    assert.throws(() => verifySource(root, inputs));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("Go MVS requires exact complete versions and one unchanged main", () => {
  assert.equal(
    verifyModuleGraph("main \nx v1.0.0\ny v2.0.0\n", { x: "v1.0.0", y: "v2.0.0" }, "main"),
    2,
  );
  for (const text of [
    "main \nx v1.0.0\n",
    "main v1\nx v1.0.0\ny v2.0.0\n",
    "main \nx v1.0.0\nx v1.0.0\ny v2.0.0\n",
    "main \nx v1.0.0 replacement\ny v2.0.0\n",
  ])
    assert.throws(() => verifyModuleGraph(text, { x: "v1.0.0", y: "v2.0.0" }, "main"));
});
test("Go import graph rejects added affected packages, omissions and duplicates", () => {
  assert.equal(verifyProductionImports("a\nb\n", ["b", "a"]), 2);
  for (const text of ["a\n", "a\nb\nb\n", "a\nb\nopenpgp\n"])
    assert.throws(() => verifyProductionImports(text, ["a", "b"]));
});
test("Go notice check binds real content, byte length and nonempty heading count", () => {
  const bytes = Buffer.from("## dependency (MIT)\ntext\n");
  const inputs = { goNotices: { sha256: hash(bytes), bytes: bytes.length, headings: 1 } };
  assert.equal(verifyGoNotices(bytes, inputs), 1);
  assert.throws(() => verifyGoNotices(Buffer.alloc(0), inputs));
  inputs.goNotices.headings = 2;
  assert.throws(() => verifyGoNotices(bytes, inputs));
});
test("qualified source and tool manifests retain exact independent boundaries", () => {
  assert.equal(Object.keys(MAILPIT_INPUTS.upstream.files).length, 208);
  assert.equal(Object.keys(MAILPIT_INPUTS.licenseTool.files).length, 62);
  assert.equal(Object.keys(MAILPIT_INPUTS.goSelectedVersions).length, 83);
  assert.equal(Object.keys(MAILPIT_INPUTS.licenseTool.selectedVersions).length, 88);
  assert.equal(MAILPIT_INPUTS.goSelectedVersions["golang.org/x/text"], "v0.42.0");
  assert.equal(MAILPIT_INPUTS.licenseTool.selectedVersions["golang.org/x/text"], "v0.39.0");
  for (const [file, key] of [
    ["mailpit-go-licenses.go.mod", "goModSha256"],
    ["mailpit-go-licenses.go.sum", "goSumSha256"],
  ])
    assert.equal(
      hash(readFileSync(new URL(`../infra/docker/${file}`, import.meta.url))),
      MAILPIT_INPUTS.licenseTool[key],
    );
  assert.equal(MAILPIT_INPUTS.browserDirectPackages.length, 28);
  assert.ok(
    MAILPIT_INPUTS.browserNoticeFiles.some((item) =>
      item.file.endsWith("rapidoc-min.js.LICENSE.txt"),
    ),
  );
});
