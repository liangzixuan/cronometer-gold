import {
  MAX_QUICK_ADD_OUTBOX_ITEMS,
  parseQuickAddOutboxItem,
  type QuickAddOutboxBlockedState,
  type QuickAddOutboxDraft,
  type QuickAddOutboxItem,
  type QuickAddOutboxSnapshot,
  type TerminalQuickAddStatus,
} from "./quick-add-outbox";

export const QUICK_ADD_OUTBOX_MANIFEST_KEY = "nutrition-tracker.quick-add-outbox.v1.manifest";
const SLOT_PREFIX = "nutrition-tracker.quick-add-outbox.v1.slot";

export function quickAddOutboxSlotKey(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index >= MAX_QUICK_ADD_OUTBOX_ITEMS) {
    throw new RangeError("The quick-add outbox slot index was invalid.");
  }
  return `${SLOT_PREFIX}.${String(index).padStart(2, "0")}`;
}

export interface ProtectedQuickAddKeyValue {
  readonly get: (key: string) => Promise<string | null>;
  readonly set: (key: string, value: string) => Promise<void>;
  readonly delete: (key: string) => Promise<void>;
}

export type QuickAddEpochGuard = () => boolean;

export interface QuickAddOutboxStore {
  readonly snapshot: (ownerUserId: string) => Promise<QuickAddOutboxSnapshot>;
  readonly append: (
    ownerUserId: string,
    draft: QuickAddOutboxDraft,
    guard?: QuickAddEpochGuard,
  ) => Promise<QuickAddOutboxItem>;
  readonly acknowledgeHead: (
    ownerUserId: string,
    expectedOperationId: string,
    guard?: QuickAddEpochGuard,
  ) => Promise<void>;
  readonly blockHead: (
    ownerUserId: string,
    expectedOperationId: string,
    status: TerminalQuickAddStatus,
    reason: QuickAddOutboxBlockedState["reason"],
    guard?: QuickAddEpochGuard,
  ) => Promise<void>;
  readonly retryHead: (
    ownerUserId: string,
    expectedOperationId: string,
    guard?: QuickAddEpochGuard,
  ) => Promise<void>;
  readonly discardBlockedHead: (
    ownerUserId: string,
    expectedOperationId: string,
    guard?: QuickAddEpochGuard,
  ) => Promise<void>;
  readonly clear: () => Promise<void>;
}

export class QuickAddOutboxFullError extends Error {
  constructor() {
    super("The quick-add outbox has reached its fixed 50-item capacity.");
    this.name = "QuickAddOutboxFullError";
  }
}

export class QuickAddOutboxCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuickAddOutboxCorruptError";
  }
}

export class QuickAddOutboxOwnerMismatchError extends Error {
  constructor() {
    super("The quick-add outbox belongs to a different authenticated account.");
    this.name = "QuickAddOutboxOwnerMismatchError";
  }
}

export class QuickAddOutboxHeadConflictError extends Error {
  constructor() {
    super("The quick-add outbox head changed before the requested operation.");
    this.name = "QuickAddOutboxHeadConflictError";
  }
}

export class QuickAddOutboxEpochError extends Error {
  constructor() {
    super("The quick-add outbox lifecycle epoch changed before commit.");
    this.name = "QuickAddOutboxEpochError";
  }
}

interface QuickAddOutboxManifestBase {
  readonly version: 1;
  readonly ownerUserId: string;
  readonly headSequence: number;
  readonly nextSequence: number;
  readonly count: number;
}

interface QuickAddOutboxReadyManifest extends QuickAddOutboxManifestBase {
  readonly state: "ready";
}

interface QuickAddOutboxAppendManifest extends QuickAddOutboxManifestBase {
  readonly state: "appending";
  readonly sequence: number;
  readonly operationId: string;
}

interface QuickAddOutboxRemoveManifest extends QuickAddOutboxManifestBase {
  readonly state: "removing";
  readonly sequence: number;
  readonly operationId: string;
}

interface QuickAddOutboxClearingManifest {
  readonly version: 1;
  readonly state: "clearing";
}

type QuickAddOutboxManifest =
  | QuickAddOutboxReadyManifest
  | QuickAddOutboxAppendManifest
  | QuickAddOutboxRemoveManifest
  | QuickAddOutboxClearingManifest;

interface LoadedOutbox {
  readonly manifest: QuickAddOutboxReadyManifest | null;
  readonly snapshot: QuickAddOutboxSnapshot;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SLOT_TOMBSTONE = '{"version":1,"tombstone":true}';
const locks = new Map<string, Promise<void>>();

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function parseManifestBase(value: Record<string, unknown>): QuickAddOutboxManifestBase {
  if (
    value.version !== 1 ||
    typeof value.ownerUserId !== "string" ||
    !UUID.test(value.ownerUserId) ||
    !Number.isSafeInteger(value.headSequence) ||
    Number(value.headSequence) < 0 ||
    !Number.isSafeInteger(value.nextSequence) ||
    Number(value.nextSequence) < Number(value.headSequence) ||
    !Number.isSafeInteger(value.count) ||
    Number(value.count) < 0 ||
    Number(value.count) > MAX_QUICK_ADD_OUTBOX_ITEMS ||
    Number(value.nextSequence) - Number(value.headSequence) !== Number(value.count)
  ) {
    throw new QuickAddOutboxCorruptError("The quick-add outbox manifest was invalid.");
  }
  return {
    version: 1,
    ownerUserId: value.ownerUserId,
    headSequence: Number(value.headSequence),
    nextSequence: Number(value.nextSequence),
    count: Number(value.count),
  };
}

function parseManifest(raw: string): QuickAddOutboxManifest {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new QuickAddOutboxCorruptError("The quick-add outbox manifest was invalid.");
  }
  if (!record(value)) {
    throw new QuickAddOutboxCorruptError("The quick-add outbox manifest was invalid.");
  }
  if (value.state === "clearing") {
    if (!exactKeys(value, ["version", "state"]) || value.version !== 1) {
      throw new QuickAddOutboxCorruptError("The quick-add outbox manifest was invalid.");
    }
    return { version: 1, state: "clearing" };
  }
  const baseKeys = ["version", "state", "ownerUserId", "headSequence", "nextSequence", "count"];
  if (value.state === "ready" && exactKeys(value, baseKeys)) {
    return { ...parseManifestBase(value), state: "ready" };
  }
  if (
    (value.state === "appending" || value.state === "removing") &&
    exactKeys(value, [...baseKeys, "sequence", "operationId"]) &&
    Number.isSafeInteger(value.sequence) &&
    typeof value.operationId === "string" &&
    UUID_V4.test(value.operationId)
  ) {
    const base = parseManifestBase(value);
    const sequence = Number(value.sequence);
    if (
      (value.state === "appending" &&
        base.count < MAX_QUICK_ADD_OUTBOX_ITEMS &&
        sequence === base.nextSequence) ||
      (value.state === "removing" && base.count > 0 && sequence === base.headSequence)
    ) {
      return { ...base, state: value.state, sequence, operationId: value.operationId };
    }
  }
  throw new QuickAddOutboxCorruptError("The quick-add outbox manifest was invalid.");
}

function assertOwner(ownerUserId: string): void {
  if (!UUID.test(ownerUserId)) throw new TypeError("The quick-add outbox owner was invalid.");
}

function assertGuard(guard: QuickAddEpochGuard | undefined): void {
  if (guard && !guard()) throw new QuickAddOutboxEpochError();
}

async function serialized<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const prior = locks.get(key) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = prior.then(() => current);
  locks.set(key, queued);
  await prior;
  try {
    return await operation();
  } finally {
    release();
    if (locks.get(key) === queued) locks.delete(key);
  }
}

async function writeVerified(
  storage: ProtectedQuickAddKeyValue,
  key: string,
  value: string,
): Promise<void> {
  await storage.set(key, value);
  if ((await storage.get(key)) !== value) {
    throw new Error("A protected quick-add outbox write failed read-back verification.");
  }
}

function readyManifest(manifest: QuickAddOutboxManifestBase): QuickAddOutboxReadyManifest {
  return {
    version: 1,
    state: "ready",
    ownerUserId: manifest.ownerUserId,
    headSequence: manifest.headSequence,
    nextSequence: manifest.nextSequence,
    count: manifest.count,
  };
}

async function sanitizeSlot(storage: ProtectedQuickAddKeyValue, key: string): Promise<void> {
  const raw = await storage.get(key);
  if (raw === null) {
    try {
      await storage.delete(key);
    } catch {
      // The read proved this fixed key contains no private value.
    }
    return;
  }
  if (raw !== SLOT_TOMBSTONE) await writeVerified(storage, key, SLOT_TOMBSTONE);
  try {
    await storage.delete(key);
  } catch {
    // A verified constant tombstone contains no private diary intent and is safe to retry later.
  }
}

async function sanitizeAllSlots(storage: ProtectedQuickAddKeyValue): Promise<void> {
  const errors: unknown[] = [];
  for (let index = 0; index < MAX_QUICK_ADD_OUTBOX_ITEMS; index += 1) {
    try {
      await sanitizeSlot(storage, quickAddOutboxSlotKey(index));
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      "The protected quick-add outbox slots could not be sanitized.",
    );
  }
}

async function loadItems(
  storage: ProtectedQuickAddKeyValue,
  manifest: QuickAddOutboxReadyManifest,
): Promise<readonly QuickAddOutboxItem[]> {
  const items: QuickAddOutboxItem[] = [];
  const operationIds = new Set<string>();
  for (let offset = 0; offset < manifest.count; offset += 1) {
    const sequence = manifest.headSequence + offset;
    const rawItem = await storage.get(quickAddOutboxSlotKey(sequence % MAX_QUICK_ADD_OUTBOX_ITEMS));
    if (rawItem === null) {
      throw new QuickAddOutboxCorruptError("A committed quick-add outbox slot was missing.");
    }
    let item: QuickAddOutboxItem;
    try {
      item = parseQuickAddOutboxItem(rawItem);
    } catch {
      throw new QuickAddOutboxCorruptError("A committed quick-add outbox slot was invalid.");
    }
    if (item.sequence !== sequence || item.ownerUserId !== manifest.ownerUserId) {
      throw new QuickAddOutboxCorruptError(
        "A committed quick-add outbox slot did not match its manifest.",
      );
    }
    if (operationIds.has(item.operationId)) {
      throw new QuickAddOutboxCorruptError(
        "The quick-add outbox contained a duplicate operation identifier.",
      );
    }
    operationIds.add(item.operationId);
    items.push(item);
  }
  return items;
}

async function recoverManifest(
  storage: ProtectedQuickAddKeyValue,
  manifest: QuickAddOutboxManifest,
): Promise<QuickAddOutboxReadyManifest | null> {
  if (manifest.state === "clearing") {
    await sanitizeAllSlots(storage);
    await storage.delete(QUICK_ADD_OUTBOX_MANIFEST_KEY);
    return null;
  }
  if (manifest.state === "ready") return manifest;
  const base = readyManifest(manifest);
  if (manifest.state === "removing") {
    const slotKey = quickAddOutboxSlotKey(manifest.sequence % MAX_QUICK_ADD_OUTBOX_ITEMS);
    const rawHead = await storage.get(slotKey);
    if (rawHead !== null && rawHead !== SLOT_TOMBSTONE) {
      let head: QuickAddOutboxItem;
      try {
        head = parseQuickAddOutboxItem(rawHead);
      } catch {
        throw new QuickAddOutboxCorruptError("The removing quick-add outbox head was invalid.");
      }
      if (
        head.sequence !== manifest.sequence ||
        head.ownerUserId !== manifest.ownerUserId ||
        head.operationId !== manifest.operationId
      ) {
        throw new QuickAddOutboxHeadConflictError();
      }
    }
    await sanitizeSlot(storage, slotKey);
    const removed: QuickAddOutboxReadyManifest = {
      ...base,
      headSequence: base.headSequence + 1,
      count: base.count - 1,
    };
    await writeVerified(storage, QUICK_ADD_OUTBOX_MANIFEST_KEY, JSON.stringify(removed));
    return removed;
  }

  const activeItems = await loadItems(storage, base);
  const slotKey = quickAddOutboxSlotKey(manifest.sequence % MAX_QUICK_ADD_OUTBOX_ITEMS);
  const rawItem = await storage.get(slotKey);
  let appended: QuickAddOutboxItem | null = null;
  if (rawItem !== null && rawItem !== SLOT_TOMBSTONE) {
    try {
      const candidate = parseQuickAddOutboxItem(rawItem);
      if (
        candidate.sequence === manifest.sequence &&
        candidate.ownerUserId === manifest.ownerUserId &&
        candidate.operationId === manifest.operationId &&
        !activeItems.some((item) => item.operationId === candidate.operationId)
      ) {
        appended = candidate;
      }
    } catch {
      // A malformed staged slot is rolled back and sanitized below.
    }
  }
  if (!appended) {
    await sanitizeSlot(storage, slotKey);
    await writeVerified(storage, QUICK_ADD_OUTBOX_MANIFEST_KEY, JSON.stringify(base));
    return base;
  }
  const committed: QuickAddOutboxReadyManifest = {
    ...base,
    nextSequence: base.nextSequence + 1,
    count: base.count + 1,
  };
  await writeVerified(storage, QUICK_ADD_OUTBOX_MANIFEST_KEY, JSON.stringify(committed));
  return committed;
}

async function loadOutbox(
  storage: ProtectedQuickAddKeyValue,
  ownerUserId: string,
): Promise<LoadedOutbox> {
  assertOwner(ownerUserId);
  const rawManifest = await storage.get(QUICK_ADD_OUTBOX_MANIFEST_KEY);
  if (rawManifest === null) {
    await sanitizeAllSlots(storage);
    return { manifest: null, snapshot: { ownerUserId, items: [] } };
  }
  const manifest = await recoverManifest(storage, parseManifest(rawManifest));
  if (manifest === null) return { manifest: null, snapshot: { ownerUserId, items: [] } };
  if (manifest.ownerUserId !== ownerUserId) throw new QuickAddOutboxOwnerMismatchError();
  const items = await loadItems(storage, manifest);
  return { manifest, snapshot: { ownerUserId, items } };
}

async function secureStoreAdapter(): Promise<ProtectedQuickAddKeyValue> {
  const SecureStore = await import("expo-secure-store");
  const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
  return {
    get: (key) => SecureStore.getItemAsync(key, options),
    set: (key, value) => SecureStore.setItemAsync(key, value, options),
    delete: (key) => SecureStore.deleteItemAsync(key, options),
  };
}

export function createQuickAddOutboxStore(overrides?: {
  readonly storage?: ProtectedQuickAddKeyValue;
  readonly lockKey?: string;
}): QuickAddOutboxStore {
  const lockKey = overrides?.lockKey ?? QUICK_ADD_OUTBOX_MANIFEST_KEY;
  let nativeStorage: Promise<ProtectedQuickAddKeyValue> | null = null;

  function storage(): Promise<ProtectedQuickAddKeyValue> {
    if (overrides?.storage) return Promise.resolve(overrides.storage);
    nativeStorage ??= secureStoreAdapter();
    return nativeStorage;
  }

  async function removeHead(
    protectedStorage: ProtectedQuickAddKeyValue,
    ownerUserId: string,
    expectedOperationId: string,
    requireBlocked: boolean,
    guard: QuickAddEpochGuard | undefined,
  ): Promise<void> {
    const current = await loadOutbox(protectedStorage, ownerUserId);
    const head = current.snapshot.items[0];
    if (!current.manifest || !head || head.operationId !== expectedOperationId) {
      throw new QuickAddOutboxHeadConflictError();
    }
    if (requireBlocked && head.blocked === null) throw new QuickAddOutboxHeadConflictError();
    assertGuard(guard);
    const removing: QuickAddOutboxRemoveManifest = {
      ...current.manifest,
      state: "removing",
      sequence: head.sequence,
      operationId: head.operationId,
    };
    await writeVerified(protectedStorage, QUICK_ADD_OUTBOX_MANIFEST_KEY, JSON.stringify(removing));
    await sanitizeSlot(
      protectedStorage,
      quickAddOutboxSlotKey(head.sequence % MAX_QUICK_ADD_OUTBOX_ITEMS),
    );
    const removed: QuickAddOutboxReadyManifest = {
      ...current.manifest,
      headSequence: current.manifest.headSequence + 1,
      count: current.manifest.count - 1,
    };
    await writeVerified(protectedStorage, QUICK_ADD_OUTBOX_MANIFEST_KEY, JSON.stringify(removed));
  }

  return {
    snapshot: (ownerUserId) =>
      serialized(lockKey, async () => (await loadOutbox(await storage(), ownerUserId)).snapshot),

    append: (ownerUserId, draft, guard) =>
      serialized(lockKey, async () => {
        const protectedStorage = await storage();
        const current = await loadOutbox(protectedStorage, ownerUserId);
        if (draft.ownerUserId !== ownerUserId) throw new QuickAddOutboxOwnerMismatchError();
        if (current.snapshot.items.length >= MAX_QUICK_ADD_OUTBOX_ITEMS) {
          throw new QuickAddOutboxFullError();
        }
        const manifest: QuickAddOutboxReadyManifest = current.manifest ?? {
          version: 1,
          state: "ready",
          ownerUserId,
          headSequence: 0,
          nextSequence: 0,
          count: 0,
        };
        if (manifest.nextSequence >= Number.MAX_SAFE_INTEGER) {
          throw new RangeError("The quick-add outbox sequence space was exhausted.");
        }
        if (current.snapshot.items.some((item) => item.operationId === draft.operationId)) {
          throw new Error("The quick-add outbox operation identifier was already queued.");
        }
        const item = parseQuickAddOutboxItem({
          ...draft,
          sequence: manifest.nextSequence,
          blocked: null,
        });
        const slotKey = quickAddOutboxSlotKey(manifest.nextSequence % MAX_QUICK_ADD_OUTBOX_ITEMS);
        assertGuard(guard);
        const appending: QuickAddOutboxAppendManifest = {
          ...manifest,
          state: "appending",
          sequence: item.sequence,
          operationId: item.operationId,
        };
        await writeVerified(
          protectedStorage,
          QUICK_ADD_OUTBOX_MANIFEST_KEY,
          JSON.stringify(appending),
        );
        assertGuard(guard);
        await writeVerified(protectedStorage, slotKey, JSON.stringify(item));
        assertGuard(guard);
        const committed: QuickAddOutboxReadyManifest = {
          ...manifest,
          nextSequence: manifest.nextSequence + 1,
          count: manifest.count + 1,
        };
        await writeVerified(
          protectedStorage,
          QUICK_ADD_OUTBOX_MANIFEST_KEY,
          JSON.stringify(committed),
        );
        return item;
      }),

    acknowledgeHead: (ownerUserId, expectedOperationId, guard) =>
      serialized(lockKey, async () =>
        removeHead(await storage(), ownerUserId, expectedOperationId, false, guard),
      ),

    blockHead: (ownerUserId, expectedOperationId, status, reason, guard) =>
      serialized(lockKey, async () => {
        const protectedStorage = await storage();
        const current = await loadOutbox(protectedStorage, ownerUserId);
        const head = current.snapshot.items[0];
        if (!head || head.operationId !== expectedOperationId || head.blocked !== null) {
          throw new QuickAddOutboxHeadConflictError();
        }
        const blocked = parseQuickAddOutboxItem({
          ...head,
          blocked: { kind: "terminal_http", status, reason },
        });
        assertGuard(guard);
        await writeVerified(
          protectedStorage,
          quickAddOutboxSlotKey(head.sequence % MAX_QUICK_ADD_OUTBOX_ITEMS),
          JSON.stringify(blocked),
        );
      }),

    retryHead: (ownerUserId, expectedOperationId, guard) =>
      serialized(lockKey, async () => {
        const protectedStorage = await storage();
        const current = await loadOutbox(protectedStorage, ownerUserId);
        const head = current.snapshot.items[0];
        if (!head || head.operationId !== expectedOperationId || head.blocked === null) {
          throw new QuickAddOutboxHeadConflictError();
        }
        const retried = parseQuickAddOutboxItem({ ...head, blocked: null });
        assertGuard(guard);
        await writeVerified(
          protectedStorage,
          quickAddOutboxSlotKey(head.sequence % MAX_QUICK_ADD_OUTBOX_ITEMS),
          JSON.stringify(retried),
        );
      }),

    discardBlockedHead: (ownerUserId, expectedOperationId, guard) =>
      serialized(lockKey, async () =>
        removeHead(await storage(), ownerUserId, expectedOperationId, true, guard),
      ),

    clear: () =>
      serialized(lockKey, async () => {
        const protectedStorage = await storage();
        let markerError: unknown = null;
        try {
          const clearing: QuickAddOutboxClearingManifest = { version: 1, state: "clearing" };
          await writeVerified(
            protectedStorage,
            QUICK_ADD_OUTBOX_MANIFEST_KEY,
            JSON.stringify(clearing),
          );
        } catch (error) {
          markerError = error;
        }
        try {
          await sanitizeAllSlots(protectedStorage);
        } catch (error) {
          throw new AggregateError(
            markerError === null ? [error] : [markerError, error],
            "The protected quick-add outbox could not be sanitized.",
          );
        }
        try {
          await protectedStorage.delete(QUICK_ADD_OUTBOX_MANIFEST_KEY);
        } catch (error) {
          throw new AggregateError(
            markerError === null ? [error] : [markerError, error],
            "The protected quick-add outbox clear marker could not be removed.",
          );
        }
      }),
  };
}

export const createSecureQuickAddOutboxStore = createQuickAddOutboxStore;

/** Wipe every fixed key without trusting or parsing the manifest. */
export async function clearQuickAddOutbox(): Promise<void> {
  await createSecureQuickAddOutboxStore().clear();
}
