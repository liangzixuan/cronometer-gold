export type IngestionErrorCode =
  | "ABORTED"
  | "ARCHIVE_LIMIT_EXCEEDED"
  | "CHECKPOINT_CONFLICT"
  | "CHECKSUM_MISMATCH"
  | "DUPLICATE_KEY"
  | "HTTP_ERROR"
  | "INVALID_ARCHIVE_ENTRY"
  | "INVALID_ARTIFACT"
  | "INVALID_MANIFEST"
  | "INVALID_RECORD"
  | "UNSUPPORTED_SOURCE";

export class IngestionError extends Error {
  readonly code: IngestionErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: IngestionErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "IngestionError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export function invariant(
  condition: unknown,
  code: IngestionErrorCode,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): asserts condition {
  if (!condition) {
    throw new IngestionError(code, message, details);
  }
}

export function abortError(signal?: AbortSignal): IngestionError {
  return new IngestionError(
    "ABORTED",
    "Artifact acquisition was aborted",
    {},
    {
      cause: signal?.reason,
    },
  );
}
