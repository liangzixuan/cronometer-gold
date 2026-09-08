import { apiUrl, authenticatedHeaders, jsonBody } from "../api/private-api";
import {
  type DiaryMutationResult,
  type DiaryOrderCanonicalGroups,
  diaryOrderDigestPayload,
  isLocalDate,
  isSupportedTimeZone,
  localDateInTimeZone,
  type MealSlot,
  mealSlots,
  parseDiaryMutation,
} from "./diary";
import type { QuickAddOutboxStore } from "./quick-add-outbox-store";

export const MAX_QUICK_ADD_OUTBOX_ITEMS = 50;
export const MAX_QUICK_ADD_OUTBOX_SLOT_BYTES = 1_600;

export const terminalQuickAddStatuses = [400, 403, 404, 409, 410, 412, 422, 428] as const;
export type TerminalQuickAddStatus = (typeof terminalQuickAddStatuses)[number];
export type PublicFoodKind = "generic" | "branded";

export interface PublicFoodLogRequestBody {
  readonly foodVersionId: string;
  readonly portion:
    | {
        readonly kind: "serving";
        readonly servingId: string;
        readonly amount: string;
      }
    | { readonly kind: "grams"; readonly grams: string };
  readonly mealSlot: MealSlot;
  readonly occurredAt: string;
}

export interface QuickAddRequestBody {
  readonly foodVersionId: string;
  readonly portion: {
    readonly kind: "serving";
    readonly servingId: string;
    readonly amount: "1";
  };
  readonly mealSlot: MealSlot;
  readonly occurredAt: string;
}

export interface RecipeLogRequestBody {
  readonly recipeVersionId: string;
  readonly portion:
    | { readonly kind: "serving"; readonly amount: string }
    | { readonly kind: "grams"; readonly grams: string };
  readonly mealSlot: MealSlot;
  readonly occurredAt: string;
}

export interface CustomFoodLogRequestBody {
  readonly customFoodVersionId: string;
  readonly portion:
    | {
        readonly kind: "serving";
        readonly servingId: string;
        readonly amount: string;
      }
    | { readonly kind: "grams"; readonly grams: string };
  readonly mealSlot: MealSlot;
  readonly occurredAt: string;
}

export type DiaryEntryUpdateRequestBody = {
  readonly portion?:
    | {
        readonly kind: "serving";
        readonly servingId?: string;
        readonly amount: string;
      }
    | { readonly kind: "grams"; readonly grams: string };
  readonly mealSlot?: MealSlot;
  readonly occurredAt?: string;
  readonly note?: string | null;
};

export interface DiaryEntryRepeatRequestBody {
  readonly occurredAt: string;
  readonly mealSlot: MealSlot;
}

export interface DiaryDayReorderRequestBody {
  readonly groups: Readonly<Record<MealSlot, readonly number[]>>;
}

export interface QuickAddOutboxBlockedState {
  readonly kind: "terminal_http";
  readonly status: TerminalQuickAddStatus;
  readonly reason: "terminal_http" | "time_zone_changed";
}

interface DiaryOutboxItemCommon {
  readonly sequence: number;
  readonly ownerUserId: string;
  readonly operationId: string;
  readonly enqueuedAt: string;
  readonly expectedTimeZone: string;
  readonly localDate: string;
  readonly display: {
    /** Compatibility name retained for the existing quick-add UI; may describe any logged item. */
    readonly foodName: string;
    readonly servingLabel: string;
  };
  readonly blocked: QuickAddOutboxBlockedState | null;
}

export interface LegacyQuickAddOutboxItem extends DiaryOutboxItemCommon {
  readonly version: 1;
  readonly foodKind: PublicFoodKind;
  readonly body: QuickAddRequestBody;
}

export type DiaryOutboxOperationKind =
  | "public_food"
  | "recipe"
  | "custom_food"
  | "repeat"
  | "update"
  | "delete"
  | "reorder";

export interface PublicFoodOutboxItem extends DiaryOutboxItemCommon {
  readonly version: 2;
  readonly operationKind: "public_food";
  readonly foodKind: PublicFoodKind;
  readonly body: PublicFoodLogRequestBody;
}

export interface RecipeOutboxItem extends DiaryOutboxItemCommon {
  readonly version: 2;
  readonly operationKind: "recipe";
  readonly recipeId: string;
  readonly body: RecipeLogRequestBody;
}

export interface CustomFoodOutboxItem extends DiaryOutboxItemCommon {
  readonly version: 2;
  readonly operationKind: "custom_food";
  readonly customFoodId: string;
  /** The immutable response exposes the owner-scoped version number, not only its internal ID. */
  readonly customFoodVersionNumber: number;
  readonly body: CustomFoodLogRequestBody;
}

interface DiaryCorrectionOutboxItemCommon extends DiaryOutboxItemCommon {
  readonly version: 3;
  readonly entryId: string;
  readonly expectedEntryRevision: string;
  readonly sourceMealSlot: MealSlot;
}

export interface DiaryRepeatOutboxItem extends DiaryCorrectionOutboxItemCommon {
  readonly operationKind: "repeat";
  readonly sourceLocalDate: string;
  readonly body: DiaryEntryRepeatRequestBody;
}

export interface DiaryUpdateOutboxItem extends DiaryCorrectionOutboxItemCommon {
  readonly operationKind: "update";
  readonly body: DiaryEntryUpdateRequestBody;
}

export interface DiaryDeleteOutboxItem extends DiaryCorrectionOutboxItemCommon {
  readonly operationKind: "delete";
  readonly body: Record<never, never>;
}

export interface DiaryReorderOutboxItem extends DiaryOutboxItemCommon {
  readonly version: 3;
  readonly operationKind: "reorder";
  readonly expectedDayRevision: string;
  readonly dayTimeZone: string;
  readonly expectedOrderDigest: string;
  readonly expectedResultOrderDigest: string;
  readonly body: DiaryDayReorderRequestBody;
}

export type QuickAddOutboxItem =
  | LegacyQuickAddOutboxItem
  | PublicFoodOutboxItem
  | RecipeOutboxItem
  | CustomFoodOutboxItem
  | DiaryRepeatOutboxItem
  | DiaryUpdateOutboxItem
  | DiaryDeleteOutboxItem
  | DiaryReorderOutboxItem;
export type DiaryOutboxItem = QuickAddOutboxItem;

type WithoutJournalState<T> = T extends unknown ? Omit<T, "sequence" | "blocked"> : never;
export type QuickAddOutboxDraft = WithoutJournalState<QuickAddOutboxItem>;
export type DiaryOutboxDraft = QuickAddOutboxDraft;

export interface QuickAddEnqueueInput {
  readonly foodKind: PublicFoodKind;
  readonly foodName: string;
  readonly foodVersionId: string;
  readonly servingId: string;
  readonly servingLabel: string;
  readonly localDate: string;
  readonly mealSlot: MealSlot;
  readonly occurredAt: string;
}

interface DiaryOutboxEnqueueCommon {
  readonly localDate: string;
  readonly mealSlot: MealSlot;
  readonly occurredAt: string;
}

export interface PublicFoodOutboxEnqueueInput extends DiaryOutboxEnqueueCommon {
  readonly operationKind: "public_food";
  readonly foodKind: PublicFoodKind;
  readonly foodName: string;
  readonly foodVersionId: string;
  readonly portion:
    | {
        readonly kind: "serving";
        readonly servingId: string;
        readonly amount: string;
        readonly servingLabel: string;
      }
    | { readonly kind: "grams"; readonly grams: string };
}

export interface RecipeOutboxEnqueueInput extends DiaryOutboxEnqueueCommon {
  readonly operationKind: "recipe";
  readonly recipeName: string;
  readonly recipeId: string;
  readonly recipeVersionId: string;
  readonly portion:
    | { readonly kind: "serving"; readonly amount: string; readonly servingLabel: string }
    | { readonly kind: "grams"; readonly grams: string };
}

export interface CustomFoodOutboxEnqueueInput extends DiaryOutboxEnqueueCommon {
  readonly operationKind: "custom_food";
  readonly customFoodName: string;
  readonly customFoodId: string;
  readonly customFoodVersionId: string;
  readonly customFoodVersionNumber: number;
  readonly portion:
    | {
        readonly kind: "serving";
        readonly servingId: string;
        readonly amount: string;
        readonly servingLabel: string;
      }
    | { readonly kind: "grams"; readonly grams: string };
}

export type DiaryOutboxEnqueueInput =
  | PublicFoodOutboxEnqueueInput
  | RecipeOutboxEnqueueInput
  | CustomFoodOutboxEnqueueInput;

interface DiaryCorrectionEnqueueCommon {
  readonly entryId: string;
  readonly expectedEntryRevision: string;
  readonly entryName: string;
  readonly portionLabel: string;
  readonly localDate: string;
  readonly mealSlot: MealSlot;
}

export interface DiaryRepeatOutboxEnqueueInput extends DiaryCorrectionEnqueueCommon {
  readonly operationKind: "repeat";
  readonly sourceLocalDate: string;
  readonly occurredAt: string;
  readonly targetMealSlot: MealSlot;
}

export interface DiaryUpdateOutboxEnqueueInput extends DiaryCorrectionEnqueueCommon {
  readonly operationKind: "update";
  readonly body: DiaryEntryUpdateRequestBody;
}

export interface DiaryDeleteOutboxEnqueueInput extends DiaryCorrectionEnqueueCommon {
  readonly operationKind: "delete";
}

export interface DiaryReorderOutboxEnqueueInput {
  readonly operationKind: "reorder";
  readonly localDate: string;
  readonly expectedDayRevision: string;
  readonly dayTimeZone: string;
  readonly expectedOrderDigest: string;
  readonly expectedResultOrderDigest: string;
  readonly groups: Readonly<Record<MealSlot, readonly number[]>>;
}

export type DiaryCorrectionOutboxEnqueueInput =
  | DiaryRepeatOutboxEnqueueInput
  | DiaryUpdateOutboxEnqueueInput
  | DiaryDeleteOutboxEnqueueInput
  | DiaryReorderOutboxEnqueueInput;

export type AnyDiaryOutboxEnqueueInput =
  | DiaryOutboxEnqueueInput
  | DiaryCorrectionOutboxEnqueueInput;

export interface QuickAddOutboxSnapshot {
  readonly ownerUserId: string;
  readonly items: readonly QuickAddOutboxItem[];
}

export interface QuickAddReceipt {
  readonly operationId: string;
  readonly mutation: DiaryMutationResult;
}

export type FatalQuickAddOutboxStoreReason = "owner_mismatch" | "corrupt";

export class QuickAddEnqueueAmbiguousError extends Error {
  constructor(
    readonly operationId: string,
    readonly storageCause: unknown,
  ) {
    super("Secure storage could not confirm whether the quick-add operation was queued.");
    this.name = "QuickAddEnqueueAmbiguousError";
  }
}

export class DiaryOutboxCapacityError extends Error {
  constructor(
    readonly encodedBytes: number,
    readonly maximumBytes = MAX_QUICK_ADD_OUTBOX_SLOT_BYTES,
  ) {
    super(
      `This diary change needs ${encodedBytes} protected-storage bytes, exceeding the reviewed ${maximumBytes}-byte slot.`,
    );
    this.name = "DiaryOutboxCapacityError";
  }
}

export type DiaryOutboxDependencyReason =
  | "entry_correction_pending"
  | "day_reorder_pending"
  | "day_has_pending_operation";

export class DiaryOutboxDependencyError extends Error {
  constructor(readonly reason: DiaryOutboxDependencyReason) {
    super(
      reason === "entry_correction_pending"
        ? "A durable update or delete is already pending for this confirmed diary entry."
        : reason === "day_reorder_pending"
          ? "This diary day already has a durable reorder pending."
          : "A diary reorder cannot be queued while another operation for that day is pending.",
    );
    this.name = "DiaryOutboxDependencyError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const POSITIVE_ID = /^[1-9][0-9]{0,19}$/u;
const UTC_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/u;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function validUnicodeText(value: unknown, maximum: number): value is string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\u0000")) return false;
  const points = [...value];
  if (points.length > maximum) return false;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

function instant(value: unknown): value is string {
  return (
    typeof value === "string" &&
    UTC_MILLISECONDS.test(value) &&
    !Number.isNaN(new Date(value).getTime()) &&
    new Date(value).toISOString() === value
  );
}

function mealSlot(value: unknown): value is MealSlot {
  return mealSlots.some((candidate) => candidate === value);
}

function terminalStatus(value: unknown): value is TerminalQuickAddStatus {
  return terminalQuickAddStatuses.some((candidate) => candidate === value);
}

function parseBlocked(value: unknown): QuickAddOutboxBlockedState | null {
  if (value === null) return null;
  if (
    !record(value) ||
    !exactKeys(value, ["kind", "status", "reason"]) ||
    value.kind !== "terminal_http" ||
    !terminalStatus(value.status) ||
    !(value.reason === "terminal_http" || value.reason === "time_zone_changed") ||
    (value.reason === "time_zone_changed" && value.status !== 409)
  ) {
    throw new TypeError("The quick-add outbox block state was invalid.");
  }
  return { kind: "terminal_http", status: value.status, reason: value.reason };
}

const POSITIVE_DECIMAL = /^(?=.*[1-9])(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/u;

function positiveDecimal(value: unknown): value is string {
  return typeof value === "string" && value.length <= 19 && POSITIVE_DECIMAL.test(value);
}

function canonicalPositiveDecimal(value: string): string {
  if (!positiveDecimal(value)) {
    throw new RangeError("Diary quantity must be a positive decimal.");
  }
  const decimalPoint = value.indexOf(".");
  if (decimalPoint === -1) return value;
  const fraction = value.slice(decimalPoint + 1).replace(/0+$/u, "");
  return fraction.length === 0
    ? value.slice(0, decimalPoint)
    : `${value.slice(0, decimalPoint)}.${fraction}`;
}

function samePositiveDecimal(expected: string, actual: unknown): boolean {
  return (
    typeof actual === "string" &&
    positiveDecimal(actual) &&
    canonicalPositiveDecimal(expected) === canonicalPositiveDecimal(actual)
  );
}

function parseFoodPortion(
  value: unknown,
): PublicFoodLogRequestBody["portion"] | CustomFoodLogRequestBody["portion"] {
  if (!record(value)) throw new TypeError("The diary outbox portion was invalid.");
  if (
    value.kind === "serving" &&
    exactKeys(value, ["kind", "servingId", "amount"]) &&
    typeof value.servingId === "string" &&
    POSITIVE_ID.test(value.servingId) &&
    positiveDecimal(value.amount)
  ) {
    return { kind: "serving", servingId: value.servingId, amount: value.amount };
  }
  if (
    value.kind === "grams" &&
    exactKeys(value, ["kind", "grams"]) &&
    positiveDecimal(value.grams)
  ) {
    return { kind: "grams", grams: value.grams };
  }
  throw new TypeError("The diary outbox portion was invalid.");
}

function parseRecipePortion(value: unknown): RecipeLogRequestBody["portion"] {
  if (!record(value)) throw new TypeError("The diary outbox recipe portion was invalid.");
  if (
    value.kind === "serving" &&
    exactKeys(value, ["kind", "amount"]) &&
    positiveDecimal(value.amount)
  ) {
    return { kind: "serving", amount: value.amount };
  }
  if (
    value.kind === "grams" &&
    exactKeys(value, ["kind", "grams"]) &&
    positiveDecimal(value.grams)
  ) {
    return { kind: "grams", grams: value.grams };
  }
  throw new TypeError("The diary outbox recipe portion was invalid.");
}

function parsePublicFoodBody(value: unknown): PublicFoodLogRequestBody {
  if (
    !record(value) ||
    !exactKeys(value, ["foodVersionId", "portion", "mealSlot", "occurredAt"]) ||
    typeof value.foodVersionId !== "string" ||
    !POSITIVE_ID.test(value.foodVersionId) ||
    !mealSlot(value.mealSlot) ||
    !instant(value.occurredAt)
  ) {
    throw new TypeError("The diary outbox public-food request body was invalid.");
  }
  return {
    foodVersionId: value.foodVersionId,
    portion: parseFoodPortion(value.portion),
    mealSlot: value.mealSlot,
    occurredAt: value.occurredAt,
  };
}

function parseLegacyBody(value: unknown): QuickAddRequestBody {
  const parsed = parsePublicFoodBody(value);
  if (parsed.portion.kind !== "serving" || parsed.portion.amount !== "1") {
    throw new TypeError("The legacy quick-add outbox request body was invalid.");
  }
  return {
    foodVersionId: parsed.foodVersionId,
    portion: { ...parsed.portion, amount: "1" },
    mealSlot: parsed.mealSlot,
    occurredAt: parsed.occurredAt,
  };
}

function parseRecipeBody(value: unknown): RecipeLogRequestBody {
  if (
    !record(value) ||
    !exactKeys(value, ["recipeVersionId", "portion", "mealSlot", "occurredAt"]) ||
    typeof value.recipeVersionId !== "string" ||
    !UUID.test(value.recipeVersionId) ||
    !mealSlot(value.mealSlot) ||
    !instant(value.occurredAt)
  ) {
    throw new TypeError("The diary outbox recipe request body was invalid.");
  }
  return {
    recipeVersionId: value.recipeVersionId,
    portion: parseRecipePortion(value.portion),
    mealSlot: value.mealSlot,
    occurredAt: value.occurredAt,
  };
}

function parseCustomFoodBody(value: unknown): CustomFoodLogRequestBody {
  if (
    !record(value) ||
    !exactKeys(value, ["customFoodVersionId", "portion", "mealSlot", "occurredAt"]) ||
    typeof value.customFoodVersionId !== "string" ||
    !POSITIVE_ID.test(value.customFoodVersionId) ||
    !mealSlot(value.mealSlot) ||
    !instant(value.occurredAt)
  ) {
    throw new TypeError("The diary outbox custom-food request body was invalid.");
  }
  return {
    customFoodVersionId: value.customFoodVersionId,
    portion: parseFoodPortion(value.portion),
    mealSlot: value.mealSlot,
    occurredAt: value.occurredAt,
  };
}

function parseUpdatePortion(value: unknown): NonNullable<DiaryEntryUpdateRequestBody["portion"]> {
  if (!record(value)) throw new TypeError("The diary outbox update portion was invalid.");
  if (
    value.kind === "grams" &&
    exactKeys(value, ["kind", "grams"]) &&
    positiveDecimal(value.grams)
  ) {
    return { kind: "grams", grams: value.grams };
  }
  if (
    value.kind === "serving" &&
    (exactKeys(value, ["kind", "amount"]) || exactKeys(value, ["kind", "servingId", "amount"])) &&
    positiveDecimal(value.amount) &&
    (value.servingId === undefined ||
      (typeof value.servingId === "string" && POSITIVE_ID.test(value.servingId)))
  ) {
    return {
      kind: "serving",
      ...(value.servingId === undefined ? {} : { servingId: value.servingId }),
      amount: value.amount,
    };
  }
  throw new TypeError("The diary outbox update portion was invalid.");
}

function parseUpdateBody(value: unknown): DiaryEntryUpdateRequestBody {
  if (!record(value)) throw new TypeError("The diary outbox update request body was invalid.");
  const keys = Object.keys(value);
  const permitted = ["portion", "mealSlot", "occurredAt", "note"];
  if (
    keys.length === 0 ||
    keys.some((key) => !permitted.includes(key)) ||
    (value.mealSlot !== undefined && !mealSlot(value.mealSlot)) ||
    (value.occurredAt !== undefined && !instant(value.occurredAt)) ||
    (value.note !== undefined &&
      value.note !== null &&
      !(typeof value.note === "string" && validUnicodeText(value.note, 2_000)))
  ) {
    throw new TypeError("The diary outbox update request body was invalid.");
  }
  return {
    ...(value.portion === undefined ? {} : { portion: parseUpdatePortion(value.portion) }),
    ...(value.mealSlot === undefined ? {} : { mealSlot: value.mealSlot as MealSlot }),
    ...(value.occurredAt === undefined ? {} : { occurredAt: value.occurredAt as string }),
    ...(value.note === undefined ? {} : { note: value.note as string | null }),
  };
}

function parseRepeatBody(value: unknown): DiaryEntryRepeatRequestBody {
  if (
    !record(value) ||
    !exactKeys(value, ["occurredAt", "mealSlot"]) ||
    !instant(value.occurredAt) ||
    !mealSlot(value.mealSlot)
  ) {
    throw new TypeError("The diary outbox repeat request body was invalid.");
  }
  return { occurredAt: value.occurredAt, mealSlot: value.mealSlot };
}

function parsePermutation(value: unknown): readonly number[] {
  if (!Array.isArray(value) || value.length > 50) {
    throw new TypeError("The diary outbox order permutation was invalid.");
  }
  if (
    value.some(
      (index) =>
        typeof index !== "number" ||
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index >= value.length,
    ) ||
    new Set(value).size !== value.length
  ) {
    throw new TypeError("The diary outbox order permutation was invalid.");
  }
  return value;
}

function parseReorderBody(value: unknown): DiaryDayReorderRequestBody {
  if (
    !record(value) ||
    !exactKeys(value, ["groups"]) ||
    !record(value.groups) ||
    !exactKeys(value.groups, mealSlots)
  ) {
    throw new TypeError("The diary outbox reorder request body was invalid.");
  }
  const groups = {
    breakfast: parsePermutation(value.groups.breakfast),
    lunch: parsePermutation(value.groups.lunch),
    dinner: parsePermutation(value.groups.dinner),
    snacks: parsePermutation(value.groups.snacks),
  };
  if (mealSlots.reduce((total, slot) => total + groups[slot].length, 0) > 50) {
    throw new TypeError("The diary outbox reorder request body was invalid.");
  }
  return { groups };
}

function parseCommonEnvelope(candidate: Record<string, unknown>) {
  if (
    !Number.isSafeInteger(candidate.sequence) ||
    Number(candidate.sequence) < 0 ||
    typeof candidate.ownerUserId !== "string" ||
    !UUID.test(candidate.ownerUserId) ||
    typeof candidate.operationId !== "string" ||
    !UUID_V4.test(candidate.operationId) ||
    !instant(candidate.enqueuedAt) ||
    typeof candidate.expectedTimeZone !== "string" ||
    !isSupportedTimeZone(candidate.expectedTimeZone) ||
    !isLocalDate(candidate.localDate) ||
    !record(candidate.display) ||
    !exactKeys(candidate.display, ["foodName", "servingLabel"]) ||
    !validUnicodeText(candidate.display.foodName, 96) ||
    !validUnicodeText(candidate.display.servingLabel, 64)
  ) {
    throw new TypeError("The diary outbox envelope was invalid.");
  }
  return {
    sequence: Number(candidate.sequence),
    ownerUserId: candidate.ownerUserId,
    operationId: candidate.operationId,
    enqueuedAt: candidate.enqueuedAt,
    expectedTimeZone: candidate.expectedTimeZone,
    localDate: candidate.localDate,
    display: {
      foodName: candidate.display.foodName,
      servingLabel: candidate.display.servingLabel,
    },
    blocked: parseBlocked(candidate.blocked),
  };
}

function finishParsedItem<T extends QuickAddOutboxItem>(item: T): T {
  const occurredAt = "occurredAt" in item.body ? item.body.occurredAt : undefined;
  if (
    occurredAt !== undefined &&
    !(item.version === 3 && item.operationKind === "update") &&
    localDateInTimeZone(new Date(occurredAt), item.expectedTimeZone) !== item.localDate
  ) {
    throw new TypeError("The diary outbox date did not match its immutable request.");
  }
  if (new TextEncoder().encode(JSON.stringify(item)).byteLength > MAX_QUICK_ADD_OUTBOX_SLOT_BYTES) {
    throw new RangeError("The diary outbox envelope exceeded its reviewed storage bound.");
  }
  return item;
}

/** Parse one closed, bounded envelope. Unknown fields, credentials, queries, and paths are rejected. */
export function parseQuickAddOutboxItem(value: unknown): QuickAddOutboxItem {
  const candidate: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (!record(candidate)) throw new TypeError("The diary outbox envelope was invalid.");
  const baseKeys = [
    "version",
    "sequence",
    "ownerUserId",
    "operationId",
    "enqueuedAt",
    "expectedTimeZone",
    "localDate",
    "display",
    "body",
    "blocked",
  ];
  const common = parseCommonEnvelope(candidate);

  if (
    candidate.version === 1 &&
    exactKeys(candidate, [...baseKeys, "foodKind"]) &&
    (candidate.foodKind === "generic" || candidate.foodKind === "branded")
  ) {
    return finishParsedItem({
      version: 1,
      ...common,
      foodKind: candidate.foodKind,
      body: parseLegacyBody(candidate.body),
    });
  }
  if (
    candidate.version === 2 &&
    candidate.operationKind === "public_food" &&
    exactKeys(candidate, [...baseKeys, "operationKind", "foodKind"]) &&
    (candidate.foodKind === "generic" || candidate.foodKind === "branded")
  ) {
    return finishParsedItem({
      version: 2,
      ...common,
      operationKind: "public_food",
      foodKind: candidate.foodKind,
      body: parsePublicFoodBody(candidate.body),
    });
  }
  if (
    candidate.version === 2 &&
    candidate.operationKind === "recipe" &&
    exactKeys(candidate, [...baseKeys, "operationKind", "recipeId"]) &&
    typeof candidate.recipeId === "string" &&
    UUID.test(candidate.recipeId)
  ) {
    return finishParsedItem({
      version: 2,
      ...common,
      operationKind: "recipe",
      recipeId: candidate.recipeId,
      body: parseRecipeBody(candidate.body),
    });
  }
  if (
    candidate.version === 2 &&
    candidate.operationKind === "custom_food" &&
    exactKeys(candidate, [
      ...baseKeys,
      "operationKind",
      "customFoodId",
      "customFoodVersionNumber",
    ]) &&
    typeof candidate.customFoodId === "string" &&
    UUID.test(candidate.customFoodId) &&
    Number.isSafeInteger(candidate.customFoodVersionNumber) &&
    Number(candidate.customFoodVersionNumber) >= 1
  ) {
    return finishParsedItem({
      version: 2,
      ...common,
      operationKind: "custom_food",
      customFoodId: candidate.customFoodId,
      customFoodVersionNumber: Number(candidate.customFoodVersionNumber),
      body: parseCustomFoodBody(candidate.body),
    });
  }
  if (
    candidate.version === 3 &&
    (candidate.operationKind === "repeat" ||
      candidate.operationKind === "update" ||
      candidate.operationKind === "delete") &&
    exactKeys(candidate, [
      ...baseKeys,
      "operationKind",
      "entryId",
      "expectedEntryRevision",
      "sourceMealSlot",
      ...(candidate.operationKind === "repeat" ? ["sourceLocalDate"] : []),
    ]) &&
    typeof candidate.entryId === "string" &&
    UUID.test(candidate.entryId) &&
    typeof candidate.expectedEntryRevision === "string" &&
    /^[1-9]\d*$/u.test(candidate.expectedEntryRevision) &&
    mealSlot(candidate.sourceMealSlot) &&
    (candidate.operationKind !== "repeat" ||
      (typeof candidate.sourceLocalDate === "string" && isLocalDate(candidate.sourceLocalDate)))
  ) {
    const correction = {
      version: 3 as const,
      ...common,
      entryId: candidate.entryId.toLowerCase(),
      expectedEntryRevision: candidate.expectedEntryRevision,
      sourceMealSlot: candidate.sourceMealSlot,
    };
    if (candidate.operationKind === "repeat") {
      return finishParsedItem({
        ...correction,
        operationKind: "repeat",
        sourceLocalDate: candidate.sourceLocalDate as string,
        body: parseRepeatBody(candidate.body),
      });
    }
    if (candidate.operationKind === "update") {
      return finishParsedItem({
        ...correction,
        operationKind: "update",
        body: parseUpdateBody(candidate.body),
      });
    }
    if (!record(candidate.body) || !exactKeys(candidate.body, [])) {
      throw new TypeError("The diary outbox delete request body was invalid.");
    }
    return finishParsedItem({ ...correction, operationKind: "delete", body: {} });
  }
  if (
    candidate.version === 3 &&
    candidate.operationKind === "reorder" &&
    exactKeys(candidate, [
      ...baseKeys,
      "operationKind",
      "expectedDayRevision",
      "dayTimeZone",
      "expectedOrderDigest",
      "expectedResultOrderDigest",
    ]) &&
    typeof candidate.expectedDayRevision === "string" &&
    /^[1-9]\d*$/u.test(candidate.expectedDayRevision) &&
    typeof candidate.dayTimeZone === "string" &&
    isSupportedTimeZone(candidate.dayTimeZone) &&
    typeof candidate.expectedOrderDigest === "string" &&
    /^[0-9a-f]{64}$/u.test(candidate.expectedOrderDigest) &&
    typeof candidate.expectedResultOrderDigest === "string" &&
    /^[0-9a-f]{64}$/u.test(candidate.expectedResultOrderDigest)
  ) {
    return finishParsedItem({
      version: 3,
      ...common,
      operationKind: "reorder",
      expectedDayRevision: candidate.expectedDayRevision,
      dayTimeZone: candidate.dayTimeZone,
      expectedOrderDigest: candidate.expectedOrderDigest,
      expectedResultOrderDigest: candidate.expectedResultOrderDigest,
      body: parseReorderBody(candidate.body),
    });
  }
  throw new TypeError("The diary outbox envelope discriminant was invalid.");
}

function truncate(value: string, maximum: number): string {
  return [...value].slice(0, maximum).join("");
}

export function createQuickAddOutboxDraft(
  ownerUserId: string,
  expectedTimeZone: string,
  input: QuickAddEnqueueInput,
  operationId: string,
  now: Date,
): QuickAddOutboxDraft {
  const item = parseQuickAddOutboxItem({
    version: 1,
    sequence: 0,
    ownerUserId,
    operationId,
    enqueuedAt: now.toISOString(),
    expectedTimeZone,
    localDate: input.localDate,
    foodKind: input.foodKind,
    display: {
      foodName: truncate(input.foodName, 96),
      servingLabel: truncate(input.servingLabel, 64),
    },
    body: {
      foodVersionId: input.foodVersionId,
      portion: { kind: "serving", servingId: input.servingId, amount: "1" },
      mealSlot: input.mealSlot,
      occurredAt: input.occurredAt,
    },
    blocked: null,
  });
  const { sequence: _sequence, blocked: _blocked, ...draft } = item;
  return draft;
}

function inputPortionLabel(
  portion:
    | PublicFoodOutboxEnqueueInput["portion"]
    | RecipeOutboxEnqueueInput["portion"]
    | CustomFoodOutboxEnqueueInput["portion"],
): string {
  return portion.kind === "grams"
    ? truncate(`${canonicalPositiveDecimal(portion.grams)} g`, 64)
    : truncate(`${canonicalPositiveDecimal(portion.amount)} ${portion.servingLabel}`, 64);
}

/** Build a version-2 journal item without accepting an arbitrary URL, header, or request body. */
export function createDiaryOutboxDraft(
  ownerUserId: string,
  expectedTimeZone: string,
  input: DiaryOutboxEnqueueInput,
  operationId: string,
  now: Date,
): DiaryOutboxDraft {
  const common = {
    version: 2 as const,
    sequence: 0,
    ownerUserId,
    operationId,
    enqueuedAt: now.toISOString(),
    expectedTimeZone,
    localDate: input.localDate,
    display: {
      foodName: truncate(
        input.operationKind === "public_food"
          ? input.foodName
          : input.operationKind === "recipe"
            ? input.recipeName
            : input.customFoodName,
        96,
      ),
      servingLabel: inputPortionLabel(input.portion),
    },
    blocked: null,
  };
  let item: QuickAddOutboxItem;
  switch (input.operationKind) {
    case "public_food":
      item = parseQuickAddOutboxItem({
        ...common,
        operationKind: "public_food",
        foodKind: input.foodKind,
        body: {
          foodVersionId: input.foodVersionId,
          portion:
            input.portion.kind === "serving"
              ? {
                  kind: "serving",
                  servingId: input.portion.servingId,
                  amount: canonicalPositiveDecimal(input.portion.amount),
                }
              : { kind: "grams", grams: canonicalPositiveDecimal(input.portion.grams) },
          mealSlot: input.mealSlot,
          occurredAt: input.occurredAt,
        },
      });
      break;
    case "recipe":
      item = parseQuickAddOutboxItem({
        ...common,
        operationKind: "recipe",
        recipeId: input.recipeId.toLowerCase(),
        body: {
          recipeVersionId: input.recipeVersionId.toLowerCase(),
          portion:
            input.portion.kind === "serving"
              ? { kind: "serving", amount: canonicalPositiveDecimal(input.portion.amount) }
              : { kind: "grams", grams: canonicalPositiveDecimal(input.portion.grams) },
          mealSlot: input.mealSlot,
          occurredAt: input.occurredAt,
        },
      });
      break;
    case "custom_food":
      item = parseQuickAddOutboxItem({
        ...common,
        operationKind: "custom_food",
        customFoodId: input.customFoodId.toLowerCase(),
        customFoodVersionNumber: input.customFoodVersionNumber,
        body: {
          customFoodVersionId: input.customFoodVersionId,
          portion:
            input.portion.kind === "serving"
              ? {
                  kind: "serving",
                  servingId: input.portion.servingId,
                  amount: canonicalPositiveDecimal(input.portion.amount),
                }
              : { kind: "grams", grams: canonicalPositiveDecimal(input.portion.grams) },
          mealSlot: input.mealSlot,
          occurredAt: input.occurredAt,
        },
      });
      break;
  }
  const { sequence: _sequence, blocked: _blocked, ...draft } = item;
  return draft;
}

function correctionDisplay(input: DiaryCorrectionOutboxEnqueueInput): {
  readonly foodName: string;
  readonly servingLabel: string;
} {
  return input.operationKind === "reorder"
    ? { foodName: "Diary order", servingLabel: "all meal groups" }
    : {
        foodName: truncate(input.entryName, 96),
        servingLabel: truncate(input.portionLabel, 64),
      };
}

function canonicalUpdateBody(body: DiaryEntryUpdateRequestBody): DiaryEntryUpdateRequestBody {
  return parseUpdateBody({
    ...body,
    ...(body.portion?.kind === "grams"
      ? { portion: { kind: "grams", grams: canonicalPositiveDecimal(body.portion.grams) } }
      : body.portion
        ? {
            portion: {
              kind: "serving",
              ...(body.portion.servingId === undefined
                ? {}
                : { servingId: body.portion.servingId }),
              amount: canonicalPositiveDecimal(body.portion.amount),
            },
          }
        : {}),
  });
}

/** Build a version-3 correction/reorder envelope with no caller-controlled route or headers. */
export function createDiaryCorrectionOutboxDraft(
  ownerUserId: string,
  expectedTimeZone: string,
  input: DiaryCorrectionOutboxEnqueueInput,
  operationId: string,
  now: Date,
): DiaryOutboxDraft {
  const common = {
    version: 3 as const,
    sequence: 0,
    ownerUserId,
    operationId,
    enqueuedAt: now.toISOString(),
    expectedTimeZone,
    localDate: input.localDate,
    display: correctionDisplay(input),
    blocked: null,
  };
  const value =
    input.operationKind === "reorder"
      ? {
          ...common,
          operationKind: "reorder" as const,
          expectedDayRevision: input.expectedDayRevision,
          dayTimeZone: input.dayTimeZone,
          expectedOrderDigest: input.expectedOrderDigest,
          expectedResultOrderDigest: input.expectedResultOrderDigest,
          body: { groups: input.groups },
        }
      : {
          ...common,
          operationKind: input.operationKind,
          entryId: input.entryId,
          expectedEntryRevision: input.expectedEntryRevision,
          sourceMealSlot: input.mealSlot,
          ...(input.operationKind === "repeat" ? { sourceLocalDate: input.sourceLocalDate } : {}),
          body:
            input.operationKind === "repeat"
              ? { occurredAt: input.occurredAt, mealSlot: input.targetMealSlot }
              : input.operationKind === "update"
                ? canonicalUpdateBody(input.body)
                : {},
        };
  try {
    const item = parseQuickAddOutboxItem(value);
    const { sequence: _sequence, blocked: _blocked, ...draft } = item;
    return draft;
  } catch (error) {
    const encodedBytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
    if (encodedBytes > MAX_QUICK_ADD_OUTBOX_SLOT_BYTES) {
      throw new DiaryOutboxCapacityError(encodedBytes);
    }
    throw error;
  }
}

export function diaryOutboxOperationKind(item: QuickAddOutboxItem): DiaryOutboxOperationKind {
  return item.version === 1 ? "public_food" : item.operationKind;
}

export function diaryOutboxDisplayMealSlot(item: QuickAddOutboxItem): MealSlot {
  if (item.version === 3) {
    return item.operationKind === "reorder" ? "breakfast" : item.sourceMealSlot;
  }
  return item.body.mealSlot;
}

export function diaryOutboxAffectedLocalDates(item: QuickAddOutboxItem): readonly string[] {
  if (item.version === 3 && item.operationKind === "update" && item.body.occurredAt !== undefined) {
    const target = localDateInTimeZone(new Date(item.body.occurredAt), item.expectedTimeZone);
    return target === item.localDate ? [item.localDate] : [item.localDate, target];
  }
  return [item.localDate];
}

export function diaryOutboxEntryCorrectionId(item: QuickAddOutboxItem): string | null {
  return item.version === 3 && (item.operationKind === "update" || item.operationKind === "delete")
    ? item.entryId
    : null;
}

export function assertDiaryOutboxAppendDependencies(
  existing: readonly QuickAddOutboxItem[],
  candidate: QuickAddOutboxItem,
): void {
  const correctionId = diaryOutboxEntryCorrectionId(candidate);
  const repeatSourceEntryId =
    candidate.version === 3 && candidate.operationKind === "repeat" ? candidate.entryId : null;
  if (
    (correctionId !== null || repeatSourceEntryId !== null) &&
    existing.some(
      (item) => diaryOutboxEntryCorrectionId(item) === (correctionId ?? repeatSourceEntryId),
    )
  ) {
    throw new DiaryOutboxDependencyError("entry_correction_pending");
  }
  const candidateDates = new Set(diaryOutboxAffectedLocalDates(candidate));
  if (candidate.version === 3 && candidate.operationKind === "reorder") {
    if (
      existing.some((item) =>
        diaryOutboxAffectedLocalDates(item).some((date) => candidateDates.has(date)),
      )
    ) {
      throw new DiaryOutboxDependencyError("day_has_pending_operation");
    }
    return;
  }
  if (candidate.version === 3 && candidate.operationKind === "repeat") {
    if (
      existing.some(
        (item) =>
          item.version === 3 &&
          item.operationKind === "reorder" &&
          (item.localDate === candidate.sourceLocalDate || item.localDate === candidate.localDate),
      )
    ) {
      throw new DiaryOutboxDependencyError("day_reorder_pending");
    }
    return;
  }
  if (
    existing.some(
      (item) =>
        item.version === 3 &&
        item.operationKind === "reorder" &&
        candidateDates.has(item.localDate),
    )
  ) {
    throw new DiaryOutboxDependencyError("day_reorder_pending");
  }
}

export interface DiaryOutboxRequest {
  readonly method: "POST" | "PATCH" | "DELETE" | "PUT";
  readonly path: string;
  readonly body:
    | PublicFoodLogRequestBody
    | RecipeLogRequestBody
    | CustomFoodLogRequestBody
    | DiaryEntryRepeatRequestBody
    | DiaryEntryUpdateRequestBody
    | DiaryDayReorderRequestBody
    | undefined;
  readonly expectedRevision?: string;
  readonly sendExpectedTimeZone: boolean;
}

/** Derive only reviewed endpoints; persisted items never carry a URL or headers. */
export function diaryOutboxRequest(item: QuickAddOutboxItem): DiaryOutboxRequest {
  if (item.version === 1 || item.operationKind === "public_food") {
    return {
      method: "POST",
      path: "/v1/diary/entries?profileTimeZonePrecondition=v1",
      body: item.body,
      sendExpectedTimeZone: true,
    };
  }
  if (item.operationKind === "recipe") {
    return {
      method: "POST",
      path: `/v1/recipes/${item.recipeId}/log?profileTimeZonePrecondition=v1`,
      body: item.body,
      sendExpectedTimeZone: true,
    };
  }
  if (item.version === 3) {
    if (item.operationKind === "repeat") {
      return {
        method: "POST",
        path: `/v1/diary/corrections/entries/${item.entryId}/repeat?profileTimeZonePrecondition=v1`,
        body: item.body,
        expectedRevision: item.expectedEntryRevision,
        sendExpectedTimeZone: true,
      };
    }
    if (item.operationKind === "update") {
      const hasTimeZonePrecondition = item.body.occurredAt !== undefined;
      return {
        method: "PATCH",
        path: `/v1/diary/entries/${item.entryId}?diaryCorrectionProtocol=v1${hasTimeZonePrecondition ? "&profileTimeZonePrecondition=v1" : ""}`,
        body: item.body,
        expectedRevision: item.expectedEntryRevision,
        sendExpectedTimeZone: hasTimeZonePrecondition,
      };
    }
    if (item.operationKind === "delete") {
      return {
        method: "DELETE",
        path: `/v1/diary/entries/${item.entryId}?diaryCorrectionProtocol=v1`,
        body: undefined,
        expectedRevision: item.expectedEntryRevision,
        sendExpectedTimeZone: false,
      };
    }
    return {
      method: "PUT",
      path: `/v1/diary/days/${item.localDate}/order?profileTimeZonePrecondition=v1`,
      body: item.body,
      expectedRevision: item.expectedDayRevision,
      sendExpectedTimeZone: true,
    };
  }
  if (item.operationKind === "custom_food") {
    return {
      method: "POST",
      path: `/v1/custom-foods/${item.customFoodId}/log?profileTimeZonePrecondition=v1`,
      body: item.body,
      sendExpectedTimeZone: true,
    };
  }
  throw new TypeError("The diary outbox operation was not routable.");
}

function matchesFoodPortion(
  expected: PublicFoodLogRequestBody["portion"] | CustomFoodLogRequestBody["portion"],
  actual: unknown,
): boolean {
  if (!record(actual) || actual.kind !== expected.kind) return false;
  return expected.kind === "grams"
    ? samePositiveDecimal(expected.grams, actual.grams)
    : actual.servingId === expected.servingId &&
        samePositiveDecimal(expected.amount, actual.amount);
}

function matchesUuidIdentity(expected: string, actual: string): boolean {
  return expected.toLowerCase() === actual.toLowerCase();
}

function matchesRecipePortion(expected: RecipeLogRequestBody["portion"], actual: unknown): boolean {
  if (!record(actual) || actual.kind !== expected.kind) return false;
  return expected.kind === "grams"
    ? samePositiveDecimal(expected.grams, actual.grams)
    : samePositiveDecimal(expected.amount, actual.amount);
}

function isNextRevision(candidate: string, expected: string): boolean {
  try {
    return BigInt(candidate) === BigInt(expected) + 1n;
  } catch {
    return false;
  }
}

function sameAffectedDays(
  left: readonly { readonly localDate: string; readonly revision: string }[],
  right: unknown,
): boolean {
  return (
    Array.isArray(right) &&
    right.length === left.length &&
    right.every(
      (day, index) =>
        record(day) &&
        exactKeys(day, ["localDate", "revision"]) &&
        day.localDate === left[index]?.localDate &&
        String(day.revision) === left[index]?.revision,
    )
  );
}

function matchesUpdatePortion(
  expected: NonNullable<DiaryEntryUpdateRequestBody["portion"]>,
  actual: unknown,
): boolean {
  if (!record(actual) || actual.kind !== expected.kind) return false;
  if (expected.kind === "grams") return samePositiveDecimal(expected.grams, actual.grams);
  return (
    samePositiveDecimal(expected.amount, actual.amount) &&
    (expected.servingId === undefined || actual.servingId === expected.servingId)
  );
}

function matchesCorrectionReceipt(
  item: DiaryRepeatOutboxItem | DiaryUpdateOutboxItem | DiaryDeleteOutboxItem,
  mutation: DiaryMutationResult,
  responseValue: unknown,
): boolean {
  if (
    !record(responseValue) ||
    !exactKeys(responseValue, ["data"]) ||
    !record(responseValue.data) ||
    !exactKeys(responseValue.data, ["replayed", "entry", "affectedDays", "receipt"]) ||
    !record(responseValue.data.receipt)
  ) {
    return false;
  }
  const receipt = responseValue.data.receipt;
  if (
    !exactKeys(receipt, [
      "protocol",
      "operationId",
      "kind",
      "expectedSubjects",
      "resultSubjects",
      "affectedDays",
    ]) ||
    receipt.protocol !== "v1" ||
    receipt.operationId !== item.operationId ||
    receipt.kind !== item.operationKind ||
    !Array.isArray(receipt.expectedSubjects) ||
    receipt.expectedSubjects.length !== 1 ||
    !record(receipt.expectedSubjects[0]) ||
    !exactKeys(receipt.expectedSubjects[0], ["entryId", "revision"]) ||
    receipt.expectedSubjects[0].entryId !== item.entryId ||
    String(receipt.expectedSubjects[0].revision) !== item.expectedEntryRevision ||
    !sameAffectedDays(mutation.affectedDays, receipt.affectedDays) ||
    !Array.isArray(receipt.resultSubjects) ||
    receipt.resultSubjects.length !== 1 ||
    !record(receipt.resultSubjects[0]) ||
    !exactKeys(receipt.resultSubjects[0], ["entryId", "revision", "state"]) ||
    typeof receipt.resultSubjects[0].revision !== "string" ||
    !/^[1-9]\d*$/u.test(receipt.resultSubjects[0].revision) ||
    (item.operationKind === "repeat"
      ? receipt.resultSubjects[0].revision !== "1"
      : !isNextRevision(receipt.resultSubjects[0].revision, item.expectedEntryRevision))
  ) {
    return false;
  }
  const result = receipt.resultSubjects[0];
  if (item.operationKind === "delete") {
    return mutation.entry === null && result.entryId === item.entryId && result.state === "deleted";
  }
  if (
    mutation.entry === null ||
    result.entryId !== mutation.entry.id ||
    result.revision !== mutation.entry.revision ||
    result.state !== "active"
  ) {
    return false;
  }
  if (item.operationKind === "repeat") {
    return (
      UUID.test(mutation.entry.id) &&
      !matchesUuidIdentity(mutation.entry.id, item.entryId) &&
      mutation.entry.mealSlot === item.body.mealSlot &&
      mutation.entry.occurredAt === item.body.occurredAt &&
      mutation.entry.localDate === item.localDate &&
      mutation.entry.timeZone === item.expectedTimeZone
    );
  }
  const targetDate =
    item.body.occurredAt === undefined
      ? item.localDate
      : localDateInTimeZone(new Date(item.body.occurredAt), item.expectedTimeZone);
  return (
    mutation.entry.id === item.entryId &&
    mutation.entry.localDate === targetDate &&
    (item.body.portion === undefined ||
      matchesUpdatePortion(item.body.portion, mutation.entry.portion)) &&
    (item.body.mealSlot === undefined || mutation.entry.mealSlot === item.body.mealSlot) &&
    (item.body.occurredAt === undefined ||
      (mutation.entry.occurredAt === item.body.occurredAt &&
        mutation.entry.timeZone === item.expectedTimeZone)) &&
    (item.body.note === undefined || mutation.entry.note === item.body.note)
  );
}

export function matchesDiaryOutboxReceipt(
  item: QuickAddOutboxItem,
  status: number,
  mutation: DiaryMutationResult,
  responseValue?: unknown,
): boolean {
  if (item.version === 3) {
    if (item.operationKind === "reorder") return false;
    if (
      (item.operationKind === "repeat" &&
        !((status === 201 && !mutation.replayed) || (status === 200 && mutation.replayed))) ||
      (item.operationKind !== "repeat" && status !== 200)
    ) {
      return false;
    }
    const expectedDates = diaryOutboxAffectedLocalDates(item);
    if (
      mutation.affectedDays.length !== expectedDates.length ||
      mutation.affectedDays.some((day, index) => day.localDate !== expectedDates[index])
    ) {
      return false;
    }
    return matchesCorrectionReceipt(item, mutation, responseValue);
  }
  const entry = mutation.entry;
  if (
    !((status === 201 && !mutation.replayed) || (status === 200 && mutation.replayed)) ||
    entry === null ||
    entry.mealSlot !== item.body.mealSlot ||
    entry.occurredAt !== item.body.occurredAt ||
    entry.localDate !== item.localDate ||
    entry.timeZone !== item.expectedTimeZone ||
    mutation.affectedDays.length !== 1 ||
    mutation.affectedDays[0]?.localDate !== item.localDate
  ) {
    return false;
  }
  if (item.version === 1 || item.operationKind === "public_food") {
    return (
      entry.entryKind === "food" &&
      entry.foodProvenance.kind === "public" &&
      entry.foodVersionId === item.body.foodVersionId &&
      matchesFoodPortion(item.body.portion, entry.portion)
    );
  }
  if (item.operationKind === "recipe") {
    return (
      entry.entryKind === "recipe" &&
      matchesUuidIdentity(item.recipeId, entry.recipe.id) &&
      matchesUuidIdentity(item.body.recipeVersionId, entry.recipeVersionId) &&
      matchesRecipePortion(item.body.portion, entry.portion)
    );
  }
  return (
    entry.entryKind === "food" &&
    entry.foodProvenance.kind === "private_custom" &&
    matchesUuidIdentity(item.customFoodId, entry.foodProvenance.customFoodId) &&
    entry.foodProvenance.customFoodVersionNumber === item.customFoodVersionNumber &&
    entry.foodVersionId === item.body.customFoodVersionId &&
    matchesFoodPortion(item.body.portion, entry.portion)
  );
}

/** Compatibility alias retained while existing quick-add screens migrate to typed enqueue. */
export function matchesQuickAddReceipt(
  item: QuickAddOutboxItem,
  status: number,
  mutation: DiaryMutationResult,
): boolean {
  return matchesDiaryOutboxReceipt(item, status, mutation);
}

async function parseDiaryOrderReceipt(
  item: DiaryReorderOutboxItem,
  status: number,
  value: unknown,
  sha256Hex: (payload: string) => Promise<string>,
): Promise<DiaryMutationResult | null> {
  if (
    status !== 200 ||
    !record(value) ||
    !exactKeys(value, ["data"]) ||
    !record(value.data) ||
    !exactKeys(value.data, ["replayed", "receipt"]) ||
    typeof value.data.replayed !== "boolean" ||
    !record(value.data.receipt)
  ) {
    return null;
  }
  const receipt = value.data.receipt;
  if (
    !exactKeys(receipt, [
      "operationId",
      "localDate",
      "timeZone",
      "expectedDayRevision",
      "resultingDayRevision",
      "previousOrderDigest",
      "orderDigest",
      "groups",
    ]) ||
    receipt.operationId !== item.operationId ||
    receipt.localDate !== item.localDate ||
    receipt.timeZone !== item.dayTimeZone ||
    String(receipt.expectedDayRevision) !== item.expectedDayRevision ||
    typeof receipt.resultingDayRevision !== "string" ||
    !/^[1-9]\d*$/u.test(receipt.resultingDayRevision) ||
    !isNextRevision(receipt.resultingDayRevision, item.expectedDayRevision) ||
    receipt.previousOrderDigest !== item.expectedOrderDigest ||
    receipt.orderDigest !== item.expectedResultOrderDigest ||
    !Array.isArray(receipt.groups) ||
    receipt.groups.length !== mealSlots.length
  ) {
    return null;
  }
  const seen = new Set<string>();
  let total = 0;
  const canonicalGroups: Array<DiaryOrderCanonicalGroups[number]> = [];
  for (const [groupIndex, slot] of mealSlots.entries()) {
    const group = receipt.groups[groupIndex];
    if (
      !record(group) ||
      !exactKeys(group, ["mealSlot", "entries"]) ||
      group.mealSlot !== slot ||
      !Array.isArray(group.entries) ||
      group.entries.length !== item.body.groups[slot].length
    ) {
      return null;
    }
    const canonicalEntries: Array<DiaryOrderCanonicalGroups[number][1][number]> = [];
    total += group.entries.length;
    for (const [position, entry] of group.entries.entries()) {
      if (
        !record(entry) ||
        !exactKeys(entry, ["entryId", "entryRevision", "position"]) ||
        typeof entry.entryId !== "string" ||
        !UUID.test(entry.entryId) ||
        seen.has(entry.entryId.toLowerCase()) ||
        typeof entry.entryRevision !== "string" ||
        !/^[1-9]\d*$/u.test(entry.entryRevision) ||
        entry.position !== position
      ) {
        return null;
      }
      seen.add(entry.entryId.toLowerCase());
      canonicalEntries.push([entry.entryId, entry.entryRevision, entry.position]);
    }
    canonicalGroups.push([slot, canonicalEntries]);
  }
  if (total < 1 || total > 50) return null;
  const canonicalDigest = await sha256Hex(
    diaryOrderDigestPayload(receipt.localDate, receipt.timeZone, canonicalGroups),
  );
  if (
    !/^[0-9a-f]{64}$/u.test(canonicalDigest) ||
    canonicalDigest !== receipt.orderDigest ||
    canonicalDigest !== item.expectedResultOrderDigest
  ) {
    return null;
  }
  return {
    replayed: value.data.replayed,
    entry: null,
    affectedDays: [{ localDate: item.localDate, revision: receipt.resultingDayRevision }],
  };
}

export type QuickAddOutboxControllerState =
  | { readonly status: "idle"; readonly pendingCount: 0 }
  | { readonly status: "pending"; readonly pendingCount: number }
  | {
      readonly status: "draining";
      readonly pendingCount: number;
      readonly operationId: string;
    }
  | {
      readonly status: "blocked";
      readonly pendingCount: number;
      readonly operationId: string;
      readonly httpStatus: TerminalQuickAddStatus;
      readonly blockedReason: "terminal_http" | "time_zone_changed";
      readonly operationKind?: DiaryOutboxOperationKind;
      readonly foodName: string;
      readonly servingLabel: string;
      readonly localDate: string;
      readonly mealSlot: MealSlot;
    }
  | {
      readonly status: "unavailable";
      readonly pendingCount: number;
      readonly reason: "storage" | "credential" | "network" | "response";
    }
  | { readonly status: "owner_mismatch"; readonly pendingCount: 0 }
  | { readonly status: "closed"; readonly pendingCount: number };

export interface QuickAddOutboxControllerOptions {
  readonly apiBase: URL;
  readonly ownerUserId: string;
  readonly expectedTimeZone: string;
  readonly store: QuickAddOutboxStore;
  readonly fetcher: (input: URL, init: RequestInit) => Promise<Response>;
  readonly accessToken: () => string | null;
  readonly isForeground: () => boolean;
  readonly operationId: () => string;
  readonly sha256Hex: (payload: string) => Promise<string>;
  readonly now?: () => Date;
  readonly onUnauthorized: () => Promise<void>;
  /** Fence the controller and begin durable private-device cleanup for structural journal faults. */
  readonly onFatalStoreError: (reason: FatalQuickAddOutboxStoreReason) => Promise<void>;
  readonly onReceipt?: (receipt: QuickAddReceipt) => void | Promise<void>;
}

export interface QuickAddOutboxController {
  readonly getState: () => QuickAddOutboxControllerState;
  readonly subscribe: (listener: (state: QuickAddOutboxControllerState) => void) => () => void;
  readonly enqueue: (
    input: QuickAddEnqueueInput | AnyDiaryOutboxEnqueueInput,
  ) => Promise<QuickAddOutboxItem>;
  /** Preferred typed API for every closed durable diary operation. */
  readonly enqueueOperation: (input: AnyDiaryOutboxEnqueueInput) => Promise<QuickAddOutboxItem>;
  readonly pendingDependencies: () => Promise<DiaryOutboxPendingDependencies>;
  /**
   * Release one newly persisted operation after its receipt owner is registered, then request a
   * drain. Calls without an operation ID never release a new enqueue.
   */
  readonly requestDrain: (releaseOperationId?: string) => Promise<void>;
  readonly retryBlockedHead: (expectedOperationId: string) => Promise<void>;
  readonly discardBlockedHead: (expectedOperationId: string) => Promise<void>;
  readonly suspend: () => void;
  readonly resume: () => Promise<void>;
  readonly close: () => void;
}

export interface DiaryOutboxPendingDependencies {
  readonly correctedEntryIds: readonly string[];
  readonly reorderedLocalDates: readonly string[];
  readonly pendingLocalDates: readonly string[];
}

function correctionEnqueueInput(
  input: AnyDiaryOutboxEnqueueInput,
): input is DiaryCorrectionOutboxEnqueueInput {
  return (
    input.operationKind === "repeat" ||
    input.operationKind === "update" ||
    input.operationKind === "delete" ||
    input.operationKind === "reorder"
  );
}

function fatalStoreReason(error: unknown): FatalQuickAddOutboxStoreReason | null {
  if (!(error instanceof Error)) return null;
  if (error.name === "QuickAddOutboxOwnerMismatchError") return "owner_mismatch";
  if (
    error.name === "QuickAddOutboxCorruptError" ||
    error.name === "QuickAddOutboxHeadConflictError"
  ) {
    return "corrupt";
  }
  return null;
}

function pendingState(snapshot: QuickAddOutboxSnapshot): QuickAddOutboxControllerState {
  const head = snapshot.items[0];
  if (!head) return { status: "idle", pendingCount: 0 };
  if (head.blocked) {
    return {
      status: "blocked",
      pendingCount: snapshot.items.length,
      operationId: head.operationId,
      httpStatus: head.blocked.status,
      blockedReason: head.blocked.reason,
      operationKind: diaryOutboxOperationKind(head),
      foodName: head.display.foodName,
      servingLabel: head.display.servingLabel,
      localDate: head.localDate,
      mealSlot: diaryOutboxDisplayMealSlot(head),
    };
  }
  return { status: "pending", pendingCount: snapshot.items.length };
}

/**
 * A foreground-only FIFO controller. It never persists credentials and never acknowledges an
 * operation until the server's idempotent receipt exactly matches the immutable stored request.
 */
export function createQuickAddOutboxController(
  options: QuickAddOutboxControllerOptions,
): QuickAddOutboxController {
  let state: QuickAddOutboxControllerState = { status: "idle", pendingCount: 0 };
  let closed = false;
  let suspended = false;
  let authExpired = false;
  let fatalStoreFailure = false;
  let epoch = 0;
  let storageEpoch = 0;
  let activeRequest: AbortController | null = null;
  let drainFlight: Promise<void> | null = null;
  let drainRequestVersion = 0;
  let unauthorizedFlight: Promise<void> | null = null;
  let fatalStoreFlight: Promise<void> | null = null;
  let acceptedHead: {
    readonly item: QuickAddOutboxItem;
    readonly mutation: DiaryMutationResult;
  } | null = null;
  const registrationHolds = new Set<string>();
  const listeners = new Set<(next: QuickAddOutboxControllerState) => void>();

  function publish(next: QuickAddOutboxControllerState): void {
    state = next;
    for (const listener of listeners) {
      try {
        listener(next);
      } catch {
        // Observers cannot interrupt durable queue transitions or network classification.
      }
    }
  }

  function alive(capturedEpoch: number): boolean {
    return !closed && !authExpired && !fatalStoreFailure && epoch === capturedEpoch;
  }

  function storageAlive(capturedStorageEpoch: number): boolean {
    return !closed && !authExpired && !fatalStoreFailure && storageEpoch === capturedStorageEpoch;
  }

  function fail(
    error: unknown,
    reason: "storage" | "credential" | "network" | "response",
    pendingCount: number,
  ): void {
    void error;
    publish({ status: "unavailable", pendingCount, reason });
  }

  async function fenceFatalStore(
    reason: FatalQuickAddOutboxStoreReason,
    pendingCount: number,
  ): Promise<void> {
    if (fatalStoreFailure || closed) {
      if (fatalStoreFlight) await fatalStoreFlight;
      return;
    }
    fatalStoreFailure = true;
    epoch += 1;
    storageEpoch += 1;
    activeRequest?.abort();
    activeRequest = null;
    acceptedHead = null;
    publish(
      reason === "owner_mismatch"
        ? { status: "owner_mismatch", pendingCount: 0 }
        : { status: "unavailable", pendingCount, reason: "storage" },
    );
    try {
      fatalStoreFlight = Promise.resolve(options.onFatalStoreError(reason));
    } catch (error) {
      fatalStoreFlight = Promise.reject(error);
    }
    try {
      await fatalStoreFlight;
    } catch {
      // The controller stays fenced. The owning app keeps durable cleanup retry state.
    }
  }

  async function handleStoreFailure(error: unknown, pendingCount: number): Promise<void> {
    const fatal = fatalStoreReason(error);
    if (fatal) await fenceFatalStore(fatal, pendingCount);
    else fail(error, "storage", pendingCount);
  }

  async function blockReason(response: Response): Promise<QuickAddOutboxBlockedState["reason"]> {
    if (response.status !== 409) return "terminal_http";
    try {
      const body = await jsonBody(response);
      return record(body) && body.status === 409 && body.code === "DIARY_TIME_ZONE_CHANGED"
        ? "time_zone_changed"
        : "terminal_http";
    } catch {
      return "terminal_http";
    }
  }

  async function snapshot(capturedEpoch: number): Promise<QuickAddOutboxSnapshot | null> {
    try {
      const current = await options.store.snapshot(options.ownerUserId);
      if (!alive(capturedEpoch)) return null;
      return current;
    } catch (error) {
      if (alive(capturedEpoch)) await handleStoreFailure(error, 0);
      return null;
    }
  }

  async function fenceUnauthorized(pendingCount: number): Promise<void> {
    if (authExpired || closed) return;
    authExpired = true;
    epoch += 1;
    storageEpoch += 1;
    activeRequest?.abort();
    activeRequest = null;
    acceptedHead = null;
    publish({ status: "unavailable", pendingCount, reason: "credential" });
    unauthorizedFlight ??= Promise.resolve().then(options.onUnauthorized);
    try {
      await unauthorizedFlight;
    } catch {
      // The controller stays fenced. The owning auth flow is responsible for retrying cleanup.
    }
  }

  async function recoverySnapshot(
    capturedEpoch: number,
    pendingCount: number,
  ): Promise<QuickAddOutboxSnapshot | null> {
    try {
      const recovered = await options.store.snapshot(options.ownerUserId);
      return alive(capturedEpoch) ? recovered : null;
    } catch (error) {
      if (alive(capturedEpoch)) await handleStoreFailure(error, pendingCount);
      return null;
    }
  }

  async function emitAcceptedReceipt(capturedEpoch: number): Promise<boolean> {
    const accepted = acceptedHead;
    if (!accepted || !alive(capturedEpoch)) return false;
    acceptedHead = null;
    if (options.onReceipt) {
      try {
        await options.onReceipt({
          operationId: accepted.item.operationId,
          mutation: accepted.mutation,
        });
      } catch {
        // The receipt was already durably accepted; UI refresh failure must not replay it.
      }
    }
    return alive(capturedEpoch);
  }

  async function reconcileAcceptedHead(
    current: QuickAddOutboxSnapshot,
    capturedEpoch: number,
  ): Promise<boolean> {
    const accepted = acceptedHead;
    if (!accepted || !alive(capturedEpoch)) return false;
    const matching = current.items.find((item) => item.operationId === accepted.item.operationId);
    if (!matching) return emitAcceptedReceipt(capturedEpoch);
    if (current.items[0]?.operationId !== accepted.item.operationId || matching.blocked !== null) {
      await fenceFatalStore("corrupt", current.items.length);
      return false;
    }
    try {
      await options.store.acknowledgeHead(options.ownerUserId, accepted.item.operationId, () =>
        alive(capturedEpoch),
      );
    } catch (error) {
      if (!alive(capturedEpoch)) return false;
      const recovered = await recoverySnapshot(capturedEpoch, current.items.length);
      if (!recovered || !alive(capturedEpoch)) return false;
      const recoveredMatch = recovered.items.find(
        (item) => item.operationId === accepted.item.operationId,
      );
      if (!recoveredMatch) return emitAcceptedReceipt(capturedEpoch);
      if (
        recovered.items[0]?.operationId !== accepted.item.operationId ||
        recoveredMatch.blocked !== null
      ) {
        await fenceFatalStore("corrupt", recovered.items.length);
        return false;
      }
      const fatal = fatalStoreReason(error);
      if (fatal) await fenceFatalStore(fatal, recovered.items.length);
      else fail(error, "storage", recovered.items.length);
      return false;
    }
    return emitAcceptedReceipt(capturedEpoch);
  }

  async function runDrainPass(capturedEpoch: number): Promise<void> {
    let maximumSequence: number | null = null;
    while (alive(capturedEpoch) && !suspended && options.isForeground()) {
      const current = await snapshot(capturedEpoch);
      if (!current) return;
      if (maximumSequence === null) maximumSequence = current.items.at(-1)?.sequence ?? -1;
      if (acceptedHead) {
        if (!(await reconcileAcceptedHead(current, capturedEpoch))) return;
        continue;
      }
      const head = current.items[0];
      if (!head) {
        publish({ status: "idle", pendingCount: 0 });
        return;
      }
      if (registrationHolds.has(head.operationId)) {
        publish(pendingState(current));
        return;
      }
      if (head.sequence > maximumSequence) {
        publish(pendingState(current));
        return;
      }
      if (head.blocked) {
        publish(pendingState(current));
        return;
      }
      const token = options.accessToken();
      if (!token) {
        publish({
          status: "unavailable",
          pendingCount: current.items.length,
          reason: "credential",
        });
        return;
      }
      publish({
        status: "draining",
        pendingCount: current.items.length,
        operationId: head.operationId,
      });
      const request = new AbortController();
      activeRequest = request;
      let response: Response;
      try {
        const outbound = diaryOutboxRequest(head);
        const headers: Record<string, string> = { "idempotency-key": head.operationId };
        if (outbound.body !== undefined) headers["content-type"] = "application/json";
        if (outbound.expectedRevision !== undefined) {
          headers["if-match"] = `"${outbound.expectedRevision}"`;
        }
        if (outbound.sendExpectedTimeZone) {
          headers["x-expected-profile-time-zone"] = head.expectedTimeZone;
        }
        if (head.version === 3 && head.operationKind === "reorder") {
          headers["x-expected-diary-order-digest"] = head.expectedOrderDigest;
        }
        response = await options.fetcher(apiUrl(options.apiBase, outbound.path), {
          method: outbound.method,
          headers: authenticatedHeaders(token, headers),
          ...(outbound.body === undefined ? {} : { body: JSON.stringify(outbound.body) }),
          signal: request.signal,
        });
      } catch {
        if (alive(capturedEpoch) && !suspended) {
          publish({
            status: "unavailable",
            pendingCount: current.items.length,
            reason: "network",
          });
        }
        return;
      } finally {
        if (activeRequest === request) activeRequest = null;
      }
      if (!alive(capturedEpoch) || suspended) return;
      if (response.status === 401) {
        await fenceUnauthorized(current.items.length);
        return;
      }
      if (terminalStatus(response.status)) {
        try {
          const reason = await blockReason(response);
          await options.store.blockHead(
            options.ownerUserId,
            head.operationId,
            response.status,
            reason,
            () => alive(capturedEpoch),
          );
          if (alive(capturedEpoch)) {
            publish({
              status: "blocked",
              pendingCount: current.items.length,
              operationId: head.operationId,
              httpStatus: response.status,
              blockedReason: reason,
              operationKind: diaryOutboxOperationKind(head),
              foodName: head.display.foodName,
              servingLabel: head.display.servingLabel,
              localDate: head.localDate,
              mealSlot: diaryOutboxDisplayMealSlot(head),
            });
          }
        } catch (error) {
          if (alive(capturedEpoch)) await handleStoreFailure(error, current.items.length);
        }
        return;
      }
      if (!(response.status === 200 || response.status === 201)) {
        publish({ status: "pending", pendingCount: current.items.length });
        return;
      }
      let mutation: DiaryMutationResult;
      try {
        const responseBody = await jsonBody(response);
        if (head.version === 3 && head.operationKind === "reorder") {
          const orderMutation = await parseDiaryOrderReceipt(
            head,
            response.status,
            responseBody,
            options.sha256Hex,
          );
          if (orderMutation === null) throw new TypeError("The diary order receipt was invalid.");
          mutation = orderMutation;
        } else {
          mutation = parseDiaryMutation(responseBody);
          if (!matchesDiaryOutboxReceipt(head, response.status, mutation, responseBody)) {
            throw new TypeError("The diary operation receipt was invalid.");
          }
        }
      } catch {
        if (alive(capturedEpoch)) {
          publish({
            status: "unavailable",
            pendingCount: current.items.length,
            reason: "response",
          });
        }
        return;
      }
      if (!alive(capturedEpoch)) return;
      acceptedHead = { item: head, mutation };
      if (!(await reconcileAcceptedHead(current, capturedEpoch))) return;
    }
  }

  async function runDrain(capturedEpoch: number): Promise<number> {
    let handledRequestVersion: number;
    do {
      handledRequestVersion = drainRequestVersion;
      await runDrainPass(capturedEpoch);
    } while (
      alive(capturedEpoch) &&
      !suspended &&
      options.isForeground() &&
      handledRequestVersion !== drainRequestVersion
    );
    return handledRequestVersion;
  }

  function requestDrain(releaseOperationId?: string): Promise<void> {
    if (releaseOperationId !== undefined) registrationHolds.delete(releaseOperationId);
    if (closed || authExpired || fatalStoreFailure || suspended || !options.isForeground()) {
      return Promise.resolve();
    }
    drainRequestVersion += 1;
    if (drainFlight) return drainFlight;
    const capturedEpoch = epoch;
    let handledRequestVersion = drainRequestVersion;
    let pending!: Promise<void>;
    pending = runDrain(capturedEpoch)
      .then((handled) => {
        handledRequestVersion = handled;
      })
      .catch(async (error: unknown) => {
        if (alive(capturedEpoch)) await handleStoreFailure(error, state.pendingCount);
      })
      .finally(() => {
        if (drainFlight !== pending) return;
        drainFlight = null;
        if (
          alive(capturedEpoch) &&
          !suspended &&
          options.isForeground() &&
          handledRequestVersion !== drainRequestVersion
        ) {
          return requestDrain();
        }
      });
    drainFlight = pending;
    return pending;
  }

  async function enqueue(
    input: QuickAddEnqueueInput | AnyDiaryOutboxEnqueueInput,
  ): Promise<QuickAddOutboxItem> {
    if (closed || authExpired || fatalStoreFailure) {
      throw new Error("The quick-add outbox controller is fenced.");
    }
    const capturedStorageEpoch = storageEpoch;
    const operationId = options.operationId();
    const draft =
      "operationKind" in input
        ? correctionEnqueueInput(input)
          ? createDiaryCorrectionOutboxDraft(
              options.ownerUserId,
              options.expectedTimeZone,
              input,
              operationId,
              (options.now ?? (() => new Date()))(),
            )
          : createDiaryOutboxDraft(
              options.ownerUserId,
              options.expectedTimeZone,
              input,
              operationId,
              (options.now ?? (() => new Date()))(),
            )
        : createQuickAddOutboxDraft(
            options.ownerUserId,
            options.expectedTimeZone,
            input,
            operationId,
            (options.now ?? (() => new Date()))(),
          );
    registrationHolds.add(operationId);
    try {
      const item = await options.store.append(options.ownerUserId, draft, () =>
        storageAlive(capturedStorageEpoch),
      );
      if (!storageAlive(capturedStorageEpoch)) {
        throw new Error("The quick-add outbox controller changed storage epoch.");
      }
      const current = await options.store.snapshot(options.ownerUserId);
      if (!storageAlive(capturedStorageEpoch)) {
        throw new Error("The quick-add outbox controller changed storage epoch.");
      }
      publish(pendingState(current));
      return item;
    } catch (error) {
      let recoveredWithoutOperation: QuickAddOutboxSnapshot | null = null;
      if (storageAlive(capturedStorageEpoch)) {
        try {
          const recovered = await options.store.snapshot(options.ownerUserId);
          if (!storageAlive(capturedStorageEpoch)) {
            throw new Error("The quick-add outbox controller changed storage epoch.");
          }
          const recoveredItem = recovered.items.find((item) => item.operationId === operationId);
          if (recoveredItem) {
            publish(pendingState(recovered));
            return recoveredItem;
          }
          recoveredWithoutOperation = recovered;
        } catch (recoveryError) {
          if (storageAlive(capturedStorageEpoch)) {
            const fatal = fatalStoreReason(recoveryError) ?? fatalStoreReason(error);
            if (fatal) {
              registrationHolds.delete(operationId);
              await fenceFatalStore(fatal, state.pendingCount);
              throw error;
            }
            fail(recoveryError, "storage", state.pendingCount);
            throw new QuickAddEnqueueAmbiguousError(operationId, error);
          }
        }
      }
      registrationHolds.delete(operationId);
      if (!storageAlive(capturedStorageEpoch)) {
        throw new QuickAddEnqueueAmbiguousError(operationId, error);
      }
      const fatal = fatalStoreReason(error);
      if (fatal) await fenceFatalStore(fatal, state.pendingCount);
      else if (recoveredWithoutOperation) publish(pendingState(recoveredWithoutOperation));
      else fail(error, "storage", state.pendingCount);
      throw error;
    }
  }

  async function retryBlockedHead(expectedOperationId: string): Promise<void> {
    if (closed || authExpired || fatalStoreFailure) {
      throw new Error("The quick-add outbox controller is fenced.");
    }
    const capturedEpoch = epoch;
    try {
      await options.store.retryHead(options.ownerUserId, expectedOperationId, () =>
        alive(capturedEpoch),
      );
    } catch (error) {
      if (!alive(capturedEpoch)) throw error;
      const recovered = await recoverySnapshot(capturedEpoch, state.pendingCount);
      if (!recovered || !alive(capturedEpoch)) throw error;
      const matching = recovered.items.find((item) => item.operationId === expectedOperationId);
      if (!matching) {
        publish(pendingState(recovered));
        if (alive(capturedEpoch)) await requestDrain();
        return;
      }
      if (recovered.items[0]?.operationId !== expectedOperationId) {
        await fenceFatalStore("corrupt", recovered.items.length);
        throw error;
      }
      publish(pendingState(recovered));
      if (matching.blocked !== null) throw error;
    }
    if (alive(capturedEpoch)) await requestDrain();
  }

  async function discardBlockedHead(expectedOperationId: string): Promise<void> {
    if (closed || authExpired || fatalStoreFailure) {
      throw new Error("The quick-add outbox controller is fenced.");
    }
    const capturedEpoch = epoch;
    try {
      await options.store.discardBlockedHead(options.ownerUserId, expectedOperationId, () =>
        alive(capturedEpoch),
      );
    } catch (error) {
      if (!alive(capturedEpoch)) throw error;
      const recovered = await recoverySnapshot(capturedEpoch, state.pendingCount);
      if (!recovered || !alive(capturedEpoch)) throw error;
      const matching = recovered.items.find((item) => item.operationId === expectedOperationId);
      if (matching) {
        if (recovered.items[0]?.operationId !== expectedOperationId) {
          await fenceFatalStore("corrupt", recovered.items.length);
        } else {
          publish(pendingState(recovered));
        }
        throw error;
      }
      publish(pendingState(recovered));
    }
    if (alive(capturedEpoch)) await requestDrain();
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    enqueue,
    enqueueOperation: enqueue,
    async pendingDependencies() {
      const current = await options.store.snapshot(options.ownerUserId);
      return {
        correctedEntryIds: current.items
          .map(diaryOutboxEntryCorrectionId)
          .filter((entryId): entryId is string => entryId !== null),
        reorderedLocalDates: current.items
          .filter(
            (item): item is DiaryReorderOutboxItem =>
              item.version === 3 && item.operationKind === "reorder",
          )
          .map((item) => item.localDate),
        pendingLocalDates: [
          ...new Set(current.items.flatMap((item) => diaryOutboxAffectedLocalDates(item))),
        ],
      };
    },
    requestDrain,
    retryBlockedHead,
    discardBlockedHead,
    suspend() {
      if (closed || suspended) return;
      suspended = true;
      activeRequest?.abort();
      activeRequest = null;
      if (state.status === "draining") {
        publish({ status: "pending", pendingCount: state.pendingCount });
      }
    },
    resume() {
      if (closed || authExpired || fatalStoreFailure) return Promise.resolve();
      suspended = false;
      const interruptedDrain = drainFlight;
      return interruptedDrain ? interruptedDrain.then(() => requestDrain()) : requestDrain();
    },
    close() {
      if (closed) return;
      closed = true;
      epoch += 1;
      storageEpoch += 1;
      activeRequest?.abort();
      activeRequest = null;
      acceptedHead = null;
      registrationHolds.clear();
      publish({ status: "closed", pendingCount: state.pendingCount });
      listeners.clear();
    },
  };
}
