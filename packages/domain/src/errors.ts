export type DomainErrorCode =
  | "DUPLICATE_NUTRIENT"
  | "INCOMPATIBLE_UNITS"
  | "INVALID_DATE"
  | "INVALID_DECIMAL"
  | "INVALID_IDENTIFIER"
  | "INVALID_NUTRIENT_AGGREGATE"
  | "INVALID_PORTION"
  | "INVALID_RECIPE"
  | "INVALID_SNAPSHOT"
  | "INVALID_UNIT"
  | "MISSING_CONVERSION"
  | "UNIT_MISMATCH";

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: DomainErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export function domainInvariant(
  condition: unknown,
  code: DomainErrorCode,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): asserts condition {
  if (!condition) {
    throw new DomainError(code, message, details);
  }
}
