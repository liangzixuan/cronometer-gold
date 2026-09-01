import { apiUrl, authenticatedHeaders, jsonBody } from "../api/private-api";
import {
  type DiaryMutationResult,
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

export interface QuickAddOutboxBlockedState {
  readonly kind: "terminal_http";
  readonly status: TerminalQuickAddStatus;
  readonly reason: "terminal_http" | "time_zone_changed";
}

export interface QuickAddOutboxItem {
  readonly version: 1;
  readonly sequence: number;
  readonly ownerUserId: string;
  readonly operationId: string;
  readonly enqueuedAt: string;
  readonly expectedTimeZone: string;
  readonly localDate: string;
  readonly foodKind: PublicFoodKind;
  readonly display: {
    readonly foodName: string;
    readonly servingLabel: string;
  };
  readonly body: QuickAddRequestBody;
  readonly blocked: QuickAddOutboxBlockedState | null;
}

export type QuickAddOutboxDraft = Omit<QuickAddOutboxItem, "sequence" | "blocked">;

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

function parseBody(value: unknown): QuickAddRequestBody {
  if (
    !record(value) ||
    !exactKeys(value, ["foodVersionId", "portion", "mealSlot", "occurredAt"]) ||
    typeof value.foodVersionId !== "string" ||
    !POSITIVE_ID.test(value.foodVersionId) ||
    !record(value.portion) ||
    !exactKeys(value.portion, ["kind", "servingId", "amount"]) ||
    value.portion.kind !== "serving" ||
    typeof value.portion.servingId !== "string" ||
    !POSITIVE_ID.test(value.portion.servingId) ||
    value.portion.amount !== "1" ||
    !mealSlot(value.mealSlot) ||
    !instant(value.occurredAt)
  ) {
    throw new TypeError("The quick-add outbox request body was invalid.");
  }
  return {
    foodVersionId: value.foodVersionId,
    portion: { kind: "serving", servingId: value.portion.servingId, amount: "1" },
    mealSlot: value.mealSlot,
    occurredAt: value.occurredAt,
  };
}

/** Parse a closed, bounded envelope. Unknown fields are rejected, including credentials and queries. */
export function parseQuickAddOutboxItem(value: unknown): QuickAddOutboxItem {
  const candidate: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (
    !record(candidate) ||
    !exactKeys(candidate, [
      "version",
      "sequence",
      "ownerUserId",
      "operationId",
      "enqueuedAt",
      "expectedTimeZone",
      "localDate",
      "foodKind",
      "display",
      "body",
      "blocked",
    ]) ||
    candidate.version !== 1 ||
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
    !(candidate.foodKind === "generic" || candidate.foodKind === "branded") ||
    !record(candidate.display) ||
    !exactKeys(candidate.display, ["foodName", "servingLabel"]) ||
    !validUnicodeText(candidate.display.foodName, 96) ||
    !validUnicodeText(candidate.display.servingLabel, 64)
  ) {
    throw new TypeError("The quick-add outbox envelope was invalid.");
  }
  const body = parseBody(candidate.body);
  if (
    localDateInTimeZone(new Date(body.occurredAt), candidate.expectedTimeZone) !==
    candidate.localDate
  ) {
    throw new TypeError("The quick-add outbox date did not match its immutable request.");
  }
  const item: QuickAddOutboxItem = {
    version: 1,
    sequence: Number(candidate.sequence),
    ownerUserId: candidate.ownerUserId,
    operationId: candidate.operationId,
    enqueuedAt: candidate.enqueuedAt,
    expectedTimeZone: candidate.expectedTimeZone,
    localDate: candidate.localDate,
    foodKind: candidate.foodKind,
    display: {
      foodName: candidate.display.foodName,
      servingLabel: candidate.display.servingLabel,
    },
    body,
    blocked: parseBlocked(candidate.blocked),
  };
  if (new TextEncoder().encode(JSON.stringify(item)).byteLength > MAX_QUICK_ADD_OUTBOX_SLOT_BYTES) {
    throw new RangeError("The quick-add outbox envelope exceeded its reviewed storage bound.");
  }
  return item;
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

export function matchesQuickAddReceipt(
  item: QuickAddOutboxItem,
  status: number,
  mutation: DiaryMutationResult,
): boolean {
  const entry = mutation.entry;
  return (
    ((status === 201 && !mutation.replayed) || (status === 200 && mutation.replayed)) &&
    entry !== null &&
    entry.entryKind === "food" &&
    entry.foodProvenance.kind === "public" &&
    entry.foodVersionId === item.body.foodVersionId &&
    entry.portion.kind === "serving" &&
    entry.portion.servingId === item.body.portion.servingId &&
    entry.portion.amount === "1" &&
    entry.mealSlot === item.body.mealSlot &&
    entry.occurredAt === item.body.occurredAt &&
    entry.localDate === item.localDate &&
    entry.timeZone === item.expectedTimeZone &&
    mutation.affectedDays.some((day) => day.localDate === item.localDate)
  );
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
  readonly now?: () => Date;
  readonly onUnauthorized: () => Promise<void>;
  /** Fence the controller and begin durable private-device cleanup for structural journal faults. */
  readonly onFatalStoreError: (reason: FatalQuickAddOutboxStoreReason) => Promise<void>;
  readonly onReceipt?: (receipt: QuickAddReceipt) => void | Promise<void>;
}

export interface QuickAddOutboxController {
  readonly getState: () => QuickAddOutboxControllerState;
  readonly subscribe: (listener: (state: QuickAddOutboxControllerState) => void) => () => void;
  readonly enqueue: (input: QuickAddEnqueueInput) => Promise<QuickAddOutboxItem>;
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
      foodName: head.display.foodName,
      servingLabel: head.display.servingLabel,
      localDate: head.localDate,
      mealSlot: head.body.mealSlot,
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
        response = await options.fetcher(
          apiUrl(options.apiBase, "/v1/diary/entries?profileTimeZonePrecondition=v1"),
          {
            method: "POST",
            headers: authenticatedHeaders(token, {
              "content-type": "application/json",
              "idempotency-key": head.operationId,
              "x-expected-profile-time-zone": head.expectedTimeZone,
            }),
            body: JSON.stringify(head.body),
            signal: request.signal,
          },
        );
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
              foodName: head.display.foodName,
              servingLabel: head.display.servingLabel,
              localDate: head.localDate,
              mealSlot: head.body.mealSlot,
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
        mutation = parseDiaryMutation(await jsonBody(response));
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
      if (!alive(capturedEpoch) || !matchesQuickAddReceipt(head, response.status, mutation)) {
        if (alive(capturedEpoch)) {
          publish({
            status: "unavailable",
            pendingCount: current.items.length,
            reason: "response",
          });
        }
        return;
      }
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

  async function enqueue(input: QuickAddEnqueueInput): Promise<QuickAddOutboxItem> {
    if (closed || authExpired || fatalStoreFailure) {
      throw new Error("The quick-add outbox controller is fenced.");
    }
    const capturedStorageEpoch = storageEpoch;
    const operationId = options.operationId();
    registrationHolds.add(operationId);
    try {
      const draft = createQuickAddOutboxDraft(
        options.ownerUserId,
        options.expectedTimeZone,
        input,
        operationId,
        (options.now ?? (() => new Date()))(),
      );
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
      if (storageAlive(capturedStorageEpoch)) {
        const fatal = fatalStoreReason(error);
        if (fatal) await fenceFatalStore(fatal, state.pendingCount);
        else if (recoveredWithoutOperation) publish(pendingState(recoveredWithoutOperation));
        else fail(error, "storage", state.pendingCount);
      }
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
