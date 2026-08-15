import type { DecimalInput, DecimalString } from "./decimal.js";
import { canonicalDecimal, canonicalPositiveDecimal, decimal } from "./decimal.js";
import { DomainError, domainInvariant } from "./errors.js";
import { deepFreeze } from "./immutable.js";

export type UnitDimension = "energy" | "mass" | "volume";
export type MassUnit = "g" | "kg" | "mg" | "ug";
export type EnergyUnit = "kcal" | "kJ";
export type VolumeUnit = "mL" | "L" | "tsp_us" | "tbsp_us" | "fl_oz_us" | "cup_us";
export type QuantityUnit = MassUnit | EnergyUnit | VolumeUnit;

interface UnitDefinition {
  readonly dimension: UnitDimension;
  /** Multiplicative factor to g, kcal, or mL respectively. */
  readonly toBase: string;
}

const UNIT_DEFINITIONS: Readonly<Record<QuantityUnit, UnitDefinition>> = Object.freeze({
  g: { dimension: "mass", toBase: "1" },
  kg: { dimension: "mass", toBase: "1000" },
  mg: { dimension: "mass", toBase: "0.001" },
  ug: { dimension: "mass", toBase: "0.000001" },
  kcal: { dimension: "energy", toBase: "1" },
  kJ: { dimension: "energy", toBase: "0.23900573613766730401529636711281" },
  mL: { dimension: "volume", toBase: "1" },
  L: { dimension: "volume", toBase: "1000" },
  tsp_us: { dimension: "volume", toBase: "4.92892159375" },
  tbsp_us: { dimension: "volume", toBase: "14.78676478125" },
  fl_oz_us: { dimension: "volume", toBase: "29.5735295625" },
  cup_us: { dimension: "volume", toBase: "236.5882365" },
});

export interface Quantity<U extends QuantityUnit = QuantityUnit> {
  readonly amount: DecimalString;
  readonly unit: U;
}

export function quantity<U extends QuantityUnit>(amount: DecimalInput, unit: U): Quantity<U> {
  unitDefinition(unit);
  return Object.freeze({ amount: canonicalDecimal(amount, "quantity amount"), unit });
}

export function unitDimension(unit: QuantityUnit): UnitDimension {
  return unitDefinition(unit).dimension;
}

export function convertQuantity<ToUnit extends QuantityUnit>(
  input: Quantity,
  toUnit: ToUnit,
): Quantity<ToUnit> {
  const from = unitDefinition(input.unit);
  const to = unitDefinition(toUnit);
  domainInvariant(
    from.dimension === to.dimension,
    "INCOMPATIBLE_UNITS",
    `Cannot convert ${input.unit} to ${toUnit}`,
    { fromUnit: input.unit, toUnit },
  );

  const converted = decimal(input.amount, "quantity amount").mul(from.toBase).div(to.toBase);
  return quantity(converted, toUnit);
}

function unitDefinition(unit: QuantityUnit): UnitDefinition {
  const definition = UNIT_DEFINITIONS[unit];
  if (!definition) {
    throw new DomainError("INVALID_UNIT", `Unsupported unit: ${String(unit)}`, {
      unit,
    });
  }
  return definition;
}

export interface ServingDefinition {
  readonly id: string;
  readonly label: string;
  /** Source-defined reference, such as 1 cup, 2 crackers, or 0.5 package. */
  readonly reference: {
    readonly amount: DecimalInput;
    readonly unit: string;
  };
  /** Gram weight for exactly `reference`. */
  readonly gramWeight: DecimalInput;
  readonly source: string;
}

export interface DensityDefinition {
  readonly gramsPerMilliliter: DecimalInput;
  readonly source: string;
}

export type PortionSelection =
  | {
      readonly kind: "mass";
      readonly quantity: Quantity<MassUnit>;
    }
  | {
      /** Number of the source-defined reference serving. */
      readonly kind: "serving-count";
      readonly count: DecimalInput;
      readonly serving: ServingDefinition;
    }
  | {
      /** A household amount that must exactly match the selected serving unit. */
      readonly kind: "household";
      readonly amount: DecimalInput;
      readonly unit: string;
      readonly serving: ServingDefinition;
    }
  | {
      readonly kind: "volume-with-density";
      readonly quantity: Quantity<VolumeUnit>;
      readonly density: DensityDefinition;
    };

export type PortionConversion =
  | { readonly kind: "direct-mass" }
  | {
      readonly kind: "source-serving";
      readonly servingId: string;
      readonly servingSource: string;
    }
  | {
      readonly kind: "food-density";
      readonly densitySource: string;
    };

export interface ResolvedPortion {
  readonly grams: DecimalString;
  readonly conversion: PortionConversion;
}

/**
 * Resolve an entered portion to grams without any implicit food density. A
 * household measure can cross dimensions only through source-specific serving
 * data or an explicit food density.
 */
export function resolvePortionToGrams(selection: PortionSelection): ResolvedPortion {
  switch (selection.kind) {
    case "mass": {
      const amount = canonicalPositiveDecimal(selection.quantity.amount, "portion amount");
      const grams = convertQuantity(quantity(amount, selection.quantity.unit), "g").amount;
      return deepFreeze<ResolvedPortion>({ grams, conversion: { kind: "direct-mass" } });
    }
    case "serving-count": {
      validateServing(selection.serving);
      const count = decimal(canonicalPositiveDecimal(selection.count, "serving count"));
      const grams = canonicalDecimal(
        count.mul(selection.serving.gramWeight),
        "resolved portion grams",
      );
      return deepFreeze<ResolvedPortion>({
        grams,
        conversion: {
          kind: "source-serving",
          servingId: selection.serving.id,
          servingSource: selection.serving.source,
        },
      });
    }
    case "household": {
      validateServing(selection.serving);
      domainInvariant(
        selection.unit === selection.serving.reference.unit,
        "MISSING_CONVERSION",
        "Entered household unit does not match the selected food-specific serving",
        {
          enteredUnit: selection.unit,
          servingUnit: selection.serving.reference.unit,
          servingId: selection.serving.id,
        },
      );
      const entered = decimal(canonicalPositiveDecimal(selection.amount, "household amount"));
      const reference = decimal(
        canonicalPositiveDecimal(selection.serving.reference.amount, "serving reference amount"),
      );
      const grams = canonicalDecimal(
        entered.div(reference).mul(selection.serving.gramWeight),
        "resolved portion grams",
      );
      return deepFreeze<ResolvedPortion>({
        grams,
        conversion: {
          kind: "source-serving",
          servingId: selection.serving.id,
          servingSource: selection.serving.source,
        },
      });
    }
    case "volume-with-density": {
      const volumeAmount = canonicalPositiveDecimal(selection.quantity.amount, "volume amount");
      const milliliters = convertQuantity(
        quantity(volumeAmount, selection.quantity.unit),
        "mL",
      ).amount;
      const density = canonicalPositiveDecimal(selection.density.gramsPerMilliliter, "density");
      domainInvariant(
        selection.density.source.trim().length > 0,
        "MISSING_CONVERSION",
        "Food density requires a source",
      );
      return deepFreeze<ResolvedPortion>({
        grams: canonicalDecimal(decimal(milliliters).mul(density), "resolved portion grams"),
        conversion: {
          kind: "food-density",
          densitySource: selection.density.source,
        },
      });
    }
  }
}

function validateServing(serving: ServingDefinition): void {
  domainInvariant(
    serving.id.trim().length > 0 &&
      serving.label.trim().length > 0 &&
      serving.source.trim().length > 0 &&
      serving.reference.unit.trim().length > 0,
    "INVALID_PORTION",
    "Serving id, label, source, and reference unit are required",
  );
  canonicalPositiveDecimal(serving.reference.amount, "serving reference amount");
  canonicalPositiveDecimal(serving.gramWeight, "serving gram weight");
}
