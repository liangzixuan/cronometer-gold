import { afterEach, describe, expect, it, vi } from "vitest";

import { proxyRecipeLog } from "../app/api/recipes/proxy";
import { proxyRetentionRequest } from "../app/api/retention/proxy";
import {
  customFoodLogTimeZoneReviewMessage,
  customFoodProfileRefreshBelongsToOwner,
  fenceCustomFoodLogForTimeZoneChange,
} from "../app/health/HealthClient";
import {
  fenceRecipeLogForTimeZoneChange,
  recipeLogTimeZoneReviewMessage,
  recipeProfileRefreshBelongsToOwner,
} from "../app/recipes/RecipesClient";
import { SESSION_COOKIE } from "./private-api";
import type { RecipeLogBody, StableMutation } from "./recipes-goals";

const token = "t".repeat(43);
const operationId = "61eec75e-fe16-47e4-9f7b-efb6914ad9dc";
const recipeId = "218f6f58-4e2c-7b62-8f0b-3d75491713b5";
const customFoodId = "318f6f58-4e2c-7b62-8f0b-3d75491713b5";
const initiatingUserId = "418f6f58-4e2c-7b62-8f0b-3d75491713b5";
const otherUserId = "518f6f58-4e2c-7b62-8f0b-3d75491713b5";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function mutationHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    cookie: `${SESSION_COOKIE}=${token}`,
    "content-type": "application/json",
    "idempotency-key": operationId,
    origin: "https://app.example.test",
    "sec-fetch-site": "same-origin",
    ...extra,
  };
}

function noWriteConflict(): Response {
  return Response.json(
    { error: "The profile time zone changed.", code: "DIARY_TIME_ZONE_CHANGED" },
    { status: 409 },
  );
}

describe("guarded recipe and custom-food BFF logging", () => {
  it("forwards the single reviewed recipe marker and profile-zone header only", async () => {
    const calls: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL, init?: RequestInit) => {
        calls.push({ url: url.href, ...(init ? { init } : {}) });
        return noWriteConflict();
      }),
    );
    const response = await proxyRecipeLog(
      new Request(
        `https://app.example.test/api/recipes/${recipeId}/log?profileTimeZonePrecondition=v1`,
        {
          method: "POST",
          headers: mutationHeaders({
            "x-expected-profile-time-zone": "America/Chicago",
            "x-device-signature": "must-not-forward",
          }),
          body: JSON.stringify({ recipeVersionId: recipeId }),
        },
      ),
      recipeId,
    );
    expect(response.status).toBe(409);
    expect(calls[0]?.url).toBe(
      `http://127.0.0.1:4000/v1/recipes/${recipeId}/log?profileTimeZonePrecondition=v1`,
    );
    const forwarded = new Headers(calls[0]?.init?.headers);
    expect(forwarded.get("authorization")).toBe(`Bearer ${token}`);
    expect(forwarded.get("x-expected-profile-time-zone")).toBe("America/Chicago");
    expect(forwarded.get("x-device-signature")).toBeNull();
  });

  it("rejects unpaired or expanded recipe guards before upstream", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    for (const [query, zone] of [
      ["", "America/Chicago"],
      ["?profileTimeZonePrecondition=v1", ""],
      ["?profileTimeZonePrecondition=v2", "America/Chicago"],
      ["?profileTimeZonePrecondition=v1&debug=1", "America/Chicago"],
    ] as const) {
      const response = await proxyRecipeLog(
        new Request(`https://app.example.test/api/recipes/${recipeId}/log${query}`, {
          method: "POST",
          headers: mutationHeaders(zone ? { "x-expected-profile-time-zone": zone } : {}),
          body: "{}",
        }),
        recipeId,
      );
      expect(response.status).toBe(400);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("forwards the reviewed custom-food marker and profile-zone header only", async () => {
    const calls: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL, init?: RequestInit) => {
        calls.push({ url: url.href, ...(init ? { init } : {}) });
        return noWriteConflict();
      }),
    );
    const response = await proxyRetentionRequest(
      new Request(
        `https://app.example.test/api/retention/custom-foods/${customFoodId}/log?profileTimeZonePrecondition=v1`,
        {
          method: "POST",
          headers: mutationHeaders({
            "x-expected-profile-time-zone": "America/Chicago",
            "x-device-signature": "must-not-forward",
          }),
          body: JSON.stringify({ customFoodVersionId: customFoodId }),
        },
      ),
      ["custom-foods", customFoodId, "log"],
    );
    expect(response.status).toBe(409);
    expect(calls[0]?.url).toBe(
      `http://127.0.0.1:4000/v1/custom-foods/${customFoodId}/log?profileTimeZonePrecondition=v1`,
    );
    const forwarded = new Headers(calls[0]?.init?.headers);
    expect(forwarded.get("authorization")).toBe(`Bearer ${token}`);
    expect(forwarded.get("x-expected-profile-time-zone")).toBe("America/Chicago");
    expect(forwarded.get("x-device-signature")).toBeNull();
  });

  it("rejects an unpaired custom-food guard before upstream", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const response = await proxyRetentionRequest(
      new Request(
        `https://app.example.test/api/retention/custom-foods/${customFoodId}/log?profileTimeZonePrecondition=v1`,
        { method: "POST", headers: mutationHeaders(), body: "{}" },
      ),
      ["custom-foods", customFoodId, "log"],
    );
    expect(response.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("typed no-write time-zone recovery", () => {
  it("clears only the exact stale recipe retry and requires date review", () => {
    const operation: StableMutation<RecipeLogBody> = {
      intentKey: "recipe-intent",
      operationId,
      body: {
        recipeVersionId: recipeId,
        portion: { kind: "grams", grams: "100" },
        mealSlot: "lunch",
        occurredAt: "2026-09-08T17:00:00.000Z",
      },
    };
    const pending = new Map([[operation.intentKey, operation]]);
    expect(
      fenceRecipeLogForTimeZoneChange(pending, operation, 409, {
        code: "DIARY_TIME_ZONE_CHANGED",
      }),
    ).toBe(true);
    expect(pending.size).toBe(0);
    expect(recipeLogTimeZoneReviewMessage("2026-09-08", "America/New_York")).toContain(
      "This recipe was not logged",
    );
  });

  it("clears only the exact stale custom-food retry and requires date review", () => {
    const pending = new Map([["custom-intent", operationId]]);
    expect(
      fenceCustomFoodLogForTimeZoneChange(pending, "custom-intent", operationId, 409, {
        code: "DIARY_TIME_ZONE_CHANGED",
      }),
    ).toBe(true);
    expect(pending.size).toBe(0);
    expect(customFoodLogTimeZoneReviewMessage("2026-09-08", "America/New_York")).toContain(
      "This private food was not logged",
    );
  });

  it("accepts a custom-food profile refresh only for the initiating private owner", () => {
    expect(customFoodProfileRefreshBelongsToOwner(initiatingUserId, initiatingUserId)).toBe(true);
    expect(customFoodProfileRefreshBelongsToOwner(initiatingUserId, otherUserId)).toBe(false);
  });

  it("accepts a recipe profile refresh only while the initiating owner remains active", () => {
    expect(
      recipeProfileRefreshBelongsToOwner(initiatingUserId, initiatingUserId, initiatingUserId),
    ).toBe(true);
    expect(
      recipeProfileRefreshBelongsToOwner(initiatingUserId, otherUserId, initiatingUserId),
    ).toBe(false);
    expect(
      recipeProfileRefreshBelongsToOwner(initiatingUserId, initiatingUserId, otherUserId),
    ).toBe(false);
    expect(recipeProfileRefreshBelongsToOwner(initiatingUserId, null, initiatingUserId)).toBe(
      false,
    );
  });
});
