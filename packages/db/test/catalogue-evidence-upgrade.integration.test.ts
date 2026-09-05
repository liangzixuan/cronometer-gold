import { randomBytes } from "node:crypto";

import { sql } from "kysely";
import { describe, expect, it } from "vitest";

import { createDatabase, discoverMigrations } from "../src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("0011 catalogue evidence upgrade", { timeout: 30_000 }, () => {
  it("preserves legacy authority state without fabricating reusable evidence", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const bootstrap = createDatabase({ connectionString: databaseUrl, maxConnections: 1 });
    const schemaName = `catalogue_evidence_upgrade_${randomBytes(6).toString("hex")}`;
    await sql`create schema ${sql.id(schemaName)}`.execute(bootstrap);
    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName},public`);
    const database = createDatabase({ connectionString: scopedUrl.toString(), maxConnections: 2 });

    try {
      const migrations = await discoverMigrations();
      const evidenceMigrationIndex = migrations.findIndex(
        (migration) => migration.name === "0011_food_import_evidence_binding.sql",
      );
      const grandfatherMigrationIndex = migrations.findIndex(
        (migration) => migration.name === "0012_food_source_release_legacy_grandfather.sql",
      );
      const hardeningMigrationIndex = migrations.findIndex(
        (migration) => migration.name === "0013_food_release_authority_hardening.sql",
      );
      expect(evidenceMigrationIndex).toBeGreaterThan(0);
      expect(grandfatherMigrationIndex).toBe(evidenceMigrationIndex + 1);
      expect(hardeningMigrationIndex).toBe(grandfatherMigrationIndex + 1);
      expect(migrations[evidenceMigrationIndex - 1]?.name).toBe("0010_hydration_ledger.sql");
      for (const migration of migrations.slice(0, evidenceMigrationIndex)) {
        await sql.raw(migration.sql).execute(database);
      }

      const suffix = randomBytes(4).toString("hex").toUpperCase();
      const source = await database
        .insertInto("food_source")
        .values({
          access_url: null,
          active: true,
          attribution_required: true,
          attribution_text: "0010 catalogue evidence upgrade fixture",
          code: `EU${suffix}`,
          commercial_use_allowed: true,
          database_rights_notes: "Historical pre-evidence fixture",
          display_name: `Evidence upgrade source ${suffix}`,
          homepage_url: "https://example.invalid/evidence-upgrade",
          kind: "government",
          license_expression: "CC0-1.0",
          license_url: "https://creativecommons.org/publicdomain/zero/1.0/",
          redistribution_allowed: true,
          rights_review_status: "approved",
          rights_reviewed_at: "2026-08-15T12:00:00Z",
          rights_reviewed_by: "principal:evidence-upgrade",
          terms_url: null,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const release = await database
        .insertInto("food_source_release")
        .values({
          acquired_at: "2026-08-15T12:00:00Z",
          artifact_bytes: 1,
          artifact_sha256: "a".repeat(64),
          artifact_uri: "s3://legacy-catalogue/release.json",
          food_source_id: source.id,
          media_type: "application/json",
          parser_version: "legacy-parser@1",
          promoted_at: "2026-08-15T13:00:00Z",
          published_on: "2026-08-15",
          record_counts: { records: 0 },
          release_key: "legacy-promoted-release",
          rights_manifest_sha256: "b".repeat(64),
          rights_manifest_uri: "repo://legacy-catalogue-rights.json",
          status: "promoted",
          upstream_schema_version: "legacy-v1",
          validation_summary: { legacy: true },
        } as never)
        .returning("id")
        .executeTakeFirstOrThrow();
      const completedBatch = await database
        .insertInto("food_import_batch")
        .values({
          acquired_at: "2026-08-15T12:00:00Z",
          artifact_bytes: 1,
          artifact_sha256: "a".repeat(64),
          artifact_uri: "s3://legacy-catalogue/release.json",
          completed_at: "2026-08-15T13:00:00Z",
          food_source_id: source.id,
          materialized_count: 0,
          media_type: "application/json",
          parser_version: "legacy-parser@1",
          published_on: "2026-08-15",
          release_id: release.id,
          release_key: "legacy-promoted-release",
          rights_manifest_sha256: "b".repeat(64),
          rights_manifest_uri: "repo://legacy-catalogue-rights.json",
          staged_count: 0,
          status: "completed",
          upstream_schema_version: "legacy-v1",
          valid_count: 0,
          validated_at: "2026-08-15T12:30:00Z",
        } as never)
        .returning("id")
        .executeTakeFirstOrThrow();
      const readyBatch = await database
        .insertInto("food_import_batch")
        .values({
          acquired_at: "2026-08-16T12:00:00Z",
          artifact_bytes: 1,
          artifact_sha256: "c".repeat(64),
          artifact_uri: "s3://legacy-catalogue/ready.json",
          food_source_id: source.id,
          media_type: "application/json",
          parser_version: "legacy-parser@1",
          published_on: "2026-08-16",
          release_key: "legacy-ready-release",
          rights_manifest_sha256: "b".repeat(64),
          rights_manifest_uri: "repo://legacy-catalogue-rights.json",
          staged_count: 0,
          status: "ready",
          upstream_schema_version: "legacy-v1",
          valid_count: 0,
          validated_at: "2026-08-16T12:30:00Z",
        } as never)
        .returning("id")
        .executeTakeFirstOrThrow();
      await database
        .updateTable("food_source")
        .set({ active_release_id: release.id })
        .where("id", "=", source.id)
        .execute();

      const evidenceMigration = migrations[evidenceMigrationIndex];
      if (!evidenceMigration) throw new Error("0011 evidence migration was not discovered");
      const grandfatherMigration = migrations[grandfatherMigrationIndex];
      if (!grandfatherMigration) throw new Error("0012 grandfather migration was not discovered");
      const hardeningMigration = migrations[hardeningMigrationIndex];
      if (!hardeningMigration) throw new Error("0013 hardening migration was not discovered");
      await database.transaction().execute(async (transaction) => {
        await sql.raw(evidenceMigration.sql).execute(transaction);
        await sql.raw(grandfatherMigration.sql).execute(transaction);
        await sql.raw(hardeningMigration.sql).execute(transaction);
      });

      const bindingProjection = [
        "evidence_bundle_sha256",
        "evidence_bundle_uri",
        "evidence_decision_sha256",
        "evidence_object_version_id",
        "evidence_valid_until",
        "release_class",
      ] as const;
      const expectedLegacyBinding = {
        evidence_bundle_sha256: null,
        evidence_bundle_uri: null,
        evidence_decision_sha256: null,
        evidence_object_version_id: null,
        evidence_valid_until: null,
        release_class: "legacy-unbound",
      };
      expect(
        await database
          .selectFrom("food_import_batch")
          .select(bindingProjection)
          .where("id", "=", completedBatch.id)
          .executeTakeFirstOrThrow(),
      ).toEqual(expectedLegacyBinding);
      expect(
        await database
          .selectFrom("food_source_release")
          .select([...bindingProjection, "legacy_promotion_grandfathered_at"])
          .where("id", "=", release.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({
        ...expectedLegacyBinding,
        legacy_promotion_grandfathered_at: expect.any(Date),
      });
      expect(
        await database
          .selectFrom("food_source")
          .select("active_release_id")
          .where("id", "=", source.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ active_release_id: release.id });
      expect(
        (
          await sql<{ count: string }>`
            select count(*)::text as count
            from pg_constraint
            where connamespace = ${schemaName}::regnamespace
              and not convalidated
          `.execute(database)
        ).rows[0],
      ).toEqual({ count: "0" });
      const uriDigest = "e".repeat(64);
      expect(
        (
          await sql<{ valid: boolean }>`
            select catalogue_evidence_bundle_uri_is_valid(
              ${`s3://catalogue-evidence/sha256/${uriDigest}/bundle.json`},
              ${uriDigest}
            ) as valid
          `.execute(database)
        ).rows[0],
      ).toEqual({ valid: true });
      for (const value of [
        `s3://catalogue-evidence//sha256/${uriDigest}/bundle.json`,
        `s3://catalogue-evidence/sha256/${uriDigest}//bundle.json`,
        `s3://catalogue-evidence/sha256/${uriDigest}/nested/../bundle.json`,
        `s3://catalogue-evidence/%zz/sha256/${uriDigest}/bundle.json`,
      ]) {
        expect(
          (
            await sql<{ valid: boolean }>`
              select catalogue_evidence_bundle_uri_is_valid(${value}, ${uriDigest}) as valid
            `.execute(database)
          ).rows[0],
        ).toEqual({ valid: false });
      }

      await expect(
        database
          .insertInto("food_import_approval")
          .values({
            approval_reference: "review://legacy-upgrade",
            approval_role: "data",
            batch_id: completedBatch.id,
            principal_id: "principal:legacy-upgrade",
            rights_manifest_sha256: "b".repeat(64),
            validation_digest: "d".repeat(64),
          })
          .execute(),
      ).rejects.toThrow("approval requires current live-reviewed evidence");
      await expect(
        database
          .updateTable("food_import_batch")
          .set({ status: "promoting" })
          .where("id", "=", readyBatch.id)
          .execute(),
      ).rejects.toThrow("only current live-reviewed evidence may enter batch status promoting");
      await expect(
        database
          .updateTable("food_import_batch")
          .set({
            evidence_bundle_sha256: "e".repeat(64),
            evidence_bundle_uri: `s3://catalogue-evidence/sha256/${"e".repeat(64)}/bundle.json`,
            evidence_decision_sha256: "f".repeat(64),
            evidence_object_version_id: "fabricated-legacy-upgrade",
            evidence_valid_until: new Date(Date.now() + 12 * 60 * 60 * 1_000),
            release_class: "live-reviewed",
          })
          .where("id", "=", completedBatch.id)
          .execute(),
      ).rejects.toThrow("food import batch provenance cannot be rewritten");
      await expect(
        sql`
          update food_source_release
          set legacy_promotion_grandfathered_at = clock_timestamp()
          where id = ${release.id}
        `.execute(database),
      ).rejects.toThrow("grandfather marker is migration-owned and immutable");

      await database
        .updateTable("food_source")
        .set({ active_release_id: null })
        .where("id", "=", source.id)
        .execute();
      await expect(
        database
          .updateTable("food_source")
          .set({ active_release_id: release.id })
          .where("id", "=", source.id)
          .execute(),
      ).rejects.toThrow("only a promoted live-reviewed catalogue release may become active");
    } finally {
      await database.destroy();
      await sql`drop schema ${sql.id(schemaName)} cascade`.execute(bootstrap);
      await bootstrap.destroy();
    }
  });
});
