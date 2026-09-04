import { domainInvariant } from "./errors.js";
import { deepFreeze } from "./immutable.js";
import { canonicalRfc3339Instant, deriveDiaryLocalCoordinates } from "./time.js";

/** Operational product bounds, not medical intake recommendations. */
export const MAX_HYDRATION_AMOUNT_MILLILITERS = 20_000;
export const MAX_HYDRATION_ENTRIES_PER_DAY = 64;
export const MAX_HYDRATION_DAY_TOTAL_MILLILITERS = 100_000;

export type HydrationRevisionOperation = "create" | "delete" | "update";

export interface HydrationEntryRevisionInput {
  readonly revisionId: string;
  readonly entryId: string;
  readonly revisionNumber: number;
  readonly supersedesRevisionId: string | null;
  readonly operation: HydrationRevisionOperation;
  readonly amountMilliliters: number;
  readonly occurredAt: string;
  readonly timeZone: string;
  /** Supplied by the application clock; this pure package never reads time. */
  readonly capturedAt: string;
}

export interface HydrationEntryRevision {
  readonly schemaVersion: 1;
  readonly revisionId: string;
  readonly entryId: string;
  readonly revisionNumber: number;
  readonly supersedesRevisionId: string | null;
  readonly operation: HydrationRevisionOperation;
  readonly amountMilliliters: number;
  readonly occurredAt: string;
  readonly localDate: string;
  readonly localTime: string;
  readonly timeZone: string;
  readonly capturedAt: string;
}

export function canonicalHydrationAmountMilliliters(value: number): number {
  domainInvariant(
    Number.isSafeInteger(value) && value >= 1 && value <= MAX_HYDRATION_AMOUNT_MILLILITERS,
    "INVALID_HYDRATION",
    `amountMilliliters must be an integer from 1 through ${MAX_HYDRATION_AMOUNT_MILLILITERS}`,
    { amountMilliliters: value },
  );
  return value;
}

/**
 * Build the immutable, owner-exportable event state persisted for one revision.
 * Hydration is deliberately independent from food, nutrient, and energy models.
 */
export function createHydrationEntryRevision(
  input: HydrationEntryRevisionInput,
): HydrationEntryRevision {
  validateRequiredText("revisionId", input.revisionId);
  validateRequiredText("entryId", input.entryId);
  domainInvariant(
    Number.isSafeInteger(input.revisionNumber) && input.revisionNumber > 0,
    "INVALID_HYDRATION",
    "revisionNumber must be a positive safe integer",
  );
  if (input.operation === "create") {
    domainInvariant(
      input.revisionNumber === 1 && input.supersedesRevisionId === null,
      "INVALID_HYDRATION",
      "A create revision must be revision 1 and supersede nothing",
    );
  } else {
    domainInvariant(
      input.revisionNumber > 1 && input.supersedesRevisionId !== null,
      "INVALID_HYDRATION",
      "An update or delete revision must supersede an earlier revision",
    );
    validateRequiredText("supersedesRevisionId", input.supersedesRevisionId);
    domainInvariant(
      input.supersedesRevisionId !== input.revisionId,
      "INVALID_HYDRATION",
      "A hydration revision cannot supersede itself",
    );
  }

  const coordinates = deriveDiaryLocalCoordinates(input.occurredAt, input.timeZone);
  return deepFreeze({
    schemaVersion: 1,
    revisionId: input.revisionId,
    entryId: input.entryId,
    revisionNumber: input.revisionNumber,
    supersedesRevisionId: input.supersedesRevisionId,
    operation: input.operation,
    amountMilliliters: canonicalHydrationAmountMilliliters(input.amountMilliliters),
    occurredAt: coordinates.occurredAt,
    localDate: coordinates.localDate,
    localTime: coordinates.localTime,
    timeZone: coordinates.timeZone,
    capturedAt: canonicalRfc3339Instant(input.capturedAt, "capturedAt"),
  });
}

/** Exact bounded sum for one profile-local day. */
export function sumHydrationMilliliters(amounts: readonly number[]): number {
  domainInvariant(
    amounts.length <= MAX_HYDRATION_ENTRIES_PER_DAY,
    "INVALID_HYDRATION",
    `A hydration day may contain at most ${MAX_HYDRATION_ENTRIES_PER_DAY} active entries`,
  );
  const total = amounts.reduce(
    (sum, amount) => sum + canonicalHydrationAmountMilliliters(amount),
    0,
  );
  domainInvariant(
    Number.isSafeInteger(total) && total <= MAX_HYDRATION_DAY_TOTAL_MILLILITERS,
    "INVALID_HYDRATION",
    `A hydration day may total at most ${MAX_HYDRATION_DAY_TOTAL_MILLILITERS} milliliters`,
  );
  return total;
}

function validateRequiredText(field: string, value: string): void {
  domainInvariant(value.trim().length > 0, "INVALID_HYDRATION", `${field} is required`);
}
