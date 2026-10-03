import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { lintSource } from "@secretlint/core";
import { rules } from "@secretlint/secretlint-rule-preset-recommend";
import { evaluateToolLicenses } from "./check-licenses.mjs";
import { committedFiles, generate, scannerPolicy, verifyCoverage } from "./pack.mjs";

const fullConfig = JSON.parse(
  await readFile(new URL("../../repomix.config.json", import.meta.url), "utf8"),
);
const toolLock = await readFile(new URL("./pnpm-lock.yaml", import.meta.url), "utf8");
const toolPackage = await readFile(new URL("./package.json", import.meta.url), "utf8");
const toolLockSha256 = createHash("sha256").update(toolLock).digest("hex");
const env = {
  PATH: process.env.PATH,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};
function git(directory, ...args) {
  return execFileSync("git", ["-C", directory, ...args], {
    env,
    timeout: 10000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}
async function fixture(t, files = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "repomix-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  git(directory, "init", "-q");
  const initial = {
    "README.md": "# Fixture\nComplete source fixture.\n",
    "repomix.security-baseline.json": JSON.stringify({
      schemaVersion: 1,
      toolLockSha256,
      scanner: scannerPolicy,
      review: "Reviewed public fixture/default/placeholder findings",
      files: [],
    }),
    "tools/repomix/pnpm-lock.yaml": toolLock,
    "tools/repomix/package.json": toolPackage,
    "repomix.config.json": JSON.stringify(fullConfig),
    "repomix.onboarding.config.json": JSON.stringify({ include: ["README.md"] }),
    ...files,
  };
  for (const [name, value] of Object.entries(initial)) {
    await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await writeFile(path.join(directory, name), value);
  }
  git(directory, "add", "--force", ".");
  git(
    directory,
    "-c",
    "user.name=Pack fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "Fixture",
  );
  return directory;
}

test("actual pack includes committed locks/tests/policies despite ignores and excludes dirty/untracked data", {
  timeout: 60000,
}, async (t) => {
  const directory = await fixture(t, {
    ".gitignore": "pnpm-lock.yaml\nprivate-local.txt\n",
    ".repomixignore": "*\n",
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "infra/terraform.tfvars.example": 'location = "eastus2"\n',
    "tests/example.test.mjs": "// Keep this comment.\n\nexport const value = 1;\n",
    "migrations/001.sql": "CREATE TABLE fixture (id INTEGER);\n",
    "policy/[literal].json": '\uFEFF  {"policy":true}  \n',
    "image.png": Buffer.from([137, 80, 78, 71, 0, 1, 2, 3]),
    "repomix.config.js": "throw new Error('Executable config must not run');\n",
  });
  await writeFile(path.join(directory, "README.md"), "DIRTY_CONTENT_MUST_NOT_APPEAR");
  await writeFile(path.join(directory, ".env"), "PRIVATE_LOCAL_CONTENT_MUST_NOT_APPEAR");
  await writeFile(
    path.join(directory, "private-local.txt"),
    "PRIVATE_LOCAL_CONTENT_MUST_NOT_APPEAR",
  );
  const manifest = await generate({ repository: directory });
  assert.equal(manifest.sourceCommit, git(directory, "rev-parse", "HEAD").toString().trim());
  assert.equal(manifest.trackedFiles.length, 15);
  assert.deepEqual(manifest.packs[0].omitted, [{ path: "image.png", reason: "binary-content" }]);
  assert.equal(manifest.packs[0].fileCount, 14);
  assert.deepEqual(manifest.packs[1].paths, ["README.md"]);
  const markdown = await readFile(path.join(directory, "repomix-output.md"), "utf8");
  assert(
    markdown.includes("CREATE TABLE fixture") &&
      markdown.includes("// Keep this comment.\n\nexport const value = 1;"),
  );
  assert(markdown.includes("lockfileVersion") && markdown.includes('"policy":true'));
  assert(!markdown.includes("DIRTY_CONTENT") && !markdown.includes("PRIVATE_LOCAL_CONTENT"));
  assert(manifest.packs.every((pack) => pack.tokens > 0));
});

test("actual secret scanner prevents publication and preserves previous artifacts", {
  timeout: 60000,
}, async (t) => {
  const directory = await fixture(t, { "credential.txt": `token = ghp_${"aB3cD4".repeat(6)}\n` });
  await writeFile(path.join(directory, "repomix-output.md"), "previous accepted artifact");
  await assert.rejects(generate({ repository: directory }), /security check rejected/);
  assert.equal(
    await readFile(path.join(directory, "repomix-output.md"), "utf8"),
    "previous accepted artifact",
  );
  await assert.rejects(readFile(path.join(directory, "repomix-manifest.json")), { code: "ENOENT" });
});

test("tracked symlinks and private state names are rejected before packing", async (t) => {
  const directory = await fixture(t);
  await symlink("/does-not-exist-private-target", path.join(directory, "linked"));
  git(directory, "add", "linked");
  git(
    directory,
    "-c",
    "user.name=Pack fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "Link",
  );
  assert.throws(() => committedFiles(directory), /regular committed Git blobs/);
  const privateDirectory = await fixture(t, { "state.tfstate": "not read as pack input" });
  assert.throws(() => committedFiles(privateDirectory), /Private tracked input/);
});

test("unsupported text encoding and oversized source fail without accepted artifacts", {
  timeout: 60000,
}, async (t) => {
  const directory = await fixture(t, { "binary-disguised.txt": Buffer.from([0, 1, 2, 3]) });
  await assert.rejects(
    generate({ repository: directory }),
    /Scanner text coverage mismatch|Unexplained text omission/,
  );
  await assert.rejects(readFile(path.join(directory, "repomix-manifest.json")), { code: "ENOENT" });
  const large = await fixture(t, { "large.txt": "x".repeat(2097153) });
  assert.throws(() => committedFiles(large), /size bound/);
});

test("executable config and scanning-disable options cannot enter the data-only policy", async (t) => {
  for (const changed of [
    { ...fullConfig, security: { enableSecurityCheck: false } },
    { ...fullConfig, output: { ...fullConfig.output, instructionFilePath: "/private/input" } },
  ]) {
    const directory = await fixture(t, { "repomix.config.json": JSON.stringify(changed) });
    await assert.rejects(generate({ repository: directory }), /supported secure configuration/);
  }
});

test("coverage rejects missing, duplicated, transformed or falsely skipped text", () => {
  const entries = [{ path: "lock.yaml", content: Buffer.from("lock: true\n") }];
  const good = {
    suspiciousFilesResults: [],
    suspiciousGitDiffResults: [],
    suspiciousGitLogResults: [],
    processedFiles: [{ path: "lock.yaml", content: "lock: true" }],
    safeFilePaths: ["lock.yaml"],
    skippedFiles: [],
    totalFiles: 1,
  };
  verifyCoverage(good, entries);
  for (const changed of [
    { ...good, processedFiles: [], safeFilePaths: [], totalFiles: 0 },
    { ...good, processedFiles: [...good.processedFiles, ...good.processedFiles], totalFiles: 2 },
    { ...good, processedFiles: [{ path: "lock.yaml", content: "lock: false" }] },
    {
      ...good,
      processedFiles: [],
      safeFilePaths: [],
      totalFiles: 0,
      skippedFiles: [{ path: "lock.yaml", reason: "size-limit" }],
    },
  ])
    assert.throws(() => verifyCoverage(changed, entries));
});

test("tool license exception is exact-version, expiring and cannot override denied identifiers", async () => {
  const report = { "LGPL-2.1+": [{ name: "jschardet", versions: ["3.1.4"] }] };
  assert.deepEqual(evaluateToolLicenses(report).violations, []);
  assert(
    evaluateToolLicenses({ "LGPL-2.1+": [{ name: "jschardet", versions: ["3.1.5"] }] }).violations
      .length > 0,
  );
  const policy = JSON.parse(
    await readFile(new URL("./license-policy.json", import.meta.url), "utf8"),
  );
  const expired = structuredClone(policy);
  expired.reviewedExceptions[0].expires = "2000-01-01";
  assert.throws(() => evaluateToolLicenses(report, expired), /expired/);
  const denied = structuredClone(policy);
  denied.reviewedExceptions[0].license = "AGPL-3.0";
  assert(
    evaluateToolLicenses({ "AGPL-3.0": report["LGPL-2.1+"] }, denied).violations.some((entry) =>
      entry.reason.includes("denied identifier"),
    ),
  );
});

test("inline suppression cannot hide a new credential from actual detectors", {
  timeout: 60000,
}, async (t) => {
  const directory = await fixture(t, {
    "hidden.js": `// secretlint-disable\nconst token = "ghp_${"aB3cD4".repeat(6)}";\n`,
  });
  await assert.rejects(generate({ repository: directory }), /security check rejected unreviewed/);
  await assert.rejects(readFile(path.join(directory, "repomix-manifest.json")), { code: "ENOENT" });
});

test("exact public fixture baseline accepts only complete unchanged findings", {
  timeout: 60000,
}, async (t) => {
  const source = `const fixture = "postgres${"ql://"}fixture:public-default@127.0.0.1:5432/fixture";\n`;
  const detected = await lintSource({
    source: { filePath: "fixture.js", content: source, ext: "js", contentType: "text" },
    options: {
      config: {
        rules: rules
          .filter((rule) => rule.meta.id !== "@secretlint/secretlint-rule-filter-comments")
          .map((rule) => ({ id: rule.meta.id, rule })),
      },
    },
  });
  assert.equal(detected.messages.length, 1);
  const entry = {
    path: "fixture.js",
    sha256: createHash("sha256").update(source).digest("hex"),
    findings: detected.messages.map(({ ruleId, messageId, range, loc }) => ({
      ruleId,
      messageId,
      range,
      loc,
    })),
  };
  const baseline = {
    schemaVersion: 1,
    toolLockSha256,
    scanner: scannerPolicy,
    review: "Reviewed public fixture/default/placeholder findings",
    files: [entry],
  };
  const directory = await fixture(t, {
    "fixture.js": source,
    "repomix.security-baseline.json": JSON.stringify(baseline),
  });
  const manifest = await generate({ repository: directory });
  assert.equal(manifest.securityCheck.reviewedFindings, 1);
  assert.equal(manifest.securityCheck.unreviewedFindings, 0);
  assert.equal(manifest.securityCheck.inlineSuppression, false);
  assert.equal(manifest.securityCheck.detectorIds.length, 27);
  assert(manifest.securityCheck.detectorIds.includes("@secretlint/secretlint-rule-github"));
  assert(
    !manifest.securityCheck.detectorIds.includes("@secretlint/secretlint-rule-filter-comments"),
  );
  const full = await readFile(path.join(directory, "repomix-output.md"), "utf8");
  assert(full.includes(source.trim()), "Reviewed source remains complete in output");
  for (const [name, changedSource, changeBaseline, additional] of [
    [
      "tool lock changed",
      source,
      (value) => value,
      { "tools/repomix/pnpm-lock.yaml": `${toolLock}# changed graph metadata\n` },
    ],
    ["source changed outside finding", `${source}// changed\n`, (value) => value, {}],
    ["new file finding", source, (value) => value, { "another.js": source }],
    [
      "stale path",
      source,
      (value) => {
        value.files[0].path = "missing.js";
        return value;
      },
      {},
    ],
    [
      "missing finding",
      "const publicValue = 1;\n",
      (value) => {
        value.files[0].sha256 = createHash("sha256")
          .update("const publicValue = 1;\n")
          .digest("hex");
        return value;
      },
      {},
    ],
    [
      "duplicate baseline file",
      source,
      (value) => {
        value.files.push(structuredClone(value.files[0]));
        return value;
      },
      {},
    ],
    [
      "duplicate baseline finding",
      source,
      (value) => {
        value.files[0].findings.push(structuredClone(value.files[0].findings[0]));
        return value;
      },
      {},
    ],
    [
      "changed rule fingerprint",
      source,
      (value) => {
        value.files[0].findings[0].messageId += "changed";
        return value;
      },
      {},
    ],
    [
      "scanner policy drift",
      source,
      (value) => {
        value.scanner.inlineSuppression = true;
        return value;
      },
      {},
    ],
  ]) {
    await t.test(name, async (caseTest) => {
      const altered = await fixture(caseTest, {
        "fixture.js": changedSource,
        "repomix.security-baseline.json": JSON.stringify(changeBaseline(structuredClone(baseline))),
        ...additional,
      });
      await assert.rejects(generate({ repository: altered }));
      await assert.rejects(readFile(path.join(altered, "repomix-manifest.json")), {
        code: "ENOENT",
      });
    });
  }
});

test("text and synthetic credentials named as binary cannot bypass scanning", {
  timeout: 60000,
}, async (t) => {
  for (const [name, content] of [
    ["ordinary UTF8 text", "This is complete UTF-8 source text, not a picture.\n"],
    ["synthetic credential text", `token = ghp_${"aB3cD4".repeat(6)}\n`],
  ]) {
    await t.test(name, async (caseTest) => {
      const directory = await fixture(caseTest, { "disguised.png": content });
      await writeFile(path.join(directory, "repomix-output.md"), "previous accepted artifact");
      await assert.rejects(generate({ repository: directory }), /Binary extension contains text/);
      assert.equal(
        await readFile(path.join(directory, "repomix-output.md"), "utf8"),
        "previous accepted artifact",
      );
      await assert.rejects(readFile(path.join(directory, "repomix-manifest.json")), {
        code: "ENOENT",
      });
    });
  }
});

test("tracked handoffs are bounded exclusions and regenerate without recursive source", {
  timeout: 60000,
}, async (t) => {
  const outputNames = ["repomix-output.md", "repomix-onboarding.md", "repomix-manifest.json"];
  const directory = await fixture(t, {
    "repomix-output.md": "OLD_DERIVED_CONTENT".repeat(150000),
    "repomix-onboarding.md": "OLD_ONBOARDING_CONTENT",
    "repomix-manifest.json": "OLD_MANIFEST_CONTENT",
    "nested/repomix-output.md": "Nested source must remain in the pack.\n",
    "repomix-output.md.source": "Lookalike source must remain in the pack.\n",
  });
  const sourceCommit = git(directory, "rev-parse", "HEAD").toString().trim();
  const expected = outputNames.map((name) => ({
    path: name,
    mode: "100644",
    blob: git(directory, "rev-parse", `HEAD:${name}`).toString().trim(),
    reason: "derived-output",
  }));
  const first = await generate({ repository: directory });
  assert.equal(first.sourceCommit, sourceCommit);
  assert.deepEqual(first.derivedOutputs.paths, outputNames);
  assert.deepEqual(
    first.derivedOutputs.excluded,
    expected.sort((a, b) => a.path.localeCompare(b.path)),
  );
  assert.equal(first.trackedFiles.length, 8);
  assert(first.trackedFiles.every((entry) => !outputNames.includes(entry.path)));
  assert.equal(first.packs[0].scope, "complete-non-derived-tracked-text");
  const full = await readFile(path.join(directory, outputNames[0]), "utf8");
  assert(!full.includes("OLD_DERIVED_CONTENT") && !full.includes("OLD_ONBOARDING_CONTENT"));
  assert(
    full.includes("Nested source must remain") && full.includes("Lookalike source must remain"),
  );
  git(directory, "add", "--", ...outputNames);
  git(
    directory,
    "-c",
    "user.name=Pack fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "Generated snapshot only",
  );
  const second = await generate({ repository: directory });
  assert.notEqual(second.sourceCommit, sourceCommit);
  assert.equal(second.sourceCommit, git(directory, "rev-parse", "HEAD").toString().trim());
  assert.deepEqual(second.trackedFiles, first.trackedFiles);
  assert.equal(second.packs[0].bytes, first.packs[0].bytes);
  assert.equal(second.derivedOutputs.excluded.length, 3);
});

test("derived exclusions never hide nested or lookalike credentials", {
  timeout: 60000,
}, async (t) => {
  for (const name of ["nested/repomix-output.md", "repomix-output.md.source"]) {
    await t.test(name, async (caseTest) => {
      const directory = await fixture(caseTest, { [name]: `token = ghp_${"aB3cD4".repeat(6)}\n` });
      await assert.rejects(generate({ repository: directory }), /security check rejected/);
      await assert.rejects(readFile(path.join(directory, "repomix-manifest.json")), {
        code: "ENOENT",
      });
    });
  }
});

test("excluded root output names still reject committed symlinks", async (t) => {
  const directory = await fixture(t);
  await symlink("/does-not-exist-private-target", path.join(directory, "repomix-output.md"));
  git(directory, "add", "repomix-output.md");
  git(
    directory,
    "-c",
    "user.name=Pack fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "Invalid linked output",
  );
  assert.throws(() => committedFiles(directory), /regular committed Git blobs/);
});

test("onboarding cannot select a tracked derived output", async (t) => {
  const directory = await fixture(t, {
    "repomix-output.md": "Previous public output",
    "repomix.onboarding.config.json": JSON.stringify({ include: ["repomix-output.md"] }),
  });
  await assert.rejects(
    generate({ repository: directory }),
    /Onboarding must name unique committed files/,
  );
});

test("onboarding opens with an explicit partial header without the full-repository summary", {
  timeout: 60000,
}, async (t) => {
  const directory = await fixture(t);
  const manifest = await generate({ repository: directory });
  assert.deepEqual(manifest.derivedOutputs, {
    paths: ["repomix-output.md", "repomix-onboarding.md", "repomix-manifest.json"],
    excluded: [],
  });
  const partial = await readFile(path.join(directory, "repomix-onboarding.md"), "utf8");
  assert(partial.startsWith("# User Provided Header\nSource commit: "));
  assert(partial.includes("Partial onboarding subset"));
  assert(!partial.includes("# File Summary") && !partial.includes("entire codebase"));
});
