import { describe, expect, it } from "vitest";

import {
  deriveErasureLedgerLocator,
  ErasureLedgerLocatorConfigurationError,
  erasureLedgerLocatorCandidates,
  parseErasureLedgerLocatorKeyRing,
} from "./erasure-ledger-locator.js";

const userA = "a0000000-0000-4000-8000-000000000001";
const userB = "20000000-0000-4000-8000-000000000002";

function ring(currentKeyId = "locator-v2") {
  return parseErasureLedgerLocatorKeyRing({
    currentKeyId,
    serializedKeys: JSON.stringify({
      "locator-v1": Buffer.alloc(32, 1).toString("base64"),
      "locator-v2": Buffer.alloc(32, 2).toString("base64"),
    }),
  });
}

describe("erasure replay ledger locators", () => {
  it("derives a fixed versioned path from the canonical user and current key", () => {
    const locator = deriveErasureLedgerLocator(ring(), userA);
    expect(locator).toEqual({
      digest: expect.stringMatching(/^[0-9a-f]{64}$/),
      keyId: "locator-v2",
      objectKey: expect.stringMatching(/^erasure-ledger\/v1\/locator-v2\/[0-9a-f]{64}\.json\.enc$/),
      value: expect.stringMatching(/^v1:locator-v2:[0-9a-f]{64}$/),
    });
    expect(() => deriveErasureLedgerLocator(ring(), userA.toUpperCase())).toThrow(TypeError);
  });

  it("fails closed for a wrong key or cross-user substitution", () => {
    const original = deriveErasureLedgerLocator(ring(), userA);
    const wrongKey = parseErasureLedgerLocatorKeyRing({
      currentKeyId: "locator-v2",
      serializedKeys: JSON.stringify({
        "locator-v2": Buffer.alloc(32, 9).toString("base64"),
      }),
    });
    expect(deriveErasureLedgerLocator(wrongKey, userA).value).not.toBe(original.value);
    expect(deriveErasureLedgerLocator(ring(), userB).value).not.toBe(original.value);
  });

  it("retains old locator candidates through the backup tail and loses them only when retired", () => {
    const withOldKey = erasureLedgerLocatorCandidates(ring(), userA);
    expect(withOldKey.map((locator) => locator.keyId)).toEqual(["locator-v1", "locator-v2"]);
    const retired = parseErasureLedgerLocatorKeyRing({
      currentKeyId: "locator-v2",
      serializedKeys: JSON.stringify({
        "locator-v2": Buffer.alloc(32, 2).toString("base64"),
      }),
    });
    expect(erasureLedgerLocatorCandidates(retired, userA).map((locator) => locator.keyId)).toEqual([
      "locator-v2",
    ]);
  });

  it("validates the selected key and every canonical base64 256-bit entry", () => {
    expect(() =>
      parseErasureLedgerLocatorKeyRing({ currentKeyId: "missing", serializedKeys: "{}" }),
    ).toThrow(ErasureLedgerLocatorConfigurationError);
  });
});
