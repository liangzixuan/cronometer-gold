const KEY = "nutrition-tracker.erasure-status-capability.v1";
const TOKEN = /^[A-Za-z0-9_-]{43,128}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface ErasureStatusCapability {
  readonly version: 1;
  readonly jobId: string;
  readonly token: string;
  readonly expiresAt: string;
}

export interface ErasureCapabilityKeyValue {
  get(): Promise<string | null>;
  set(value: string): Promise<void>;
  delete(): Promise<void>;
}

export interface ErasureCapabilityStore {
  load(): Promise<ErasureStatusCapability | null>;
  save(value: ErasureStatusCapability): Promise<void>;
  clear(): Promise<void>;
}

export function parseErasureStatusCapability(raw: string): ErasureStatusCapability {
  const value: unknown = JSON.parse(raw);
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "expiresAt,jobId,token,version"
  ) {
    throw new TypeError("The erasure status capability was invalid.");
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== 1 ||
    typeof candidate.jobId !== "string" ||
    !UUID.test(candidate.jobId) ||
    typeof candidate.token !== "string" ||
    !TOKEN.test(candidate.token) ||
    typeof candidate.expiresAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T/u.test(candidate.expiresAt) ||
    !Number.isFinite(Date.parse(candidate.expiresAt))
  ) {
    throw new TypeError("The erasure status capability was invalid.");
  }
  return candidate as unknown as ErasureStatusCapability;
}

async function secureKeyValue(): Promise<ErasureCapabilityKeyValue> {
  const SecureStore = await import("expo-secure-store");
  const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
  return {
    get: () => SecureStore.getItemAsync(KEY, options),
    set: (value) => SecureStore.setItemAsync(KEY, value, options),
    delete: () => SecureStore.deleteItemAsync(KEY, options),
  };
}

export function createErasureCapabilityStore(
  injected?: ErasureCapabilityKeyValue,
  now: () => Date = () => new Date(),
): ErasureCapabilityStore {
  async function keyValue() {
    return injected ?? secureKeyValue();
  }
  return {
    async load() {
      const storage = await keyValue();
      const raw = await storage.get();
      if (raw === null) return null;
      const value = parseErasureStatusCapability(raw);
      if (Date.parse(value.expiresAt) <= now().getTime()) {
        await storage.delete();
        return null;
      }
      return value;
    },
    async save(value) {
      if (Date.parse(value.expiresAt) <= now().getTime()) {
        throw new RangeError("The erasure status capability has already expired.");
      }
      const parsed = parseErasureStatusCapability(JSON.stringify(value));
      await (await keyValue()).set(JSON.stringify(parsed));
    },
    async clear() {
      await (await keyValue()).delete();
    },
  };
}
