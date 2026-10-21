import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const mobile = createRequire(new URL("../apps/mobile/package.json", import.meta.url));
const expo = createRequire(mobile.resolve("expo/package.json"));
const cli = createRequire(expo.resolve("@expo/cli/package.json"));
const expoMetro = createRequire(cli.resolve("@expo/metro/package.json"));
const metroFileMap = createRequire(expoMetro.resolve("metro-file-map/package.json"));
const micromatch = metroFileMap("micromatch");
const match = createRequire(metroFileMap.resolve("micromatch/package.json"));
const braces = match("braces");
const nestingError = { name: "SyntaxError", message: "Input nesting depth exceeds maximum of 128" };
const nested = (depth) => "{".repeat(depth) + "a" + "}".repeat(depth);

for (const method of ["compile", "expand", "stringify"]) {
  test(`${method} rejects the reproduced stack-overflow input before recursion`, () => {
    assert.throws(() => braces[method](nested(4999)), nestingError);
  });
  test(`${method} accepts 128 nested containers and rejects 129`, () => {
    assert.doesNotThrow(() => braces[method](nested(128)));
    assert.throws(() => braces[method](nested(129)), nestingError);
  });
}

test("parentheses share the same parser nesting budget", () => {
  const pattern = "(".repeat(129) + "a" + ")".repeat(129);
  assert.throws(() => braces.compile(pattern), nestingError);
});

test("the existing character allowance remains available to flat input", () => {
  const pattern = "a".repeat(10000);
  assert.equal(braces.compile(pattern), pattern);
  assert.deepEqual(braces.expand(pattern), [pattern]);
});

test("Metro's micromatch consumer retains brace and numeric range behavior", () => {
  assert.deepEqual(micromatch.braceExpand("src/{api,web}/{1..2}.ts"), [
    "src/api/1.ts",
    "src/api/2.ts",
    "src/web/1.ts",
    "src/web/2.ts",
  ]);
  assert.deepEqual(micromatch.braces("src/{api,web}/*.ts"), ["src/(api|web)/*.ts"]);
  assert.throws(() => micromatch.braces(nested(4999)), nestingError);
  assert.throws(() => micromatch.braceExpand(nested(4999)), nestingError);
});
