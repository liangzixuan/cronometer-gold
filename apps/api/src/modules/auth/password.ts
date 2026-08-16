import { scrypt as nodeScrypt, timingSafeEqual } from "node:crypto";

/** OWASP-equivalent memory/work trade-off: N=2^15, r=8, p=3 (~32 MiB per job). */
export const PASSWORD_SCRYPT_PARAMETERS = Object.freeze({
  algorithm: "scrypt" as const,
  N: 32_768,
  r: 8,
  p: 3,
  keyLength: 64,
  maxmem: 64 * 1024 * 1024,
});

export type PasswordScryptParameters = typeof PASSWORD_SCRYPT_PARAMETERS;

export class PasswordWorkQueueFullError extends Error {
  constructor() {
    super("Password work queue is full");
    this.name = "PasswordWorkQueueFullError";
  }
}

interface PendingJob<T> {
  run(): Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

/** Bounds both memory-heavy in-flight scrypt calls and pending work. */
export class PasswordWorkQueue {
  readonly #maxConcurrent: number;
  readonly #maxPending: number;
  #active = 0;
  readonly #pending: PendingJob<unknown>[] = [];

  constructor(options: { maxConcurrent?: number; maxPending?: number } = {}) {
    this.#maxConcurrent = options.maxConcurrent ?? 2;
    this.#maxPending = options.maxPending ?? 32;
    if (this.#maxConcurrent < 1 || this.#maxPending < 0) {
      throw new Error("Password work limits must be non-negative");
    }
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#active < this.#maxConcurrent) return this.#start(operation);
    if (this.#pending.length >= this.#maxPending) {
      return Promise.reject(new PasswordWorkQueueFullError());
    }

    return new Promise<T>((resolve, reject) => {
      this.#pending.push({ run: operation, resolve, reject } as PendingJob<unknown>);
    });
  }

  async #start<T>(operation: () => Promise<T>): Promise<T> {
    this.#active += 1;
    try {
      return await operation();
    } finally {
      this.#active -= 1;
      const next = this.#pending.shift();
      if (next) {
        void this.#start(next.run).then(next.resolve, next.reject);
      }
    }
  }
}

async function derivePasswordKey(password: string, salt: Uint8Array): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    nodeScrypt(
      password,
      salt,
      PASSWORD_SCRYPT_PARAMETERS.keyLength,
      {
        N: PASSWORD_SCRYPT_PARAMETERS.N,
        r: PASSWORD_SCRYPT_PARAMETERS.r,
        p: PASSWORD_SCRYPT_PARAMETERS.p,
        maxmem: PASSWORD_SCRYPT_PARAMETERS.maxmem,
      },
      (error, derivedKey) => {
        if (error) reject(error);
        else resolve(derivedKey);
      },
    );
  });
}

export async function hashPassword(
  password: string,
  salt: Uint8Array,
  queue: PasswordWorkQueue,
): Promise<string> {
  const key = await queue.run(() => derivePasswordKey(password, salt));
  return key.toString("base64url");
}

export async function verifyPassword(
  password: string,
  saltBase64Url: string,
  expectedHashBase64Url: string,
  parameters: Readonly<Record<string, unknown>>,
  queue: PasswordWorkQueue,
): Promise<boolean> {
  const parametersMatch = Object.entries(PASSWORD_SCRYPT_PARAMETERS).every(
    ([key, value]) => parameters[key] === value,
  );
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltBase64Url, "base64url");
    expected = Buffer.from(expectedHashBase64Url, "base64url");
  } catch {
    salt = Buffer.alloc(16);
    expected = Buffer.alloc(PASSWORD_SCRYPT_PARAMETERS.keyLength);
  }

  const encodingIsValid =
    salt.length === 16 && expected.length === PASSWORD_SCRYPT_PARAMETERS.keyLength;
  if (!encodingIsValid) {
    salt = Buffer.alloc(16);
    expected = Buffer.alloc(PASSWORD_SCRYPT_PARAMETERS.keyLength);
  }
  const actual = await queue.run(() => derivePasswordKey(password, salt));
  return parametersMatch && encodingIsValid && timingSafeEqual(actual, expected);
}
