import { describe, expect, it, vi } from "vitest";

import {
  canOpenBarcodeScanner,
  createBarcodeScannerEventGate,
  FOOD_BARCODE_TYPES,
  parseScannedFoodBarcode,
} from "./barcode-scanner";

describe("food barcode camera boundary", () => {
  it("accepts reviewed food symbologies with their exact platform decimal lengths", () => {
    expect(FOOD_BARCODE_TYPES).toEqual(["ean8", "ean13", "upc_a", "itf14"]);
    expect(parseScannedFoodBarcode({ type: "ean8", data: "96385074" })).toBe("96385074");
    expect(parseScannedFoodBarcode({ type: "ean13", data: "4006381333931" })).toBe("4006381333931");
    expect(parseScannedFoodBarcode({ type: "ean13", data: "036000291452" })).toBe("036000291452");
    expect(parseScannedFoodBarcode({ type: "upc_a", data: "036000291452" })).toBe("036000291452");
    expect(parseScannedFoodBarcode({ type: "itf14", data: "10012345000017" })).toBe(
      "10012345000017",
    );
  });

  it("normalizes bounded Unicode decimal scans without accepting separators or arbitrary data", () => {
    expect(parseScannedFoodBarcode({ type: "ean8", data: " ９６３８５０７４ " })).toBe("96385074");
    expect(parseScannedFoodBarcode({ type: "ean8", data: "9638-5074" })).toBeNull();
    expect(parseScannedFoodBarcode({ type: "ean13", data: "https://example.test" })).toBeNull();
    expect(parseScannedFoodBarcode({ type: "ean13", data: "4".repeat(33) })).toBeNull();
  });

  it("rejects unsupported and compressed formats instead of inferring a GTIN", () => {
    expect(parseScannedFoodBarcode({ type: "qr", data: "4006381333931" })).toBeNull();
    expect(parseScannedFoodBarcode({ type: "code128", data: "4006381333931" })).toBeNull();
    expect(parseScannedFoodBarcode({ type: "upc_e", data: "01234565" })).toBeNull();
    expect(parseScannedFoodBarcode({ type: "ean13", data: "03600029145" })).toBeNull();
  });

  it("opens the native scanner only while the app is foreground-active", () => {
    expect(canOpenBarcodeScanner("active")).toBe(true);
    expect(canOpenBarcodeScanner("background")).toBe(false);
    expect(canOpenBarcodeScanner("inactive")).toBe(false);
    expect(canOpenBarcodeScanner(null)).toBe(false);
  });

  it.each([
    ["cancel", "scan"],
    ["background", "scan"],
    ["scan", "cancel"],
    ["error", "scan"],
    ["scan", "error"],
  ] as const)("allows only the first %s/%s lifecycle event to win", (first, second) => {
    const onCancel = vi.fn();
    const onError = vi.fn();
    const onScanned = vi.fn();
    const gate = createBarcodeScannerEventGate({ onCancel, onError, onScanned });
    const emit = (event: "background" | "cancel" | "error" | "scan") => {
      if (event === "cancel" || event === "background") gate.cancel();
      else if (event === "error") gate.error();
      else gate.scan("4006381333931");
    };

    emit(first);
    emit(second);

    expect(
      onCancel.mock.calls.length + onError.mock.calls.length + onScanned.mock.calls.length,
    ).toBe(1);
    expect(
      first === "cancel" || first === "background"
        ? onCancel
        : first === "error"
          ? onError
          : onScanned,
    ).toHaveBeenCalledTimes(1);
  });
});
