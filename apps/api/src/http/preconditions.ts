import { HttpProblem } from "./problem.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function requireIdempotencyKey(value: string | string[] | undefined): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new HttpProblem({
      statusCode: 400,
      code: "VALIDATION_ERROR",
      title: "Bad Request",
      detail: "A valid UUID Idempotency-Key header is required.",
      issues: [{ path: "/headers/idempotency-key", code: "invalid", message: "Invalid value." }],
      expose: true,
    });
  }
  return value.toLowerCase();
}

export function requireRevision(
  value: string | string[] | undefined,
  options: { readonly allowZero?: boolean } = {},
): string {
  if (value === undefined) {
    throw new HttpProblem({
      statusCode: 428,
      code: "PRECONDITION_REQUIRED",
      title: "Precondition Required",
      detail: "If-Match is required for this operation.",
      expose: true,
    });
  }
  if (typeof value !== "string") return invalidRevision();
  const match = (options.allowZero ? /^"(0|[1-9][0-9]*)"$/ : /^"([1-9][0-9]*)"$/).exec(
    value.trim(),
  );
  const revision = match?.[1];
  if (!revision) return invalidRevision();
  return revision;
}

function invalidRevision(): never {
  throw new HttpProblem({
    statusCode: 400,
    code: "VALIDATION_ERROR",
    title: "Bad Request",
    detail: "If-Match must contain one current strong revision ETag.",
    issues: [{ path: "/headers/if-match", code: "invalid", message: "Invalid value." }],
    expose: true,
  });
}

export function revisionEtag(revision: string): string {
  return `"${revision}"`;
}
