const KEY = "nutrition-tracker.pending-erasure-envelope.v1";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TOKEN = /^[A-Za-z0-9_-]{43,128}$/u;
const EXACT_BODY = '{"confirmation":"DELETE_MY_ACCOUNT"}';

export interface PendingErasureEnvelope {
  readonly version: 1;
  readonly operationId: string;
  readonly serializedBody: typeof EXACT_BODY;
  readonly reauthenticationToken: string;
  readonly createdAt: string;
}

export interface PendingErasureKeyValue {
  get(): Promise<string | null>;
  set(value: string): Promise<void>;
  delete(): Promise<void>;
}

export interface PendingErasureStore {
  load(): Promise<PendingErasureEnvelope | null>;
  save(value: PendingErasureEnvelope): Promise<void>;
  clear(): Promise<void>;
}

export function parsePendingErasureEnvelope(raw: string): PendingErasureEnvelope {
  const value: unknown = JSON.parse(raw);
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !==
      "createdAt,operationId,reauthenticationToken,serializedBody,version"
  ) {
    throw new TypeError("The pending erasure envelope was invalid.");
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== 1 ||
    typeof candidate.operationId !== "string" ||
    !UUID_V4.test(candidate.operationId) ||
    candidate.serializedBody !== EXACT_BODY ||
    typeof candidate.reauthenticationToken !== "string" ||
    !TOKEN.test(candidate.reauthenticationToken) ||
    typeof candidate.createdAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T/u.test(candidate.createdAt) ||
    !Number.isFinite(Date.parse(candidate.createdAt))
  ) {
    throw new TypeError("The pending erasure envelope was invalid.");
  }
  return candidate as unknown as PendingErasureEnvelope;
}

async function secureKeyValue(): Promise<PendingErasureKeyValue> {
  const SecureStore = await import("expo-secure-store");
  const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
  return {
    get: () => SecureStore.getItemAsync(KEY, options),
    set: (value) => SecureStore.setItemAsync(KEY, value, options),
    delete: () => SecureStore.deleteItemAsync(KEY, options),
  };
}

export function createPendingErasureStore(injected?: PendingErasureKeyValue): PendingErasureStore {
  async function keyValue() {
    return injected ?? secureKeyValue();
  }
  return {
    async load() {
      const raw = await (await keyValue()).get();
      return raw === null ? null : parsePendingErasureEnvelope(raw);
    },
    async save(value) {
      const parsed = parsePendingErasureEnvelope(JSON.stringify(value));
      await (await keyValue()).set(JSON.stringify(parsed));
    },
    async clear() {
      await (await keyValue()).delete();
    },
  };
}

export const ACCOUNT_ERASURE_SERIALIZED_BODY = EXACT_BODY;
