import { describe, expect, it, vi } from "vitest";

import { defaultDiaryGroups, type SessionSummary } from "../../lib/diary";
import { HealthOwnerFenceError, installHealthPrivateDataForOwner } from "./HealthClient";

function session(userId: string): SessionSummary {
  return {
    user: { id: userId, email: `${userId}@example.test`, emailVerified: true },
    profile: {
      displayName: "Owner",
      birthDate: null,
      sexAtBirth: null,
      heightCm: null,
      baselineWeightKg: null,
      activityLevelCode: null,
      locale: "en-US",
      timeZone: "America/Chicago",
      unitSystem: "metric",
      onboardingCompletedAt: null,
      revision: "1",
      diaryGroups: defaultDiaryGroups,
    },
  };
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((complete) => {
      resolve = complete;
    }),
    resolve,
  };
}

describe("private health workspace owner fence", () => {
  it("never installs a delayed private response set after the browser session changes owner", async () => {
    const ownerA = "5e041a5d-00e7-4260-832a-90e34a04e60a";
    const ownerB = "5f5536b9-0f35-44e8-9a77-c26679d7b21b";
    const delayedHealthData = deferred<{ readonly owner: string }>();
    let currentSession = session(ownerA);
    const install = vi.fn();

    const loading = installHealthPrivateDataForOwner({
      expectedOwnerUserId: ownerA,
      loadPrivateData: () => delayedHealthData.promise,
      revalidateSession: async () => currentSession,
      install,
    });

    currentSession = session(ownerB);
    delayedHealthData.resolve({ owner: ownerB });

    await expect(loading).rejects.toBeInstanceOf(HealthOwnerFenceError);
    expect(install).not.toHaveBeenCalled();
  });

  it("installs one coherent response set after the initiating owner is revalidated", async () => {
    const owner = "cdafce92-d3cb-48e1-a3d3-6acc9525abf7";
    const install = vi.fn();
    const data = { customFoods: ["private-food-a"], events: ["event-a"] };

    await installHealthPrivateDataForOwner({
      expectedOwnerUserId: owner,
      loadPrivateData: async () => data,
      revalidateSession: async () => session(owner),
      install,
    });

    expect(install).toHaveBeenCalledOnce();
    expect(install).toHaveBeenCalledWith(data, session(owner));
  });
});
