import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as canonical from "../../../packages/db/src/canonical-json.js";
import {
  canonicalJson,
  canonicalJsonChunks,
  sha256CanonicalJson,
} from "../../../packages/db/src/catalogue-validation.js";

describe("canonical JSON import boundary", () => {
  it("keeps existing catalogue exports as the same serializer functions", () => {
    expect(canonicalJson).toBe(canonical.canonicalJson);
    expect(canonicalJsonChunks).toBe(canonical.canonicalJsonChunks);
    expect(sha256CanonicalJson).toBe(canonical.sha256CanonicalJson);
  });

  it("loads the public subpath in a fresh process with only builtin runtime dependencies", () => {
    const script = String.raw`
      import assert from "node:assert/strict";
      import { createHash } from "node:crypto";
      import { registerHooks } from "node:module";
      import { resolve } from "node:path";
      import { pathToFileURL } from "node:url";
      const entry = import.meta.resolve("@nutrition-tracker/db/canonical-json");
      assert.equal(entry, pathToFileURL(resolve("../../packages/db/dist/canonical-json.js")).href);
      const loaded = new Set();
      const check = (url) => {
        if (url !== entry && !url.startsWith("node:")) {
          throw new Error("Unexpected canonical runtime dependency: " + url);
        }
      };
      const hooks = registerHooks({
        resolve(specifier, context, nextResolve) {
          const result = nextResolve(specifier, context);
          check(result.url);
          return result;
        },
        load(url, context, nextLoad) {
          check(url);
          loaded.add(url);
          return nextLoad(url, context);
        },
      });
      try {
        const api = await import("@nutrition-tracker/db/canonical-json");
        assert.deepEqual(Object.keys(api).sort(), ["canonicalJson", "canonicalJsonChunks", "sha256CanonicalJson"]);
        const value = { z: "雪🍓", "2": [-0, null, true], "10": '"\n\\' };
        const expected = '{"10":' + JSON.stringify(value["10"]) + ',"2":[0,null,true],"z":' + JSON.stringify(value.z) + '}';
        assert.equal(api.canonicalJson(value), expected);
        assert.equal([...api.canonicalJsonChunks(value)].join(""), expected);
        assert.equal(api.sha256CanonicalJson(value), createHash("sha256").update(expected).digest("hex"));
        assert(loaded.has(entry));
        // Prove the guard rejects the broad root before its modules can execute.
        await assert.rejects(import("@nutrition-tracker/db"), /Unexpected canonical runtime dependency/);
        console.log(JSON.stringify({ loadedEntry: true, broadRootRejected: true }));
      } finally {
        hooks.deregister();
      }
    `;
    const output = execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 4096,
    });
    expect(JSON.parse(output)).toEqual({ loadedEntry: true, broadRootRejected: true });
  });
});
