import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QuickAddOutboxController } from "../diary/quick-add-outbox";

// Reuse the deterministic hook fixture pattern from PastedIngredientReview.state.test.
// Runs the real App and startup effects, not native rendering or concurrent React.
const hooks = vi.hoisted(() => {
  interface Slot {
    value?: unknown;
    current?: unknown;
    deps?: readonly unknown[];
    cleanup?: (() => void) | undefined;
    effect?: (() => undefined | (() => void)) | undefined;
  }
  let slots: Slot[] = [];
  let cursor = 0;
  let dirty = false;
  let closed = false;
  let afterClose = 0;
  let effects: Array<() => void> = [];
  let component: () => unknown;
  let tree: unknown;
  const same = (a: readonly unknown[] | undefined, b: readonly unknown[] | undefined) =>
    a !== undefined &&
    b !== undefined &&
    a.length === b.length &&
    a.every((item, index) => Object.is(item, b[index]));
  const render = () => {
    cursor = 0;
    dirty = false;
    tree = component();
    const pending = effects;
    effects = [];
    for (const effect of pending) effect();
  };
  return {
    useState<T>(initial: T | (() => T)) {
      const index = cursor++;
      if (!slots[index]) {
        slots[index] = { value: typeof initial === "function" ? (initial as () => T)() : initial };
      }
      const slot = slots[index] as Slot;
      return [
        slot.value as T,
        (change: T | ((current: T) => T)) => {
          if (closed) afterClose += 1;
          const next =
            typeof change === "function" ? (change as (current: T) => T)(slot.value as T) : change;
          if (!Object.is(next, slot.value)) {
            slot.value = next;
            dirty = true;
          }
        },
      ] as const;
    },
    useRef<T>(initial: T) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { current: initial };
      return slots[index] as { current: T };
    },
    useMemo<T>(factory: () => T, deps: readonly unknown[]) {
      const index = cursor++;
      const old = slots[index];
      if (old && same(old.deps, deps)) return old.value as T;
      const value = factory();
      slots[index] = { value, deps };
      return value;
    },
    useEffect(effect: () => undefined | (() => void), deps?: readonly unknown[]) {
      const index = cursor++;
      const old = slots[index];
      if (old && same(old.deps, deps)) return;
      const slot: Slot = { ...(deps ? { deps } : {}), effect };
      slots[index] = slot;
      effects.push(() => {
        old?.cleanup?.();
        slot.cleanup = effect();
      });
    },
    replayEffects() {
      const mountedEffects = slots.filter((slot) => slot.effect);
      for (const slot of mountedEffects) slot.cleanup?.();
      for (const slot of mountedEffects) slot.cleanup = slot.effect?.();
    },
    mount(next: () => unknown) {
      slots = [];
      effects = [];
      closed = false;
      afterClose = 0;
      component = next;
      render();
    },
    render,
    async settle() {
      for (let pass = 0; pass < 8; pass += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (dirty && !closed) render();
      }
    },
    tree: () => tree,
    afterClose: () => afterClose,
    unmount() {
      if (closed) return;
      closed = true;
      for (const slot of slots) slot.cleanup?.();
    },
  };
});

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useState: hooks.useState,
  useRef: hooks.useRef,
  useMemo: hooks.useMemo,
  useEffect: hooks.useEffect,
  useCallback: <T>(callback: T, deps: readonly unknown[]) => hooks.useMemo(() => callback, deps),
}));

const native = vi.hoisted(() => ({
  values: new Map<string, string>(),
  operations: [] as string[],
  fetch: vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(),
}));
vi.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1,
  getItemAsync: async (key: string) => {
    native.operations.push(`get:${key}`);
    return native.values.get(key) ?? null;
  },
  setItemAsync: async (key: string, value: string) => {
    native.operations.push(`set:${key}`);
    native.values.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    native.operations.push(`delete:${key}`);
    native.values.delete(key);
  },
}));
vi.mock("expo/fetch", () => ({ fetch: native.fetch }));
vi.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA256" },
  randomUUID: () => crypto.randomUUID(),
  digestStringAsync: async (_algorithm: string, value: string) =>
    [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join(""),
}));
vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) },
  ActivityIndicator: "ActivityIndicator",
  Pressable: "Pressable",
  Text: "Text",
  View: "View",
  StyleSheet: { create: <T>(styles: T) => styles },
}));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaProvider: "SafeAreaProvider",
  SafeAreaView: "SafeAreaView",
}));
vi.mock("@react-navigation/native", () => ({
  NavigationContainer: "NavigationContainer",
  useFocusEffect() {},
  useIsFocused: () => true,
  useNavigation: () => ({}),
  useRoute: () => ({}),
}));
vi.mock("@react-navigation/native-stack", () => ({
  createNativeStackNavigator: () => ({ Navigator: "Navigator", Screen: "Screen" }),
}));
vi.mock("expo-status-bar", () => ({ StatusBar: "StatusBar" }));
vi.mock("../activity/ActivityScreen", () => ({ ActivityScreen: "ActivityScreen" }));
vi.mock("../auth/AuthScreen", () => ({ AuthScreen: "AuthScreen" }));
vi.mock("../auth/EmailVerificationScreen", () => ({
  EmailVerificationScreen: "EmailVerificationScreen",
}));
vi.mock("../diary/DiaryScreen", () => ({ DiaryScreen: "DiaryScreen" }));
vi.mock("../hydration/HydrationScreen", () => ({ HydrationScreen: "HydrationScreen" }));
vi.mock("../recipes/GoalsScreen", () => ({ GoalsScreen: "GoalsScreen" }));
vi.mock("../recipes/RecipesScreen", () => ({ RecipesScreen: "RecipesScreen" }));
vi.mock("../reports/ReportsScreen", () => ({ ReportsScreen: "ReportsScreen" }));
vi.mock("../retention/ErasureStatusScreen", () => ({ ErasureStatusScreen: "ErasureStatusScreen" }));
vi.mock("../retention/RetentionScreen", () => ({ RetentionScreen: "RetentionScreen" }));
vi.mock("../search/FoodSearchScreen", () => ({ FoodSearchScreen: "FoodSearchScreen" }));

const origin = "https://dev-api.nourishing.app";
const owner = "70eedafb-9d6e-4adc-b924-8e55e87ff5d0";
const operationId = "00000000-0000-4000-8000-000000000001";
const credential = { accessToken: "h".repeat(43), expiresAt: "2099-01-01T00:00:00.000Z" };
interface ElementNode {
  readonly type: unknown;
  readonly props: Record<string, unknown>;
}
function elements(value: unknown = hooks.tree()): ElementNode[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as ElementNode;
  return [node, ...elements(node.props.children ?? null)];
}
function authenticatedProps() {
  const node = elements().find((element) => "quickAddOutboxController" in element.props);
  if (!node) throw new Error("Actual App did not open the authenticated state.");
  return node.props as {
    apiBase: URL;
    accessToken: string;
    quickAddOutboxController: QuickAddOutboxController;
  };
}
function selectedEnvironment() {
  vi.stubEnv("EXPO_PUBLIC_API_URL", origin);
  vi.stubEnv("EXPO_PUBLIC_NOURISHING_PROFILE", "hosted-development");
}
async function mountApp() {
  const { default: App } = await import("../../App");
  hooks.mount(App);
  await hooks.settle();
}
function sessionResponse() {
  return Response.json({
    data: {
      user: { id: owner, email: "owner@example.test", emailVerified: true },
      profile: {
        displayName: "Owner",
        birthDate: null,
        sexAtBirth: "not_specified",
        heightCm: null,
        baselineWeightKg: null,
        activityLevelCode: null,
        locale: "en-US",
        timeZone: "UTC",
        unitSystem: "metric",
        onboardingCompletedAt: null,
        revision: "4",
      },
    },
  });
}
async function seedSessionAndQueue(apiUrl: string, selector?: string) {
  const policy = await import("./mobile-profile");
  const profile = policy.bindMobileProfile({ apiUrl, selector, platform: "android" });
  const { saveSecureSession } = await import("../auth/secure-session");
  const { createSecureQuickAddOutboxStore } = await import("../diary/quick-add-outbox-store");
  const { createQuickAddOutboxDraft } = await import("../diary/quick-add-outbox");
  await saveSecureSession(credential);
  await createSecureQuickAddOutboxStore().append(
    owner,
    createQuickAddOutboxDraft(
      owner,
      "UTC",
      {
        foodKind: "generic",
        foodName: "Apple",
        foodVersionId: "1",
        servingId: "2",
        servingLabel: "one",
        localDate: "2026-10-01",
        mealSlot: "breakfast",
        occurredAt: "2026-10-01T08:00:00.000Z",
      },
      operationId,
      new Date("2026-10-01T08:00:00.000Z"),
    ),
  );
  return profile;
}
beforeEach(() => {
  vi.resetModules();
  native.values.clear();
  native.operations.length = 0;
  native.fetch.mockReset();
  native.fetch.mockImplementation(async () => {
    throw new Error("Unexpected native request");
  });
  // A global/RN fallback must never be used by this actual-App path.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Ambient fetch must not run");
    }),
  );
  selectedEnvironment();
});
afterEach(() => {
  hooks.unmount();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("actual App origin-bound bootstrap", () => {
  it.each([
    ["unknown", origin],
    ["hosted-development", undefined],
    ["hosted-development", "https://api.nourishing.app"],
    ["hosted-development", "http://127.0.0.1:4000"],
    ["hosted-development", "https://other.example.test"],
  ])("performs zero protected I/O or replay with invalid %s / %s", async (selector, apiUrl) => {
    vi.stubEnv("EXPO_PUBLIC_NOURISHING_PROFILE", selector);
    vi.stubEnv("EXPO_PUBLIC_API_URL", apiUrl);
    native.values.set("nutrition_tracker_session_v1", JSON.stringify(credential));
    native.values.set("nutrition-tracker.pending-erasure-envelope.v1", "legacy replay must remain");
    const before = [...native.values];
    await mountApp();
    expect(native.operations).toEqual([]);
    expect(native.fetch).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect([...native.values]).toEqual(before);
    expect(elements().some((node) => "quickAddOutboxController" in node.props)).toBe(false);
  });

  it("restores a hosted session and queued operation through real App binding and Expo transport", async () => {
    const profile = await seedSessionAndQueue(origin, "hosted-development");
    // Model restart: keep native bytes, discard the setup process's profile/module state.
    vi.resetModules();
    native.operations.length = 0;
    native.fetch.mockImplementation(async (url) => {
      if (new URL(url).pathname === "/v1/auth/me") return sessionResponse();
      if (new URL(url).pathname === "/v1/diary/entries")
        return Response.json({ error: "Synthetic retryable failure" }, { status: 503 });
      throw new Error("Unexpected selected-origin request");
    });
    await mountApp();
    const props = authenticatedProps();
    expect(props.apiBase.origin).toBe(origin);
    expect(props.accessToken).toBe(credential.accessToken);
    expect((await import("./mobile-profile")).getMobileProfile()).toEqual(profile);
    // Invoke the actual controller App passed to its authenticated subtree.
    await props.quickAddOutboxController.resume();
    await hooks.settle();
    expect(
      native.fetch.mock.calls.some(([url]) => new URL(url).pathname === "/v1/diary/entries"),
    ).toBe(true);
    for (const [url, init] of native.fetch.mock.calls) {
      expect(new URL(url).origin).toBe(origin);
      expect(new Headers(init?.headers).get("authorization")).toBe(
        `Bearer ${credential.accessToken}`,
      );
      expect(init?.redirect).toBe("error");
      expect(init?.credentials).toBe("omit");
    }
    expect(
      native.operations.every((op) =>
        op.slice(op.indexOf(":") + 1).startsWith(`${profile.namespace}.`),
      ),
    ).toBe(true);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    const { createSecureQuickAddOutboxStore } = await import("../diary/quick-add-outbox-store");
    expect((await createSecureQuickAddOutboxStore().snapshot(owner)).items[0]?.operationId).toBe(
      operationId,
    );
  });

  it("does not read or replay foreign and legacy sessions, queues or erasure authority", async () => {
    const foreign = await seedSessionAndQueue("https://api.nourishing.app");
    const { mobileProfileKey } = await import("./mobile-profile");
    native.values.set(
      mobileProfileKey(foreign, "nutrition-tracker.pending-erasure-envelope.v1"),
      "foreign replay",
    );
    native.values.set(
      mobileProfileKey(foreign, "nutrition-tracker.erasure-status-capability.v1"),
      "foreign capability",
    );
    native.values.set("nutrition_tracker_session_v1", JSON.stringify(credential));
    native.values.set("nutrition-tracker.pending-erasure-envelope.v1", "legacy replay");
    native.values.set("nutrition-tracker.erasure-status-capability.v1", "legacy capability");
    const preserved = [...native.values];
    vi.resetModules();
    native.operations.length = 0;
    await mountApp();
    const selected = (await import("./mobile-profile")).getMobileProfile();
    expect(selected.apiOrigin).toBe(origin);
    expect(elements().some((node) => node.type === "AuthScreen")).toBe(true);
    expect(native.fetch).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(native.operations.length).toBeGreaterThan(0);
    expect(
      native.operations.every((op) =>
        op.slice(op.indexOf(":") + 1).startsWith(`${selected.namespace}.`),
      ),
    ).toBe(true);
    for (const [key, value] of preserved) expect(native.values.get(key)).toBe(value);
  });
});
