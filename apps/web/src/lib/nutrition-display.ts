const decimal = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u;

function formatter(maximumFractionDigits: number, lowerBound: boolean) {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits,
    roundingMode: lowerBound ? "floor" : "halfExpand",
    useGrouping: true,
  });
}

const whole = { exact: formatter(0, false), lowerBound: formatter(0, true) };
const fractional = { exact: formatter(1, false), lowerBound: formatter(1, true) };

/** Display only: callers retain their original decimals for storage and arithmetic. */
export function formatNutrientAmount(
  amount: string,
  unit: string,
  options: { readonly lowerBound?: boolean; readonly lowerBoundPrefix?: string } = {},
): string {
  if (!decimal.test(amount)) throw new TypeError("A nutrient display amount was invalid.");
  const format = unit === "kcal" ? whole : fractional;
  const rounded = (options.lowerBound ? format.lowerBound : format.exact).format(
    amount as Intl.StringNumericLiteral,
  );
  if (rounded === "0" && /[1-9]/u.test(amount)) {
    // A small positive lower bound does not place an upper bound on total intake.
    return options.lowerBound ? `>0 ${unit}` : `<${unit === "kcal" ? "1" : "0.1"} ${unit}`;
  }
  return `${options.lowerBound ? `${options.lowerBoundPrefix ?? "≥"} ` : ""}${rounded} ${unit}`;
}
