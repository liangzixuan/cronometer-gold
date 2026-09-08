import { canonicalIanaTimeZone } from "@nutrition-tracker/domain";
import type { FastifyRequest } from "fastify";

import { HttpProblem } from "./problem.js";

export function expectedProfileTimeZone(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    if (typeof value !== "string") throw new RangeError("Expected one header value");
    return canonicalIanaTimeZone(value);
  } catch {
    throw new HttpProblem({
      statusCode: 400,
      code: "VALIDATION_ERROR",
      title: "Bad Request",
      detail: "One or more request fields are invalid.",
      issues: [
        {
          path: "/headers/x-expected-profile-time-zone",
          code: "invalid",
          message: "Invalid value.",
        },
      ],
      expose: true,
    });
  }
}

export async function rejectUnpairedProfileTimeZonePrecondition(
  request: FastifyRequest,
): Promise<void> {
  const query =
    typeof request.query === "object" && request.query !== null && !Array.isArray(request.query)
      ? (request.query as Readonly<Record<string, unknown>>)
      : {};
  const marker = query.profileTimeZonePrecondition;
  const header = request.headers["x-expected-profile-time-zone"];
  const isLegacy = marker === undefined && header === undefined;
  const isGuardedV1 = marker === "v1" && typeof header === "string";
  if (isLegacy || isGuardedV1) return;
  throw new HttpProblem({
    statusCode: 400,
    code: "VALIDATION_ERROR",
    title: "Bad Request",
    detail: "One or more request fields are invalid.",
    expose: true,
  });
}
