import { createHash } from "node:crypto";

export const REFERENCE_TARGET_TEMPLATE_CODE = "us-ca-dri-adults-19-50" as const;
export const REFERENCE_TARGET_TEMPLATE_VERSION = "1" as const;
export const REFERENCE_TARGET_ACKNOWLEDGEMENT_POLICY_CODE =
  "us-ca-dri-adults-19-50-eligibility-ack" as const;
export const REFERENCE_TARGET_ACKNOWLEDGEMENT_POLICY_VERSION = "1" as const;
export const REFERENCE_TARGET_ACKNOWLEDGEMENT_TEXT =
  "I confirm this template’s age/sex group and nonpregnant, nonlactating scope apply to me. I understand it may not fit medical conditions, medications, clinician-directed diets, current smoking, vegetarian iron needs, or unusually high sweat loss, and I can edit or remove it." as const;
export const REFERENCE_TARGET_NOTICE =
  "This optional template copies U.S.–Canada population reference values into your goals. It is for usual intake by apparently healthy adults in the selected group, not a diagnosis, prescription, or proof of adequacy. A single day above or below a reference does not determine nutrient status." as const;

export const REFERENCE_TARGET_SOURCES = {
  code: "health-canada-dri-tables",
  version: "2025-11-19",
  reviewedOn: "2026-09-07",
  overviewUrl:
    "https://www.canada.ca/en/health-canada/services/food-nutrition/healthy-eating/dietary-reference-intakes/tables.html",
  macronutrientsUrl:
    "https://www.canada.ca/en/health-canada/services/food-nutrition/healthy-eating/dietary-reference-intakes/tables/reference-values-macronutrients.html",
  elementsUrl:
    "https://www.canada.ca/en/health-canada/services/food-nutrition/healthy-eating/dietary-reference-intakes/tables/reference-values-elements.html",
  vitaminsUrl:
    "https://www.canada.ca/en/health-canada/services/food-nutrition/healthy-eating/dietary-reference-intakes/tables/reference-values-vitamins.html",
  reportListUrl:
    "https://www.canada.ca/en/health-canada/services/food-nutrition/healthy-eating/dietary-reference-intakes/dietary-reference-intake-report-list.html",
} as const;

export const REFERENCE_TARGET_CAUTIONS = [
  {
    code: "ul-not-target",
    text: "An upper level is not a recommended intake or a guarantee of safety.",
  },
  {
    code: "single-day-not-status",
    text: "A single day above or below a reference does not establish adequacy, deficiency, or toxicity.",
  },
  {
    code: "potassium-impaired-excretion",
    text: "The potassium AI does not apply when a medical condition or medication impairs potassium excretion.",
  },
  {
    code: "vitamin-c-current-smoking",
    text: "Current smokers require 35 mg/day additional vitamin C under the source footnote.",
  },
  {
    code: "iron-vegetarian",
    text: "The source states iron requirements are 1.8 times higher for vegetarian diets because of lower bioavailability.",
  },
  {
    code: "iron-female-table-assumption",
    text: "The female iron row is a population reference using the source table’s menstruation assumptions, not an individualized target.",
  },
  {
    code: "vitamin-d-minimal-sun",
    text: "The vitamin D reference assumes minimal sun exposure.",
  },
  {
    code: "sodium-high-sweat",
    text: "Unusually high sweat loss may require individualized sodium intake.",
  },
  {
    code: "folate-folic-acid-distinction",
    text: "Total DFE does not establish compliance with separate folic-acid advice for people capable of becoming pregnant.",
  },
  {
    code: "clinical-exclusions",
    text: "Pregnancy, lactation, diagnosed conditions, medications, clinician-directed diets, malabsorption/bariatric care, kidney/cardiac disease, eating-disorder care, and therapeutic or athlete sweat-replacement targets remain out of scope.",
  },
] as const;

export type ReferenceTargetGroupCode = "male-19-50" | "female-19-50";
export type ReferenceTargetAvailabilityReasonCode =
  | "profile_missing_birth_date"
  | "profile_sex_unsupported"
  | "outside_reviewed_age"
  | "nutrient_registry_unavailable";

export interface ReferenceTargetSelectionInput {
  readonly templateCode: string;
  readonly templateVersion: string;
  readonly groupCode: string;
  readonly eligibilityAcknowledgement: {
    readonly policyCode: string;
    readonly policyVersion: string;
    readonly accepted: boolean;
  };
}

export interface ReferenceTargetPolicyRow {
  readonly code: string;
  readonly unit: string;
  readonly targetAmount: string;
  readonly maximumAmount: string | null;
  readonly referenceType: "rda" | "ai";
  readonly maximumReferenceType: "ul" | null;
  readonly sourceLabel: "Health Canada Dietary Reference Intakes";
  readonly sourceVersion: string;
  readonly sourceUrl: string;
  readonly sourceTable: string;
  readonly rationale: string;
}

const common = {
  carbohydrate: row(
    "carbohydrate",
    "g",
    "130",
    null,
    "rda",
    null,
    "IOM-2005",
    "macronutrients",
    "Table 1",
  ),
  sodium: row("sodium", "mg", "1500", null, "ai", null, "NASEM-2019", "elements", "Table 3"),
  calcium: row("calcium", "mg", "1000", "2500", "rda", "ul", "IOM-2011", "elements", "Table 1"),
  "vitamin-d": row("vitamin-d", "ug", "15", "100", "rda", "ul", "IOM-2011", "vitamins", "Table 1"),
  "vitamin-b12": row(
    "vitamin-b12",
    "ug",
    "2.4",
    null,
    "rda",
    null,
    "IOM-1998",
    "vitamins",
    "Table 3",
  ),
  "folate-dfe": row(
    "folate-dfe",
    "ug_DFE",
    "400",
    null,
    "rda",
    null,
    "IOM-1998",
    "vitamins",
    "Table 3",
  ),
} as const;

const POLICY_ROWS: Readonly<Record<ReferenceTargetGroupCode, readonly ReferenceTargetPolicyRow[]>> =
  {
    "male-19-50": [
      common.carbohydrate,
      row("protein", "g", "56", null, "rda", null, "IOM-2005", "macronutrients", "Table 1"),
      row("fiber", "g", "38", null, "ai", null, "IOM-2005", "macronutrients", "Table 1"),
      common.sodium,
      row("potassium", "mg", "3400", null, "ai", null, "NASEM-2019", "elements", "Table 3"),
      common.calcium,
      row("iron", "mg", "8", "45", "rda", "ul", "IOM-2001", "elements", "Table 2"),
      row("vitamin-c", "mg", "90", "2000", "rda", "ul", "IOM-2000", "vitamins", "Table 2"),
      common["vitamin-d"],
      common["vitamin-b12"],
      common["folate-dfe"],
      row("vitamin-a-rae", "ug_RAE", "900", null, "rda", null, "IOM-2001", "vitamins", "Table 1"),
    ],
    "female-19-50": [
      common.carbohydrate,
      row("protein", "g", "46", null, "rda", null, "IOM-2005", "macronutrients", "Table 1"),
      row("fiber", "g", "25", null, "ai", null, "IOM-2005", "macronutrients", "Table 1"),
      common.sodium,
      row("potassium", "mg", "2600", null, "ai", null, "NASEM-2019", "elements", "Table 3"),
      common.calcium,
      row("iron", "mg", "18", "45", "rda", "ul", "IOM-2001", "elements", "Table 2"),
      row("vitamin-c", "mg", "75", "2000", "rda", "ul", "IOM-2000", "vitamins", "Table 2"),
      common["vitamin-d"],
      common["vitamin-b12"],
      common["folate-dfe"],
      row("vitamin-a-rae", "ug_RAE", "700", null, "rda", null, "IOM-2001", "vitamins", "Table 1"),
    ],
  };

function row(
  code: string,
  unit: string,
  targetAmount: string,
  maximumAmount: string | null,
  referenceType: "rda" | "ai",
  maximumReferenceType: "ul" | null,
  sourceRevision: string,
  sourceKind: "macronutrients" | "elements" | "vitamins",
  sourceTable: string,
): ReferenceTargetPolicyRow {
  return {
    code,
    maximumAmount,
    maximumReferenceType,
    rationale: `Source-verified U.S.–Canada adult 19–50 ${referenceType.toUpperCase()} population reference.`,
    referenceType,
    sourceLabel: "Health Canada Dietary Reference Intakes",
    sourceTable,
    sourceUrl:
      sourceKind === "macronutrients"
        ? REFERENCE_TARGET_SOURCES.macronutrientsUrl
        : sourceKind === "elements"
          ? REFERENCE_TARGET_SOURCES.elementsUrl
          : REFERENCE_TARGET_SOURCES.vitaminsUrl,
    sourceVersion: `HC-2025-11-19/${sourceRevision}`,
    targetAmount,
    unit,
  };
}

export function referenceTargetPolicy(groupCode: ReferenceTargetGroupCode): {
  readonly groupCode: ReferenceTargetGroupCode;
  readonly title: string;
  readonly rows: readonly ReferenceTargetPolicyRow[];
  readonly policyDigest: string;
} {
  assertReferenceSourcesHttps();
  const rows = POLICY_ROWS[groupCode];
  const title =
    groupCode === "male-19-50"
      ? "U.S.–Canada reference candidate: male adults 19–50"
      : "U.S.–Canada reference candidate: female adults 19–50";
  return {
    groupCode,
    policyDigest: digest({
      acknowledgement: {
        code: REFERENCE_TARGET_ACKNOWLEDGEMENT_POLICY_CODE,
        text: REFERENCE_TARGET_ACKNOWLEDGEMENT_TEXT,
        version: REFERENCE_TARGET_ACKNOWLEDGEMENT_POLICY_VERSION,
      },
      cautions: REFERENCE_TARGET_CAUTIONS,
      groupCode,
      notice: REFERENCE_TARGET_NOTICE,
      rows,
      sources: REFERENCE_TARGET_SOURCES,
      templateCode: REFERENCE_TARGET_TEMPLATE_CODE,
      templateVersion: REFERENCE_TARGET_TEMPLATE_VERSION,
    }),
    rows,
    title,
  };
}

export function assertReferenceSourcesHttps(): void {
  for (const [key, value] of Object.entries(REFERENCE_TARGET_SOURCES)) {
    if (key.endsWith("Url") && (typeof value !== "string" || !value.startsWith("https://"))) {
      throw new Error("Reference target source URLs must use HTTPS");
    }
  }
}

export function assertReferenceTargetSelection(
  selection: ReferenceTargetSelectionInput,
): ReferenceTargetGroupCode {
  if (
    selection.templateCode !== REFERENCE_TARGET_TEMPLATE_CODE ||
    selection.templateVersion !== REFERENCE_TARGET_TEMPLATE_VERSION ||
    (selection.groupCode !== "male-19-50" && selection.groupCode !== "female-19-50") ||
    selection.eligibilityAcknowledgement.policyCode !==
      REFERENCE_TARGET_ACKNOWLEDGEMENT_POLICY_CODE ||
    selection.eligibilityAcknowledgement.policyVersion !==
      REFERENCE_TARGET_ACKNOWLEDGEMENT_POLICY_VERSION ||
    selection.eligibilityAcknowledgement.accepted !== true
  ) {
    throw new Error("Unsupported reference target selection");
  }
  return selection.groupCode;
}

export function referenceSourceRows(groupCode: ReferenceTargetGroupCode): readonly string[] {
  return groupCode === "male-19-50"
    ? ["Males 19–30 y", "Males 31–50 y"]
    : ["Females 19–30 y", "Females 31–50 y"];
}

export function referenceEligibleThroughExclusive(birthDate: string): string {
  const [year, month, day] = birthDate.split("-").map(Number) as [number, number, number];
  const birthday = new Date(0);
  birthday.setUTCHours(0, 0, 0, 0);
  birthday.setUTCFullYear(year + 51, month - 1, day);
  return birthday.toISOString().slice(0, 10);
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}
