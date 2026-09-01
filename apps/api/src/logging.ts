import type { FastifyServerOptions } from "fastify";

import type { AppConfig } from "./config.js";

const REDACTED_LOG_KEYS = [
  "authorization",
  "cookie",
  "headers",
  "body",
  "password",
  "secret",
  "token",
  "accessToken",
  "refreshToken",
  "apiKey",
  "session",
  "note",
  "notes",
  "biometrics",
] as const;

/**
 * Defense-in-depth for conventional fields up to three nested objects. It is not
 * a general PHI sanitizer: application logs must use reviewed, allowlisted
 * operational fields. Lifecycle serializers never include URL, query, headers,
 * or body.
 */
export const LOG_REDACTION_PATHS = REDACTED_LOG_KEYS.flatMap((key) => [
  key,
  `*.${key}`,
  `*.*.${key}`,
  `*.*.*.${key}`,
]);

type LoggerOption = Exclude<FastifyServerOptions["logger"], boolean | undefined>;

export function createLoggerOptions(config: AppConfig): LoggerOption {
  return {
    level: config.logLevel,
    redact: {
      paths: [...LOG_REDACTION_PATHS],
      censor: "[REDACTED]",
    },
    serializers: {
      req(request) {
        const route = request.routeOptions.url;
        return {
          requestId: request.id,
          method: request.method,
          ...(route === undefined ? {} : { route }),
        };
      },
      res(reply) {
        return { statusCode: reply.statusCode };
      },
    },
  };
}

export function safeErrorName(error: unknown): string {
  if (error instanceof Error && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(error.name)) {
    return error.name;
  }

  return "UnknownError";
}
