import { isLocalDate } from "./diary";
import type { TargetableNutrient } from "./recipes-goals";

const TEMPLATE_CODE = "us-ca-dri-adults-19-50" as const;
const TEMPLATE_VERSION = "1" as const;
const ACKNOWLEDGEMENT_POLICY_CODE = "us-ca-dri-adults-19-50-eligibility-ack" as const;
const ACKNOWLEDGEMENT_POLICY_VERSION = "1" as const;
const ACKNOWLEDGEMENT_TEXT =
  "I confirm this template’s age/sex group and nonpregnant, nonlactating scope apply to me. I understand it may not fit medical conditions, medications, clinician-directed diets, current smoking, vegetarian iron needs, or unusually high sweat loss, and I can edit or remove it." as const;
const REFERENCE_NOTICE =
  "This optional template copies U.S.–Canada population reference values into your goals. It is for usual intake by apparently healthy adults in the selected group, not a diagnosis, prescription, or proof of adequacy. A single day above or below a reference does not determine nutrient status." as const;
const GROUP_CODES = ["male-19-50", "female-19-50"] as const;
const AVAILABILITY_REASONS = [
  "profile_missing_birth_date",
  "profile_sex_unsupported",
  "outside_reviewed_age",
  "nutrient_registry_unavailable",
] as const;
const CATEGORIES = new Set([
  "energy",
  "macronutrient",
  "vitamin",
  "mineral",
  "amino-acid",
  "fatty-acid",
  "other",
]);
const EXACT_DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SOURCE_BASE =
  "https://www.canada.ca/en/health-canada/services/food-nutrition/healthy-eating/dietary-reference-intakes";
const SOURCE_URLS = {
  overviewUrl: `${SOURCE_BASE}/tables.html`,
  macronutrientsUrl: `${SOURCE_BASE}/tables/reference-values-macronutrients.html`,
  elementsUrl: `${SOURCE_BASE}/tables/reference-values-elements.html`,
  vitaminsUrl: `${SOURCE_BASE}/tables/reference-values-vitamins.html`,
  reportListUrl: `${SOURCE_BASE}/dietary-reference-intake-report-list.html`,
} as const;

interface ExpectedTargetPolicy {
  readonly unit: string;
  readonly targetAmount: string;
  readonly maximumAmount: string | null;
  readonly referenceType: "rda" | "ai";
  readonly maximumReferenceType: "ul" | null;
  readonly sourceVersion: string;
  readonly sourceTable: string;
  readonly sourceKind: "macronutrientsUrl" | "elementsUrl" | "vitaminsUrl";
}

const sharedPolicy = {
  carbohydrate: expected("g", "130", null, "rda", null, "IOM-2005", "Table 1", "macronutrientsUrl"),
  sodium: expected("mg", "1500", null, "ai", null, "NASEM-2019", "Table 3", "elementsUrl"),
  calcium: expected("mg", "1000", "2500", "rda", "ul", "IOM-2011", "Table 1", "elementsUrl"),
  "vitamin-d": expected("ug", "15", "100", "rda", "ul", "IOM-2011", "Table 1", "vitaminsUrl"),
  "vitamin-b12": expected("ug", "2.4", null, "rda", null, "IOM-1998", "Table 3", "vitaminsUrl"),
  "folate-dfe": expected("ug_DFE", "400", null, "rda", null, "IOM-1998", "Table 3", "vitaminsUrl"),
} as const;

const EXPECTED_POLICY: Readonly<
  Record<ReferenceTargetGroupCode, Readonly<Record<string, ExpectedTargetPolicy>>>
> = {
  "male-19-50": {
    ...sharedPolicy,
    protein: expected("g", "56", null, "rda", null, "IOM-2005", "Table 1", "macronutrientsUrl"),
    fiber: expected("g", "38", null, "ai", null, "IOM-2005", "Table 1", "macronutrientsUrl"),
    potassium: expected("mg", "3400", null, "ai", null, "NASEM-2019", "Table 3", "elementsUrl"),
    iron: expected("mg", "8", "45", "rda", "ul", "IOM-2001", "Table 2", "elementsUrl"),
    "vitamin-c": expected("mg", "90", "2000", "rda", "ul", "IOM-2000", "Table 2", "vitaminsUrl"),
    "vitamin-a-rae": expected(
      "ug_RAE",
      "900",
      null,
      "rda",
      null,
      "IOM-2001",
      "Table 1",
      "vitaminsUrl",
    ),
  },
  "female-19-50": {
    ...sharedPolicy,
    protein: expected("g", "46", null, "rda", null, "IOM-2005", "Table 1", "macronutrientsUrl"),
    fiber: expected("g", "25", null, "ai", null, "IOM-2005", "Table 1", "macronutrientsUrl"),
    potassium: expected("mg", "2600", null, "ai", null, "NASEM-2019", "Table 3", "elementsUrl"),
    iron: expected("mg", "18", "45", "rda", "ul", "IOM-2001", "Table 2", "elementsUrl"),
    "vitamin-c": expected("mg", "75", "2000", "rda", "ul", "IOM-2000", "Table 2", "vitaminsUrl"),
    "vitamin-a-rae": expected(
      "ug_RAE",
      "700",
      null,
      "rda",
      null,
      "IOM-2001",
      "Table 1",
      "vitaminsUrl",
    ),
  },
};

function expected(
  unit: string,
  targetAmount: string,
  maximumAmount: string | null,
  referenceType: "rda" | "ai",
  maximumReferenceType: "ul" | null,
  sourceRevision: string,
  sourceTable: string,
  sourceKind: ExpectedTargetPolicy["sourceKind"],
): ExpectedTargetPolicy {
  return {
    unit,
    targetAmount,
    maximumAmount,
    referenceType,
    maximumReferenceType,
    sourceVersion: `HC-2025-11-19/${sourceRevision}`,
    sourceTable,
    sourceKind,
  };
}

export type ReferenceTargetGroupCode = (typeof GROUP_CODES)[number];
export type ReferenceTargetAvailabilityReason = (typeof AVAILABILITY_REASONS)[number];

export interface ReferenceTargetValue {
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

export interface ReferenceTargetSet {
  readonly templateCode: typeof TEMPLATE_CODE;
  readonly templateVersion: typeof TEMPLATE_VERSION;
  readonly groupCode: ReferenceTargetGroupCode;
  readonly title: string;
  readonly policyDigest: string;
  readonly eligibleThroughExclusive: string;
  readonly targets: readonly ReferenceTargetValue[];
}

export interface ReferenceTargetSetList {
  readonly date: string;
  readonly profileRevision: string;
  readonly availability: {
    readonly available: boolean;
    readonly reasonCodes: readonly ReferenceTargetAvailabilityReason[];
  };
  readonly sets: readonly ReferenceTargetSet[];
  readonly acknowledgementPolicy: {
    readonly code: typeof ACKNOWLEDGEMENT_POLICY_CODE;
    readonly version: typeof ACKNOWLEDGEMENT_POLICY_VERSION;
    readonly text: string;
  };
  readonly sources: {
    readonly code: "health-canada-dri-tables";
    readonly version: "2025-11-19";
    readonly reviewedOn: "2026-09-07";
    readonly overviewUrl: string;
    readonly macronutrientsUrl: string;
    readonly elementsUrl: string;
    readonly vitaminsUrl: string;
    readonly reportListUrl: string;
  };
  readonly cautions: readonly { readonly code: string; readonly text: string }[];
  readonly applied: {
    readonly goalId: string;
    readonly goalVersionId: string;
    readonly goalRevision: string;
    readonly templateCode: typeof TEMPLATE_CODE;
    readonly templateVersion: typeof TEMPLATE_VERSION;
    readonly groupCode: ReferenceTargetGroupCode;
    readonly appliedProfileRevision: string;
    readonly policyDigest: string;
    readonly eligibleThroughExclusive: string;
    readonly acknowledgement: {
      readonly accepted: true;
      readonly acceptedAt: string;
      readonly policyCode: typeof ACKNOWLEDGEMENT_POLICY_CODE;
      readonly policyVersion: typeof ACKNOWLEDGEMENT_POLICY_VERSION;
    };
    readonly set: ReferenceTargetSet;
  } | null;
  readonly notice: typeof REFERENCE_NOTICE;
}

export interface ReferenceTargetSelection {
  readonly templateCode: typeof TEMPLATE_CODE;
  readonly templateVersion: typeof TEMPLATE_VERSION;
  readonly groupCode: ReferenceTargetGroupCode;
  readonly eligibilityAcknowledgement: {
    readonly policyCode: typeof ACKNOWLEDGEMENT_POLICY_CODE;
    readonly policyVersion: typeof ACKNOWLEDGEMENT_POLICY_VERSION;
    readonly accepted: true;
  };
}

export interface ReferenceDraftTarget {
  readonly definition: TargetableNutrient;
  readonly minimumAmount: string;
  readonly targetAmount: string;
  readonly maximumAmount: string;
  readonly sourceLabel: string;
  readonly sourceVersion: string;
  readonly rationale: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return (
    Object.keys(value).length === expected.size &&
    Object.keys(value).every((key) => expected.has(key))
  );
}

function text(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === "string" && value.length >= minimum && value.length <= maximum;
}

function positiveIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]{0,19}$/u.test(value);
}

function revisionIdentifier(value: unknown): value is string {
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

function exactDecimal(value: unknown): value is string {
  return typeof value === "string" && value.length <= 160 && EXACT_DECIMAL.test(value);
}

function httpsUrl(value: unknown): value is string {
  if (!text(value, 1, 500)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

function definition(value: unknown): TargetableNutrient {
  if (
    !record(value) ||
    !exactKeys(value, ["id", "code", "name", "unit", "category"]) ||
    !positiveIdentifier(value.id) ||
    !text(value.code, 1, 64) ||
    !text(value.name, 1, 200) ||
    !text(value.unit, 1, 32) ||
    typeof value.category !== "string" ||
    !CATEGORIES.has(value.category) ||
    value.category === "energy" ||
    value.code === "energy"
  ) {
    throw new TypeError("A source-verified candidate nutrient definition was invalid.");
  }
  return {
    nutrientId: value.id,
    code: value.code,
    name: value.name,
    unit: value.unit,
    category: value.category,
  };
}

function target(value: unknown): ReferenceTargetValue {
  if (
    !record(value) ||
    !exactKeys(value, [
      "definition",
      "minimumAmount",
      "targetAmount",
      "maximumAmount",
      "basis",
      "source",
      "rationale",
    ]) ||
    value.minimumAmount !== null ||
    !exactDecimal(value.targetAmount) ||
    !(value.maximumAmount === null || exactDecimal(value.maximumAmount)) ||
    !record(value.basis) ||
    !exactKeys(value.basis, ["timeBasis", "referenceType", "maximumReferenceType", "sourceRows"]) ||
    value.basis.timeBasis !== "usual-average-daily-intake" ||
    !["rda", "ai"].includes(String(value.basis.referenceType)) ||
    !(value.basis.maximumReferenceType === null || value.basis.maximumReferenceType === "ul") ||
    (value.maximumAmount === null) !== (value.basis.maximumReferenceType === null) ||
    !Array.isArray(value.basis.sourceRows) ||
    value.basis.sourceRows.length !== 2 ||
    new Set(value.basis.sourceRows).size !== 2 ||
    !value.basis.sourceRows.every((row) => text(row, 1, 80)) ||
    !record(value.source) ||
    !exactKeys(value.source, ["label", "version", "url", "table"]) ||
    !text(value.source.label, 1, 160) ||
    !text(value.source.version, 1, 100) ||
    !httpsUrl(value.source.url) ||
    !text(value.source.table, 1, 32) ||
    !text(value.rationale, 1, 1_000)
  ) {
    throw new TypeError("A source-verified candidate target was invalid.");
  }
  return {
    definition: definition(value.definition),
    minimumAmount: null,
    targetAmount: value.targetAmount,
    maximumAmount: value.maximumAmount,
    basis: {
      timeBasis: "usual-average-daily-intake",
      referenceType: value.basis.referenceType as "rda" | "ai",
      maximumReferenceType: value.basis.maximumReferenceType as "ul" | null,
      sourceRows: value.basis.sourceRows as readonly string[],
    },
    source: {
      label: value.source.label,
      version: value.source.version,
      url: value.source.url,
      table: value.source.table,
    },
    rationale: value.rationale,
  };
}

function set(value: unknown): ReferenceTargetSet {
  if (
    !record(value) ||
    !exactKeys(value, [
      "templateCode",
      "templateVersion",
      "groupCode",
      "title",
      "policyDigest",
      "eligibleThroughExclusive",
      "targets",
    ]) ||
    value.templateCode !== TEMPLATE_CODE ||
    value.templateVersion !== TEMPLATE_VERSION ||
    !GROUP_CODES.includes(value.groupCode as ReferenceTargetGroupCode) ||
    !text(value.title, 1, 160) ||
    typeof value.policyDigest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.policyDigest) ||
    !isLocalDate(value.eligibleThroughExclusive) ||
    !Array.isArray(value.targets) ||
    value.targets.length !== 12
  ) {
    throw new TypeError("A source-verified candidate set was invalid.");
  }
  const targets = value.targets.map(target);
  if (
    new Set(targets.map((item) => item.definition.nutrientId)).size !== targets.length ||
    new Set(targets.map((item) => item.definition.code)).size !== targets.length
  ) {
    throw new TypeError("A source-verified candidate set contained duplicate nutrients.");
  }
  const expectedTitle =
    value.groupCode === "male-19-50"
      ? "U.S.–Canada reference candidate: male adults 19–50"
      : "U.S.–Canada reference candidate: female adults 19–50";
  if (value.title !== expectedTitle) {
    throw new TypeError("A source-verified candidate title was invalid.");
  }
  return {
    templateCode: TEMPLATE_CODE,
    templateVersion: TEMPLATE_VERSION,
    groupCode: value.groupCode as ReferenceTargetGroupCode,
    title: value.title,
    policyDigest: value.policyDigest,
    eligibleThroughExclusive: value.eligibleThroughExclusive,
    targets,
  };
}

function sources(value: unknown): ReferenceTargetSetList["sources"] {
  if (
    !record(value) ||
    !exactKeys(value, [
      "code",
      "version",
      "reviewedOn",
      "overviewUrl",
      "macronutrientsUrl",
      "elementsUrl",
      "vitaminsUrl",
      "reportListUrl",
    ]) ||
    value.code !== "health-canada-dri-tables" ||
    value.version !== "2025-11-19" ||
    value.reviewedOn !== "2026-09-07" ||
    Object.entries(SOURCE_URLS).some(([key, url]) => value[key] !== url)
  ) {
    throw new TypeError("The source-verified candidate source set was invalid.");
  }
  return value as unknown as ReferenceTargetSetList["sources"];
}

function applied(
  value: unknown,
  sourceSet: ReferenceTargetSetList["sources"],
): ReferenceTargetSetList["applied"] {
  if (value === null) return null;
  if (
    !record(value) ||
    !exactKeys(value, [
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
    typeof value.goalId !== "string" ||
    !UUID.test(value.goalId) ||
    typeof value.goalVersionId !== "string" ||
    !UUID.test(value.goalVersionId) ||
    !positiveIdentifier(value.goalRevision) ||
    value.templateCode !== TEMPLATE_CODE ||
    value.templateVersion !== TEMPLATE_VERSION ||
    !GROUP_CODES.includes(value.groupCode as ReferenceTargetGroupCode) ||
    !revisionIdentifier(value.appliedProfileRevision) ||
    typeof value.policyDigest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.policyDigest) ||
    !isLocalDate(value.eligibleThroughExclusive) ||
    !record(value.acknowledgement) ||
    !exactKeys(value.acknowledgement, ["accepted", "acceptedAt", "policyCode", "policyVersion"]) ||
    value.acknowledgement.accepted !== true ||
    !utcDateTime(value.acknowledgement.acceptedAt) ||
    value.acknowledgement.policyCode !== ACKNOWLEDGEMENT_POLICY_CODE ||
    value.acknowledgement.policyVersion !== ACKNOWLEDGEMENT_POLICY_VERSION
  ) {
    throw new TypeError("Applied source-verified candidate provenance was invalid.");
  }
  const persistedSet = set(value.set);
  if (
    persistedSet.templateCode !== value.templateCode ||
    persistedSet.templateVersion !== value.templateVersion ||
    persistedSet.groupCode !== value.groupCode ||
    persistedSet.policyDigest !== value.policyDigest ||
    persistedSet.eligibleThroughExclusive !== value.eligibleThroughExclusive
  ) {
    throw new TypeError("Applied source-verified candidate snapshot identity was invalid.");
  }
  assertExpectedPolicy(persistedSet, sourceSet);
  return {
    goalId: value.goalId,
    goalVersionId: value.goalVersionId,
    goalRevision: value.goalRevision,
    templateCode: TEMPLATE_CODE,
    templateVersion: TEMPLATE_VERSION,
    groupCode: value.groupCode as ReferenceTargetGroupCode,
    appliedProfileRevision: value.appliedProfileRevision,
    policyDigest: value.policyDigest,
    eligibleThroughExclusive: value.eligibleThroughExclusive,
    acknowledgement: {
      accepted: true,
      acceptedAt: value.acknowledgement.acceptedAt,
      policyCode: ACKNOWLEDGEMENT_POLICY_CODE,
      policyVersion: ACKNOWLEDGEMENT_POLICY_VERSION,
    },
    set: persistedSet,
  };
}

export function parseReferenceTargetSets(value: unknown): ReferenceTargetSetList {
  if (
    !record(value) ||
    !exactKeys(value, ["data"]) ||
    !record(value.data) ||
    !exactKeys(value.data, [
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
    !isLocalDate(value.data.date) ||
    !revisionIdentifier(value.data.profileRevision) ||
    !record(value.data.availability) ||
    !exactKeys(value.data.availability, ["available", "reasonCodes"]) ||
    typeof value.data.availability.available !== "boolean" ||
    !Array.isArray(value.data.availability.reasonCodes) ||
    value.data.availability.reasonCodes.length > 4 ||
    !value.data.availability.reasonCodes.every((reason) =>
      AVAILABILITY_REASONS.includes(reason as ReferenceTargetAvailabilityReason),
    ) ||
    new Set(value.data.availability.reasonCodes).size !==
      value.data.availability.reasonCodes.length ||
    !Array.isArray(value.data.sets) ||
    value.data.sets.length > 1 ||
    !record(value.data.acknowledgementPolicy) ||
    !exactKeys(value.data.acknowledgementPolicy, ["code", "version", "text"]) ||
    value.data.acknowledgementPolicy.code !== ACKNOWLEDGEMENT_POLICY_CODE ||
    value.data.acknowledgementPolicy.version !== ACKNOWLEDGEMENT_POLICY_VERSION ||
    value.data.acknowledgementPolicy.text !== ACKNOWLEDGEMENT_TEXT ||
    !Array.isArray(value.data.cautions) ||
    value.data.cautions.length < 1 ||
    value.data.cautions.length > 32 ||
    value.data.notice !== REFERENCE_NOTICE
  ) {
    throw new TypeError("The source-verified candidate response was invalid.");
  }
  const parsedSets = value.data.sets.map(set);
  const reasonCodes = value.data.availability
    .reasonCodes as readonly ReferenceTargetAvailabilityReason[];
  if (
    value.data.availability.available !== (parsedSets.length === 1) ||
    (value.data.availability.available && reasonCodes.length !== 0)
  ) {
    throw new TypeError("Source-verified candidate availability was contradictory.");
  }
  const parsedCautions = value.data.cautions.map((caution) => {
    if (
      !record(caution) ||
      !exactKeys(caution, ["code", "text"]) ||
      !text(caution.code, 1, 80) ||
      !text(caution.text, 1, 1_000)
    ) {
      throw new TypeError("A source-verified candidate caution was invalid.");
    }
    return { code: caution.code, text: caution.text };
  });
  const parsedSources = sources(value.data.sources);
  parsedSets.forEach((candidate) => {
    assertExpectedPolicy(candidate, parsedSources);
  });
  return {
    date: value.data.date,
    profileRevision: value.data.profileRevision,
    availability: { available: value.data.availability.available, reasonCodes },
    sets: parsedSets,
    acknowledgementPolicy: {
      code: ACKNOWLEDGEMENT_POLICY_CODE,
      version: ACKNOWLEDGEMENT_POLICY_VERSION,
      text: value.data.acknowledgementPolicy.text,
    },
    sources: parsedSources,
    cautions: parsedCautions,
    applied: applied(value.data.applied, parsedSources),
    notice: REFERENCE_NOTICE,
  };
}

export function referenceTargetsForDraft(
  set: ReferenceTargetSet,
  customized = false,
): readonly ReferenceDraftTarget[] {
  return set.targets.map((item) => ({
    definition: item.definition,
    minimumAmount: "",
    targetAmount: item.targetAmount,
    maximumAmount: item.maximumAmount ?? "",
    sourceLabel: customized
      ? `User-customized copy of ${item.source.label}`.slice(0, 160)
      : item.source.label,
    sourceVersion: item.source.version,
    rationale: customized
      ? "User-editable copy; verified reference-template identity cleared."
      : item.rationale,
  }));
}

export function referenceTargetSelection(
  list: ReferenceTargetSetList,
  set: ReferenceTargetSet,
): ReferenceTargetSelection {
  if (!list.availability.available || list.sets[0]?.groupCode !== set.groupCode) {
    throw new RangeError("This source-verified candidate set is not currently available.");
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

export function appliedReferenceMatchesGoal(
  current: ReferenceTargetSetList["applied"],
  goal: { readonly id: string; readonly versionId: string; readonly revision: string } | null,
): boolean {
  return (
    current !== null &&
    goal !== null &&
    current.goalId === goal.id &&
    current.goalVersionId === goal.versionId &&
    current.goalRevision === goal.revision
  );
}

export function carriedReferenceSet(
  list: ReferenceTargetSetList,
  goal: { readonly id: string; readonly versionId: string; readonly revision: string } | null,
): ReferenceTargetSet | null {
  const applied = list.applied;
  if (
    !appliedReferenceMatchesGoal(applied, goal) ||
    applied?.appliedProfileRevision !== list.profileRevision
  ) {
    return null;
  }
  const currentCandidate = list.sets.find(
    (candidate) =>
      candidate.groupCode === applied.groupCode && candidate.policyDigest === applied.policyDigest,
  );
  return currentCandidate ? applied.set : null;
}

export function appliedReferenceSetForDisplay(
  list: ReferenceTargetSetList | null,
  goal: { readonly id: string; readonly versionId: string; readonly revision: string } | null,
): ReferenceTargetSet | null {
  return appliedReferenceMatchesGoal(list?.applied ?? null, goal)
    ? (list?.applied?.set ?? null)
    : null;
}

export function referenceAvailabilityMessage(
  reasons: readonly ReferenceTargetAvailabilityReason[],
): string {
  if (reasons.includes("profile_missing_birth_date")) {
    return "Add a birth date below to check the source-verified age range.";
  }
  if (reasons.includes("profile_sex_unsupported")) {
    return "The source tables publish only female and male groups; custom targets remain available.";
  }
  if (reasons.includes("outside_reviewed_age")) {
    return "This source-verified candidate applies only from age 19 through the day before age 51.";
  }
  return "The source-verified nutrient definitions are temporarily unavailable; custom targets still work.";
}

export function referenceTargetSectionVisible(
  templatesSupported: boolean,
  list: ReferenceTargetSetList | null,
): list is ReferenceTargetSetList {
  return templatesSupported && list !== null;
}

function assertExpectedPolicy(
  candidate: ReferenceTargetSet,
  sourceSet: ReferenceTargetSetList["sources"],
): void {
  const expectedRows = EXPECTED_POLICY[candidate.groupCode];
  if (
    Object.keys(expectedRows).length !== candidate.targets.length ||
    !candidate.targets.every((item) => {
      const expectedRow = expectedRows[item.definition.code];
      const expectedSourceRows =
        candidate.groupCode === "male-19-50"
          ? ["Males 19–30 y", "Males 31–50 y"]
          : ["Females 19–30 y", "Females 31–50 y"];
      return (
        expectedRow !== undefined &&
        item.definition.unit === expectedRow.unit &&
        item.targetAmount === expectedRow.targetAmount &&
        item.maximumAmount === expectedRow.maximumAmount &&
        item.basis.referenceType === expectedRow.referenceType &&
        item.basis.maximumReferenceType === expectedRow.maximumReferenceType &&
        item.basis.sourceRows.length === expectedSourceRows.length &&
        item.basis.sourceRows.every((row, index) => row === expectedSourceRows[index]) &&
        item.source.label === "Health Canada Dietary Reference Intakes" &&
        item.source.version === expectedRow.sourceVersion &&
        item.source.url === sourceSet[expectedRow.sourceKind] &&
        item.source.table === expectedRow.sourceTable &&
        item.rationale ===
          `Source-verified U.S.–Canada adult 19–50 ${expectedRow.referenceType.toUpperCase()} population reference.`
      );
    })
  ) {
    throw new TypeError("A source-verified candidate target did not match its pinned policy row.");
  }
}
