import { describe, expect, it } from "vitest";
import { resolveMobileProfile } from "../config/mobile-profile";
import { scopeProtectedStore } from "./profile-secure-store";

describe("origin-bound protected storage", () => {
  it("isolates reads, overwrites and deletes without touching unqualified legacy bytes", async () => {
    const values = new Map([["session.v1", "legacy"]]);
    const operations: string[] = [];
    const physical = {
      get: async (key: string) => {
        operations.push(key);
        return values.get(key) ?? null;
      },
      set: async (key: string, value: string) => {
        operations.push(key);
        values.set(key, value);
      },
      delete: async (key: string) => {
        operations.push(key);
        values.delete(key);
      },
    };
    const a = scopeProtectedStore(
      resolveMobileProfile({ apiUrl: "https://a.invalid", platform: "ios" }),
      physical,
    );
    const b = scopeProtectedStore(
      resolveMobileProfile({ apiUrl: "https://b.invalid", platform: "ios" }),
      physical,
    );
    await a.set("session.v1", "A");
    await b.set("session.v1", "B");
    expect(await a.get("session.v1")).toBe("A");
    expect(await b.get("session.v1")).toBe("B");
    await a.delete("session.v1");
    expect(await b.get("session.v1")).toBe("B");
    expect(values.get("session.v1")).toBe("legacy");
    expect(operations).not.toContain("session.v1");
  });
  it("propagates protected-storage failures without trying another key", async () => {
    const keys: string[] = [];
    const scoped = scopeProtectedStore(resolveMobileProfile({ platform: "android" }), {
      get: async (key) => {
        keys.push(key);
        throw new Error("read failed");
      },
      set: async () => {},
      delete: async () => {},
    });
    await expect(scoped.get("session.v1")).rejects.toThrow("read failed");
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^nutrition-origin\./u);
  });
});
