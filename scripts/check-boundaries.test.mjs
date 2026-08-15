import assert from "node:assert/strict";
import test from "node:test";

import {
  forbiddenDomainGlobals,
  importedSpecifiers,
  isNodeBuiltin,
} from "./workspace-boundaries.mjs";

test("recognizes bare and node-prefixed built-ins", () => {
  assert.equal(isNodeBuiltin("fs"), true);
  assert.equal(isNodeBuiltin("fs/promises"), true);
  assert.equal(isNodeBuiltin("node:path"), true);
  assert.equal(isNodeBuiltin("decimal.js"), false);
});

test("parses static, exported, side-effect, required, and dynamic imports", () => {
  const source = `
    import type { A } from "type-package";
    import "side-effect-package";
    export { value } from "exported-package";
    const required = require("required-package");
    const dynamic = import("dynamic-package");
    const requiredTemplate = require(\`required-template-package\`);
    const dynamicTemplate = import(\`dynamic-template-package\`);
  `;
  assert.deepEqual(importedSpecifiers(source).sort(), [
    "dynamic-package",
    "dynamic-template-package",
    "exported-package",
    "required-package",
    "required-template-package",
    "side-effect-package",
    "type-package",
  ]);
});

test("detects environment and network globals in alternate forms", () => {
  const source = `
    process["env"].TOKEN;
    fetch("https://example.test");
    globalThis["fetch"]("https://example.test");
    new WebSocket("wss://example.test");
    new XMLHttpRequest();
  `;
  assert.deepEqual(forbiddenDomainGlobals(source).sort(), [
    "WebSocket",
    "XMLHttpRequest",
    "fetch",
    "globalThis.fetch",
    "process.env",
  ]);
});
