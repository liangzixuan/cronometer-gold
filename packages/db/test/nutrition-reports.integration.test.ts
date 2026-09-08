import { randomBytes, randomUUID } from "node:crypto";

import {
  CORE_NUTRIENTS,
  canonicalIanaTimeZone,
  NUTRITION_ENGINE_VERSION,
} from "@nutrition-tracker/domain";
import { sql, type Transaction } from "kysely";
import { describe, expect, it } from "vitest";

import {
  createDatabase,
  createNutritionGoal,
  type Database,
  getNutritionReportSnapshot,
  NutritionReportCapacityError,
  type NutritionReportDayRecord,
  REFERENCE_TARGET_ACKNOWLEDGEMENT_POLICY_CODE,
  REFERENCE_TARGET_ACKNOWLEDGEMENT_POLICY_VERSION,
  REFERENCE_TARGET_TEMPLATE_CODE,
  REFERENCE_TARGET_TEMPLATE_VERSION,
  registerPasswordAccount,
  reviseNutritionGoal,
  runMigrations,
  updateUserProfile,
} from "../src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("nutrition report snapshot persistence", () => {
  it("isolates owners, uses active-profile DST bounds, preserves missingness, and selects current goal versions", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const fixture = await createFixture(databaseUrl);
    try {
      const ownerDayEight = await createDiary(fixture.database, {
        localDate: "2026-03-08",
        revision: 2,
        timeZone: "UTC",
        userId: fixture.ownerUserId,
      });
      const ownerDayNine = await createDiary(fixture.database, {
        localDate: "2026-03-09",
        revision: 2,
        timeZone: "UTC",
        userId: fixture.ownerUserId,
      });
      const otherDay = await createDiary(fixture.database, {
        localDate: "2026-03-08",
        revision: 1,
        timeZone: "UTC",
        userId: fixture.otherUserId,
      });
      const ownerOriginalDay = await createDiary(fixture.database, {
        localDate: "2026-03-01",
        revision: 1,
        timeZone: "UTC",
        userId: fixture.ownerUserId,
      });

      // Chicago's 2026 spring-forward day is [06:00Z, 05:00Z): 23 hours.
      await insertFoodEntry(fixture.database, fixture, {
        diaryId: ownerDayEight,
        localDate: "2026-03-08",
        localTime: "05:59:59",
        nutrientCodes: ["energy"],
        occurredAt: "2026-03-08T05:59:59Z",
        position: 0,
        userId: fixture.ownerUserId,
      });
      await insertFoodEntry(fixture.database, fixture, {
        diaryId: ownerDayEight,
        localDate: "2026-03-08",
        localTime: "06:00:00",
        nutrientCodes: ["energy"],
        occurredAt: "2026-03-08T06:00:00Z",
        position: 1,
        userId: fixture.ownerUserId,
      });
      await insertFoodEntry(fixture.database, fixture, {
        diaryId: ownerDayNine,
        localDate: "2026-03-09",
        localTime: "04:59:59",
        nutrientCodes: ["energy", "protein"],
        occurredAt: "2026-03-09T04:59:59Z",
        position: 0,
        userId: fixture.ownerUserId,
      });
      await insertFoodEntry(fixture.database, fixture, {
        diaryId: ownerDayNine,
        localDate: "2026-03-09",
        localTime: "05:00:00",
        nutrientCodes: ["energy", "protein"],
        occurredAt: "2026-03-09T05:00:00Z",
        position: 1,
        userId: fixture.ownerUserId,
      });
      await insertFoodEntry(fixture.database, fixture, {
        diaryId: otherDay,
        localDate: "2026-03-08",
        localTime: "12:00:00",
        nutrientCodes: ["energy", "protein"],
        occurredAt: "2026-03-08T12:00:00Z",
        position: 0,
        userId: fixture.otherUserId,
      });
      const movedEntry = await insertFoodEntry(fixture.database, fixture, {
        diaryId: ownerOriginalDay,
        localDate: "2026-03-01",
        localTime: "12:00:00",
        nutrientCodes: ["energy"],
        occurredAt: "2026-03-01T12:00:00Z",
        position: 0,
        userId: fixture.ownerUserId,
      });
      await moveFoodEntryHeadForReport(fixture.database, {
        diaryId: ownerDayEight,
        entryId: movedEntry.entryId,
        localDate: "2026-03-08",
        localTime: "07:00:00",
        occurredAt: "2026-03-08T12:00:00Z",
        previousRevisionId: movedEntry.revisionId,
        timeZone: "America/Chicago",
        userId: fixture.ownerUserId,
      });

      const firstGoal = await createNutritionGoal(fixture.database, {
        clientOperationId: randomUUID(),
        effectiveFrom: "2026-03-08",
        energy: { mode: "fixed", rationale: "Initial report target", targetKcal: "2000" },
        requestDigest: randomBytes(32).toString("hex"),
        targets: [],
        userId: fixture.ownerUserId,
      });
      const revisedFirstGoal = await reviseNutritionGoal(fixture.database, {
        clientOperationId: randomUUID(),
        energy: { mode: "fixed", rationale: "Current report target", targetKcal: "2100" },
        expectedRevision: firstGoal.goal.currentRevision,
        goalId: firstGoal.goal.id,
        requestDigest: randomBytes(32).toString("hex"),
        targets: [],
        userId: fixture.ownerUserId,
      });
      const secondGoal = await createNutritionGoal(fixture.database, {
        clientOperationId: randomUUID(),
        effectiveFrom: "2026-03-09",
        energy: { mode: "fixed", rationale: "Next report target", targetKcal: "2300" },
        requestDigest: randomBytes(32).toString("hex"),
        targets: [],
        userId: fixture.ownerUserId,
      });
      const otherGoal = await createNutritionGoal(fixture.database, {
        clientOperationId: randomUUID(),
        effectiveFrom: "2026-03-08",
        energy: { mode: "fixed", rationale: "Other owner target", targetKcal: "1800" },
        requestDigest: randomBytes(32).toString("hex"),
        targets: [],
        userId: fixture.otherUserId,
      });

      const snapshot = await getNutritionReportSnapshot(fixture.database, {
        fromLocalDate: "2026-03-08",
        toLocalDate: "2026-03-09",
        userId: fixture.ownerUserId,
      });
      expect(snapshot).toMatchObject({
        fromLocalDate: "2026-03-08",
        ownerUserId: fixture.ownerUserId,
        profileRevision: "0",
        profileTimeZone: "America/Chicago",
        toLocalDate: "2026-03-09",
      });
      expect(snapshot.watermarkRevision).toMatch(/^(?:0|[1-9][0-9]*)$/u);
      expect(snapshot.definitions.map((definition) => definition.code)).toEqual(
        CORE_NUTRIENTS.map((definition) => definition.id),
      );
      expect(snapshot.days).toHaveLength(2);

      const springForward = snapshot.days[0];
      const followingDay = snapshot.days[1];
      expect(springForward).toMatchObject({
        endsAt: "2026-03-09T05:00:00.000Z",
        entryCount: 3,
        localDate: "2026-03-08",
        sourceTimeZones: ["America/Chicago", "UTC"],
        startsAt: "2026-03-08T06:00:00.000Z",
      });
      expect(springForward?.sourceDiaries.map((diary) => diary.localDate).sort()).toEqual([
        "2026-03-08",
        "2026-03-09",
      ]);
      expect(followingDay).toMatchObject({
        endsAt: "2026-03-10T05:00:00.000Z",
        entryCount: 1,
        localDate: "2026-03-09",
        sourceTimeZones: ["UTC"],
        startsAt: "2026-03-09T05:00:00.000Z",
      });

      expect(aggregate(springForward, "energy")).toMatchObject({
        completeness: "complete",
        contributorCount: 3,
        isExact: true,
        knownAmount: "0",
        quantifiedCount: 3,
        traceCount: 0,
        unknownCount: 0,
      });
      expect(aggregate(springForward, "protein")).toMatchObject({
        completeness: "partial",
        contributorCount: 3,
        isExact: false,
        knownAmount: "0",
        quantifiedCount: 1,
        traceCount: 0,
        unknownCount: 2,
        unknownReasons: { not_reported: 2 },
      });
      expect(aggregate(springForward, "fat")).toMatchObject({
        completeness: "unknown",
        contributorCount: 3,
        isExact: false,
        knownAmount: "0",
        quantifiedCount: 0,
        unknownCount: 3,
        unknownReasons: { not_reported: 3 },
      });
      expect(aggregate(followingDay, "protein")).toMatchObject({
        completeness: "complete",
        contributorCount: 1,
        isExact: true,
        knownAmount: "0",
        quantifiedCount: 1,
        unknownCount: 0,
      });

      expect(snapshot.goals.map((goal) => goal.id)).toEqual([
        firstGoal.goal.id,
        secondGoal.goal.id,
      ]);
      const firstSnapshotGoal = snapshot.goals[0];
      expect(firstSnapshotGoal).toMatchObject({
        currentRevision: "3",
        effectiveFrom: "2026-03-08",
        effectiveTo: "2026-03-09",
        id: firstGoal.goal.id,
        currentVersion: {
          effectiveFrom: "2026-03-08",
          effectiveTo: "2026-03-09",
          energy: { mode: "fixed", targetKcal: "2100" },
          versionNumber: "3",
        },
      });
      expect(firstSnapshotGoal?.currentVersion.id).not.toBe(
        revisedFirstGoal.goal.currentVersion.id,
      );
      expect(snapshot.goals.some((goal) => goal.id === otherGoal.goal.id)).toBe(false);

      const boundarySnapshot = await getNutritionReportSnapshot(fixture.database, {
        fromLocalDate: "2026-03-09",
        toLocalDate: "2026-03-09",
        userId: fixture.ownerUserId,
      });
      expect(boundarySnapshot.goals.map((goal) => goal.id)).toEqual([secondGoal.goal.id]);

      const isolatedOther = await getNutritionReportSnapshot(fixture.database, {
        fromLocalDate: "2026-03-08",
        toLocalDate: "2026-03-08",
        userId: fixture.otherUserId,
      });
      expect(isolatedOther).toMatchObject({
        ownerUserId: fixture.otherUserId,
        profileRevision: "0",
        profileTimeZone: "UTC",
        days: [
          {
            endsAt: "2026-03-09T00:00:00.000Z",
            entryCount: 1,
            startsAt: "2026-03-08T00:00:00.000Z",
          },
        ],
      });
      expect(isolatedOther.goals.map((goal) => goal.id)).toEqual([otherGoal.goal.id]);
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it("uses a bounded indexed current-head path and rejects the 2,001st head", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const fixture = await createFixture(databaseUrl);
    try {
      const diaryId = await createDiary(fixture.database, {
        localDate: "2026-09-07",
        revision: 1,
        timeZone: "UTC",
        userId: fixture.ownerUserId,
      });
      await insertFoodEntryHeads(fixture.database, fixture, {
        count: 2_001,
        diaryId,
        localDate: "2026-09-07",
        occurredAt: "2026-09-07T12:00:00Z",
        userId: fixture.ownerUserId,
      });

      const plan = await fixture.database.transaction().execute(async (transaction) => {
        await sql`set local enable_seqscan = off`.execute(transaction);
        return sql<{ "QUERY PLAN": unknown }>`
          explain (analyze, format json, costs off, timing off, summary off)
          select (revision.occurred_at at time zone 'America/Chicago')::date::text local_date,
                 entry.id::text entry_id,
                 revision.id::text revision_id
          from diary
          join lateral (
            select current_entry.id, current_entry.user_id, current_entry.diary_id,
                   current_entry.current_revision_id
            from diary_entry current_entry
            where current_entry.diary_id = diary.id
              and current_entry.deleted_at is null
            order by current_entry.meal_slot, current_entry.position,
                     current_entry.occurred_at, current_entry.id
            offset 0
          ) entry on true
          join lateral (
            select current_revision.id, current_revision.diary_entry_id,
                   current_revision.diary_id, current_revision.user_id,
                   current_revision.occurred_at, current_revision.operation
            from diary_entry_revision current_revision
            where current_revision.id = entry.current_revision_id
              and current_revision.diary_entry_id = entry.id
              and current_revision.diary_id = entry.diary_id
              and current_revision.user_id = entry.user_id
              and current_revision.occurred_at >=
                (date '2026-09-07'::timestamp at time zone 'America/Chicago')
              and current_revision.occurred_at <
                ((date '2026-09-07' + 1)::timestamp at time zone 'America/Chicago')
              and current_revision.operation <> 'delete'
            offset 0
          ) revision on true
          where diary.user_id = ${fixture.ownerUserId}
            and diary.local_date >= (date '2026-09-07' - 2)
            and diary.local_date <= (date '2026-09-07' + 2)
          limit 2001
        `.execute(transaction);
      });
      const serializedPlan = JSON.stringify(plan.rows);
      expect(serializedPlan).toContain('"Node Type":"Limit"');
      expect(serializedPlan).toContain('"Actual Rows":2001');
      expect(serializedPlan).toContain("diary_entry_day_order_idx");
      expect(serializedPlan).not.toContain('"Node Type":"Sort"');

      await expect(
        getNutritionReportSnapshot(fixture.database, {
          fromLocalDate: "2026-09-07",
          toLocalDate: "2026-09-07",
          userId: fixture.ownerUserId,
        }),
      ).rejects.toBeInstanceOf(NutritionReportCapacityError);
    } finally {
      await fixture.close();
    }
  }, 60_000);

  it("rejects a report day with more source time zones than the response contract permits", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const fixture = await createFixture(databaseUrl);
    try {
      const diaryId = await createDiary(fixture.database, {
        localDate: "2026-09-07",
        revision: 1,
        timeZone: "UTC",
        userId: fixture.ownerUserId,
      });
      const sourceTimeZones = await distinctCanonicalTimeZones(fixture.database, 51);
      expect(sourceTimeZones).toHaveLength(51);
      for (const [position, timeZone] of sourceTimeZones.entries()) {
        await insertFoodEntry(fixture.database, fixture, {
          diaryId,
          localDate: "2026-09-07",
          localTime: "12:00:00",
          nutrientCodes: [],
          occurredAt: "2026-09-07T12:00:00Z",
          position,
          timeZone,
          userId: fixture.ownerUserId,
        });
      }

      await expect(
        getNutritionReportSnapshot(fixture.database, {
          fromLocalDate: "2026-09-07",
          toLocalDate: "2026-09-07",
          userId: fixture.ownerUserId,
        }),
      ).rejects.toBeInstanceOf(NutritionReportCapacityError);
    } finally {
      await fixture.close();
    }
  }, 60_000);

  it("keeps an expiring reference goal in the snapshot for mapper-side exclusive expiry", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const fixture = await createFixture(databaseUrl);
    try {
      const dates = (
        await sql<{ birth_date: string; today: string; yesterday: string }>`
          with local_day as (
            select (transaction_timestamp() at time zone 'America/Chicago')::date as day
          )
          select to_char(day - interval '51 years', 'YYYY-MM-DD') as birth_date,
                 day::text today,
                 (day - 1)::text yesterday
          from local_day
        `.execute(fixture.database)
      ).rows[0];
      if (!dates) throw new Error("Expected server-local reference dates");
      const profile = await updateUserProfile(fixture.database, {
        expectedRevision: "0",
        patch: { birthDate: dates.birth_date, sexAtBirth: "male" },
        userId: fixture.ownerUserId,
      });
      const created = await createNutritionGoal(fixture.database, {
        clientOperationId: randomUUID(),
        effectiveFrom: dates.yesterday,
        energy: { mode: "fixed", rationale: "Expiring report target", targetKcal: "2000" },
        referenceTargetSet: {
          expectedProfileRevision: profile.revision,
          selection: {
            eligibilityAcknowledgement: {
              accepted: true,
              policyCode: REFERENCE_TARGET_ACKNOWLEDGEMENT_POLICY_CODE,
              policyVersion: REFERENCE_TARGET_ACKNOWLEDGEMENT_POLICY_VERSION,
            },
            groupCode: "male-19-50",
            templateCode: REFERENCE_TARGET_TEMPLATE_CODE,
            templateVersion: REFERENCE_TARGET_TEMPLATE_VERSION,
          },
        },
        requestDigest: randomBytes(32).toString("hex"),
        targets: [],
        userId: fixture.ownerUserId,
      });

      const snapshot = await getNutritionReportSnapshot(fixture.database, {
        fromLocalDate: dates.yesterday,
        toLocalDate: dates.today,
        userId: fixture.ownerUserId,
      });
      expect(snapshot.goals).toHaveLength(1);
      expect(snapshot.goals[0]).toMatchObject({
        id: created.goal.id,
        currentVersion: {
          referenceTargetSet: { eligibleThroughExclusive: dates.today },
        },
      });
      expect(snapshot.days.map((day) => day.localDate)).toEqual([dates.yesterday, dates.today]);
    } finally {
      await fixture.close();
    }
  }, 30_000);
});

function aggregate(day: NutritionReportDayRecord | undefined, code: string) {
  const value = day?.aggregates.find((candidate) => candidate.code === code);
  if (!value) throw new Error(`Missing ${code} report aggregate`);
  return value;
}

async function createFixture(connectionString: string) {
  const bootstrap = createDatabase({ connectionString, maxConnections: 1 });
  const schemaName = `nutrition_report_${randomBytes(6).toString("hex")}`;
  await sql`create schema ${sql.id(schemaName)}`.execute(bootstrap);
  const scopedUrl = new URL(connectionString);
  scopedUrl.searchParams.set("options", `-csearch_path=${schemaName},public`);
  const database = createDatabase({ connectionString: scopedUrl.toString(), maxConnections: 4 });
  try {
    await runMigrations(database);
    const nutrients = await seedCoreNutrients(database);
    const owner = await registerPasswordAccount(
      database,
      accountInput("report-owner", "America/Chicago"),
    );
    const other = await registerPasswordAccount(database, accountInput("report-other", "UTC"));
    return {
      close: async () => {
        await database.destroy();
        await sql`drop schema ${sql.id(schemaName)} cascade`.execute(bootstrap);
        await bootstrap.destroy();
      },
      database,
      nutrients,
      otherFoodVersionId: await createCustomFoodVersion(database, other.userId, "Other food"),
      otherUserId: other.userId,
      ownerFoodVersionId: await createCustomFoodVersion(database, owner.userId, "Owner food"),
      ownerUserId: owner.userId,
    };
  } catch (error) {
    await database.destroy();
    await sql`drop schema ${sql.id(schemaName)} cascade`.execute(bootstrap);
    await bootstrap.destroy();
    throw error;
  }
}

function accountInput(label: string, timeZone: string) {
  return {
    email: `${label}-${randomUUID()}@example.invalid`,
    passwordHash: `$argon2id$${label}-hash`,
    passwordParameters: { algorithm: "argon2id" },
    passwordSalt: `${label}-salt-value`,
    timeZone,
  };
}

async function seedCoreNutrients(database: ReturnType<typeof createDatabase>) {
  const rows = await database
    .insertInto("nutrient")
    .values(
      CORE_NUTRIENTS.map((definition, displayOrder) => ({
        canonical_unit: definition.canonicalUnit,
        code: definition.id,
        dimension: definition.category === "energy" ? ("energy" as const) : ("mass" as const),
        display_order: displayOrder,
        is_core: true,
        is_targetable: true,
        name: definition.name,
      })),
    )
    .returning(["canonical_unit", "code", "id", "name"])
    .execute();
  return new Map(rows.map((row) => [row.code, row]));
}

async function createCustomFoodVersion(
  database: ReturnType<typeof createDatabase>,
  ownerUserId: string,
  name: string,
): Promise<string> {
  const food = await database
    .insertInto("food")
    .values({
      food_source_id: null,
      kind: "custom",
      owner_user_id: ownerUserId,
      source_food_key: null,
      visibility: "private",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const version = await database
    .insertInto("food_version")
    .values({
      basis_quantity: "100",
      basis_unit: "g",
      data_quality: "provisional",
      food_id: food.id,
      language_tag: "en-US",
      market_code: "US",
      name,
      normalized_name: name.toLowerCase(),
      source_release_id: null,
      version_number: 1,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await database
    .updateTable("food")
    .set({ current_version_id: version.id })
    .where("id", "=", food.id)
    .executeTakeFirstOrThrow();
  return version.id;
}

async function createDiary(
  database: ReturnType<typeof createDatabase>,
  input: {
    readonly localDate: string;
    readonly revision: number;
    readonly timeZone: string;
    readonly userId: string;
  },
): Promise<string> {
  return (
    await database
      .insertInto("diary")
      .values({
        local_date: input.localDate,
        note: null,
        revision: input.revision,
        status: "open",
        time_zone: input.timeZone,
        user_id: input.userId,
      })
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id;
}

async function distinctCanonicalTimeZones(
  database: ReturnType<typeof createDatabase>,
  count: number,
): Promise<readonly string[]> {
  const candidates = await sql<{ name: string }>`
    select name
    from pg_catalog.pg_timezone_names
    where name like '%/%'
    order by name collate "C"
  `.execute(database);
  const values = new Set<string>();
  for (const row of candidates.rows) {
    try {
      values.add(canonicalIanaTimeZone(row.name));
    } catch {
      // PostgreSQL also exposes aliases that the JavaScript runtime does not recognize.
    }
    if (values.size === count) break;
  }
  return [...values];
}

async function moveFoodEntryHeadForReport(
  database: ReturnType<typeof createDatabase>,
  input: {
    readonly diaryId: string;
    readonly entryId: string;
    readonly localDate: string;
    readonly localTime: string;
    readonly occurredAt: string;
    readonly previousRevisionId: string;
    readonly timeZone: string;
    readonly userId: string;
  },
): Promise<void> {
  const revisionId = randomUUID();
  await database.transaction().execute(async (transaction) => {
    await sql`set constraints all deferred`.execute(transaction);
    await sql`
      insert into diary_entry_revision (
        id, diary_entry_id, user_id, diary_id, revision_number, operation,
        entry_kind, food_version_id, recipe_version_id, food_serving_id,
        meal_slot, position, note, occurred_at, local_date, local_time, time_zone,
        quantity, input_unit, resolved_quantity, resolved_unit,
        food_name, brand_name, serving_label,
        source_code, source_display_name, source_release_id,
        attribution_text, attribution_required, license_expression,
        snapshot_status, snapshot_engine_version, nutrient_component_count,
        custom_food_id, custom_food_version_number, repeated_from_revision_id
      )
      select ${revisionId}::uuid, diary_entry_id, user_id, ${input.diaryId}::uuid, 2, 'move',
             entry_kind, food_version_id, recipe_version_id, food_serving_id,
             meal_slot, position, note, ${input.occurredAt}::timestamptz,
             ${input.localDate}::date, ${input.localTime}::time, ${input.timeZone},
             quantity, input_unit, resolved_quantity, resolved_unit,
             food_name, brand_name, serving_label,
             source_code, source_display_name, source_release_id,
             attribution_text, attribution_required, license_expression,
             snapshot_status, snapshot_engine_version, nutrient_component_count,
             custom_food_id, custom_food_version_number, repeated_from_revision_id
      from diary_entry_revision
      where id = ${input.previousRevisionId}::uuid
        and diary_entry_id = ${input.entryId}::uuid
        and user_id = ${input.userId}::uuid
    `.execute(transaction);
    await sql`
      insert into diary_entry_revision_nutrient (
        diary_entry_revision_id, nutrient_id, nutrient_code, nutrient_name, unit,
        known_amount, completeness, is_exact, contributor_count, quantified_count,
        trace_count, unknown_count, unknown_reasons
      )
      select ${revisionId}::uuid, nutrient_id, nutrient_code, nutrient_name, unit,
             known_amount, completeness, is_exact, contributor_count, quantified_count,
             trace_count, unknown_count, unknown_reasons
      from diary_entry_revision_nutrient
      where diary_entry_revision_id = ${input.previousRevisionId}::uuid
    `.execute(transaction);
    await transaction
      .updateTable("diary_entry")
      .set({
        current_revision_id: revisionId,
        current_revision_number: 2,
        diary_id: input.diaryId,
      })
      .where("id", "=", input.entryId)
      .where("user_id", "=", input.userId)
      .executeTakeFirstOrThrow();
  });
}

async function insertFoodEntryHeads(
  database: ReturnType<typeof createDatabase>,
  fixture: {
    readonly ownerFoodVersionId: string;
    readonly ownerUserId: string;
  },
  input: {
    readonly count: number;
    readonly diaryId: string;
    readonly localDate: string;
    readonly occurredAt: string;
    readonly userId: string;
  },
): Promise<void> {
  if (input.userId !== fixture.ownerUserId)
    throw new Error("Unsupported report-head fixture owner");
  await database.transaction().execute(async (transaction) => {
    await sql`set constraints all deferred`.execute(transaction);
    await sql`
      with generated as materialized (
        select gen_random_uuid() entry_id,
               gen_random_uuid() revision_id,
               ordinal::integer position
        from generate_series(0, ${input.count - 1}) ordinal
      ), inserted_entries as (
        insert into diary_entry (
          id, user_id, client_operation_id, diary_id,
          current_revision_id, current_revision_number,
          entry_kind, food_version_id, recipe_version_id, food_serving_id,
          meal_slot, quantity, input_unit, resolved_grams,
          occurred_at, local_time, position, note,
          snapshot_status, snapshot_engine_version,
          custom_food_id, custom_food_version_number, repeated_from_revision_id
        )
        select entry_id, ${input.userId}::uuid, gen_random_uuid(), ${input.diaryId}::uuid,
               revision_id, 1,
               'food', ${fixture.ownerFoodVersionId}::bigint, null, null,
               'snacks', 1, 'g', 1,
               ${input.occurredAt}::timestamptz, time '12:00:00', position, null,
               'partial', ${NUTRITION_ENGINE_VERSION},
               null, null, null
        from generated
        returning id
      )
      insert into diary_entry_revision (
        id, diary_entry_id, user_id, diary_id, revision_number, operation,
        entry_kind, food_version_id, recipe_version_id, food_serving_id,
        meal_slot, position, note, occurred_at, local_date, local_time, time_zone,
        quantity, input_unit, resolved_quantity, resolved_unit,
        food_name, brand_name, serving_label,
        source_code, source_display_name, source_release_id,
        attribution_text, attribution_required, license_expression,
        snapshot_status, snapshot_engine_version, nutrient_component_count
      )
      select generated.revision_id, generated.entry_id, ${input.userId}::uuid,
             ${input.diaryId}::uuid, 1, 'create',
             'food', ${fixture.ownerFoodVersionId}::bigint, null, null,
             'snacks', generated.position, null, ${input.occurredAt}::timestamptz,
             ${input.localDate}::date, time '12:00:00', 'UTC',
             1, 'g', 1, 'g',
             'Report load fixture food', null, null,
             null, null, null,
             null, null, null,
             'partial', ${NUTRITION_ENGINE_VERSION}, 0
      from generated
      join inserted_entries on inserted_entries.id = generated.entry_id
    `.execute(transaction);
  });
}

async function insertFoodEntry(
  database: ReturnType<typeof createDatabase>,
  fixture: {
    readonly nutrients: ReadonlyMap<
      string,
      {
        readonly canonical_unit: string;
        readonly code: string;
        readonly id: string;
        readonly name: string;
      }
    >;
    readonly otherFoodVersionId: string;
    readonly otherUserId: string;
    readonly ownerFoodVersionId: string;
    readonly ownerUserId: string;
  },
  input: {
    readonly diaryId: string;
    readonly localDate: string;
    readonly localTime: string;
    readonly nutrientCodes: readonly string[];
    readonly occurredAt: string;
    readonly position: number;
    readonly timeZone?: string;
    readonly userId: string;
  },
): Promise<{ readonly entryId: string; readonly revisionId: string }> {
  const definitions = input.nutrientCodes.map((code) => {
    const definition = fixture.nutrients.get(code);
    if (!definition) throw new Error(`Missing ${code} fixture nutrient`);
    return definition;
  });
  const entryId = randomUUID();
  const revisionId = randomUUID();
  const foodVersionId =
    input.userId === fixture.ownerUserId ? fixture.ownerFoodVersionId : fixture.otherFoodVersionId;
  await database.transaction().execute(async (transaction: Transaction<Database>) => {
    await sql`set constraints all deferred`.execute(transaction);
    await transaction
      .insertInto("diary_entry")
      .values({
        client_operation_id: randomUUID(),
        current_revision_id: revisionId,
        current_revision_number: 1,
        custom_food_id: null,
        custom_food_version_number: null,
        diary_id: input.diaryId,
        entry_kind: "food",
        food_serving_id: null,
        food_version_id: foodVersionId,
        id: entryId,
        input_unit: "g",
        local_time: input.localTime,
        meal_slot: "snacks",
        note: null,
        occurred_at: input.occurredAt,
        position: input.position,
        quantity: "1",
        recipe_version_id: null,
        repeated_from_revision_id: null,
        resolved_grams: "1",
        snapshot_engine_version: NUTRITION_ENGINE_VERSION,
        snapshot_status: "partial",
        user_id: input.userId,
      })
      .execute();
    await transaction
      .insertInto("diary_entry_revision")
      .values({
        attribution_required: null,
        attribution_text: null,
        brand_name: null,
        diary_entry_id: entryId,
        diary_id: input.diaryId,
        entry_kind: "food",
        food_name: "Report fixture food",
        food_serving_id: null,
        food_version_id: foodVersionId,
        id: revisionId,
        input_unit: "g",
        license_expression: null,
        local_date: input.localDate,
        local_time: input.localTime,
        meal_slot: "snacks",
        note: null,
        nutrient_component_count: definitions.length,
        occurred_at: input.occurredAt,
        operation: "create",
        position: input.position,
        quantity: "1",
        recipe_version_id: null,
        resolved_quantity: "1",
        resolved_unit: "g",
        revision_number: 1,
        serving_label: null,
        snapshot_engine_version: NUTRITION_ENGINE_VERSION,
        snapshot_status: "partial",
        source_code: null,
        source_display_name: null,
        source_release_id: null,
        time_zone: input.timeZone ?? "UTC",
        user_id: input.userId,
      })
      .execute();
    if (definitions.length > 0) {
      await transaction
        .insertInto("diary_entry_revision_nutrient")
        .values(
          definitions.map((definition) => ({
            completeness: "complete" as const,
            contributor_count: 1,
            diary_entry_revision_id: revisionId,
            is_exact: true,
            known_amount: "0",
            nutrient_code: definition.code,
            nutrient_id: definition.id,
            nutrient_name: definition.name,
            quantified_count: 1,
            trace_count: 0,
            unit: definition.canonical_unit,
            unknown_count: 0,
            unknown_reasons: {},
          })),
        )
        .execute();
    }
  });
  return { entryId, revisionId };
}
