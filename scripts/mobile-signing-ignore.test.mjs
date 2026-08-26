import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const repositoryRoot = new URL("..", import.meta.url);
const ignoreLines = readFileSync(new URL("../.gitignore", import.meta.url), "utf8").split("\n");

const signingArtifacts = new Map([
  ["apps/mobile/.local-signing/AuthKey_TEST.p8", "*.p8"],
  ["apps/mobile/.local-signing/distribution.p12", "*.p12"],
  ["apps/mobile/android/app/upload.jks", "*.jks"],
  ["apps/mobile/android/app/release.keystore", "*.keystore"],
  ["apps/mobile/ios/device.mobileprovision", "*.mobileprovision"],
  ["apps/mobile/credentials.json", "credentials.json"],
]);

test("keeps mobile signing credentials and provisioning profiles out of Git", () => {
  for (const [path, expectedPattern] of signingArtifacts) {
    assert.equal(
      ignoreLines.filter((line) => line === expectedPattern).length,
      1,
      `${expectedPattern} must appear exactly once in .gitignore`,
    );

    const result = spawnSync("git", ["check-ignore", "--no-index", "--verbose", "--", path], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, `${path} must be ignored by Git`);
    const matchedRule = result.stdout.trim().split("\t", 1)[0];
    assert.ok(
      matchedRule.endsWith(`:${expectedPattern}`),
      `${path} must be ignored by the exact ${expectedPattern} rule`,
    );
  }

  const tracked = spawnSync("git", ["ls-files"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert.equal(tracked.error, undefined);
  assert.equal(tracked.status, 0);
  const trackedPaths = tracked.stdout.split("\n").filter(Boolean);
  for (const trackedPath of trackedPaths) {
    assert.equal(
      [...signingArtifacts.values()].some((pattern) => {
        if (pattern === "credentials.json") {
          return trackedPath === pattern || trackedPath.endsWith(`/${pattern}`);
        }
        return trackedPath.endsWith(pattern.slice(1));
      }),
      false,
      `tracked mobile signing artifact is forbidden: ${trackedPath}`,
    );
  }
});
