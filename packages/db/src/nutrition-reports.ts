import {
  assertNutritionReportRange,
  CORE_NUTRIENTS,
  canonicalIanaTimeZone,
  canonicalLocalDate,
  canonicalNonNegativeDecimal,
  type NutrientCompleteness,
  type UnknownNutrientReason,
} from "@nutrition-tracker/domain";
import { type Kysely, sql } from "kysely";

import {
  type GoalNutrientDefinitionRecord,
  type NutritionGoalRecord,
  readNutritionGoalsForRangeSnapshot,
} from "./goals.js";
import type { Database } from "./types.js";

export class NutritionReportValidationError extends Error {
  override readonly name = "NutritionReportValidationError";
}

export class NutritionReportNotFoundError extends Error {
  override readonly name = "NutritionReportNotFoundError";
}

export class NutritionReportPersistedIntegrityError extends Error {
  override readonly name = "NutritionReportPersistedIntegrityError";
}

export class NutritionReportCapacityError extends Error {
  override readonly name = "NutritionReportCapacityError";
}

const MAX_NUTRITION_REPORT_ENTRY_HEADS = 2_000;
const MAX_NUTRITION_REPORT_SOURCE_TIME_ZONES_PER_DAY = 50;

export interface NutritionReportAggregateRecord {
  readonly nutrientId: string;
  readonly code: string;
  readonly name: string;
  readonly unit: string;
  readonly knownAmount: string;
  readonly completeness: NutrientCompleteness;
  readonly isExact: boolean;
  readonly contributorCount: number;
  readonly quantifiedCount: number;
  readonly traceCount: number;
  readonly unknownCount: number;
  readonly unknownReasons: Readonly<Record<UnknownNutrientReason, number>>;
}

export interface NutritionReportDayRecord {
  readonly localDate: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly entryCount: number;
  readonly sourceDiaries: readonly {
    readonly id: string;
    readonly localDate: string;
    readonly revision: string;
  }[];
  readonly sourceTimeZones: readonly string[];
  /** Empty only when entryCount is zero; otherwise contains every core nutrient. */
  readonly aggregates: readonly NutritionReportAggregateRecord[];
}

export interface NutritionReportSnapshotRecord {
  readonly ownerUserId: string;
  readonly profileRevision: string;
  readonly profileTimeZone: string;
  readonly watermarkRevision: string;
  readonly snapshotAt: string;
  readonly fromLocalDate: string;
  readonly toLocalDate: string;
  readonly definitions: readonly GoalNutrientDefinitionRecord[];
  readonly days: readonly NutritionReportDayRecord[];
  readonly goals: readonly NutritionGoalRecord[];
}

interface MutableDay {
  readonly localDate: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly entryIds: Set<string>;
  readonly sourceDiaries: Map<string, { id: string; localDate: string; revision: string }>;
  readonly sourceTimeZones: Set<string>;
  readonly aggregates: NutritionReportAggregateRecord[];
}

interface AggregateSqlRow {
  readonly local_date: string;
  readonly nutrient_id: string;
  readonly known_amount: string;
  readonly contributor_count: string;
  readonly quantified_count: string;
  readonly trace_count: string;
  readonly unknown_count: string;
  readonly not_reported_count: string;
  readonly not_analyzed_count: string;
  readonly not_applicable_count: string;
  readonly withheld_count: string;
  readonly unit_mismatch_count: string;
}

export async function getNutritionReportSnapshot(
  database: Kysely<Database>,
  input: {
    readonly userId: string;
    readonly fromLocalDate: string;
    readonly toLocalDate: string;
  },
): Promise<NutritionReportSnapshotRecord> {
  try {
    assertNutritionReportRange(input.fromLocalDate, input.toLocalDate);
  } catch {
    throw new NutritionReportValidationError("Nutrition report range is invalid");
  }
  return database
    .transaction()
    .setIsolationLevel("repeatable read")
    .setAccessMode("read only")
    .execute(async (transaction) => {
      const profile = await transaction
        .selectFrom("app_user as user")
        .innerJoin("user_profile as profile", "profile.user_id", "user.id")
        .innerJoin("user_data_watermark as watermark", "watermark.user_id", "user.id")
        .select([
          "profile.revision",
          "profile.time_zone",
          "watermark.revision as watermark_revision",
          sql<Date>`transaction_timestamp()`.as("snapshot_at"),
        ])
        .where("user.id", "=", input.userId)
        .where("user.status", "=", "active")
        .where("user.deleted_at", "is", null)
        .executeTakeFirst();
      if (!profile) throw new NutritionReportNotFoundError();
      const profileTimeZone = canonicalIanaTimeZone(profile.time_zone);
      const profileRevision = nonNegativeRevision(profile.revision, "profile revision");
      const watermarkRevision = nonNegativeRevision(
        profile.watermark_revision,
        "data watermark revision",
      );

      const coreByCode = new Map(CORE_NUTRIENTS.map((definition) => [definition.id, definition]));
      const definitionRows = await transaction
        .selectFrom("nutrient")
        .select(["id", "code", "name", "canonical_unit", "dimension"])
        .where(
          "code",
          "in",
          CORE_NUTRIENTS.map((definition) => definition.id),
        )
        .where("active", "=", true)
        .execute();
      if (definitionRows.length !== CORE_NUTRIENTS.length) {
        throw new NutritionReportPersistedIntegrityError("Core nutrient registry is incomplete");
      }
      const rowsByCode = new Map(definitionRows.map((row) => [row.code, row]));
      const definitions = CORE_NUTRIENTS.map((expected) => {
        const row = rowsByCode.get(expected.id);
        if (
          !row ||
          !/^[1-9][0-9]*$/u.test(row.id) ||
          row.canonical_unit !== expected.canonicalUnit ||
          (expected.category === "energy"
            ? row.dimension !== "energy"
            : row.dimension === "energy") ||
          !coreByCode.has(row.code)
        ) {
          throw new NutritionReportPersistedIntegrityError(
            "Core nutrient registry is ambiguous or incompatible",
          );
        }
        return {
          category: expected.category,
          code: row.code,
          id: row.id,
          name: row.name,
          unit: row.canonical_unit,
        } satisfies GoalNutrientDefinitionRecord;
      });
      if (new Set(definitions.map((definition) => definition.id)).size !== definitions.length) {
        throw new NutritionReportPersistedIntegrityError(
          "Core nutrient identifiers are not unique",
        );
      }

      const dayRows = await sql<{
        local_date: string;
        starts_at: Date;
        ends_at: Date;
      }>`
        select day::date::text local_date,
               day::timestamp at time zone ${profileTimeZone} starts_at,
               (day::date + 1)::timestamp at time zone ${profileTimeZone} ends_at
        from generate_series(
          ${input.fromLocalDate}::date,
          ${input.toLocalDate}::date,
          interval '1 day'
        ) day
        order by day
      `.execute(transaction);
      const mutableDays = new Map<string, MutableDay>();
      for (const row of dayRows.rows) {
        const localDate = canonicalLocalDate(row.local_date);
        mutableDays.set(localDate, {
          aggregates: [],
          endsAt: row.ends_at.toISOString(),
          entryIds: new Set(),
          localDate,
          sourceDiaries: new Map(),
          sourceTimeZones: new Set(),
          startsAt: row.starts_at.toISOString(),
        });
      }

      const headRows = await sql<{
        local_date: string;
        entry_id: string;
        revision_id: string;
        diary_id: string;
        diary_local_date: string;
        diary_revision: string;
        entry_time_zone: string;
      }>`
        select (revision.occurred_at at time zone ${profileTimeZone})::date::text local_date,
               entry.id::text entry_id,
               revision.id::text revision_id,
               diary.id::text diary_id,
               diary.local_date::text diary_local_date,
               diary.revision::text diary_revision,
               revision.time_zone entry_time_zone
        from diary
        join lateral (
          select current_entry.id,
                 current_entry.user_id,
                 current_entry.diary_id,
                 current_entry.current_revision_id
          from diary_entry current_entry
          where current_entry.diary_id = diary.id
            and current_entry.deleted_at is null
          order by current_entry.meal_slot,
                   current_entry.position,
                   current_entry.occurred_at,
                   current_entry.id
          -- Preserve the diary-first, current-head-only access path.
          offset 0
        ) entry on true
        join lateral (
          select current_revision.id,
                 current_revision.diary_entry_id,
                 current_revision.diary_id,
                 current_revision.user_id,
                 current_revision.occurred_at,
                 current_revision.operation,
                 current_revision.time_zone
          from diary_entry_revision current_revision
          where current_revision.id = entry.current_revision_id
            and current_revision.diary_entry_id = entry.id
            and current_revision.diary_id = entry.diary_id
            and current_revision.user_id = entry.user_id
            and current_revision.occurred_at >=
              (${input.fromLocalDate}::date::timestamp at time zone ${profileTimeZone})
            and current_revision.occurred_at <
              ((${input.toLocalDate}::date + 1)::timestamp at time zone ${profileTimeZone})
            and current_revision.operation <> 'delete'
          -- Do not let the planner replace pinned-head PK lookups with a revision-history scan.
          offset 0
        ) revision on true
        where diary.user_id = ${input.userId}
          -- The current source-zone diary date can differ from the active-profile date
          -- by two calendar dates across the full IANA offset range.
          and diary.local_date >= (${input.fromLocalDate}::date - 2)
          and diary.local_date <= (${input.toLocalDate}::date + 2)
        limit ${MAX_NUTRITION_REPORT_ENTRY_HEADS + 1}
      `.execute(transaction);
      if (headRows.rows.length > MAX_NUTRITION_REPORT_ENTRY_HEADS) {
        throw new NutritionReportCapacityError("Nutrition report contains too many entry heads");
      }
      for (const row of headRows.rows) {
        const day = mutableDays.get(row.local_date);
        if (!day || day.entryIds.has(row.entry_id)) {
          throw new NutritionReportPersistedIntegrityError("Report diary heads are inconsistent");
        }
        day.entryIds.add(row.entry_id);
        day.sourceDiaries.set(row.diary_id, {
          id: row.diary_id,
          localDate: canonicalLocalDate(row.diary_local_date),
          revision: positiveRevision(row.diary_revision, "diary revision"),
        });
        const sourceTimeZone = canonicalIanaTimeZone(row.entry_time_zone);
        if (
          !day.sourceTimeZones.has(sourceTimeZone) &&
          day.sourceTimeZones.size >= MAX_NUTRITION_REPORT_SOURCE_TIME_ZONES_PER_DAY
        ) {
          throw new NutritionReportCapacityError(
            "Nutrition report day contains too many source time zones",
          );
        }
        day.sourceTimeZones.add(sourceTimeZone);
      }

      const definitionIds = definitions.map((definition) => definition.id);
      const headLocalDates = headRows.rows.map((row) => row.local_date);
      const headRevisionIds = headRows.rows.map((row) => row.revision_id);
      const aggregateRows = await sql<AggregateSqlRow>`
        with requested_days as (
          select day::date local_date
          from generate_series(
            ${input.fromLocalDate}::date,
            ${input.toLocalDate}::date,
            interval '1 day'
          ) day
        ), heads as (
          select bounded.local_date, bounded.revision_id
          from unnest(
            ${sql.val(headLocalDates)}::date[],
            ${sql.val(headRevisionIds)}::uuid[]
          ) as bounded(local_date, revision_id)
        )
        select requested.local_date::text,
               definition.id::text nutrient_id,
               coalesce(sum(
                 case when heads.revision_id is null then 0
                      else coalesce(snapshot.known_amount, 0) end
               ), 0)::text known_amount,
               coalesce(sum(
                 case when heads.revision_id is null then 0
                      else coalesce(snapshot.contributor_count, 1) end
               ), 0)::text contributor_count,
               coalesce(sum(
                 case when heads.revision_id is null then 0
                      else coalesce(snapshot.quantified_count, 0) end
               ), 0)::text quantified_count,
               coalesce(sum(
                 case when heads.revision_id is null then 0
                      else coalesce(snapshot.trace_count, 0) end
               ), 0)::text trace_count,
               coalesce(sum(
                 case when heads.revision_id is null then 0
                      when snapshot.nutrient_id is null then 1
                      else snapshot.unknown_count end
               ), 0)::text unknown_count,
               coalesce(sum(
                 case when heads.revision_id is null then 0
                      when snapshot.nutrient_id is null then 1
                      else coalesce((snapshot.unknown_reasons->>'not_reported')::integer, 0) end
               ), 0)::text not_reported_count,
               coalesce(sum(
                 case when heads.revision_id is null or snapshot.nutrient_id is null then 0
                      else coalesce((snapshot.unknown_reasons->>'not_analyzed')::integer, 0) end
               ), 0)::text not_analyzed_count,
               coalesce(sum(
                 case when heads.revision_id is null or snapshot.nutrient_id is null then 0
                      else coalesce((snapshot.unknown_reasons->>'not_applicable')::integer, 0) end
               ), 0)::text not_applicable_count,
               coalesce(sum(
                 case when heads.revision_id is null or snapshot.nutrient_id is null then 0
                      else coalesce((snapshot.unknown_reasons->>'withheld')::integer, 0) end
               ), 0)::text withheld_count,
               count(snapshot.nutrient_id) filter (
                 where snapshot.unit <> definition.canonical_unit
               )::text unit_mismatch_count
        from requested_days requested
        cross join nutrient definition
        left join heads on heads.local_date = requested.local_date
        left join diary_entry_revision_nutrient snapshot
          on snapshot.diary_entry_revision_id = heads.revision_id
         and snapshot.nutrient_id = definition.id
        where definition.id = any(${sql.val(definitionIds)}::bigint[])
        group by requested.local_date, definition.id
        order by requested.local_date, definition.id
      `.execute(transaction);
      const definitionById = new Map(definitions.map((definition) => [definition.id, definition]));
      for (const row of aggregateRows.rows) {
        const day = mutableDays.get(row.local_date);
        const definition = definitionById.get(row.nutrient_id);
        if (!day || !definition) {
          throw new NutritionReportPersistedIntegrityError(
            "Report aggregate mapping is incomplete",
          );
        }
        const contributorCount = safeCount(row.contributor_count, "contributor count");
        if (day.entryIds.size === 0) {
          if (contributorCount !== 0) {
            throw new NutritionReportPersistedIntegrityError("Empty report day has contributions");
          }
          continue;
        }
        const quantifiedCount = safeCount(row.quantified_count, "quantified count");
        const traceCount = safeCount(row.trace_count, "trace count");
        const unknownCount = safeCount(row.unknown_count, "unknown count");
        const unknownReasons = {
          not_reported: safeCount(row.not_reported_count, "not-reported count"),
          not_analyzed: safeCount(row.not_analyzed_count, "not-analyzed count"),
          not_applicable: safeCount(row.not_applicable_count, "not-applicable count"),
          withheld: safeCount(row.withheld_count, "withheld count"),
        } as const;
        if (
          safeCount(row.unit_mismatch_count, "unit mismatch count") !== 0 ||
          contributorCount < 1 ||
          quantifiedCount + traceCount + unknownCount !== contributorCount ||
          Object.values(unknownReasons).reduce((total, count) => total + count, 0) !== unknownCount
        ) {
          throw new NutritionReportPersistedIntegrityError(
            "Report nutrient coverage is inconsistent",
          );
        }
        const completeness: NutrientCompleteness =
          unknownCount === contributorCount
            ? "unknown"
            : unknownCount === 0
              ? "complete"
              : "partial";
        day.aggregates.push({
          code: definition.code,
          completeness,
          contributorCount,
          isExact: unknownCount === 0 && traceCount === 0,
          knownAmount: canonicalNonNegativeDecimal(row.known_amount, "report known amount"),
          name: definition.name,
          nutrientId: definition.id,
          quantifiedCount,
          traceCount,
          unit: definition.unit,
          unknownCount,
          unknownReasons,
        });
      }

      const days = [...mutableDays.values()].map((day) => {
        if (
          (day.entryIds.size === 0 && day.aggregates.length !== 0) ||
          (day.entryIds.size > 0 && day.aggregates.length !== definitions.length)
        ) {
          throw new NutritionReportPersistedIntegrityError(
            "Report day nutrient vector is incomplete",
          );
        }
        return {
          aggregates: day.aggregates.sort(
            (left, right) =>
              definitions.findIndex((definition) => definition.id === left.nutrientId) -
              definitions.findIndex((definition) => definition.id === right.nutrientId),
          ),
          endsAt: day.endsAt,
          entryCount: day.entryIds.size,
          localDate: day.localDate,
          sourceDiaries: [...day.sourceDiaries.values()].sort((left, right) =>
            left.id.localeCompare(right.id),
          ),
          sourceTimeZones: [...day.sourceTimeZones].sort(),
          startsAt: day.startsAt,
        } satisfies NutritionReportDayRecord;
      });

      const goals = await readNutritionGoalsForRangeSnapshot(transaction, {
        fromLocalDate: input.fromLocalDate,
        toLocalDate: input.toLocalDate,
        userId: input.userId,
      });
      return {
        days,
        definitions,
        fromLocalDate: input.fromLocalDate,
        goals,
        ownerUserId: input.userId,
        profileRevision,
        profileTimeZone,
        snapshotAt: profile.snapshot_at.toISOString(),
        toLocalDate: input.toLocalDate,
        watermarkRevision,
      };
    });
}

function safeCount(value: bigint | number | string, label: string): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new NutritionReportPersistedIntegrityError(`${label} is invalid`);
  }
  return count;
}

function nonNegativeRevision(value: bigint | number | string, label: string): string {
  const revision = String(value);
  if (!/^(?:0|[1-9][0-9]*)$/u.test(revision)) {
    throw new NutritionReportPersistedIntegrityError(`${label} is invalid`);
  }
  return revision;
}

function positiveRevision(value: bigint | number | string, label: string): string {
  const revision = String(value);
  if (!/^[1-9][0-9]*$/u.test(revision)) {
    throw new NutritionReportPersistedIntegrityError(`${label} is invalid`);
  }
  return revision;
}
