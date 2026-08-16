import type { FastifyRequest, preValidationHookHandler } from "fastify";

import { HttpProblem } from "./problem.js";

function unexpectedFields(): HttpProblem {
  return new HttpProblem({
    statusCode: 400,
    code: "VALIDATION_ERROR",
    title: "Bad Request",
    detail: "One or more request fields are invalid.",
    issues: [{ path: "/", code: "additionalProperties", message: "Invalid value." }],
    expose: true,
  });
}

/** Fastify removes additional JSON fields by default, so reject them before schema validation. */
export function rejectUnexpectedBodyKeys(allowedKeys: readonly string[]): preValidationHookHandler {
  const allowed = new Set(allowedKeys);
  return async (request: FastifyRequest): Promise<void> => {
    const body = request.body;
    if (typeof body !== "object" || body === null || Array.isArray(body)) return;
    if (Object.keys(body).some((key) => !allowed.has(key))) throw unexpectedFields();
  };
}

export function rejectUnexpectedQueryKeys(
  allowedKeys: readonly string[],
): preValidationHookHandler {
  const allowed = new Set(allowedKeys);
  return async (request: FastifyRequest): Promise<void> => {
    const query = request.query;
    if (typeof query !== "object" || query === null || Array.isArray(query)) return;
    if (Object.keys(query).some((key) => !allowed.has(key))) throw unexpectedFields();
  };
}
