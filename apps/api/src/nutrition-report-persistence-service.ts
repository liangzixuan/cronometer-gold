import {
  NUTRITION_REPORT_NOTICE,
  type NutritionReportGoalVersion,
  type NutritionReportResponse,
  type NutritionReportTargetSnapshot,
} from "@nutrition-tracker/contracts";
import {
  type createDatabaseFromEnvironment,
  getNutritionReportSnapshot,
  NutritionGoalPeriodConflictError,
  NutritionGoalPersistedIntegrityError,
  NutritionGoalValidationError,
  NutritionReportCapacityError,
  NutritionReportNotFoundError,
  NutritionReportPersistedIntegrityError,
  type NutritionReportSnapshotRecord,
  NutritionReportValidationError,
} from "@nutrition-tracker/db";
import {
  CORE_NUTRIENTS,
  calculateNutrientTargetProgress,
  canonicalNonNegativeDecimal,
  nutritionReportLocalDates,
  nutritionReportScale,
  nutritionReportScalePercent,
} from "@nutrition-tracker/domain";
import {
  NutritionReportCapacityServiceError,
  NutritionReportNotFoundServiceError,
  NutritionReportPersistedIntegrityServiceError,
  NutritionReportRangeServiceError,
  type NutritionReportService,
} from "./modules/reports/nutrition-report.routes.js";
import { mapDiaryNutrientAggregate, mapNutritionGoalRecord } from "./persistence-services.js";

type AppDatabase = ReturnType<typeof createDatabaseFromEnvironment>;

interface GoalContext {
  readonly version: NutritionReportGoalVersion;
  readonly targetByNutrientId: ReadonlyMap<string, NutritionReportTargetSnapshot>;
}

export class DatabaseNutritionReportService implements NutritionReportService {
  readonly #database: AppDatabase;

  constructor(database: AppDatabase) {
    this.#database = database;
  }

  async getNutritionReport(
    input: Parameters<NutritionReportService["getNutritionReport"]>[0],
  ): Promise<NutritionReportResponse> {
    input.signal?.throwIfAborted();
    try {
      const snapshot = await getNutritionReportSnapshot(this.#database, {
        fromLocalDate: input.from,
        toLocalDate: input.to,
        userId: input.userId,
      });
      input.signal?.throwIfAborted();
      return mapNutritionReportSnapshot(snapshot);
    } catch (error) {
      if (error instanceof NutritionReportCapacityError) {
        throw new NutritionReportCapacityServiceError();
      }
      if (error instanceof NutritionReportValidationError) {
        throw new NutritionReportRangeServiceError();
      }
      if (error instanceof NutritionReportNotFoundError) {
        throw new NutritionReportNotFoundServiceError();
      }
      if (
        error instanceof NutritionReportPersistedIntegrityError ||
        error instanceof NutritionGoalPeriodConflictError ||
        error instanceof NutritionGoalPersistedIntegrityError ||
        error instanceof NutritionGoalValidationError ||
        (error instanceof Error && (error.name === "DomainError" || error instanceof TypeError))
      ) {
        throw new NutritionReportPersistedIntegrityServiceError();
      }
      throw error;
    }
  }
}

export function mapNutritionReportSnapshot(
  snapshot: NutritionReportSnapshotRecord,
): NutritionReportResponse {
  const dates = nutritionReportLocalDates(snapshot.fromLocalDate, snapshot.toLocalDate);
  if (
    snapshot.ownerUserId.length === 0 ||
    snapshot.days.length !== dates.length ||
    snapshot.definitions.length !== CORE_NUTRIENTS.length ||
    snapshot.days.some((day, index) => day.localDate !== dates[index])
  ) {
    throw new TypeError("Nutrition report snapshot boundaries are inconsistent");
  }
  const definitions = snapshot.definitions.map((definition, index) => {
    const expected = CORE_NUTRIENTS[index];
    if (
      !expected ||
      definition.code !== expected.id ||
      definition.unit !== expected.canonicalUnit ||
      definition.category !== expected.category
    ) {
      throw new TypeError("Nutrition report core nutrient registry is inconsistent");
    }
    return {
      ...definition,
      category: expected.category,
      unit: expected.canonicalUnit,
    };
  });
  const definitionIds = new Set(definitions.map((definition) => definition.id));
  if (definitionIds.size !== definitions.length) {
    throw new TypeError("Nutrition report nutrient identifiers are duplicated");
  }

  const contexts = snapshot.goals.map((record): GoalContext => {
    const goal = mapNutritionGoalRecord(record);
    const energyDefinition = definitions.find((definition) => definition.code === "energy");
    if (!energyDefinition) throw new TypeError("Nutrition report energy definition is missing");
    const energy = goal.currentVersion.energy;
    const energySnapshot: NutritionReportTargetSnapshot = {
      maximumAmount: null,
      minimumAmount: null,
      rationale: energy.rationale,
      source:
        energy.mode === "fixed"
          ? { label: energy.source.code, version: energy.source.version }
          : { label: energy.source.equation.code, version: energy.source.equation.version },
      targetAmount: energy.targetKcal,
    };
    const targets = [
      { nutrientId: energyDefinition.id, snapshot: energySnapshot },
      ...goal.currentVersion.nutrientTargets
        .filter((target) => definitionIds.has(target.definition.id))
        .map((target) => ({
          nutrientId: target.definition.id,
          snapshot: {
            maximumAmount: target.maximumAmount,
            minimumAmount: target.minimumAmount,
            rationale: target.rationale,
            source: target.source,
            targetAmount: target.targetAmount,
          },
        })),
    ].sort(
      (left, right) =>
        definitions.findIndex((definition) => definition.id === left.nutrientId) -
        definitions.findIndex((definition) => definition.id === right.nutrientId),
    );
    if (new Set(targets.map((target) => target.nutrientId)).size !== targets.length) {
      throw new TypeError("Nutrition report goal contains duplicate core targets");
    }
    const reference = record.currentVersion.referenceTargetSet ?? null;
    const version: NutritionReportGoalVersion = {
      effectiveFrom: goal.effectiveFrom,
      effectiveTo: goal.effectiveTo,
      goalId: goal.id,
      reference:
        reference === null
          ? null
          : {
              eligibleThroughExclusive: reference.eligibleThroughExclusive,
              groupCode: reference.groupCode,
              policyDigest: reference.policyDigest,
              templateCode: reference.templateCode,
              templateVersion: reference.templateVersion,
            },
      revision: goal.revision,
      targets,
      versionId: goal.currentVersion.id,
    };
    return {
      targetByNutrientId: new Map(targets.map((target) => [target.nutrientId, target.snapshot])),
      version,
    };
  });
  if (new Set(contexts.map((context) => context.version.versionId)).size !== contexts.length) {
    throw new TypeError("Nutrition report goal versions are duplicated");
  }

  const contextByDate = new Map<string, GoalContext | null>();
  for (const localDate of dates) {
    const matches = contexts.filter(
      ({ version }) =>
        version.effectiveFrom <= localDate &&
        (version.effectiveTo === null || localDate < version.effectiveTo) &&
        (version.reference === null || localDate < version.reference.eligibleThroughExclusive),
    );
    if (matches.length > 1) throw new TypeError("Nutrition report goal periods overlap");
    contextByDate.set(localDate, matches[0] ?? null);
  }
  const usedVersionIds = new Set(
    [...contextByDate.values()].flatMap((context) =>
      context === null ? [] : [context.version.versionId],
    ),
  );
  const goalVersions = contexts
    .filter((context) => usedVersionIds.has(context.version.versionId))
    .map((context) => context.version);

  const targetSegments: {
    from: string;
    to: string;
    goalVersionId: string | null;
  }[] = [];
  for (const localDate of dates) {
    const goalVersionId = contextByDate.get(localDate)?.version.versionId ?? null;
    const previous = targetSegments[targetSegments.length - 1];
    if (previous && previous.goalVersionId === goalVersionId) {
      targetSegments[targetSegments.length - 1] = { ...previous, to: localDate };
    } else {
      targetSegments.push({
        from: localDate,
        goalVersionId,
        to: localDate,
      });
    }
  }

  const days = snapshot.days.map((day) => ({
    endsAt: day.endsAt,
    entryCount: day.entryCount,
    localDate: day.localDate,
    sourceDiaries: day.sourceDiaries,
    sourceTimeZones: day.sourceTimeZones,
    startsAt: day.startsAt,
  }));
  const aggregatesByDate = new Map(
    snapshot.days.map((day) => [
      day.localDate,
      new Map(day.aggregates.map((aggregate) => [aggregate.nutrientId, aggregate])),
    ]),
  );
  const series = definitions.map((nutrient) => {
    const rows = dates.map((localDate) => {
      const day = snapshot.days.find((candidate) => candidate.localDate === localDate);
      if (!day) throw new TypeError("Nutrition report day is missing");
      const aggregateRecord = aggregatesByDate.get(localDate)?.get(nutrient.id) ?? null;
      if ((day.entryCount === 0) !== (aggregateRecord === null)) {
        throw new TypeError("Nutrition report missing-day semantics are inconsistent");
      }
      const aggregate = aggregateRecord ? mapDiaryNutrientAggregate(aggregateRecord) : null;
      if (
        aggregate &&
        (aggregate.code !== nutrient.code ||
          aggregate.name !== nutrient.name ||
          aggregate.unit !== nutrient.unit)
      ) {
        throw new TypeError("Nutrition report aggregate definition is inconsistent");
      }
      const context = contextByDate.get(localDate) ?? null;
      return {
        aggregate,
        context,
        localDate,
        target: context?.targetByNutrientId.get(nutrient.id) ?? null,
      };
    });
    const scaleMaximum = nutritionReportScale(
      rows.flatMap((row) => [
        row.aggregate?.knownAmount ?? null,
        row.target?.minimumAmount ?? null,
        row.target?.targetAmount ?? null,
        row.target?.maximumAmount ?? null,
      ]),
    );
    const points = rows.map((row) => {
      const progress =
        row.aggregate && row.target
          ? calculateNutrientTargetProgress(
              {
                completeness: row.aggregate.completeness,
                contributorCount: row.aggregate.contributorCount,
                isExact: row.aggregate.isExact,
                knownAmount: row.aggregate.knownAmount,
                nutrientId: row.aggregate.nutrientId,
                quantifiedCount: row.aggregate.quantifiedCount,
                traceCount: row.aggregate.traceCount,
                unit: nutrient.unit,
                unknownCount: row.aggregate.unknownCount,
                unknownReasons: row.aggregate.unknownReasonCounts,
              },
              {
                maximumAmount: row.target.maximumAmount,
                minimumAmount: row.target.minimumAmount,
                nutrientId: nutrient.id,
                targetAmount: row.target.targetAmount,
                unit: nutrient.unit,
              },
            )
          : null;
      return {
        aggregate: row.aggregate,
        comparison:
          progress === null
            ? null
            : {
                maximumState: progress.maximum?.state ?? null,
                minimumState: progress.minimum?.state ?? null,
                targetLowerBoundPercent: progress.target?.lowerBoundPercent ?? null,
                targetPercentIsExact: progress.target?.percentIsExact ?? null,
              },
        goalVersionId: row.context?.version.versionId ?? null,
        knownPercentOfScale:
          row.aggregate === null
            ? null
            : nutritionReportScalePercent(row.aggregate.knownAmount, scaleMaximum),
        localDate: row.localDate,
        maximumPercentOfScale:
          row.target?.maximumAmount === null || row.target === null
            ? null
            : nutritionReportScalePercent(row.target.maximumAmount, scaleMaximum),
        minimumPercentOfScale:
          row.target?.minimumAmount === null || row.target === null
            ? null
            : nutritionReportScalePercent(row.target.minimumAmount, scaleMaximum),
        targetPercentOfScale:
          row.target?.targetAmount === null || row.target === null
            ? null
            : nutritionReportScalePercent(row.target.targetAmount, scaleMaximum),
      };
    });
    return {
      nutrient,
      points,
      scaleMaximum,
      scalePolicy: "max-intake-or-saved-threshold-v1" as const,
      summary: {
        completeDays: points.filter((point) => point.aggregate?.completeness === "complete").length,
        diaryDays: points.filter((point) => point.aggregate !== null).length,
        exactDays: points.filter((point) => point.aggregate?.isExact === true).length,
        missingDays: points.filter((point) => point.aggregate === null).length,
        partialDays: points.filter((point) => point.aggregate?.completeness === "partial").length,
        traceDays: points.filter((point) => (point.aggregate?.traceCount ?? 0) > 0).length,
        unknownDays: points.filter((point) => point.aggregate?.completeness === "unknown").length,
      },
    };
  });

  return {
    data: {
      dateBasis: "active-profile-time-zone-v1",
      days,
      from: snapshot.fromLocalDate,
      goalVersionBasis: "current-version-at-report-snapshot-v1",
      goalVersions,
      notice: NUTRITION_REPORT_NOTICE,
      ownerUserId: snapshot.ownerUserId,
      profileRevision: snapshot.profileRevision,
      series,
      snapshotAt: snapshot.snapshotAt,
      targetSegments,
      timeZone: snapshot.profileTimeZone,
      to: snapshot.toLocalDate,
      watermarkRevision: canonicalNonNegativeDecimal(
        snapshot.watermarkRevision,
        "nutrition report watermark",
      ),
    },
  };
}
