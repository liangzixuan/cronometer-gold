import {
  REFERENCE_TARGET_ACKNOWLEDGEMENT_POLICY_CODE,
  REFERENCE_TARGET_ACKNOWLEDGEMENT_POLICY_VERSION,
  REFERENCE_TARGET_NOTICE,
  REFERENCE_TARGET_TEMPLATE_CODE,
  REFERENCE_TARGET_TEMPLATE_VERSION,
  type ReferenceTargetGroupCode,
  type ReferenceTargetSetSelectionRequest,
} from "@nutrition-tracker/contracts";

import { isLocalDate } from "../diary/diary";
import type { TargetableNutrient } from "./recipes-goals";

const REASONS = [
  "profile_missing_birth_date",
  "profile_sex_unsupported",
  "outside_reviewed_age",
  "nutrient_registry_unavailable",
] as const;
const SOURCE_BASE =
  "https://www.canada.ca/en/health-canada/services/food-nutrition/healthy-eating/dietary-reference-intakes";
const SOURCE_URLS = {
  overviewUrl: `${SOURCE_BASE}/tables.html`,
  macronutrientsUrl: `${SOURCE_BASE}/tables/reference-values-macronutrients.html`,
  elementsUrl: `${SOURCE_BASE}/tables/reference-values-elements.html`,
  vitaminsUrl: `${SOURCE_BASE}/tables/reference-values-vitamins.html`,
  reportListUrl: `${SOURCE_BASE}/dietary-reference-intake-report-list.html`,
} as const;
const ACKNOWLEDGEMENT_TEXT =
  "I confirm this template’s age/sex group and nonpregnant, nonlactating scope apply to me. I understand it may not fit medical conditions, medications, clinician-directed diets, current smoking, vegetarian iron needs, or unusually high sweat loss, and I can edit or remove it." as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u;
const CATEGORIES = new Set([
  "macronutrient",
  "vitamin",
  "mineral",
  "amino-acid",
  "fatty-acid",
  "other",
]);

type Reason = (typeof REASONS)[number];
type SourceKey = "macronutrientsUrl" | "elementsUrl" | "vitaminsUrl";
type PolicyRow = readonly [
  unit: string,
  target: string,
  maximum: string | null,
  kind: "rda" | "ai",
  maximumKind: "ul" | null,
  sourceRevision: string,
  sourceKey: SourceKey,
  table: string,
];

const common = {
  carbohydrate: ["g", "130", null, "rda", null, "IOM-2005", "macronutrientsUrl", "Table 1"],
  sodium: ["mg", "1500", null, "ai", null, "NASEM-2019", "elementsUrl", "Table 3"],
  calcium: ["mg", "1000", "2500", "rda", "ul", "IOM-2011", "elementsUrl", "Table 1"],
  "vitamin-d": ["ug", "15", "100", "rda", "ul", "IOM-2011", "vitaminsUrl", "Table 1"],
  "vitamin-b12": ["ug", "2.4", null, "rda", null, "IOM-1998", "vitaminsUrl", "Table 3"],
  "folate-dfe": ["ug_DFE", "400", null, "rda", null, "IOM-1998", "vitaminsUrl", "Table 3"],
} as const satisfies Readonly<Record<string, PolicyRow>>;

const POLICY: Readonly<Record<ReferenceTargetGroupCode, Readonly<Record<string, PolicyRow>>>> = {
  "male-19-50": {
    ...common,
    protein: ["g", "56", null, "rda", null, "IOM-2005", "macronutrientsUrl", "Table 1"],
    fiber: ["g", "38", null, "ai", null, "IOM-2005", "macronutrientsUrl", "Table 1"],
    potassium: ["mg", "3400", null, "ai", null, "NASEM-2019", "elementsUrl", "Table 3"],
    iron: ["mg", "8", "45", "rda", "ul", "IOM-2001", "elementsUrl", "Table 2"],
    "vitamin-c": ["mg", "90", "2000", "rda", "ul", "IOM-2000", "vitaminsUrl", "Table 2"],
    "vitamin-a-rae": ["ug_RAE", "900", null, "rda", null, "IOM-2001", "vitaminsUrl", "Table 1"],
  },
  "female-19-50": {
    ...common,
    protein: ["g", "46", null, "rda", null, "IOM-2005", "macronutrientsUrl", "Table 1"],
    fiber: ["g", "25", null, "ai", null, "IOM-2005", "macronutrientsUrl", "Table 1"],
    potassium: ["mg", "2600", null, "ai", null, "NASEM-2019", "elementsUrl", "Table 3"],
    iron: ["mg", "18", "45", "rda", "ul", "IOM-2001", "elementsUrl", "Table 2"],
    "vitamin-c": ["mg", "75", "2000", "rda", "ul", "IOM-2000", "vitaminsUrl", "Table 2"],
    "vitamin-a-rae": ["ug_RAE", "700", null, "rda", null, "IOM-2001", "vitaminsUrl", "Table 1"],
  },
};

export interface NativeReferenceTarget {
  readonly definition: TargetableNutrient;
  readonly minimumAmount: null;
  readonly targetAmount: string;
  readonly maximumAmount: string | null;
  readonly basis: {
    readonly timeBasis: "usual-average-daily-intake";
    readonly referenceType: "rda" | "ai";
    readonly maximumReferenceType: "ul" | null;
    readonly sourceRows: readonly string[];
  };
  readonly source: {
    readonly label: string;
    readonly version: string;
    readonly url: string;
    readonly table: string;
  };
  readonly rationale: string;
}

export interface NativeReferenceTargetSet {
  readonly templateCode: typeof REFERENCE_TARGET_TEMPLATE_CODE;
  readonly templateVersion: typeof REFERENCE_TARGET_TEMPLATE_VERSION;
  readonly groupCode: ReferenceTargetGroupCode;
  readonly title: string;
  readonly policyDigest: string;
  readonly eligibleThroughExclusive: string;
  readonly targets: readonly NativeReferenceTarget[];
}

export interface NativeReferenceTargetList {
  readonly date: string;
  readonly profileRevision: string;
  readonly availability: { readonly available: boolean; readonly reasonCodes: readonly Reason[] };
  readonly sets: readonly NativeReferenceTargetSet[];
  readonly acknowledgementPolicy: {
    readonly code: typeof REFERENCE_TARGET_ACKNOWLEDGEMENT_POLICY_CODE;
    readonly version: typeof REFERENCE_TARGET_ACKNOWLEDGEMENT_POLICY_VERSION;
    readonly text: string;
  };
  readonly sources: typeof SOURCE_URLS & {
    readonly code: "health-canada-dri-tables";
    readonly version: "2025-11-19";
    readonly reviewedOn: "2026-09-07";
  };
  readonly cautions: readonly { readonly code: string; readonly text: string }[];
  readonly applied: null | {
    readonly goalId: string;
    readonly goalVersionId: string;
    readonly goalRevision: string;
    readonly templateCode: typeof REFERENCE_TARGET_TEMPLATE_CODE;
    readonly templateVersion: typeof REFERENCE_TARGET_TEMPLATE_VERSION;
    readonly groupCode: ReferenceTargetGroupCode;
    readonly appliedProfileRevision: string;
    readonly policyDigest: string;
    readonly eligibleThroughExclusive: string;
    readonly acknowledgement: {
      readonly accepted: true;
      readonly acceptedAt: string;
      readonly policyCode: typeof REFERENCE_TARGET_ACKNOWLEDGEMENT_POLICY_CODE;
      readonly policyVersion: typeof REFERENCE_TARGET_ACKNOWLEDGEMENT_POLICY_VERSION;
    };
    readonly set: NativeReferenceTargetSet;
  };
  readonly notice: typeof REFERENCE_TARGET_NOTICE;
}

export interface NativeReferenceDraftTarget {
  readonly definition: TargetableNutrient;
  readonly minimumAmount: string;
  readonly targetAmount: string;
  readonly maximumAmount: string;
  readonly sourceLabel: string;
  readonly sourceVersion: string;
  readonly rationale: string;
}

export function nativeReferenceGoalRequest<TEnergy>(
  goalId: string | null,
  effectiveFrom: string,
  energy: TEnergy,
  expectedOwnerUserId: string,
  expectedProfileRevision: string,
  referenceTargetSet: ReferenceTargetSetSelectionRequest,
) {
  return {
    ...(goalId === null ? { effectiveFrom } : {}),
    energy,
    nutrientTargets: [] as const,
    expectedOwnerUserId,
    expectedProfileRevision,
    referenceTargetSet,
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every((key) => key in value);
}

function text(value: unknown, maximum = 1_000): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= maximum;
}

function revision(value: unknown): value is string {
  return typeof value === "string" && /^(?:0|[1-9][0-9]{0,19})$/u.test(value);
}

function utcDateTime(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?Z$/u.test(value)
  ) {
    return false;
  }
  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString().slice(0, 10) === value.slice(0, 10)
  );
}

function decimal(value: unknown): value is string {
  return typeof value === "string" && value.length <= 160 && DECIMAL.test(value);
}

function parseSources(value: unknown): NativeReferenceTargetList["sources"] {
  if (
    !record(value) ||
    !keys(value, ["code", "version", "reviewedOn", ...Object.keys(SOURCE_URLS)]) ||
    value.code !== "health-canada-dri-tables" ||
    value.version !== "2025-11-19" ||
    value.reviewedOn !== "2026-09-07" ||
    Object.entries(SOURCE_URLS).some(([key, url]) => value[key] !== url)
  ) {
    throw new TypeError("The source-verified candidate source set was invalid.");
  }
  return value as unknown as NativeReferenceTargetList["sources"];
}

function parseTarget(
  value: unknown,
  groupCode: ReferenceTargetGroupCode,
  sources: NativeReferenceTargetList["sources"],
): NativeReferenceTarget {
  if (
    !record(value) ||
    !keys(value, [
      "definition",
      "minimumAmount",
      "targetAmount",
      "maximumAmount",
      "basis",
      "source",
      "rationale",
    ]) ||
    value.minimumAmount !== null ||
    !decimal(value.targetAmount) ||
    !(value.maximumAmount === null || decimal(value.maximumAmount)) ||
    !record(value.definition) ||
    !keys(value.definition, ["id", "code", "name", "unit", "category"]) ||
    !revision(value.definition.id) ||
    value.definition.id === "0" ||
    !text(value.definition.code, 64) ||
    !text(value.definition.name, 200) ||
    !text(value.definition.unit, 32) ||
    typeof value.definition.category !== "string" ||
    !CATEGORIES.has(value.definition.category) ||
    !record(value.basis) ||
    !keys(value.basis, ["timeBasis", "referenceType", "maximumReferenceType", "sourceRows"]) ||
    value.basis.timeBasis !== "usual-average-daily-intake" ||
    !record(value.source) ||
    !keys(value.source, ["label", "version", "url", "table"]) ||
    !text(value.rationale)
  )
    throw new TypeError("A source-verified candidate target was invalid.");

  const row = POLICY[groupCode][value.definition.code];
  const sourceRows =
    groupCode === "male-19-50"
      ? ["Males 19–30 y", "Males 31–50 y"]
      : ["Females 19–30 y", "Females 31–50 y"];
  if (
    !row ||
    value.definition.unit !== row[0] ||
    value.targetAmount !== row[1] ||
    value.maximumAmount !== row[2] ||
    value.basis.referenceType !== row[3] ||
    value.basis.maximumReferenceType !== row[4] ||
    !Array.isArray(value.basis.sourceRows) ||
    value.basis.sourceRows.length !== 2 ||
    value.basis.sourceRows.some((item, index) => item !== sourceRows[index]) ||
    value.source.label !== "Health Canada Dietary Reference Intakes" ||
    value.source.version !== `HC-2025-11-19/${row[5]}` ||
    value.source.url !== sources[row[6]] ||
    value.source.table !== row[7] ||
    value.rationale !==
      `Source-verified U.S.–Canada adult 19–50 ${row[3].toUpperCase()} population reference.`
  )
    throw new TypeError("A source-verified candidate target did not match its pinned policy row.");
  return {
    definition: {
      nutrientId: value.definition.id,
      code: value.definition.code,
      name: value.definition.name,
      unit: value.definition.unit,
      category: value.definition.category as TargetableNutrient["category"],
    },
    minimumAmount: null,
    targetAmount: value.targetAmount,
    maximumAmount: value.maximumAmount,
    basis: value.basis as NativeReferenceTarget["basis"],
    source: value.source as NativeReferenceTarget["source"],
    rationale: value.rationale,
  };
}

function parseSet(
  candidate: unknown,
  sources: NativeReferenceTargetList["sources"],
): NativeReferenceTargetSet {
  if (
    !record(candidate) ||
    !keys(candidate, [
      "templateCode",
      "templateVersion",
      "groupCode",
      "title",
      "policyDigest",
      "eligibleThroughExclusive",
      "targets",
    ]) ||
    candidate.templateCode !== REFERENCE_TARGET_TEMPLATE_CODE ||
    candidate.templateVersion !== REFERENCE_TARGET_TEMPLATE_VERSION ||
    (candidate.groupCode !== "male-19-50" && candidate.groupCode !== "female-19-50") ||
    candidate.title !==
      `U.S.–Canada reference candidate: ${
        candidate.groupCode === "male-19-50" ? "male" : "female"
      } adults 19–50` ||
    typeof candidate.policyDigest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(candidate.policyDigest) ||
    !isLocalDate(candidate.eligibleThroughExclusive) ||
    !Array.isArray(candidate.targets) ||
    candidate.targets.length !== 12
  ) {
    throw new TypeError("A source-verified candidate set was invalid.");
  }
  const groupCode = candidate.groupCode as ReferenceTargetGroupCode;
  const targets = candidate.targets.map((target) => parseTarget(target, groupCode, sources));
  if (
    new Set(targets.map((target) => target.definition.code)).size !== 12 ||
    new Set(targets.map((target) => target.definition.nutrientId)).size !== 12
  ) {
    throw new TypeError("A source-verified candidate set contained duplicate nutrients.");
  }
  return {
    templateCode: REFERENCE_TARGET_TEMPLATE_CODE,
    templateVersion: REFERENCE_TARGET_TEMPLATE_VERSION,
    groupCode,
    title: candidate.title,
    policyDigest: candidate.policyDigest,
    eligibleThroughExclusive: candidate.eligibleThroughExclusive,
    targets,
  };
}

export function parseNativeReferenceTargetSets(value: unknown): NativeReferenceTargetList {
  if (!record(value) || !keys(value, ["data"]) || !record(value.data)) {
    throw new TypeError("The source-verified candidate response was invalid.");
  }
  const data = value.data;
  if (
    !keys(data, [
      "date",
      "profileRevision",
      "availability",
      "sets",
      "acknowledgementPolicy",
      "sources",
      "cautions",
      "applied",
      "notice",
    ]) ||
    !isLocalDate(data.date) ||
    !revision(data.profileRevision) ||
    !record(data.availability) ||
    !keys(data.availability, ["available", "reasonCodes"]) ||
    typeof data.availability.available !== "boolean" ||
    !Array.isArray(data.availability.reasonCodes) ||
    data.availability.reasonCodes.some((reason) => !REASONS.includes(reason as Reason)) ||
    new Set(data.availability.reasonCodes).size !== data.availability.reasonCodes.length ||
    !Array.isArray(data.sets) ||
    data.sets.length > 1 ||
    !record(data.acknowledgementPolicy) ||
    !keys(data.acknowledgementPolicy, ["code", "version", "text"]) ||
    data.acknowledgementPolicy.code !== REFERENCE_TARGET_ACKNOWLEDGEMENT_POLICY_CODE ||
    data.acknowledgementPolicy.version !== REFERENCE_TARGET_ACKNOWLEDGEMENT_POLICY_VERSION ||
    data.acknowledgementPolicy.text !== ACKNOWLEDGEMENT_TEXT ||
    !Array.isArray(data.cautions) ||
    data.cautions.length < 1 ||
    data.notice !== REFERENCE_TARGET_NOTICE
  )
    throw new TypeError("The source-verified candidate response was invalid.");
  const sources = parseSources(data.sources);
  const sets = data.sets.map((candidate) => parseSet(candidate, sources));
  if (
    data.availability.available !== (sets.length === 1) ||
    (data.availability.available && data.availability.reasonCodes.length > 0)
  ) {
    throw new TypeError("Source-verified candidate availability was contradictory.");
  }
  const cautions = data.cautions.map((caution) => {
    if (
      !record(caution) ||
      !keys(caution, ["code", "text"]) ||
      !text(caution.code, 80) ||
      !text(caution.text)
    ) {
      throw new TypeError("A source-verified candidate caution was invalid.");
    }
    return { code: caution.code, text: caution.text };
  });
  let applied: NativeReferenceTargetList["applied"] = null;
  if (data.applied !== null) {
    const item = data.applied;
    if (
      !record(item) ||
      !keys(item, [
        "goalId",
        "goalVersionId",
        "goalRevision",
        "templateCode",
        "templateVersion",
        "groupCode",
        "appliedProfileRevision",
        "policyDigest",
        "eligibleThroughExclusive",
        "acknowledgement",
        "set",
      ]) ||
      !UUID.test(String(item.goalId)) ||
      !UUID.test(String(item.goalVersionId)) ||
      !revision(item.goalRevision) ||
      item.templateCode !== REFERENCE_TARGET_TEMPLATE_CODE ||
      item.templateVersion !== REFERENCE_TARGET_TEMPLATE_VERSION ||
      (item.groupCode !== "male-19-50" && item.groupCode !== "female-19-50") ||
      !revision(item.appliedProfileRevision) ||
      typeof item.policyDigest !== "string" ||
      !/^[0-9a-f]{64}$/u.test(item.policyDigest) ||
      !isLocalDate(item.eligibleThroughExclusive) ||
      !record(item.acknowledgement) ||
      !keys(item.acknowledgement, ["accepted", "acceptedAt", "policyCode", "policyVersion"]) ||
      item.acknowledgement.accepted !== true ||
      !utcDateTime(item.acknowledgement.acceptedAt) ||
      item.acknowledgement.policyCode !== REFERENCE_TARGET_ACKNOWLEDGEMENT_POLICY_CODE ||
      item.acknowledgement.policyVersion !== REFERENCE_TARGET_ACKNOWLEDGEMENT_POLICY_VERSION
    )
      throw new TypeError("Applied source-verified candidate provenance was invalid.");
    const persistedSet = parseSet(item.set, sources);
    if (
      persistedSet.templateCode !== item.templateCode ||
      persistedSet.templateVersion !== item.templateVersion ||
      persistedSet.groupCode !== item.groupCode ||
      persistedSet.policyDigest !== item.policyDigest ||
      persistedSet.eligibleThroughExclusive !== item.eligibleThroughExclusive
    ) {
      throw new TypeError("Applied source-verified candidate snapshot identity was invalid.");
    }
    applied = {
      goalId: item.goalId as string,
      goalVersionId: item.goalVersionId as string,
      goalRevision: item.goalRevision,
      templateCode: REFERENCE_TARGET_TEMPLATE_CODE,
      templateVersion: REFERENCE_TARGET_TEMPLATE_VERSION,
      groupCode: item.groupCode as ReferenceTargetGroupCode,
      appliedProfileRevision: item.appliedProfileRevision,
      policyDigest: item.policyDigest,
      eligibleThroughExclusive: item.eligibleThroughExclusive,
      acknowledgement: {
        accepted: true,
        acceptedAt: item.acknowledgement.acceptedAt,
        policyCode: REFERENCE_TARGET_ACKNOWLEDGEMENT_POLICY_CODE,
        policyVersion: REFERENCE_TARGET_ACKNOWLEDGEMENT_POLICY_VERSION,
      },
      set: persistedSet,
    };
  }
  return {
    date: data.date,
    profileRevision: data.profileRevision,
    availability: {
      available: data.availability.available,
      reasonCodes: data.availability.reasonCodes as Reason[],
    },
    sets,
    acknowledgementPolicy:
      data.acknowledgementPolicy as NativeReferenceTargetList["acknowledgementPolicy"],
    sources,
    cautions,
    applied,
    notice: REFERENCE_TARGET_NOTICE,
  };
}

export function nativeReferenceSelection(
  list: NativeReferenceTargetList,
  set: NativeReferenceTargetSet,
): ReferenceTargetSetSelectionRequest {
  if (!list.availability.available || list.sets[0]?.groupCode !== set.groupCode) {
    throw new RangeError("This source-verified candidate is not currently available.");
  }
  return {
    templateCode: set.templateCode,
    templateVersion: set.templateVersion,
    groupCode: set.groupCode,
    eligibilityAcknowledgement: {
      policyCode: list.acknowledgementPolicy.code,
      policyVersion: list.acknowledgementPolicy.version,
      accepted: true,
    },
  };
}

export function nativeReferenceDraftTargets(
  set: NativeReferenceTargetSet,
  customized = false,
): readonly NativeReferenceDraftTarget[] {
  return set.targets.map((target) => ({
    definition: target.definition,
    minimumAmount: "",
    targetAmount: target.targetAmount,
    maximumAmount: target.maximumAmount ?? "",
    sourceLabel: customized
      ? `User-customized copy of ${target.source.label}`.slice(0, 160)
      : target.source.label,
    sourceVersion: target.source.version,
    rationale: customized
      ? "User-editable copy; verified reference-template identity cleared."
      : target.rationale,
  }));
}

export function nativeAppliedReferenceMatchesGoal(
  applied: NativeReferenceTargetList["applied"],
  goal: { readonly id: string; readonly versionId: string; readonly revision: string } | null,
): boolean {
  return (
    applied !== null &&
    goal !== null &&
    applied.goalId === goal.id &&
    applied.goalVersionId === goal.versionId &&
    applied.goalRevision === goal.revision
  );
}

export function nativeCarriedReferenceSet(
  list: NativeReferenceTargetList,
  goal: { readonly id: string; readonly versionId: string; readonly revision: string } | null,
): NativeReferenceTargetSet | null {
  const applied = list.applied;
  if (
    !nativeAppliedReferenceMatchesGoal(applied, goal) ||
    applied?.appliedProfileRevision !== list.profileRevision
  )
    return null;
  const currentCandidate = list.sets.find(
    (candidate) =>
      candidate.groupCode === applied.groupCode && candidate.policyDigest === applied.policyDigest,
  );
  return currentCandidate ? applied.set : null;
}

export function nativeAppliedReferenceSetForDisplay(
  list: NativeReferenceTargetList | null,
  goal: { readonly id: string; readonly versionId: string; readonly revision: string } | null,
): NativeReferenceTargetSet | null {
  return nativeAppliedReferenceMatchesGoal(list?.applied ?? null, goal)
    ? (list?.applied?.set ?? null)
    : null;
}

export function nativeReferenceAvailability(reasons: readonly Reason[]): string {
  if (reasons.includes("profile_missing_birth_date"))
    return "Add a birth date to check the source-verified age range.";
  if (reasons.includes("profile_sex_unsupported"))
    return "The source publishes only female and male groups; custom targets remain available.";
  if (reasons.includes("outside_reviewed_age"))
    return "This source-verified candidate applies only from age 19 through the day before age 51.";
  return "The source-verified nutrient definitions are temporarily unavailable; custom targets still work.";
}

export function nativeReferenceTargetSectionVisible(
  templatesSupported: boolean,
  list: NativeReferenceTargetList | null,
): list is NativeReferenceTargetList {
  return templatesSupported && list !== null;
}
