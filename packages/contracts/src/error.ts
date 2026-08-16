export const problemCodes = [
  "BAD_REQUEST",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "METHOD_NOT_ALLOWED",
  "CONFLICT",
  "PRECONDITION_FAILED",
  "PRECONDITION_REQUIRED",
  "PAYLOAD_TOO_LARGE",
  "UNSUPPORTED_MEDIA_TYPE",
  "RATE_LIMITED",
  "REQUEST_ERROR",
  "VALIDATION_ERROR",
  "INTERNAL_ERROR",
  "ROUTE_NOT_FOUND",
  "SERVICE_NOT_READY",
] as const;

export type ProblemCode = (typeof problemCodes)[number];

export interface ProblemIssue {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

/** RFC 9457 fields plus a stable product code, request id, and safe issues. */
export interface ProblemDetails {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly code: ProblemCode;
  readonly detail: string;
  readonly requestId: string;
  readonly issues?: readonly ProblemIssue[];
}

export const problemDetailsSchema = {
  $id: "ProblemDetails",
  type: "object",
  additionalProperties: false,
  required: ["type", "title", "status", "code", "detail", "requestId"],
  properties: {
    type: { type: "string", minLength: 1 },
    title: { type: "string", minLength: 1 },
    status: { type: "integer", minimum: 400, maximum: 599 },
    code: { type: "string", enum: problemCodes },
    detail: { type: "string", minLength: 1 },
    requestId: { type: "string", minLength: 1 },
    issues: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "code", "message"],
        properties: {
          path: { type: "string" },
          code: { type: "string", minLength: 1 },
          message: { type: "string", minLength: 1 },
        },
      },
    },
  },
} as const;
