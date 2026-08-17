import type {
  AuthenticatedArtifactRead,
  EncryptedArtifactMetadata,
  EncryptedArtifactStore,
} from "./artifact-encryption.js";

export class ArtifactReadRateLimitedError extends Error {
  constructor() {
    super("An artifact download is already active for this principal");
    this.name = "ArtifactReadRateLimitedError";
  }
}

export class ArtifactReadUnavailableError extends Error {
  constructor() {
    super("Artifact download capacity is temporarily unavailable");
    this.name = "ArtifactReadUnavailableError";
  }
}

/**
 * Bounds the authenticated plaintext spools used by artifact downloads.
 *
 * The owner key is internal-only (normally a user id or its SHA-256 digest). It is
 * never logged or exposed. A reservation is held from before ciphertext download
 * through plaintext stream close/disposal, so authentication and response sending
 * share the same concurrency and temporary-volume budget.
 */
export class ArtifactReadBulkhead {
  readonly #maximumConcurrentReads: number;
  readonly #maximumReservedPlaintextBytes: number;
  readonly #maximumArtifactBytes: number;
  readonly #rateWindowMs: number;
  readonly #maximumOpensPerOwnerPerWindow: number;
  readonly #maximumBytesPerOwnerPerWindow: number;
  readonly #maximumTrackedOwners: number;
  readonly #clock: () => number;
  readonly #activeOwners = new Set<string>();
  readonly #ownerBudgets = new Map<
    string,
    { windowStartedAt: number; opens: number; bytes: number }
  >();
  #activeReads = 0;
  #reservedPlaintextBytes = 0;

  constructor(input: {
    readonly maximumConcurrentReads: number;
    readonly maximumReservedPlaintextBytes: number;
    readonly maximumArtifactBytes: number;
    readonly rateWindowMs?: number;
    readonly maximumOpensPerOwnerPerWindow?: number;
    readonly maximumBytesPerOwnerPerWindow?: number;
    readonly maximumTrackedOwners?: number;
    readonly clock?: () => number;
  }) {
    for (const [name, value] of Object.entries({
      maximumArtifactBytes: input.maximumArtifactBytes,
      maximumConcurrentReads: input.maximumConcurrentReads,
      maximumReservedPlaintextBytes: input.maximumReservedPlaintextBytes,
    })) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new RangeError(`Invalid artifact read bulkhead setting: ${name}`);
      }
    }
    if (input.maximumArtifactBytes > input.maximumReservedPlaintextBytes) {
      throw new RangeError(
        "Maximum artifact bytes must fit within the plaintext reservation budget",
      );
    }
    this.#maximumConcurrentReads = input.maximumConcurrentReads;
    this.#maximumReservedPlaintextBytes = input.maximumReservedPlaintextBytes;
    this.#maximumArtifactBytes = input.maximumArtifactBytes;
    this.#rateWindowMs = input.rateWindowMs ?? 3_600_000;
    this.#maximumOpensPerOwnerPerWindow = input.maximumOpensPerOwnerPerWindow ?? 3;
    this.#maximumBytesPerOwnerPerWindow =
      input.maximumBytesPerOwnerPerWindow ?? input.maximumArtifactBytes * 2;
    this.#maximumTrackedOwners = input.maximumTrackedOwners ?? 10_000;
    this.#clock = input.clock ?? Date.now;
    if (
      !Number.isSafeInteger(this.#rateWindowMs) ||
      this.#rateWindowMs < 60_000 ||
      this.#rateWindowMs > 86_400_000 ||
      !Number.isSafeInteger(this.#maximumOpensPerOwnerPerWindow) ||
      this.#maximumOpensPerOwnerPerWindow < 1 ||
      this.#maximumOpensPerOwnerPerWindow > 100 ||
      !Number.isSafeInteger(this.#maximumBytesPerOwnerPerWindow) ||
      this.#maximumBytesPerOwnerPerWindow < this.#maximumArtifactBytes ||
      !Number.isSafeInteger(this.#maximumTrackedOwners) ||
      this.#maximumTrackedOwners < 1 ||
      this.#maximumTrackedOwners > 1_000_000
    ) {
      throw new RangeError("Invalid artifact read rate budget");
    }
  }

  get utilization(): {
    readonly activeReads: number;
    readonly reservedPlaintextBytes: number;
  } {
    return {
      activeReads: this.#activeReads,
      reservedPlaintextBytes: this.#reservedPlaintextBytes,
    };
  }

  async openAuthenticated(input: {
    readonly ownerKey: string;
    readonly metadata: EncryptedArtifactMetadata;
    readonly store: EncryptedArtifactStore;
    readonly signal?: AbortSignal;
  }): Promise<AuthenticatedArtifactRead | null> {
    if (input.ownerKey.length < 1 || input.ownerKey.length > 512) {
      throw new TypeError("Invalid artifact read owner key");
    }
    if (
      !Number.isSafeInteger(input.metadata.plaintextBytes) ||
      input.metadata.plaintextBytes < 1 ||
      input.metadata.plaintextBytes > this.#maximumArtifactBytes
    ) {
      throw new ArtifactReadUnavailableError();
    }
    if (input.signal?.aborted) throw input.signal.reason;
    if (this.#activeOwners.has(input.ownerKey)) throw new ArtifactReadRateLimitedError();
    if (
      this.#activeReads >= this.#maximumConcurrentReads ||
      this.#reservedPlaintextBytes + input.metadata.plaintextBytes >
        this.#maximumReservedPlaintextBytes
    ) {
      throw new ArtifactReadUnavailableError();
    }

    const now = this.#clock();
    if (!Number.isFinite(now)) throw new ArtifactReadUnavailableError();
    let budget = this.#ownerBudgets.get(input.ownerKey);
    if (!budget || now - budget.windowStartedAt >= this.#rateWindowMs) {
      if (!budget && this.#ownerBudgets.size >= this.#maximumTrackedOwners) {
        for (const [owner, candidate] of this.#ownerBudgets) {
          if (now - candidate.windowStartedAt >= this.#rateWindowMs) {
            this.#ownerBudgets.delete(owner);
          }
        }
      }
      if (!budget && this.#ownerBudgets.size >= this.#maximumTrackedOwners) {
        throw new ArtifactReadUnavailableError();
      }
      budget = { bytes: 0, opens: 0, windowStartedAt: now };
      this.#ownerBudgets.set(input.ownerKey, budget);
    }
    if (
      budget.opens >= this.#maximumOpensPerOwnerPerWindow ||
      budget.bytes + input.metadata.plaintextBytes > this.#maximumBytesPerOwnerPerWindow
    ) {
      throw new ArtifactReadRateLimitedError();
    }
    // Bytes meter admitted decrypt/authentication work (including tampered, missing,
    // or transiently failed ciphertext) so expensive failures cannot be abused for
    // free. The successful-download counter advances only after authentication.
    budget.bytes += input.metadata.plaintextBytes;

    this.#activeOwners.add(input.ownerKey);
    this.#activeReads += 1;
    this.#reservedPlaintextBytes += input.metadata.plaintextBytes;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.#activeOwners.delete(input.ownerKey);
      this.#activeReads -= 1;
      this.#reservedPlaintextBytes -= input.metadata.plaintextBytes;
    };

    try {
      const opened = await input.store.openAuthenticated(input.metadata, input.signal);
      if (!opened) {
        release();
        return null;
      }
      budget.opens += 1;
      let disposePromise: Promise<void> | null = null;
      const dispose = async () => {
        disposePromise ??= (async () => {
          try {
            await opened.dispose();
          } finally {
            release();
          }
        })();
        await disposePromise;
      };
      opened.stream.once("close", () => void dispose());
      return { contentLength: opened.contentLength, dispose, stream: opened.stream };
    } catch (error) {
      release();
      throw error;
    }
  }
}
