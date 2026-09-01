import { describe, expect, it } from "vitest";

import { parseDiaryMutation } from "./diary";
import {
  createQuickAddOutboxController,
  createQuickAddOutboxDraft,
  type FatalQuickAddOutboxStoreReason,
  matchesQuickAddReceipt,
  parseQuickAddOutboxItem,
  type QuickAddEnqueueInput,
  type QuickAddOutboxItem,
  type QuickAddReceipt,
} from "./quick-add-outbox";
import {
  createQuickAddOutboxStore,
  type ProtectedQuickAddKeyValue,
  QUICK_ADD_OUTBOX_MANIFEST_KEY,
  QuickAddOutboxCorruptError,
  QuickAddOutboxFullError,
  QuickAddOutboxOwnerMismatchError,
  quickAddOutboxSlotKey,
} from "./quick-add-outbox-store";

const owner = "018f6f58-4e2c-7b62-8f0b-3d75491713b5";
const otherOwner = "118f6f58-4e2c-7b62-8f0b-3d75491713b5";
const timeZone = "America/Chicago";
const occurredAt = "2026-08-15T13:30:00.000Z";

function operationId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function input(index = 1): QuickAddEnqueueInput {
  return {
    foodKind: index % 2 === 0 ? "branded" : "generic",
    foodName: `Apple ${index}`,
    foodVersionId: String(200 + index),
    servingId: String(300 + index),
    servingLabel: "1 medium",
    localDate: "2026-08-15",
    mealSlot: "breakfast",
    occurredAt,
  };
}

class MemoryProtectedStore implements ProtectedQuickAddKeyValue {
  readonly values = new Map<string, string>();
  readonly deleted: string[] = [];
  failGet: ((key: string) => boolean) | null = null;
  failSet: ((key: string, value: string) => boolean) | null = null;
  failAfterSet: ((key: string, value: string) => boolean) | null = null;
  failDelete: ((key: string) => boolean) | null = null;
  corruptSet: ((key: string, value: string) => string | null) | null = null;
  beforeSet: ((key: string, value: string) => Promise<void>) | null = null;

  async get(key: string): Promise<string | null> {
    if (this.failGet?.(key)) throw new Error("injected-get-failure");
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    await this.beforeSet?.(key, value);
    if (this.failSet?.(key, value)) throw new Error("injected-set-failure");
    this.values.set(key, this.corruptSet?.(key, value) ?? value);
    if (this.failAfterSet?.(key, value)) throw new Error("injected-after-set-crash");
  }

  async delete(key: string): Promise<void> {
    this.deleted.push(key);
    if (this.failDelete?.(key)) throw new Error("injected-delete-failure");
    this.values.delete(key);
  }
}

function isTombstone(value: string | undefined): boolean {
  return value === '{"version":1,"tombstone":true}';
}

function source() {
  return {
    code: "USDA_FDC",
    releaseId: "218f6f58-4e2c-7b62-8f0b-3d75491713b5",
    displayName: "USDA FoodData Central",
    licenseExpression: "CC0-1.0",
    attributionRequired: true,
    attributionText: "USDA FoodData Central",
  };
}

function receiptBody(item: QuickAddOutboxItem, replayed: boolean): unknown {
  const provenanceSource = source();
  return {
    data: {
      replayed,
      entry: {
        id: "entry-1",
        revision: "1",
        entryKind: "food",
        foodVersionId: item.body.foodVersionId,
        recipeVersionId: null,
        portion: {
          kind: "serving",
          servingId: item.body.portion.servingId,
          amount: "1",
          servingLabel: item.display.servingLabel,
        },
        food: { name: item.display.foodName, brandName: null },
        recipe: null,
        source: provenanceSource,
        foodProvenance: { kind: "public", source: provenanceSource },
        mealSlot: item.body.mealSlot,
        resolvedGrams: "182",
        occurredAt: item.body.occurredAt,
        localDate: item.localDate,
        timeZone: item.expectedTimeZone,
        localTime: "08:30:00",
        position: 0,
        nutrients: [],
      },
      affectedDays: [{ localDate: item.localDate, revision: "1" }],
    },
  };
}

function receiptResponse(item: QuickAddOutboxItem, status = 201): Response {
  return new Response(JSON.stringify(receiptBody(item, status === 200)), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function draft(index = 1, draftOwner = owner) {
  return createQuickAddOutboxDraft(
    draftOwner,
    timeZone,
    input(index),
    operationId(index),
    new Date("2001-01-01T00:00:00.000Z"),
  );
}

describe("protected public-food quick-add outbox journal", () => {
  it("accepts only the closed bounded envelope and persists no credentials, cursors, or query", async () => {
    const storage = new MemoryProtectedStore();
    const store = createQuickAddOutboxStore({ storage, lockKey: "strict-envelope" });
    const item = await store.append(owner, await draft());

    expect(() => parseQuickAddOutboxItem({ ...item, accessToken: "secret-bearer-value" })).toThrow(
      /envelope/u,
    );
    expect(() =>
      parseQuickAddOutboxItem({
        ...item,
        body: { ...item.body, searchQuery: "private search" },
      }),
    ).toThrow(/request body/u);
    expect(() => parseQuickAddOutboxItem({ ...item, cursor: "private-cursor" })).toThrow(
      /envelope/u,
    );

    const persisted = [...storage.values.values()].join("\n");
    expect(persisted).not.toContain("secret-bearer-value");
    expect(persisted).not.toContain("private-cursor");
    expect(persisted).not.toContain("profileTimeZonePrecondition");
    expect((await store.snapshot(owner)).items).toEqual([item]);
  });

  it("retains old entries without TTL, preserves FIFO, caps at 50, and never evicts", async () => {
    const storage = new MemoryProtectedStore();
    const store = createQuickAddOutboxStore({ storage, lockKey: "capacity" });
    for (let index = 1; index <= 50; index += 1) {
      await store.append(owner, await draft(index));
    }
    const full = await store.snapshot(owner);
    expect(full.items).toHaveLength(50);
    expect(full.items[0]?.enqueuedAt).toBe("2001-01-01T00:00:00.000Z");
    expect(full.items.map((item) => item.sequence)).toEqual(
      Array.from({ length: 50 }, (_, index) => index),
    );
    await expect(store.append(owner, await draft(51))).rejects.toBeInstanceOf(
      QuickAddOutboxFullError,
    );
    expect((await store.snapshot(owner)).items[0]?.operationId).toBe(operationId(1));

    await store.acknowledgeHead(owner, operationId(1));
    await store.append(owner, await draft(51));
    const wrapped = await store.snapshot(owner);
    expect(wrapped.items[0]?.operationId).toBe(operationId(2));
    expect(wrapped.items.at(-1)?.sequence).toBe(50);
  });

  it("binds a nonempty or empty committed journal to one account until explicit clear", async () => {
    const storage = new MemoryProtectedStore();
    const store = createQuickAddOutboxStore({ storage, lockKey: "owner-binding" });
    await store.append(owner, await draft());
    await expect(store.snapshot(otherOwner)).rejects.toBeInstanceOf(
      QuickAddOutboxOwnerMismatchError,
    );
    await store.acknowledgeHead(owner, operationId(1));
    await expect(store.snapshot(otherOwner)).rejects.toBeInstanceOf(
      QuickAddOutboxOwnerMismatchError,
    );
    await store.clear();
    expect((await store.snapshot(otherOwner)).items).toEqual([]);
  });

  it("classifies malformed manifests and committed slots as structural corruption", async () => {
    const malformedStorage = new MemoryProtectedStore();
    malformedStorage.values.set(QUICK_ADD_OUTBOX_MANIFEST_KEY, "{");
    const malformedStore = createQuickAddOutboxStore({
      storage: malformedStorage,
      lockKey: "corrupt-manifest",
    });
    await expect(malformedStore.snapshot(owner)).rejects.toBeInstanceOf(QuickAddOutboxCorruptError);

    const missingStorage = new MemoryProtectedStore();
    const missingStore = createQuickAddOutboxStore({
      storage: missingStorage,
      lockKey: "corrupt-slot",
    });
    await missingStore.append(owner, await draft());
    missingStorage.values.delete(quickAddOutboxSlotKey(0));
    await expect(missingStore.snapshot(owner)).rejects.toBeInstanceOf(QuickAddOutboxCorruptError);
  });

  it("does not expose a slot whose manifest commit failed", async () => {
    const storage = new MemoryProtectedStore();
    const store = createQuickAddOutboxStore({ storage, lockKey: "manifest-failure" });
    storage.failSet = (key) => key === QUICK_ADD_OUTBOX_MANIFEST_KEY;
    await expect(store.append(owner, await draft())).rejects.toThrow(/injected-set-failure/u);
    storage.failSet = null;
    expect((await store.snapshot(owner)).items).toEqual([]);
  });

  it("clears every fixed key even when the manifest is corrupt", async () => {
    const storage = new MemoryProtectedStore();
    const store = createQuickAddOutboxStore({ storage, lockKey: "corrupt-clear" });
    storage.values.set(QUICK_ADD_OUTBOX_MANIFEST_KEY, "{corrupt");
    storage.values.set(quickAddOutboxSlotKey(0), "private-item");
    storage.values.set(quickAddOutboxSlotKey(49), "private-item");

    await store.clear();
    expect(storage.values.size).toBe(0);
    expect(new Set(storage.deleted).size).toBe(51);
    expect(storage.deleted).toContain(QUICK_ADD_OUTBOX_MANIFEST_KEY);
    expect(storage.deleted).toContain(quickAddOutboxSlotKey(49));
  });

  it("recovers every append boundary without leaving an unreachable private slot", async () => {
    const scenarios = [
      {
        name: "pending manifest",
        matches: (key: string, value: string) =>
          key === QUICK_ADD_OUTBOX_MANIFEST_KEY && value.includes('"state":"appending"'),
        expectedCount: 0,
      },
      {
        name: "private slot",
        matches: (key: string) => key === quickAddOutboxSlotKey(0),
        expectedCount: 1,
      },
      {
        name: "committed manifest",
        matches: (key: string, value: string) =>
          key === QUICK_ADD_OUTBOX_MANIFEST_KEY &&
          value.includes('"state":"ready"') &&
          value.includes('"count":1'),
        expectedCount: 1,
      },
    ] as const;

    for (const scenario of scenarios) {
      const storage = new MemoryProtectedStore();
      const lockKey = `append-boundary-${scenario.name}`;
      const store = createQuickAddOutboxStore({ storage, lockKey });
      let failed = false;
      storage.failAfterSet = (key, value) => {
        if (!failed && scenario.matches(key, value)) {
          failed = true;
          return true;
        }
        return false;
      };
      await expect(store.append(owner, await draft())).rejects.toThrow(/after-set-crash/u);
      storage.failAfterSet = null;

      const restored = await createQuickAddOutboxStore({ storage, lockKey }).snapshot(owner);
      expect(restored.items, scenario.name).toHaveLength(scenario.expectedCount);
      const slot = storage.values.get(quickAddOutboxSlotKey(0));
      if (scenario.expectedCount === 0) {
        expect(slot === undefined || isTombstone(slot), scenario.name).toBe(true);
      } else {
        expect(slot, scenario.name).toContain('"operationId"');
      }
    }
  });

  it("recovers marker, tombstone, and final-manifest acknowledgement boundaries", async () => {
    const scenarios = ["removing", "tombstone", "ready"] as const;
    for (const scenario of scenarios) {
      const storage = new MemoryProtectedStore();
      const lockKey = `remove-boundary-${scenario}`;
      const store = createQuickAddOutboxStore({ storage, lockKey });
      await store.append(owner, await draft());
      let failed = false;
      storage.failAfterSet = (key, value) => {
        const matches =
          (scenario === "removing" &&
            key === QUICK_ADD_OUTBOX_MANIFEST_KEY &&
            value.includes('"state":"removing"')) ||
          (scenario === "tombstone" && key === quickAddOutboxSlotKey(0) && isTombstone(value)) ||
          (scenario === "ready" &&
            key === QUICK_ADD_OUTBOX_MANIFEST_KEY &&
            value.includes('"state":"ready"') &&
            value.includes('"count":0'));
        if (!failed && matches) {
          failed = true;
          return true;
        }
        return false;
      };
      await expect(store.acknowledgeHead(owner, operationId(1))).rejects.toThrow(
        /after-set-crash/u,
      );
      storage.failAfterSet = null;

      expect((await createQuickAddOutboxStore({ storage, lockKey }).snapshot(owner)).items).toEqual(
        [],
      );
      const slot = storage.values.get(quickAddOutboxSlotKey(0));
      expect(slot === undefined || isTombstone(slot), scenario).toBe(true);
      expect(slot ?? "").not.toContain("Apple 1");
    }
  });

  it("keeps a retry marker when tombstoning fails and permits only a nonprivate tombstone on delete failure", async () => {
    const storage = new MemoryProtectedStore();
    const store = createQuickAddOutboxStore({ storage, lockKey: "remove-sanitize-failures" });
    await store.append(owner, await draft());
    storage.failSet = (key, value) => key === quickAddOutboxSlotKey(0) && isTombstone(value);
    await expect(store.acknowledgeHead(owner, operationId(1))).rejects.toThrow(
      /injected-set-failure/u,
    );
    expect(storage.values.get(QUICK_ADD_OUTBOX_MANIFEST_KEY)).toContain('"state":"removing"');
    expect(storage.values.get(quickAddOutboxSlotKey(0))).toContain("Apple 1");
    storage.failSet = null;
    expect((await store.snapshot(owner)).items).toEqual([]);
    expect(storage.values.get(quickAddOutboxSlotKey(0)) ?? "").not.toContain("Apple 1");

    await store.append(owner, await draft(2));
    const activeSlot = quickAddOutboxSlotKey(1);
    storage.failDelete = (key) => key === activeSlot;
    await store.acknowledgeHead(owner, operationId(2));
    expect(isTombstone(storage.values.get(activeSlot))).toBe(true);
    expect((await store.snapshot(owner)).items).toEqual([]);
  });

  it("recovers clear-marker, slot-sanitization, and final-marker-delete failures", async () => {
    const storage = new MemoryProtectedStore();
    const lockKey = "clear-boundaries";
    const store = createQuickAddOutboxStore({ storage, lockKey });
    await store.append(owner, await draft());
    storage.failSet = (key, value) => key === quickAddOutboxSlotKey(0) && isTombstone(value);
    await expect(store.clear()).rejects.toThrow(/sanitized/u);
    expect(storage.values.get(QUICK_ADD_OUTBOX_MANIFEST_KEY)).toContain('"state":"clearing"');
    storage.failSet = null;
    expect((await store.snapshot(owner)).items).toEqual([]);
    expect(storage.values.get(quickAddOutboxSlotKey(0)) ?? "").not.toContain("Apple 1");

    await store.append(owner, await draft(2));
    storage.failDelete = (key) => key === QUICK_ADD_OUTBOX_MANIFEST_KEY;
    await expect(store.clear()).rejects.toThrow(/clear marker/u);
    expect(storage.values.get(QUICK_ADD_OUTBOX_MANIFEST_KEY)).toContain('"state":"clearing"');
    expect(storage.values.get(quickAddOutboxSlotKey(0)) ?? "").not.toContain("Apple 2");
    storage.failDelete = null;
    expect((await store.snapshot(owner)).items).toEqual([]);
    expect(storage.values.size).toBe(0);
  });
});

function controllerFor(
  store: ReturnType<typeof createQuickAddOutboxStore>,
  fetcher: (input: URL, init: RequestInit) => Promise<Response>,
  overrides?: {
    readonly foreground?: () => boolean;
    readonly onFatalStoreError?: (reason: FatalQuickAddOutboxStoreReason) => Promise<void>;
    readonly onReceipt?: (receipt: QuickAddReceipt) => void | Promise<void>;
    readonly onUnauthorized?: () => Promise<void>;
    readonly firstOperationId?: number;
  },
) {
  let nextOperationId = overrides?.firstOperationId ?? 1;
  return createQuickAddOutboxController({
    apiBase: new URL("https://api.example.test/base/ignored"),
    ownerUserId: owner,
    expectedTimeZone: timeZone,
    store,
    fetcher,
    accessToken: () => "in-memory-bearer-sentinel",
    isForeground: overrides?.foreground ?? (() => true),
    operationId: () => operationId(nextOperationId++),
    now: () => new Date("2026-08-15T13:31:00.000Z"),
    onFatalStoreError: overrides?.onFatalStoreError ?? (async () => undefined),
    onUnauthorized: overrides?.onUnauthorized ?? (async () => undefined),
    ...(overrides?.onReceipt ? { onReceipt: overrides.onReceipt } : {}),
  });
}

describe("foreground public-food quick-add outbox controller", () => {
  it("requires status/replay and every immutable request field to match before acknowledgement", async () => {
    const storage = new MemoryProtectedStore();
    const store = createQuickAddOutboxStore({ storage, lockKey: "receipt-match" });
    const item = await store.append(owner, await draft());
    const created = parseDiaryMutation(receiptBody(item, false));
    const replayed = parseDiaryMutation(receiptBody(item, true));
    expect(matchesQuickAddReceipt(item, 201, created)).toBe(true);
    expect(matchesQuickAddReceipt(item, 200, replayed)).toBe(true);
    expect(matchesQuickAddReceipt(item, 200, created)).toBe(false);
    expect(
      matchesQuickAddReceipt(item, 201, {
        ...created,
        entry: created.entry ? { ...created.entry, occurredAt: "2026-08-15T13:31:00.000Z" } : null,
      }),
    ).toBe(false);
  });

  it("never sends when the protected slot fails read-back verification", async () => {
    const storage = new MemoryProtectedStore();
    let corrupted = false;
    storage.corruptSet = (key, value) => {
      if (!corrupted && key.startsWith("nutrition-tracker.quick-add-outbox.v1.slot")) {
        corrupted = true;
        return value.slice(0, -1);
      }
      return null;
    };
    const store = createQuickAddOutboxStore({ storage, lockKey: "readback-before-send" });
    let requests = 0;
    const controller = controllerFor(store, async () => {
      requests += 1;
      throw new Error("must-not-send");
    });

    await expect(controller.enqueue(input())).rejects.toThrow(/read-back/u);
    expect(requests).toBe(0);
    expect((await store.snapshot(owner)).items).toEqual([]);
  });

  it("replays the exact durable operation after an ambiguous failure and accepts only its receipt", async () => {
    const storage = new MemoryProtectedStore();
    const store = createQuickAddOutboxStore({ storage, lockKey: "ambiguous-replay" });
    const firstRequests: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const first = controllerFor(store, async (url, init) => {
      firstRequests.push({ url: url.toString(), init });
      throw new Error("connection-lost-after-commit");
    });
    const queued = await first.enqueue(input());
    expect(firstRequests).toHaveLength(0);
    await first.requestDrain(queued.operationId);
    expect(first.getState()).toMatchObject({ status: "unavailable", reason: "network" });
    expect((await store.snapshot(owner)).items).toEqual([queued]);
    expect(firstRequests).toHaveLength(1);
    first.close();

    const secondRequests: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const restarted = controllerFor(store, async (url, init) => {
      secondRequests.push({ url: url.toString(), init });
      const head = (await store.snapshot(owner)).items[0];
      if (!head) throw new Error("missing replay head");
      return receiptResponse(head, 200);
    });
    await restarted.requestDrain();

    expect(secondRequests).toHaveLength(1);
    const replay = secondRequests[0];
    if (!replay) throw new Error("missing replay request");
    expect(replay.url).toBe(
      "https://api.example.test/v1/diary/entries?profileTimeZonePrecondition=v1",
    );
    const headers = new Headers(replay.init.headers);
    expect(headers.get("idempotency-key")).toBe(queued.operationId);
    expect(headers.get("x-expected-profile-time-zone")).toBe(timeZone);
    expect(replay.init.body).toBe(JSON.stringify(queued.body));
    expect((await store.snapshot(owner)).items).toEqual([]);
    expect([...storage.values.values()].join("\n")).not.toContain("in-memory-bearer-sentinel");
  });

  it("shares one drain promise, permits one request at a time, and drains a concurrent tail FIFO", async () => {
    const storage = new MemoryProtectedStore();
    const store = createQuickAddOutboxStore({ storage, lockKey: "single-flight" });
    let foreground = false;
    let releaseFirst: () => void = () => undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let requestCount = 0;
    let active = 0;
    let maximumActive = 0;
    const bodies: string[] = [];
    const controller = controllerFor(
      store,
      async (_url, init) => {
        requestCount += 1;
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        if (typeof init.body !== "string") throw new Error("missing request body");
        bodies.push(init.body);
        const head = (await store.snapshot(owner)).items[0];
        if (!head) throw new Error("missing request head");
        if (requestCount === 1) await firstGate;
        active -= 1;
        return receiptResponse(head, 201);
      },
      { foreground: () => foreground },
    );
    const first = await controller.enqueue(input(1));
    const second = await controller.enqueue(input(2));
    foreground = true;
    const firstDrain = controller.requestDrain(first.operationId);
    const duplicateDrain = controller.requestDrain(second.operationId);
    expect(duplicateDrain).toBe(firstDrain);
    releaseFirst();
    await firstDrain;

    expect(requestCount).toBe(2);
    expect(maximumActive).toBe(1);
    expect(bodies).toEqual([JSON.stringify(first.body), JSON.stringify(second.body)]);
    expect((await store.snapshot(owner)).items).toEqual([]);
  });

  it("does not deliver an item appended during a drain until its post-registration drain request", async () => {
    const storage = new MemoryProtectedStore();
    const store = createQuickAddOutboxStore({ storage, lockKey: "receipt-registration" });
    let releaseFirst: () => void = () => undefined;
    let startFirst: () => void = () => undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      startFirst = resolve;
    });
    const sent: string[] = [];
    const controller = controllerFor(store, async (_url, init) => {
      const head = (await store.snapshot(owner)).items[0];
      if (!head) throw new Error("missing registration-race head");
      sent.push(new Headers(init.headers).get("idempotency-key") ?? "missing");
      if (sent.length === 1) {
        startFirst();
        await firstGate;
      }
      return receiptResponse(head, 201);
    });
    const first = await controller.enqueue(input(1));
    const firstDrain = controller.requestDrain(first.operationId);
    await firstStarted;
    const second = await controller.enqueue(input(2));
    releaseFirst();
    await firstDrain;

    expect(sent).toEqual([first.operationId]);
    expect((await store.snapshot(owner)).items.map((item) => item.operationId)).toEqual([
      second.operationId,
    ]);

    await controller.requestDrain(second.operationId);
    expect(sent).toEqual([first.operationId, second.operationId]);
    expect((await store.snapshot(owner)).items).toEqual([]);
  });

  it("holds a new enqueue until registration even when a startup drain observes it", async () => {
    const storage = new MemoryProtectedStore();
    const store = createQuickAddOutboxStore({ storage, lockKey: "startup-registration" });
    let releaseSnapshot: () => void = () => undefined;
    let startSnapshot: () => void = () => undefined;
    const snapshotGate = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    const snapshotStarted = new Promise<void>((resolve) => {
      startSnapshot = resolve;
    });
    let gateFirstSnapshot = true;
    const gatedStore = {
      ...store,
      snapshot: async (ownerUserId: string) => {
        if (gateFirstSnapshot) {
          gateFirstSnapshot = false;
          startSnapshot();
          await snapshotGate;
        }
        return store.snapshot(ownerUserId);
      },
    };
    const sent: string[] = [];
    const controller = controllerFor(gatedStore, async (_url, init) => {
      const head = (await store.snapshot(owner)).items[0];
      if (!head) throw new Error("missing startup-race head");
      sent.push(new Headers(init.headers).get("idempotency-key") ?? "missing");
      return receiptResponse(head, 201);
    });

    const startupDrain = controller.requestDrain();
    await snapshotStarted;
    const queued = await controller.enqueue(input());
    releaseSnapshot();
    await startupDrain;

    expect(sent).toEqual([]);
    expect((await store.snapshot(owner)).items[0]?.operationId).toBe(queued.operationId);

    await controller.requestDrain(queued.operationId);
    expect(sent).toEqual([queued.operationId]);
    expect((await store.snapshot(owner)).items).toEqual([]);
  });

  it("blocks a terminal head without sending its tail, then retries the same operation FIFO", async () => {
    const storage = new MemoryProtectedStore();
    const store = createQuickAddOutboxStore({ storage, lockKey: "terminal-retry" });
    let foreground = false;
    const statuses = [422, 201, 201];
    const sentOperations: string[] = [];
    const controller = controllerFor(
      store,
      async (_url, init) => {
        const headers = new Headers(init.headers);
        sentOperations.push(headers.get("idempotency-key") ?? "missing");
        const head = (await store.snapshot(owner)).items[0];
        if (!head) throw new Error("missing terminal head");
        const status = statuses.shift();
        if (!status) throw new Error("unexpected request");
        return status === 422 ? new Response("{}", { status }) : receiptResponse(head, status);
      },
      { foreground: () => foreground },
    );
    const first = await controller.enqueue(input(1));
    const second = await controller.enqueue(input(2));
    foreground = true;
    const firstDrain = controller.requestDrain(first.operationId);
    await controller.requestDrain(second.operationId);
    await firstDrain;

    expect(sentOperations).toEqual([first.operationId]);
    expect(controller.getState()).toEqual({
      status: "blocked",
      pendingCount: 2,
      operationId: first.operationId,
      httpStatus: 422,
      blockedReason: "terminal_http",
      foodName: first.display.foodName,
      servingLabel: first.display.servingLabel,
      localDate: first.localDate,
      mealSlot: first.body.mealSlot,
    });
    expect((await store.snapshot(owner)).items[0]?.blocked).toEqual({
      kind: "terminal_http",
      status: 422,
      reason: "terminal_http",
    });

    await controller.retryBlockedHead(first.operationId);
    expect(sentOperations).toEqual([first.operationId, first.operationId, second.operationId]);
    expect((await store.snapshot(owner)).items).toEqual([]);
  });

  it("persists only a closed safe reason for the typed time-zone conflict", async () => {
    const storage = new MemoryProtectedStore();
    const store = createQuickAddOutboxStore({ storage, lockKey: "time-zone-conflict" });
    let foreground = false;
    const controller = controllerFor(
      store,
      async () =>
        new Response(
          JSON.stringify({
            type: "https://api.example.test/problems/diary-time-zone-changed",
            title: "Diary time zone changed",
            status: 409,
            code: "DIARY_TIME_ZONE_CHANGED",
            detail: "private-response-detail-sentinel",
            requestId: "request-1",
          }),
          { status: 409, headers: { "content-type": "application/problem+json" } },
        ),
      { foreground: () => foreground },
    );
    const queued = await controller.enqueue(input());
    foreground = true;
    await controller.requestDrain(queued.operationId);

    expect(controller.getState()).toMatchObject({
      status: "blocked",
      operationId: queued.operationId,
      httpStatus: 409,
      blockedReason: "time_zone_changed",
    });
    expect((await store.snapshot(owner)).items[0]?.blocked).toEqual({
      kind: "terminal_http",
      status: 409,
      reason: "time_zone_changed",
    });
    expect([...storage.values.values()].join("\n")).not.toContain(
      "private-response-detail-sentinel",
    );
  });

  it("treats a malformed 409 body as a generic terminal response", async () => {
    const storage = new MemoryProtectedStore();
    const store = createQuickAddOutboxStore({ storage, lockKey: "malformed-conflict" });
    let foreground = false;
    const controller = controllerFor(
      store,
      async () =>
        new Response("{", {
          status: 409,
          headers: { "content-type": "application/problem+json" },
        }),
      { foreground: () => foreground },
    );
    const queued = await controller.enqueue(input());
    foreground = true;
    await controller.requestDrain(queued.operationId);

    expect(controller.getState()).toMatchObject({
      status: "blocked",
      operationId: queued.operationId,
      httpStatus: 409,
      blockedReason: "terminal_http",
    });
    expect((await store.snapshot(owner)).items[0]?.blocked).toEqual({
      kind: "terminal_http",
      status: 409,
      reason: "terminal_http",
    });
  });

  it("allows only an explicit discard of a terminally blocked head before continuing", async () => {
    const storage = new MemoryProtectedStore();
    const store = createQuickAddOutboxStore({ storage, lockKey: "terminal-discard" });
    let foreground = false;
    let requestCount = 0;
    const controller = controllerFor(
      store,
      async () => {
        requestCount += 1;
        const head = (await store.snapshot(owner)).items[0];
        if (!head) throw new Error("missing discard head");
        return requestCount === 1
          ? new Response("{}", { status: 400 })
          : receiptResponse(head, 201);
      },
      { foreground: () => foreground },
    );
    const first = await controller.enqueue(input(1));
    const second = await controller.enqueue(input(2));
    foreground = true;
    const firstDrain = controller.requestDrain(first.operationId);
    await controller.requestDrain(second.operationId);
    await firstDrain;
    await expect(store.discardBlockedHead(owner, second.operationId)).rejects.toThrow(/head/u);

    await controller.discardBlockedHead(first.operationId);
    expect(requestCount).toBe(2);
    expect((await store.snapshot(owner)).items).toEqual([]);
  });

  it("fences on the first 401 and completes the injected account cleanup before returning", async () => {
    const storage = new MemoryProtectedStore();
    const store = createQuickAddOutboxStore({ storage, lockKey: "unauthorized" });
    let foreground = false;
    let requests = 0;
    let cleanups = 0;
    const controller = controllerFor(
      store,
      async () => {
        requests += 1;
        return new Response("{}", { status: 401 });
      },
      {
        foreground: () => foreground,
        onUnauthorized: async () => {
          cleanups += 1;
          await store.clear();
        },
      },
    );
    const first = await controller.enqueue(input(1));
    const second = await controller.enqueue(input(2));
    foreground = true;
    const firstDrain = controller.requestDrain(first.operationId);
    await controller.requestDrain(second.operationId);
    await firstDrain;
    await controller.requestDrain();

    expect(requests).toBe(1);
    expect(cleanups).toBe(1);
    expect(controller.getState()).toMatchObject({ status: "unavailable", reason: "credential" });
    expect((await store.snapshot(owner)).items).toEqual([]);
  });

  it("retains the head on retryable HTTP and on a mismatched success receipt", async () => {
    const storage = new MemoryProtectedStore();
    const store = createQuickAddOutboxStore({ storage, lockKey: "retry-and-mismatch" });
    let calls = 0;
    const controller = controllerFor(store, async () => {
      calls += 1;
      const head = (await store.snapshot(owner)).items[0];
      if (!head) throw new Error("missing retained head");
      if (calls === 1) return new Response("{}", { status: 503 });
      const mismatched = receiptBody(head, false) as {
        data: { entry: { foodVersionId: string } };
      };
      mismatched.data.entry.foodVersionId = "999999";
      return new Response(JSON.stringify(mismatched), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    });
    const queued = await controller.enqueue(input());
    await controller.requestDrain(queued.operationId);
    expect(controller.getState()).toEqual({ status: "pending", pendingCount: 1 });
    expect((await store.snapshot(owner)).items[0]?.operationId).toBe(queued.operationId);

    await controller.requestDrain();
    expect(controller.getState()).toMatchObject({ status: "unavailable", reason: "response" });
    expect((await store.snapshot(owner)).items[0]?.operationId).toBe(queued.operationId);
  });

  it("aborts on suspend, retains the durable head, and resumes only after the old drain settles", async () => {
    const storage = new MemoryProtectedStore();
    const store = createQuickAddOutboxStore({ storage, lockKey: "suspend-resume" });
    let calls = 0;
    let started: () => void = () => undefined;
    const requestStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const controller = controllerFor(store, async (_url, init) => {
      calls += 1;
      const head = (await store.snapshot(owner)).items[0];
      if (!head) throw new Error("missing suspended head");
      if (calls > 1) return receiptResponse(head, 201);
      started();
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });
    const queued = await controller.enqueue(input());
    const interruptedDrain = controller.requestDrain(queued.operationId);
    await requestStarted;
    controller.suspend();
    expect((await store.snapshot(owner)).items[0]?.operationId).toBe(queued.operationId);

    await controller.resume();
    await interruptedDrain;
    expect(calls).toBe(2);
    expect((await store.snapshot(owner)).items).toEqual([]);
  });

  it("keeps the registration hold when suspend crosses the final append manifest commit", async () => {
    const storage = new MemoryProtectedStore();
    let releaseCommit: () => void = () => undefined;
    let reachCommit: () => void = () => undefined;
    const commitGate = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const commitReached = new Promise<void>((resolve) => {
      reachCommit = resolve;
    });
    let paused = false;
    storage.beforeSet = async (key, value) => {
      if (
        !paused &&
        key === QUICK_ADD_OUTBOX_MANIFEST_KEY &&
        value.includes('"state":"ready"') &&
        value.includes('"count":1')
      ) {
        paused = true;
        reachCommit();
        await commitGate;
      }
    };
    const store = createQuickAddOutboxStore({ storage, lockKey: "suspend-final-commit" });
    const sent: string[] = [];
    const receipts: string[] = [];
    const controller = controllerFor(
      store,
      async (_url, init) => {
        const head = (await store.snapshot(owner)).items[0];
        if (!head) throw new Error("missing suspend-commit head");
        sent.push(new Headers(init.headers).get("idempotency-key") ?? "missing");
        return receiptResponse(head, 201);
      },
      { onReceipt: (receipt) => void receipts.push(receipt.operationId) },
    );

    const enqueue = controller.enqueue(input());
    await commitReached;
    controller.suspend();
    releaseCommit();
    const queued = await enqueue;

    await controller.resume();
    expect(sent).toEqual([]);
    expect((await store.snapshot(owner)).items[0]?.operationId).toBe(queued.operationId);

    await controller.requestDrain(queued.operationId);
    expect(sent).toEqual([queued.operationId]);
    expect(receipts).toEqual([queued.operationId]);
    expect((await store.snapshot(owner)).items).toEqual([]);
  });

  it("fences and delegates owner or corruption faults while retaining transient storage failures", async () => {
    const fatalReasons: FatalQuickAddOutboxStoreReason[] = [];
    const ownerStorage = new MemoryProtectedStore();
    const ownerStore = createQuickAddOutboxStore({
      storage: ownerStorage,
      lockKey: "runtime-owner-fatal",
    });
    await ownerStore.append(otherOwner, await draft(1, otherOwner));
    const ownerController = controllerFor(
      ownerStore,
      async () => {
        throw new Error("must-not-send-owner-mismatch");
      },
      {
        onFatalStoreError: async (reason) => {
          fatalReasons.push(reason);
          await ownerStore.clear();
        },
      },
    );
    await ownerController.requestDrain();
    expect(fatalReasons).toEqual(["owner_mismatch"]);
    expect(ownerController.getState()).toEqual({ status: "owner_mismatch", pendingCount: 0 });
    await expect(ownerController.enqueue(input())).rejects.toThrow(/fenced/u);
    expect((await ownerStore.snapshot(owner)).items).toEqual([]);

    const corruptStorage = new MemoryProtectedStore();
    corruptStorage.values.set(QUICK_ADD_OUTBOX_MANIFEST_KEY, "{");
    const corruptStore = createQuickAddOutboxStore({
      storage: corruptStorage,
      lockKey: "runtime-corrupt-fatal",
    });
    const corruptController = controllerFor(
      corruptStore,
      async () => {
        throw new Error("must-not-send-corrupt");
      },
      {
        onFatalStoreError: async (reason) => {
          fatalReasons.push(reason);
          await corruptStore.clear();
        },
      },
    );
    await corruptController.requestDrain();
    expect(fatalReasons).toEqual(["owner_mismatch", "corrupt"]);
    await expect(corruptController.enqueue(input())).rejects.toThrow(/fenced/u);
    expect((await corruptStore.snapshot(owner)).items).toEqual([]);

    const transientStorage = new MemoryProtectedStore();
    let failRead = true;
    transientStorage.failGet = (key) => key === QUICK_ADD_OUTBOX_MANIFEST_KEY && failRead;
    const transientStore = createQuickAddOutboxStore({
      storage: transientStorage,
      lockKey: "runtime-transient-retry",
    });
    const transientController = controllerFor(
      transientStore,
      async () => {
        throw new Error("must-not-send-empty-transient-store");
      },
      { onFatalStoreError: async (reason) => void fatalReasons.push(reason) },
    );
    await transientController.requestDrain();
    expect(transientController.getState()).toMatchObject({
      status: "unavailable",
      reason: "storage",
    });
    expect(fatalReasons).toEqual(["owner_mismatch", "corrupt"]);
    failRead = false;
    await transientController.requestDrain();
    expect(transientController.getState()).toEqual({ status: "idle", pendingCount: 0 });
    expect(fatalReasons).toEqual(["owner_mismatch", "corrupt"]);
  });

  it("emits one retained exact receipt when acknowledgement recovery proves removal", async () => {
    const storage = new MemoryProtectedStore();
    const store = createQuickAddOutboxStore({ storage, lockKey: "ambiguous-ack-reconcile" });
    const receipts: string[] = [];
    let requests = 0;
    const controller = controllerFor(
      store,
      async () => {
        requests += 1;
        const head = (await store.snapshot(owner)).items[0];
        if (!head) throw new Error("missing ambiguous-ack head");
        return receiptResponse(head, 201);
      },
      { onReceipt: (receipt) => void receipts.push(receipt.operationId) },
    );
    const queued = await controller.enqueue(input());
    let failed = false;
    storage.failAfterSet = (key, value) => {
      if (
        !failed &&
        key === QUICK_ADD_OUTBOX_MANIFEST_KEY &&
        value.includes('"state":"removing"')
      ) {
        failed = true;
        return true;
      }
      return false;
    };

    await controller.requestDrain(queued.operationId);
    await controller.requestDrain();
    expect(requests).toBe(1);
    expect(receipts).toEqual([queued.operationId]);
    expect(controller.getState()).toEqual({ status: "idle", pendingCount: 0 });
    expect((await store.snapshot(owner)).items).toEqual([]);
  });

  it("treats a recovered ambiguous blocked-head discard as success and drains its tail", async () => {
    const storage = new MemoryProtectedStore();
    const store = createQuickAddOutboxStore({ storage, lockKey: "ambiguous-discard-reconcile" });
    let foreground = false;
    const sent: string[] = [];
    const receipts: string[] = [];
    const controller = controllerFor(
      store,
      async (_url, init) => {
        const head = (await store.snapshot(owner)).items[0];
        if (!head) throw new Error("missing ambiguous-discard head");
        sent.push(new Headers(init.headers).get("idempotency-key") ?? "missing");
        return sent.length === 1 ? new Response("{}", { status: 400 }) : receiptResponse(head, 201);
      },
      {
        foreground: () => foreground,
        onReceipt: (receipt) => void receipts.push(receipt.operationId),
      },
    );
    const first = await controller.enqueue(input(1));
    const second = await controller.enqueue(input(2));
    foreground = true;
    const firstDrain = controller.requestDrain(first.operationId);
    await controller.requestDrain(second.operationId);
    await firstDrain;
    expect(controller.getState()).toMatchObject({
      status: "blocked",
      operationId: first.operationId,
    });

    let failed = false;
    storage.failAfterSet = (key, value) => {
      if (
        !failed &&
        key === QUICK_ADD_OUTBOX_MANIFEST_KEY &&
        value.includes('"state":"removing"')
      ) {
        failed = true;
        return true;
      }
      return false;
    };
    await controller.discardBlockedHead(first.operationId);

    expect(sent).toEqual([first.operationId, second.operationId]);
    expect(receipts).toEqual([second.operationId]);
    expect(controller.getState()).toEqual({ status: "idle", pendingCount: 0 });
    expect((await store.snapshot(owner)).items).toEqual([]);
  });

  it("does not resurrect or send an enqueue that loses a close-and-clear epoch race", async () => {
    const storage = new MemoryProtectedStore();
    let releaseSet: () => void = () => undefined;
    let reachedSet: () => void = () => undefined;
    const setGate = new Promise<void>((resolve) => {
      releaseSet = resolve;
    });
    const setReached = new Promise<void>((resolve) => {
      reachedSet = resolve;
    });
    let paused = false;
    storage.beforeSet = async (key) => {
      if (!paused && key === quickAddOutboxSlotKey(0)) {
        paused = true;
        reachedSet();
        await setGate;
      }
    };
    const store = createQuickAddOutboxStore({ storage, lockKey: "epoch-race" });
    let requests = 0;
    const controller = controllerFor(store, async () => {
      requests += 1;
      throw new Error("must-not-send-after-close");
    });
    const enqueue = controller.enqueue(input());
    await setReached;
    controller.close();
    const clear = store.clear();
    releaseSet();

    await expect(enqueue).rejects.toThrow(/epoch/u);
    await clear;
    expect(requests).toBe(0);
    expect(storage.values.size).toBe(0);
    expect((await store.snapshot(owner)).items).toEqual([]);
  });
});
