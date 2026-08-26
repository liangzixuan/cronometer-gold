import assert from "node:assert/strict";
import test from "node:test";

import { COMPILER_ARGUMENTS, COMPILER_SCRIPT, runBuild } from "./watch-typescript-build.mjs";

test("runs the pinned native compiler once without a shell", () => {
  let observed;
  const status = runBuild((executable, arguments_, options) => {
    observed = { arguments_, executable, options };
    return { error: undefined, signal: null, status: 0 };
  });

  assert.equal(status, 0);
  assert.deepEqual(observed, {
    arguments_: [COMPILER_SCRIPT, "-p", "tsconfig.build.json"],
    executable: process.execPath,
    options: { shell: false, stdio: "inherit" },
  });
  assert.deepEqual(COMPILER_ARGUMENTS, [COMPILER_SCRIPT, "-p", "tsconfig.build.json"]);
});

test("preserves compiler failures and sanitizes launch failures", (context) => {
  assert.equal(
    runBuild(() => ({ error: undefined, signal: null, status: 2 })),
    2,
  );

  const messages = [];
  context.mock.method(console, "error", (message) => messages.push(message));
  assert.equal(
    runBuild(() => ({ error: new Error("private path"), status: null })),
    1,
  );
  assert.equal(
    runBuild(() => {
      throw new Error("private path");
    }),
    1,
  );
  assert.deepEqual(messages, [
    "[package-watch] Could not start the pinned TypeScript compiler.",
    "[package-watch] Could not start the pinned TypeScript compiler.",
  ]);
  assert.doesNotMatch(messages.join("\n"), /private path/);
});
