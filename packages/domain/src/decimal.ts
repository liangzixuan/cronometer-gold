import { Decimal } from "decimal.js";

import { DomainError } from "./errors.js";

export type DecimalInput = string | number | bigint | Decimal;
export type DecimalString = string;

/**
 * Isolated constructor: importing this package does not mutate decimal.js's
 * process-wide defaults. Forty significant digits comfortably exceed source
 * food-label precision while protecting long recipe sums.
 */
const ExactDecimal = Decimal.clone({
  precision: 40,
  rounding: Decimal.ROUND_HALF_EVEN,
  toExpNeg: -100,
  toExpPos: 100,
});

export function decimal(value: DecimalInput, label = "value"): Decimal {
  try {
    const result = new ExactDecimal(value);
    if (!result.isFinite()) {
      throw new Error("value is not finite");
    }
    return result;
  } catch (error) {
    throw new DomainError("INVALID_DECIMAL", `${label} must be a finite decimal`, {
      label,
      value: String(value),
      cause: error instanceof Error ? error.message : "invalid decimal",
    });
  }
}

export function canonicalDecimal(value: DecimalInput, label = "value"): DecimalString {
  const parsed = decimal(value, label);
  return parsed.isZero() ? "0" : parsed.toFixed();
}

export function canonicalNonNegativeDecimal(value: DecimalInput, label = "value"): DecimalString {
  const parsed = decimal(value, label);
  if (parsed.lt(0)) {
    throw new DomainError("INVALID_DECIMAL", `${label} must be greater than or equal to zero`, {
      label,
      value: String(value),
    });
  }
  return canonicalDecimal(parsed, label);
}

export function canonicalPositiveDecimal(value: DecimalInput, label = "value"): DecimalString {
  const parsed = decimal(value, label);
  if (!parsed.gt(0)) {
    throw new DomainError("INVALID_DECIMAL", `${label} must be greater than zero`, {
      label,
      value: String(value),
    });
  }
  return canonicalDecimal(parsed, label);
}

export function multiplyDecimals(left: DecimalInput, right: DecimalInput): DecimalString {
  return canonicalDecimal(decimal(left).mul(decimal(right)));
}

export function divideDecimals(numerator: DecimalInput, denominator: DecimalInput): DecimalString {
  const divisor = decimal(denominator, "denominator");
  if (divisor.isZero()) {
    throw new DomainError("INVALID_DECIMAL", "denominator must not be zero", {
      denominator: String(denominator),
    });
  }
  return canonicalDecimal(decimal(numerator, "numerator").div(divisor));
}

export function sumDecimals(values: readonly DecimalInput[]): DecimalString {
  return canonicalDecimal(
    values.reduce<Decimal>((total, value) => total.plus(decimal(value)), decimal(0)),
  );
}
