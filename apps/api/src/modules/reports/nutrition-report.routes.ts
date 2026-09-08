import {
  NUTRITION_REPORT_NOTICE,
  type NutritionReportResponse,
  nutritionReportQuerySchema,
  nutritionReportResponseSchema,
  problemDetailsSchema,
} from "@nutrition-tracker/contracts";
import {
  assertNutritionReportRange,
  decimal,
  nutritionReportLocalDates,
} from "@nutrition-tracker/domain";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";

import { authenticatedPrincipal, requireAuthentication } from "../../http/authentication.js";
import { HttpProblem } from "../../http/problem.js";
import { rejectUnexpectedQueryKeys } from "../../http/request-validation.js";
import type { AuthService } from "../auth/auth-service.js";

export interface NutritionReportService {
  getNutritionReport(input: {
    readonly userId: string;
    readonly from: string;
    readonly to: string;
    readonly signal?: AbortSignal;
  }): Promise<NutritionReportResponse>;
}

export interface NutritionReportRoutesOptions {
  readonly authService?: AuthService;
  readonly nutritionReportService?: NutritionReportService;
}

export class NutritionReportRangeServiceError extends Error {}
export class NutritionReportCapacityServiceError extends Error {}
export class NutritionReportNotFoundServiceError extends Error {}
export class NutritionReportPersistedIntegrityServiceError extends Error {}

interface ReportQuery {
  from: string;
  to: string;
}

async function withRequestSignal<T>(
  request: FastifyRequest,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort("request-aborted");
  if (request.raw.aborted) abort();
  else request.raw.once("aborted", abort);
  try {
    return await operation(controller.signal);
  } finally {
    request.raw.off("aborted", abort);
  }
}

function unavailable(cause?: unknown): HttpProblem {
  return new HttpProblem({
    statusCode: 503,
    code: "SERVICE_NOT_READY",
    title: "Service Unavailable",
    detail: "Nutrition reports are temporarily unavailable.",
    expose: true,
    cause,
  });
}

function mapReportError(error: unknown): HttpProblem {
  if (error instanceof HttpProblem) return error;
  if (error instanceof NutritionReportRangeServiceError) {
    return new HttpProblem({
      statusCode: 422,
      code: "VALIDATION_ERROR",
      title: "Unprocessable Content",
      detail: "Choose an inclusive nutrition-report range of 1 to 31 local days.",
      expose: true,
    });
  }
  if (error instanceof NutritionReportCapacityServiceError) {
    return new HttpProblem({
      statusCode: 422,
      code: "REPORT_CAPACITY_EXCEEDED",
      title: "Unprocessable Content",
      detail:
        "This nutrition report contains too many current entries or source time zones to return safely. Choose a shorter range.",
      expose: true,
    });
  }
  if (error instanceof NutritionReportNotFoundServiceError) {
    return new HttpProblem({
      statusCode: 404,
      code: "NOT_FOUND",
      title: "Not Found",
      detail: "The nutrition report owner was not found.",
      expose: true,
    });
  }
  if (error instanceof NutritionReportPersistedIntegrityServiceError) return unavailable(error);
  return unavailable(error);
}

function assertReport(
  result: NutritionReportResponse,
  request: { readonly userId: string; readonly from: string; readonly to: string },
): void {
  const { data } = result;
  if (
    data.ownerUserId !== request.userId ||
    data.from !== request.from ||
    data.to !== request.to ||
    data.notice !== NUTRITION_REPORT_NOTICE ||
    data.dateBasis !== "active-profile-time-zone-v1" ||
    data.goalVersionBasis !== "current-version-at-report-snapshot-v1"
  ) {
    throw new NutritionReportPersistedIntegrityServiceError();
  }
  const dates = nutritionReportLocalDates(request.from, request.to);
  if (
    data.days.length !== dates.length ||
    data.days.some((day, index) => day.localDate !== dates[index]) ||
    data.series.length !== 15 ||
    new Set(data.series.map((series) => series.nutrient.id)).size !== data.series.length
  ) {
    throw new NutritionReportPersistedIntegrityServiceError();
  }
  const goalVersionIds = new Set(data.goalVersions.map((goal) => goal.versionId));
  for (const series of data.series) {
    if (
      series.points.length !== dates.length ||
      series.points.some((point, index) => point.localDate !== dates[index]) ||
      series.scalePolicy !== "max-intake-or-saved-threshold-v1" ||
      !decimal(series.scaleMaximum).gt(0)
    ) {
      throw new NutritionReportPersistedIntegrityServiceError();
    }
    const { summary } = series;
    if (
      summary.completeDays + summary.partialDays + summary.unknownDays + summary.missingDays !==
        dates.length ||
      summary.diaryDays !== summary.completeDays + summary.partialDays + summary.unknownDays ||
      summary.exactDays > summary.completeDays ||
      summary.traceDays > summary.diaryDays
    ) {
      throw new NutritionReportPersistedIntegrityServiceError();
    }
    for (const point of series.points) {
      if (point.goalVersionId !== null && !goalVersionIds.has(point.goalVersionId)) {
        throw new NutritionReportPersistedIntegrityServiceError();
      }
      const day = data.days.find((candidate) => candidate.localDate === point.localDate);
      if (!day || (day.entryCount === 0) !== (point.aggregate === null)) {
        throw new NutritionReportPersistedIntegrityServiceError();
      }
      for (const percentage of [
        point.knownPercentOfScale,
        point.minimumPercentOfScale,
        point.targetPercentOfScale,
        point.maximumPercentOfScale,
      ]) {
        if (percentage !== null && (decimal(percentage).lt(0) || decimal(percentage).gt(100))) {
          throw new NutritionReportPersistedIntegrityServiceError();
        }
      }
    }
  }
  const segmentDates = data.targetSegments.flatMap((segment) =>
    nutritionReportLocalDates(segment.from, segment.to).map((localDate) => ({
      goalVersionId: segment.goalVersionId,
      localDate,
    })),
  );
  const canonicalGoalIds = data.series[0]?.points.map((point) => point.goalVersionId) ?? [];
  if (
    segmentDates.length !== dates.length ||
    segmentDates.some(
      (entry, index) =>
        entry.localDate !== dates[index] || entry.goalVersionId !== canonicalGoalIds[index],
    ) ||
    data.series.some((series) =>
      series.points.some((point, index) => point.goalVersionId !== canonicalGoalIds[index]),
    )
  ) {
    throw new NutritionReportPersistedIntegrityServiceError();
  }
}

export const nutritionReportRoutes: FastifyPluginAsync<NutritionReportRoutesOptions> = async (
  app,
  options,
) => {
  const requireAuth = requireAuthentication(options.authService);
  app.get<{ Querystring: ReportQuery }>(
    "/",
    {
      preHandler: requireAuth,
      preValidation: rejectUnexpectedQueryKeys(["from", "to"]),
      schema: {
        querystring: nutritionReportQuerySchema,
        response: {
          200: nutritionReportResponseSchema,
          400: problemDetailsSchema,
          401: problemDetailsSchema,
          404: problemDetailsSchema,
          422: problemDetailsSchema,
          503: problemDetailsSchema,
        },
      },
    },
    async (request, reply): Promise<NutritionReportResponse> => {
      if (!options.nutritionReportService) throw unavailable();
      const principal = authenticatedPrincipal(request);
      try {
        assertNutritionReportRange(request.query.from, request.query.to);
      } catch {
        throw mapReportError(new NutritionReportRangeServiceError());
      }
      try {
        const result = await withRequestSignal(
          request,
          (signal) =>
            options.nutritionReportService?.getNutritionReport({
              from: request.query.from,
              signal,
              to: request.query.to,
              userId: principal.userId,
            }) ?? Promise.reject(unavailable()),
        );
        assertReport(result, {
          from: request.query.from,
          to: request.query.to,
          userId: principal.userId,
        });
        reply.header("cache-control", "no-store");
        return result;
      } catch (error) {
        throw mapReportError(error);
      }
    },
  );
};
