import type { HealthPlatform } from "./device-signing";
import { decodeStandardBase64 } from "./device-signing";
import {
  type HealthCursorState,
  type HealthSyncState,
  parseHealthCursorState,
  parseHealthSyncState,
} from "./health-cursor";
import type { HealthSyncStore } from "./health-sync";

// Conservative below historical iOS Keychain payload limits after base64 expansion.
const CHUNK_BYTES = 1_200;
// This cap is intentionally conservative. The signed-device release matrix must exercise the
// maximum reviewed journal and record storage/round-trip timing before it may be raised.
const MAX_CHUNKS = 1_024;
const MAX_SERIALIZED_BYTES = CHUNK_BYTES * MAX_CHUNKS;

export interface ProtectedJournalKeyValue {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface HealthJournalRuntime {
  randomUuid(): Promise<string>;
  sha256Hex(value: string): Promise<string>;
}

interface GenerationDescriptor {
  readonly generation: string;
  readonly chunkCount: number;
}

interface JournalManifest extends GenerationDescriptor {
  readonly version: 1;
  readonly byteLength: number;
  readonly sha256: string;
  readonly garbage: readonly GenerationDescriptor[];
}

const initialCursor: HealthCursorState = {
  version: 1,
  providerCursor: null,
  serverDigest: null,
  knownRevisions: {},
};

const locks = new Map<string, Promise<void>>();

async function serialized<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const prior = locks.get(key) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = prior.then(() => current);
  locks.set(key, queued);
  await prior;
  try {
    return await operation();
  } finally {
    release();
    if (locks.get(key) === queued) locks.delete(key);
  }
}

function prefix(platform: HealthPlatform): string {
  return `nutrition-tracker.health-journal.v3.${platform}`;
}

function pointerKey(platform: HealthPlatform): string {
  return `${prefix(platform)}.pointer`;
}

function stagingKey(platform: HealthPlatform): string {
  return `${prefix(platform)}.staging`;
}

function chunkKey(platform: HealthPlatform, generation: string, index: number): string {
  return `${prefix(platform)}.chunk.${generation}.${index}`;
}

function legacyV2Key(platform: HealthPlatform): string {
  return `nutrition-tracker.health-sync.v2.${platform}`;
}

function legacyV1Key(platform: HealthPlatform): string {
  return `nutrition-tracker.health-cursor.v1.${platform}`;
}

function initialState(): HealthSyncState {
  return { version: 2, cursor: initialCursor, pending: null };
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function parseDescriptor(value: unknown): GenerationDescriptor {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !exactKeys(value as Record<string, unknown>, ["generation", "chunkCount"])
  ) {
    throw new TypeError("The health-journal generation descriptor was invalid.");
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.generation !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      candidate.generation,
    ) ||
    !Number.isSafeInteger(candidate.chunkCount) ||
    Number(candidate.chunkCount) < 1 ||
    Number(candidate.chunkCount) > MAX_CHUNKS
  ) {
    throw new TypeError("The health-journal generation descriptor was invalid.");
  }
  return {
    generation: candidate.generation,
    chunkCount: Number(candidate.chunkCount),
  };
}

function parseManifest(raw: string): JournalManifest {
  const value: unknown = JSON.parse(raw);
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !exactKeys(value as Record<string, unknown>, [
      "version",
      "generation",
      "chunkCount",
      "byteLength",
      "sha256",
      "garbage",
    ])
  ) {
    throw new TypeError("The protected health-journal manifest was invalid.");
  }
  const candidate = value as Record<string, unknown>;
  const descriptor = parseDescriptor({
    generation: candidate.generation,
    chunkCount: candidate.chunkCount,
  });
  if (
    candidate.version !== 1 ||
    !Number.isSafeInteger(candidate.byteLength) ||
    Number(candidate.byteLength) < 1 ||
    Number(candidate.byteLength) > MAX_SERIALIZED_BYTES ||
    typeof candidate.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(candidate.sha256) ||
    !Array.isArray(candidate.garbage) ||
    candidate.garbage.length > 4
  ) {
    throw new TypeError("The protected health-journal manifest was invalid.");
  }
  return {
    version: 1,
    ...descriptor,
    byteLength: Number(candidate.byteLength),
    sha256: candidate.sha256,
    garbage: candidate.garbage.map(parseDescriptor),
  };
}

function bytesToStandardBase64(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let result = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    const combined = (first << 16) | (second << 8) | third;
    result += alphabet[(combined >>> 18) & 63] ?? "";
    result += alphabet[(combined >>> 12) & 63] ?? "";
    result += index + 1 < bytes.length ? (alphabet[(combined >>> 6) & 63] ?? "") : "=";
    result += index + 2 < bytes.length ? (alphabet[combined & 63] ?? "") : "=";
  }
  return result;
}

async function deleteGeneration(
  platform: HealthPlatform,
  descriptor: GenerationDescriptor,
  storage: ProtectedJournalKeyValue,
): Promise<void> {
  for (let index = 0; index < descriptor.chunkCount; index += 1) {
    await storage.delete(chunkKey(platform, descriptor.generation, index));
  }
}

async function recoverStaging(
  platform: HealthPlatform,
  storage: ProtectedJournalKeyValue,
  currentGeneration: string | null,
): Promise<void> {
  const raw = await storage.get(stagingKey(platform));
  if (raw === null) return;
  const descriptor = parseDescriptor(JSON.parse(raw) as unknown);
  if (descriptor.generation !== currentGeneration) {
    await deleteGeneration(platform, descriptor, storage);
  }
  await storage.delete(stagingKey(platform));
}

async function loadCurrent(
  platform: HealthPlatform,
  storage: ProtectedJournalKeyValue,
  runtime: HealthJournalRuntime,
): Promise<{ readonly state: HealthSyncState; readonly manifest: JournalManifest | null }> {
  const rawPointer = await storage.get(pointerKey(platform));
  if (rawPointer === null) {
    await recoverStaging(platform, storage, null);
    const legacyV2 = await storage.get(legacyV2Key(platform));
    if (legacyV2 !== null) return { state: parseHealthSyncState(legacyV2), manifest: null };
    const legacyV1 = await storage.get(legacyV1Key(platform));
    return {
      state:
        legacyV1 === null
          ? initialState()
          : { version: 2, cursor: parseHealthCursorState(legacyV1), pending: null },
      manifest: null,
    };
  }
  const manifest = parseManifest(rawPointer);
  await recoverStaging(platform, storage, manifest.generation);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (let index = 0; index < manifest.chunkCount; index += 1) {
    const rawChunk = await storage.get(chunkKey(platform, manifest.generation, index));
    if (rawChunk === null) throw new Error("A protected health-journal chunk was missing.");
    const chunk = decodeStandardBase64(rawChunk);
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  if (total !== manifest.byteLength) {
    throw new Error("The protected health-journal length check failed.");
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const serializedState = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if ((await runtime.sha256Hex(serializedState)) !== manifest.sha256) {
    throw new Error("The protected health-journal integrity check failed.");
  }
  const state = parseHealthSyncState(serializedState);
  if (manifest.garbage.length > 0) {
    for (const garbage of manifest.garbage) await deleteGeneration(platform, garbage, storage);
    await storage.set(pointerKey(platform), JSON.stringify({ ...manifest, garbage: [] }));
  }
  return { state, manifest: { ...manifest, garbage: [] } };
}

async function writeState(
  platform: HealthPlatform,
  state: HealthSyncState,
  prior: JournalManifest | null,
  storage: ProtectedJournalKeyValue,
  runtime: HealthJournalRuntime,
): Promise<void> {
  const serializedState = JSON.stringify(parseHealthSyncState(JSON.stringify(state)));
  const bytes = new TextEncoder().encode(serializedState);
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_SERIALIZED_BYTES) {
    throw new RangeError("The protected health journal exceeds its reviewed storage bound.");
  }
  const chunkCount = Math.ceil(bytes.byteLength / CHUNK_BYTES);
  const generation = await runtime.randomUuid();
  const descriptor = parseDescriptor({ generation, chunkCount });
  await storage.set(stagingKey(platform), JSON.stringify(descriptor));
  let written = 0;
  let committed = false;
  try {
    for (let index = 0; index < chunkCount; index += 1) {
      const chunk = bytes.slice(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES);
      await storage.set(chunkKey(platform, generation, index), bytesToStandardBase64(chunk));
      written += 1;
    }
    const sha256 = await runtime.sha256Hex(serializedState);
    const stagedChunks: Uint8Array[] = [];
    let stagedLength = 0;
    for (let index = 0; index < chunkCount; index += 1) {
      const value = await storage.get(chunkKey(platform, generation, index));
      if (value === null) throw new Error("A staged health-journal chunk was not durable.");
      const decoded = decodeStandardBase64(value);
      stagedChunks.push(decoded);
      stagedLength += decoded.byteLength;
    }
    if (stagedLength !== bytes.byteLength) {
      throw new Error("A staged health-journal chunk was truncated before commit.");
    }
    const stagedBytes = new Uint8Array(stagedLength);
    let stagedOffset = 0;
    for (const chunk of stagedChunks) {
      stagedBytes.set(chunk, stagedOffset);
      stagedOffset += chunk.byteLength;
    }
    const stagedState = new TextDecoder("utf-8", { fatal: true }).decode(stagedBytes);
    if (stagedState !== serializedState || (await runtime.sha256Hex(stagedState)) !== sha256) {
      throw new Error("A staged health-journal chunk failed read-back verification.");
    }
    const manifest: JournalManifest = {
      version: 1,
      ...descriptor,
      byteLength: bytes.byteLength,
      sha256,
      garbage: prior
        ? [{ generation: prior.generation, chunkCount: prior.chunkCount }, ...prior.garbage].slice(
            0,
            4,
          )
        : [],
    };
    await storage.set(pointerKey(platform), JSON.stringify(manifest));
    committed = true;
    try {
      await storage.delete(stagingKey(platform));
      for (const garbage of manifest.garbage) await deleteGeneration(platform, garbage, storage);
      await storage.set(pointerKey(platform), JSON.stringify({ ...manifest, garbage: [] }));
      await storage.delete(legacyV2Key(platform));
      await storage.delete(legacyV1Key(platform));
    } catch {
      // The atomic pointer already names a verified generation. A later load resumes garbage cleanup.
    }
  } catch (error) {
    // Best effort only: a crash-safe staging descriptor lets the next load finish this cleanup.
    if (!committed) {
      for (let index = 0; index < written; index += 1) {
        try {
          await storage.delete(chunkKey(platform, generation, index));
        } catch {
          break;
        }
      }
    }
    throw error;
  }
}

async function secureStoreAdapter(): Promise<ProtectedJournalKeyValue> {
  const SecureStore = await import("expo-secure-store");
  const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
  return {
    get: (key) => SecureStore.getItemAsync(key, options),
    set: (key, value) => SecureStore.setItemAsync(key, value, options),
    delete: (key) => SecureStore.deleteItemAsync(key, options),
  };
}

async function nativeRuntime(): Promise<HealthJournalRuntime> {
  const Crypto = await import("expo-crypto");
  return {
    randomUuid: async () => Crypto.randomUUID(),
    sha256Hex: (value) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value),
  };
}

export function createChunkedHealthSyncStore(
  platform: HealthPlatform,
  overrides?: {
    readonly storage: ProtectedJournalKeyValue;
    readonly runtime: HealthJournalRuntime;
  },
): HealthSyncStore {
  const lockKey = prefix(platform);
  async function dependencies() {
    return overrides ?? { storage: await secureStoreAdapter(), runtime: await nativeRuntime() };
  }
  return {
    load: () =>
      serialized(lockKey, async () => {
        const { storage, runtime } = await dependencies();
        return (await loadCurrent(platform, storage, runtime)).state;
      }),
    stage: (expectedServerDigest, pending) =>
      serialized(lockKey, async () => {
        const { storage, runtime } = await dependencies();
        const current = await loadCurrent(platform, storage, runtime);
        if (
          current.state.cursor.serverDigest !== expectedServerDigest ||
          current.state.pending !== null
        ) {
          throw new Error("The health synchronization journal changed before staging this batch.");
        }
        if (pending.envelope.body.platform !== platform) {
          throw new TypeError("The staged health batch targeted a different provider.");
        }
        await writeState(
          platform,
          { ...current.state, pending },
          current.manifest,
          storage,
          runtime,
        );
      }),
    accept: (batchId) =>
      serialized(lockKey, async () => {
        const { storage, runtime } = await dependencies();
        const current = await loadCurrent(platform, storage, runtime);
        if (current.state.pending?.envelope.body.batchId !== batchId) {
          throw new Error("The accepted health batch did not match the protected journal.");
        }
        await writeState(
          platform,
          {
            version: 2,
            cursor: current.state.pending.nextCursor,
            pending: null,
          },
          current.manifest,
          storage,
          runtime,
        );
      }),
  };
}

export const createSecureHealthSyncStore = createChunkedHealthSyncStore;

export async function clearHealthCursor(platform: HealthPlatform): Promise<void> {
  const storage = await secureStoreAdapter();
  await serialized(prefix(platform), async () => {
    const rawPointer = await storage.get(pointerKey(platform));
    if (rawPointer !== null) {
      const manifest = parseManifest(rawPointer);
      await deleteGeneration(platform, manifest, storage);
      for (const garbage of manifest.garbage) await deleteGeneration(platform, garbage, storage);
    }
    const rawStaging = await storage.get(stagingKey(platform));
    if (rawStaging !== null) {
      await deleteGeneration(platform, parseDescriptor(JSON.parse(rawStaging) as unknown), storage);
    }
    await storage.delete(pointerKey(platform));
    await storage.delete(stagingKey(platform));
    await storage.delete(legacyV2Key(platform));
    await storage.delete(legacyV1Key(platform));
  });
}

export type { HealthCursorState, PendingHealthImport } from "./health-cursor";
