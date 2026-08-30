import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const biomeConfig = JSON.parse(readFileSync(join(repositoryRoot, "biome.json"), "utf8"));

test("Biome excludes protected ignored local data", () => {
  assert.ok(biomeConfig.files.includes.includes("!**/.local-data"));
});
