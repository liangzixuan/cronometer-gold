import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Exercises the actual handlers and rendered props with synchronous hooks.
// Native browser input behavior and layout require separate evidence.
const hooks = vi.hoisted(() => {
  interface Slot {
    value?: unknown;
    current?: unknown;
  }
  let slots: Slot[] = [];
  let cursor = 0;
  return {
    reset() {
      slots = [];
    },
    begin() {
      cursor = 0;
    },
    useState<T>(initial: T | (() => T)) {
      const index = cursor++;
      if (!slots[index]) {
        slots[index] = { value: typeof initial === "function" ? (initial as () => T)() : initial };
      }
      const slot = slots[index] as Slot;
      return [
        slot.value as T,
        (next: T | ((current: T) => T)) => {
          slot.value =
            typeof next === "function" ? (next as (current: T) => T)(slot.value as T) : next;
        },
      ] as const;
    },
    useRef<T>(initial: T) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { current: initial };
      return slots[index] as { current: T };
    },
  };
});

const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useState: hooks.useState,
  useRef: hooks.useRef,
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("next/link", () => ({ default: "a" }));

import { AuthClient } from "./AuthClient";

interface ElementNode {
  type: unknown;
  props: Record<string, unknown>;
}
let tree: unknown;
const passwordFocus = vi.fn();

function elements(value: unknown = tree): ElementNode[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const element = value as ElementNode;
  return [element, ...elements(element.props.children ?? null)];
}

function render() {
  hooks.begin();
  tree = AuthClient();
  for (const element of elements()) {
    if (element.props.id !== "account-password") continue;
    const ref = element.props.ref as { current: unknown } | undefined;
    if (ref) ref.current = { focus: passwordFocus };
  }
}

function find(predicate: (element: ElementNode) => boolean) {
  const element = elements().find(predicate);
  if (!element) throw new Error("Expected account control is missing.");
  return element;
}

function field(id: string) {
  return find((element) => element.props.id === id);
}

function change(id: string, value: string) {
  (field(id).props.onChange as (event: { target: { value: string } }) => void)({
    target: { value },
  });
  render();
}

function text(value: unknown = tree): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(text).join(" ");
  if (!value || typeof value !== "object" || !("props" in value)) return "";
  return text((value as ElementNode).props.children ?? null);
}

function chooseMode(mode: "login" | "register") {
  if (mode === "register") {
    const button = find(
      (element) =>
        element.type === "button" &&
        element.props.type === "button" &&
        text(element) === "Create account",
    );
    (button.props.onClick as () => void)();
    render();
  }
  change("account-email", " \uff41\uff44\uff41@example.test ");
  if (mode === "register") {
    change("account-time-zone", " America/Chicago ");
    change("account-display-name", " \uff21\uff44\uff41 ");
  }
}

function submit() {
  const preventDefault = vi.fn();
  const promise = (
    find((element) => element.type === "form").props.onSubmit as (event: {
      preventDefault: () => void;
    }) => Promise<void>
  )({ preventDefault });
  expect(preventDefault).toHaveBeenCalledOnce();
  render();
  return promise;
}

function sessionResponse() {
  return Response.json({
    data: {
      user: {
        id: "96aac405-c107-4776-923e-a40ca5014975",
        email: "ada@example.test",
        emailVerified: false,
      },
      profile: {
        displayName: "Ada",
        birthDate: null,
        sexAtBirth: null,
        heightCm: null,
        baselineWeightKg: null,
        activityLevelCode: null,
        locale: "en-US",
        timeZone: "America/Chicago",
        unitSystem: "metric",
        onboardingCompletedAt: null,
        revision: "0",
        diaryGroups: [
          { mealSlot: "breakfast", label: "Breakfast" },
          { mealSlot: "lunch", label: "Lunch" },
          { mealSlot: "dinner", label: "Dinner" },
          { mealSlot: "snacks", label: "Snacks" },
        ],
      },
    },
  });
}

beforeEach(() => {
  hooks.reset();
  vi.clearAllMocks();
  render();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("account password policy", () => {
  for (const mode of ["login", "register"] as const) {
    it(`allows the full Unicode password in the ${mode} input`, () => {
      chooseMode(mode);
      expect(field("account-password").props).toMatchObject({
        type: "password",
        required: true,
        minLength: 12,
        maxLength: 256,
        autoComplete: mode === "login" ? "current-password" : "new-password",
      });
      expect(field("account-email").props).toMatchObject({
        type: "email",
        required: true,
        autoComplete: "email",
        maxLength: 254,
      });
    });

    it.each([
      { name: "128 astral characters", value: "\u{1f642}".repeat(128) },
      { name: "spaces and decomposed Unicode", value: "  e\u0301 secret \u{1f642} phrase  " },
    ])(`forwards $name exactly from the ${mode} form`, async ({ value }) => {
      const fetcher = vi.fn(async () => sessionResponse());
      vi.stubGlobal("fetch", fetcher);
      chooseMode(mode);
      change("account-password", value);
      await submit();
      render();
      expect(fetcher).toHaveBeenCalledOnce();
      const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe(`/api/auth/${mode}`);
      expect(JSON.parse(String(init.body))).toEqual({
        email: "ada@example.test",
        password: value,
        ...(mode === "register" ? { timeZone: "America/Chicago", displayName: "Ada" } : {}),
      });
      expect(field("account-password").props.value).toBe(value);
      expect(text()).not.toContain(value);
      expect(passwordFocus).not.toHaveBeenCalled();
      expect(router.replace).toHaveBeenCalledWith(
        mode === "register" ? "/verify-email" : "/dashboard",
      );
      expect(router.refresh).toHaveBeenCalledOnce();
    });

    it.each([
      { name: "11 astral characters", value: "\u{1f642}".repeat(11) },
      { name: "129 ASCII characters", value: "a".repeat(129) },
    ])(
      `rejects $name without sending ${mode}, then accepts a corrected draft`,
      async ({ value }) => {
        const fetcher = vi.fn(async () => sessionResponse());
        vi.stubGlobal("fetch", fetcher);
        chooseMode(mode);
        change("account-password", value);
        const invalid = submit();
        expect(fetcher).not.toHaveBeenCalled();
        expect(
          find((element) => element.type === "button" && element.props.type === "submit").props
            .disabled,
        ).toBe(false);
        expect(text()).not.toContain("Please wait");
        await invalid;
        render();
        expect(field("account-password").props.value).toBe(value);
        expect(field("account-email").props.value).toBe(" \uff41\uff44\uff41@example.test ");
        expect(passwordFocus).toHaveBeenCalledOnce();
        expect(field("account-password").props["aria-invalid"]).toBe(true);
        const status = find((element) => element.props.role === "status");
        expect(status.props.id).toBe("account-status");
        expect(field("account-password").props["aria-describedby"]).toBe(status.props.id);
        expect(text(status)).toContain("12");
        expect(text(status)).toContain("128");
        expect(status.props.className).toContain("authStatus--error");
        expect(text()).not.toContain(value);
        expect(router.replace).not.toHaveBeenCalled();

        const corrected = ` ${"\u{1f642}".repeat(65)}e\u0301 `;
        change("account-password", corrected);
        await submit();
        render();
        expect(fetcher).toHaveBeenCalledOnce();
        const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe(`/api/auth/${mode}`);
        expect(JSON.parse(String(init.body)).password).toBe(corrected);
        expect(field("account-password").props.value).toBe(corrected);
        expect(field("account-password").props["aria-invalid"]).not.toBe(true);
        expect(find((element) => element.props.role === "status").props.className).toBe(
          "authStatus",
        );
        expect(text()).not.toContain(corrected);
        expect(passwordFocus).toHaveBeenCalledOnce();
        expect(router.replace).toHaveBeenCalledWith(
          mode === "register" ? "/verify-email" : "/dashboard",
        );
      },
    );
  }
});
