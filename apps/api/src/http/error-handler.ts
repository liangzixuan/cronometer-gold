import { STATUS_CODES } from "node:http";

import type { ProblemCode, ProblemDetails, ProblemIssue } from "@nutrition-tracker/contracts";
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { safeErrorName } from "../logging.js";
import { HttpProblem } from "./problem.js";

interface ValidationIssueLike {
  instancePath?: string;
  dataPath?: string;
  keyword?: string;
}

const safeClientProblems: Readonly<Record<number, { code: ProblemCode; detail: string }>> = {
  400: { code: "BAD_REQUEST", detail: "The request could not be accepted." },
  401: { code: "UNAUTHORIZED", detail: "Authentication is required." },
  403: { code: "FORBIDDEN", detail: "This action is not permitted." },
  404: { code: "NOT_FOUND", detail: "The requested resource was not found." },
  405: { code: "METHOD_NOT_ALLOWED", detail: "The method is not supported." },
  409: { code: "CONFLICT", detail: "The request conflicts with current state." },
  413: { code: "PAYLOAD_TOO_LARGE", detail: "The request payload is too large." },
  415: {
    code: "UNSUPPORTED_MEDIA_TYPE",
    detail: "The request media type is not supported.",
  },
  429: { code: "RATE_LIMITED", detail: "Too many requests were received." },
};

function validationIssues(issues: readonly ValidationIssueLike[]): readonly ProblemIssue[] {
  return issues.map((issue) => ({
    path: issue.instancePath || issue.dataPath || "/",
    code: issue.keyword || "invalid",
    message: "Invalid value.",
  }));
}

function normalizeProblem(error: FastifyError | HttpProblem, requestId: string): ProblemDetails {
  if (error instanceof HttpProblem) {
    if (!error.expose) {
      return {
        type: "about:blank",
        title: STATUS_CODES[error.statusCode] ?? "Server Error",
        status: error.statusCode,
        code: "INTERNAL_ERROR",
        detail: "An unexpected error occurred.",
        requestId,
      };
    }

    return {
      type: error.type,
      title: error.title,
      status: error.statusCode,
      code: error.code,
      detail: error.detail,
      requestId,
      ...(error.issues ? { issues: error.issues } : {}),
    };
  }

  if (error.validation) {
    return {
      type: "about:blank",
      title: "Bad Request",
      status: 400,
      code: "VALIDATION_ERROR",
      detail: "One or more request fields are invalid.",
      requestId,
      issues: validationIssues(error.validation),
    };
  }

  const statusCode =
    typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500
      ? error.statusCode
      : 500;
  const clientProblem = safeClientProblems[statusCode];

  if (clientProblem) {
    return {
      type: "about:blank",
      title: STATUS_CODES[statusCode] ?? "Request Error",
      status: statusCode,
      code: clientProblem.code,
      detail: clientProblem.detail,
      requestId,
    };
  }

  if (statusCode < 500) {
    return {
      type: "about:blank",
      title: STATUS_CODES[statusCode] ?? "Request Error",
      status: statusCode,
      code: "REQUEST_ERROR",
      detail: "The request could not be completed.",
      requestId,
    };
  }

  return {
    type: "about:blank",
    title: "Internal Server Error",
    status: 500,
    code: "INTERNAL_ERROR",
    detail: "An unexpected error occurred.",
    requestId,
  };
}

function sendProblem(reply: FastifyReply, problem: ProblemDetails): void {
  reply
    .header("cache-control", "no-store")
    .type("application/problem+json")
    .status(problem.status)
    .send(problem);
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    sendProblem(reply, {
      type: "about:blank",
      title: "Not Found",
      status: 404,
      code: "ROUTE_NOT_FOUND",
      detail: "The requested route was not found.",
      requestId: request.id,
    });
  });

  app.setErrorHandler(
    (error: FastifyError | HttpProblem, request: FastifyRequest, reply: FastifyReply) => {
      const problem = normalizeProblem(error, request.id);
      const event = {
        event: "http.request.failed",
        requestId: request.id,
        method: request.method,
        route: request.routeOptions.url,
        statusCode: problem.status,
        errorType: safeErrorName(error),
        errorCode: problem.code,
      };

      if (problem.status >= 500) {
        request.log.error(event, "Request failed");
      } else if (problem.status !== 404) {
        request.log.warn(event, "Request rejected");
      }

      sendProblem(reply, problem);
    },
  );
}
