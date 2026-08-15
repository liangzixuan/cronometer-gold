import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { discoverMigrations } from "../src/migrator.js";

describe("forward migration discovery", () => {
  it("loads migrations in lexical order and records a stable checksum", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "nutrition-db-migrations-"));
    await writeFile(resolve(directory, "0002_second.sql"), "select 2;\n", "utf8");
    await writeFile(resolve(directory, "0001_first.sql"), "select 1;\n", "utf8");
    await writeFile(resolve(directory, "notes.md"), "ignored", "utf8");

    const migrations = await discoverMigrations(directory);

    expect(migrations.map((migration) => migration.name)).toEqual([
      "0001_first.sql",
      "0002_second.sql",
    ]);
    expect(migrations[0]?.checksum).toBe(createHash("sha256").update("select 1;\n").digest("hex"));
  });

  it("rejects transaction control inside a migration", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "nutrition-db-migrations-"));
    await writeFile(resolve(directory, "0001_invalid.sql"), "BEGIN;\nselect 1;\nCOMMIT;\n", "utf8");

    await expect(discoverMigrations(directory)).rejects.toThrow("must not manage transactions");
  });

  it("keeps the initial schema forward-only and covers the required aggregates", async () => {
    const migrationPath = resolve(
      import.meta.dirname,
      "../migrations/0001_initial_domain_schema.sql",
    );
    const migrationSql = await readFile(migrationPath, "utf8");

    expect(migrationSql).not.toMatch(/\bdrop\s+(table|column|type)\b/i);
    expect(migrationSql).not.toMatch(/\btruncate\b/i);

    for (const table of [
      "app_user",
      "user_profile",
      "food_source",
      "food_source_release",
      "nutrient",
      "food",
      "food_version",
      "food_nutrient_value",
      "food_serving",
      "food_barcode",
      "recipe",
      "recipe_version",
      "recipe_ingredient",
      "diary",
      "diary_entry",
      "diary_entry_nutrient_snapshot",
      "nutrition_goal",
      "nutrition_goal_version",
      "nutrition_goal_target",
      "audit_log",
      "outbox_event",
    ]) {
      expect(migrationSql).toContain(`create table ${table}`);
    }
  });
});
