export const FOOD_BARCODE_TYPES = ["ean8", "ean13", "upc_a", "itf14"] as const;

export type FoodBarcodeType = (typeof FOOD_BARCODE_TYPES)[number];

const barcodeLengths: Readonly<Record<FoodBarcodeType, readonly number[]>> = {
  ean8: [8],
  // Expo Camera 57 reports iOS UPC-A as ean13 after removing AVFoundation's
  // synthetic leading zero. Preserve that exact 12-digit representation so
  // the authoritative API can validate and canonicalize it with typed UPC-A.
  ean13: [12, 13],
  upc_a: [12],
  itf14: [14],
};

export interface ScannedBarcodePayload {
  readonly data: unknown;
  readonly type: string;
}

export function parseScannedFoodBarcode(payload: ScannedBarcodePayload): string | null {
  if (
    typeof payload.data !== "string" ||
    payload.data.length === 0 ||
    payload.data.length > 32 ||
    !Object.hasOwn(barcodeLengths, payload.type)
  ) {
    return null;
  }
  const type = payload.type as FoodBarcodeType;
  const normalized = payload.data.normalize("NFKC").trim();
  return /^[0-9]+$/u.test(normalized) && barcodeLengths[type].includes(normalized.length)
    ? normalized
    : null;
}

export function canOpenBarcodeScanner(appState: string | null): boolean {
  return appState === "active";
}

export interface BarcodeScanLatch {
  tryConsume(): boolean;
}

export function createBarcodeScanLatch(): BarcodeScanLatch {
  let consumed = false;
  return {
    tryConsume() {
      if (consumed) return false;
      consumed = true;
      return true;
    },
  };
}

export interface BarcodeScannerEventHandlers<Result> {
  readonly onCancel: () => void;
  readonly onError: () => void;
  readonly onScanned: (result: Result) => void;
}

export interface BarcodeScannerEventGate<Result> {
  cancel(): void;
  error(): void;
  scan(result: Result): void;
}

export function createBarcodeScannerEventGate<Result>(
  handlers: BarcodeScannerEventHandlers<Result>,
): BarcodeScannerEventGate<Result> {
  const latch = createBarcodeScanLatch();
  return {
    cancel() {
      if (latch.tryConsume()) handlers.onCancel();
    },
    error() {
      if (latch.tryConsume()) handlers.onError();
    },
    scan(result) {
      if (latch.tryConsume()) handlers.onScanned(result);
    },
  };
}
