import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { adaptFdcJsonRelease, extractZipArchive } from "../src/index.js";

const realFoundationArchive = fileURLToPath(
  new URL(
    "../../../data/raw/FoodData_Central_foundation_food_json_2026-04-30.zip",
    import.meta.url,
  ),
);

it.runIf(existsSync(realFoundationArchive))(
  "smoke-validates the ignored official April 2026 FDC Foundation artifact",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "fdc-foundation-real-smoke-"));
    try {
      const [extracted] = await extractZipArchive({
        archivePath: realFoundationArchive,
        destinationDirectory: directory,
        expectedFiles: ["FoodData_Central_foundation_food_json_2026-04-30.json"],
      });
      if (!extracted) {
        throw new Error("Expected FDC archive member was not extracted");
      }
      const input: unknown = JSON.parse(await readFile(extracted.path, "utf8"));
      const result = adaptFdcJsonRelease(input, { releaseKey: "fdc-foundation-2026-04" });
      expect(result.records).toHaveLength(363);
      expect(result.quarantined).toHaveLength(32);
      expect(result.quarantined.every((item) => item.sourceRecordId === null)).toBe(true);
      expect(result.excludedNutrients).toHaveLength(10);
      expect(result.excludedPortions).toHaveLength(0);
      expect(result.records.reduce((total, food) => total + food.nutrients.length, 0)).toBe(15_183);
      expect(result.records.reduce((total, food) => total + food.servings.length, 0)).toBe(383);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
