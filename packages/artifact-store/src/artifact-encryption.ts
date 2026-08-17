import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { createReadStream, createWriteStream, type ReadStream } from "node:fs";
import { chmod, link, mkdir, mkdtemp, rm, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const ENVELOPE_MAGIC = Buffer.from("NTAE0001", "ascii");
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const MAX_KEY_ID_BYTES = 64;
const MAX_OBJECT_KEY_BYTES = 1_024;
const DEFAULT_MAX_PLAINTEXT_BYTES = 107_374_182_400;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type ExportArtifactMediaType = "application/json" | "application/zip";
export type ArtifactEncryptionPurpose = "export" | "erasure_replay_ledger";

export interface ArtifactEncryptionKeyRing {
  readonly purpose: ArtifactEncryptionPurpose;
  readonly currentKeyId: string;
  readonly keys: ReadonlyMap<string, Uint8Array>;
}

export interface RawArtifactStore {
  put(input: {
    readonly objectKey: string;
    readonly source: Readable;
    readonly contentLength: number;
    readonly signal?: AbortSignal;
  }): Promise<void>;
  open(input: {
    readonly objectKey: string;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly stream: Readable; readonly contentLength: number } | null>;
  delete?(input: { readonly objectKey: string; readonly signal?: AbortSignal }): Promise<void>;
}

export interface EncryptedArtifactMetadata {
  readonly envelopeVersion: 1;
  readonly encryptionKeyId: string;
  readonly objectKey: string;
  readonly mediaType: ExportArtifactMediaType;
  readonly plaintextBytes: number;
  readonly plaintextSha256: string;
  readonly ciphertextBytes: number;
}

export interface VerifiedArtifactDeletion {
  readonly objectKey: string;
  readonly deletionEvidenceDigest: string;
}

export interface AuthenticatedArtifactRead {
  readonly stream: ReadStream;
  readonly contentLength: number;
  dispose(): Promise<void>;
}

export interface DiscoveredAuthenticatedArtifactRead extends AuthenticatedArtifactRead {
  readonly metadata: EncryptedArtifactMetadata;
}

export class ArtifactEncryptionConfigurationError extends Error {
  constructor(readonly field: string) {
    super(`Invalid artifact encryption configuration: ${field}`);
    this.name = "ArtifactEncryptionConfigurationError";
  }
}

export class ArtifactAuthenticationError extends Error {
  constructor() {
    super("Export artifact authentication failed");
    this.name = "ArtifactAuthenticationError";
  }
}

function canonicalStandardBase64(value: string): Buffer | null {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return null;
  }
  const decoded = Buffer.from(value, "base64");
  return decoded.toString("base64") === value ? decoded : null;
}

export function parseArtifactEncryptionKeyRing(input: {
  readonly purpose: ArtifactEncryptionPurpose;
  readonly currentKeyId: string | undefined;
  readonly serializedKeys: string | undefined;
}): ArtifactEncryptionKeyRing {
  const currentKeyField =
    input.purpose === "export"
      ? "EXPORT_ARTIFACT_CURRENT_KEY_ID"
      : "ERASURE_REPLAY_LEDGER_CURRENT_KEY_ID";
  const keysField =
    input.purpose === "export"
      ? "EXPORT_ARTIFACT_ENCRYPTION_KEYS"
      : "ERASURE_REPLAY_LEDGER_ENCRYPTION_KEYS";
  if (!input.currentKeyId || !KEY_ID_PATTERN.test(input.currentKeyId)) {
    throw new ArtifactEncryptionConfigurationError(currentKeyField);
  }
  if (!input.serializedKeys || input.serializedKeys.length > 32_768) {
    throw new ArtifactEncryptionConfigurationError(keysField);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.serializedKeys);
  } catch {
    throw new ArtifactEncryptionConfigurationError(keysField);
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.getPrototypeOf(parsed) !== Object.prototype
  ) {
    throw new ArtifactEncryptionConfigurationError(keysField);
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length < 1 || entries.length > 32) {
    throw new ArtifactEncryptionConfigurationError(keysField);
  }
  const keys = new Map<string, Uint8Array>();
  for (const [keyId, encoded] of entries) {
    const key = typeof encoded === "string" ? canonicalStandardBase64(encoded) : null;
    if (!KEY_ID_PATTERN.test(keyId) || !key || key.byteLength !== 32) {
      throw new ArtifactEncryptionConfigurationError(keysField);
    }
    keys.set(keyId, key);
  }
  if (!keys.has(input.currentKeyId)) {
    throw new ArtifactEncryptionConfigurationError(currentKeyField);
  }
  return { currentKeyId: input.currentKeyId, keys, purpose: input.purpose };
}

function checkedKey(keyRing: ArtifactEncryptionKeyRing, keyId: string): Buffer {
  const value = keyRing.keys.get(keyId);
  if (value?.byteLength !== 32) throw new ArtifactAuthenticationError();
  return Buffer.from(value);
}

function checkedObjectKey(objectKey: string): string {
  if (
    Buffer.byteLength(objectKey, "utf8") > MAX_OBJECT_KEY_BYTES ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(objectKey) ||
    objectKey.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw new TypeError("Invalid export artifact object key");
  }
  return objectKey;
}

function envelopeHeader(keyId: string, nonce: Buffer): Buffer {
  const encodedKeyId = Buffer.from(keyId, "ascii");
  if (
    encodedKeyId.byteLength < 1 ||
    encodedKeyId.byteLength > MAX_KEY_ID_BYTES ||
    !KEY_ID_PATTERN.test(keyId) ||
    nonce.byteLength !== NONCE_BYTES
  ) {
    throw new ArtifactEncryptionConfigurationError("EXPORT_ARTIFACT_CURRENT_KEY_ID");
  }
  return Buffer.concat([
    ENVELOPE_MAGIC,
    Buffer.from([encodedKeyId.byteLength]),
    encodedKeyId,
    nonce,
  ]);
}

function additionalAuthenticatedData(
  header: Buffer,
  objectKey: string,
  mediaType: ExportArtifactMediaType,
  purpose: ArtifactEncryptionPurpose,
): Buffer {
  const domain =
    purpose === "export"
      ? "nutrition-tracker-export-artifact-v1"
      : "nutrition-tracker-erasure-replay-ledger-v1";
  return Buffer.concat([
    header,
    Buffer.from(`\0${domain}\0`, "ascii"),
    Buffer.from(objectKey, "utf8"),
    Buffer.from("\0", "ascii"),
    Buffer.from(mediaType, "ascii"),
  ]);
}

function asBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === "string") return Buffer.from(chunk);
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  throw new ArtifactAuthenticationError();
}

class ChunkReader {
  readonly #iterator: AsyncIterator<unknown>;
  #pending = Buffer.alloc(0);

  constructor(stream: Readable) {
    this.#iterator = stream[Symbol.asyncIterator]() as AsyncIterator<unknown>;
  }

  async exactly(length: number): Promise<Buffer> {
    while (this.#pending.byteLength < length) {
      const next = await this.#iterator.next();
      if (next.done) throw new ArtifactAuthenticationError();
      this.#pending = Buffer.concat([this.#pending, asBuffer(next.value)]);
    }
    const result = Buffer.from(this.#pending.subarray(0, length));
    this.#pending = Buffer.from(this.#pending.subarray(length));
    return result;
  }

  async *remaining(): AsyncGenerator<Buffer> {
    if (this.#pending.byteLength > 0) yield this.#pending;
    for (;;) {
      const next = await this.#iterator.next();
      if (next.done) return;
      yield asBuffer(next.value);
    }
  }
}

async function writeChunk(
  stream: ReturnType<typeof createWriteStream>,
  chunk: Buffer,
): Promise<void> {
  if (chunk.byteLength === 0) return;
  if (stream.write(chunk)) return;
  await new Promise<void>((resolvePromise, reject) => {
    const onDrain = () => {
      cleanup();
      resolvePromise();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      stream.off("drain", onDrain);
      stream.off("error", onError);
    };
    stream.once("drain", onDrain);
    stream.once("error", onError);
  });
}

async function endWritable(stream: ReturnType<typeof createWriteStream>): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const onFinish = () => {
      cleanup();
      resolvePromise();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      stream.off("finish", onFinish);
      stream.off("error", onError);
    };
    stream.once("finish", onFinish);
    stream.once("error", onError);
    stream.end();
  });
}

export class EncryptedArtifactStore {
  readonly #keyRing: ArtifactEncryptionKeyRing;
  readonly #rawStore: RawArtifactStore;
  readonly #nonce: () => Buffer;
  readonly #temporaryDirectory: string;
  readonly #maxPlaintextBytes: number;

  constructor(input: {
    readonly keyRing: ArtifactEncryptionKeyRing;
    readonly rawStore: RawArtifactStore;
    readonly nonce?: () => Buffer;
    readonly temporaryDirectory?: string;
    readonly maxPlaintextBytes?: number;
  }) {
    checkedKey(input.keyRing, input.keyRing.currentKeyId);
    this.#keyRing = input.keyRing;
    this.#rawStore = input.rawStore;
    this.#nonce = input.nonce ?? (() => randomBytes(NONCE_BYTES));
    this.#temporaryDirectory = input.temporaryDirectory ?? tmpdir();
    this.#maxPlaintextBytes = input.maxPlaintextBytes ?? DEFAULT_MAX_PLAINTEXT_BYTES;
    if (!Number.isSafeInteger(this.#maxPlaintextBytes) || this.#maxPlaintextBytes < 1) {
      throw new RangeError("Invalid maximum export artifact size");
    }
  }

  async put(input: {
    readonly objectKey: string;
    readonly mediaType: ExportArtifactMediaType;
    readonly source: Readable;
    readonly plaintextBytes: number;
    readonly signal?: AbortSignal;
  }): Promise<EncryptedArtifactMetadata> {
    const objectKey = checkedObjectKey(input.objectKey);
    if (
      !Number.isSafeInteger(input.plaintextBytes) ||
      input.plaintextBytes < 1 ||
      input.plaintextBytes > this.#maxPlaintextBytes
    ) {
      throw new RangeError("Export artifact exceeds the configured bound");
    }
    const keyId = this.#keyRing.currentKeyId;
    const key = checkedKey(this.#keyRing, keyId);
    const nonce = this.#nonce();
    const header = envelopeHeader(keyId, nonce);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(
      additionalAuthenticatedData(header, objectKey, input.mediaType, this.#keyRing.purpose),
    );
    const digest = createHash("sha256");
    let observedBytes = 0;

    const encrypted = Readable.from(
      (async function* (): AsyncGenerator<Buffer> {
        yield header;
        for await (const rawChunk of input.source) {
          if (input.signal?.aborted) throw input.signal.reason;
          const chunk = asBuffer(rawChunk);
          observedBytes += chunk.byteLength;
          if (observedBytes > input.plaintextBytes) {
            throw new ArtifactAuthenticationError();
          }
          digest.update(chunk);
          const ciphertext = cipher.update(chunk);
          if (ciphertext.byteLength > 0) yield ciphertext;
        }
        if (observedBytes !== input.plaintextBytes) throw new ArtifactAuthenticationError();
        const final = cipher.final();
        if (final.byteLength > 0) yield final;
        yield cipher.getAuthTag();
      })(),
    );
    const ciphertextBytes = header.byteLength + input.plaintextBytes + AUTH_TAG_BYTES;
    await this.#rawStore.put({
      contentLength: ciphertextBytes,
      objectKey,
      source: encrypted,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    return {
      ciphertextBytes,
      encryptionKeyId: keyId,
      envelopeVersion: 1,
      mediaType: input.mediaType,
      objectKey,
      plaintextBytes: observedBytes,
      plaintextSha256: digest.digest("hex"),
    };
  }

  /** Deletes the sole immutable ciphertext and proves it is no longer readable. */
  async deleteVerified(input: {
    readonly objectKey: string;
    readonly signal?: AbortSignal;
  }): Promise<VerifiedArtifactDeletion> {
    const objectKey = checkedObjectKey(input.objectKey);
    if (!this.#rawStore.delete) {
      throw new ArtifactAuthenticationError();
    }
    await this.#rawStore.delete({
      objectKey,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const remaining = await this.#rawStore.open({
      objectKey,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (remaining) {
      remaining.stream.destroy();
      throw new ArtifactAuthenticationError();
    }
    return {
      deletionEvidenceDigest: createHash("sha256")
        .update(
          `nutrition-tracker-artifact-deletion-evidence-v1\n${this.#keyRing.purpose}\n${objectKey}`,
          "utf8",
        )
        .digest("hex"),
      objectKey,
    };
  }

  async openAuthenticated(
    metadata: EncryptedArtifactMetadata,
    signal?: AbortSignal,
  ): Promise<AuthenticatedArtifactRead | null> {
    const objectKey = checkedObjectKey(metadata.objectKey);
    if (
      metadata.envelopeVersion !== 1 ||
      (metadata.mediaType !== "application/json" && metadata.mediaType !== "application/zip") ||
      !KEY_ID_PATTERN.test(metadata.encryptionKeyId) ||
      !Number.isSafeInteger(metadata.plaintextBytes) ||
      metadata.plaintextBytes < 1 ||
      metadata.plaintextBytes > this.#maxPlaintextBytes ||
      !Number.isSafeInteger(metadata.ciphertextBytes) ||
      metadata.ciphertextBytes !==
        ENVELOPE_MAGIC.byteLength +
          1 +
          Buffer.byteLength(metadata.encryptionKeyId, "ascii") +
          NONCE_BYTES +
          metadata.plaintextBytes +
          AUTH_TAG_BYTES ||
      !/^[0-9a-f]{64}$/.test(metadata.plaintextSha256)
    ) {
      throw new ArtifactAuthenticationError();
    }
    return this.#openAuthenticatedEnvelope({
      expected: metadata,
      mediaType: metadata.mediaType,
      objectKey,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Authenticates an envelope when its database metadata is intentionally external
   * to the restored backup (the erasure replay ledger). Metadata is derived only
   * after GCM authentication; no plaintext stream is exposed first.
   */
  async openAuthenticatedByObject(input: {
    readonly objectKey: string;
    readonly mediaType: ExportArtifactMediaType;
    readonly signal?: AbortSignal;
  }): Promise<DiscoveredAuthenticatedArtifactRead | null> {
    if (input.mediaType !== "application/json" && input.mediaType !== "application/zip") {
      throw new ArtifactAuthenticationError();
    }
    return this.#openAuthenticatedEnvelope({
      mediaType: input.mediaType,
      objectKey: checkedObjectKey(input.objectKey),
      ...(input.signal ? { signal: input.signal } : {}),
    });
  }

  /**
   * Authenticates and hashes an existing immutable object without creating a
   * plaintext spool. Used only for deterministic conditional-PUT recovery while
   * the original export workspace is still reserved on disk.
   */
  async verifyAuthenticatedByObject(input: {
    readonly objectKey: string;
    readonly mediaType: ExportArtifactMediaType;
    readonly expectedPlaintextBytes: number;
    readonly expectedPlaintextSha256: string;
    readonly signal?: AbortSignal;
  }): Promise<EncryptedArtifactMetadata | null> {
    const objectKey = checkedObjectKey(input.objectKey);
    if (
      (input.mediaType !== "application/json" && input.mediaType !== "application/zip") ||
      !Number.isSafeInteger(input.expectedPlaintextBytes) ||
      input.expectedPlaintextBytes < 1 ||
      input.expectedPlaintextBytes > this.#maxPlaintextBytes ||
      !/^[0-9a-f]{64}$/.test(input.expectedPlaintextSha256)
    ) {
      throw new ArtifactAuthenticationError();
    }
    const raw = await this.#rawStore.open({
      objectKey,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (!raw) return null;
    try {
      if (
        !Number.isSafeInteger(raw.contentLength) ||
        raw.contentLength < ENVELOPE_MAGIC.byteLength + 1 + 1 + NONCE_BYTES + AUTH_TAG_BYTES + 1 ||
        raw.contentLength >
          ENVELOPE_MAGIC.byteLength +
            1 +
            MAX_KEY_ID_BYTES +
            NONCE_BYTES +
            AUTH_TAG_BYTES +
            this.#maxPlaintextBytes
      ) {
        throw new ArtifactAuthenticationError();
      }
      const reader = new ChunkReader(raw.stream);
      const prefix = await reader.exactly(ENVELOPE_MAGIC.byteLength + 1);
      if (!prefix.subarray(0, ENVELOPE_MAGIC.byteLength).equals(ENVELOPE_MAGIC)) {
        throw new ArtifactAuthenticationError();
      }
      const keyIdLength = prefix[ENVELOPE_MAGIC.byteLength];
      if (!keyIdLength || keyIdLength > MAX_KEY_ID_BYTES) throw new ArtifactAuthenticationError();
      const keyAndNonce = await reader.exactly(keyIdLength + NONCE_BYTES);
      const keyId = keyAndNonce.subarray(0, keyIdLength).toString("ascii");
      if (!KEY_ID_PATTERN.test(keyId)) throw new ArtifactAuthenticationError();
      const nonce = keyAndNonce.subarray(keyIdLength);
      const header = Buffer.concat([prefix, keyAndNonce]);
      const plaintextBytes = raw.contentLength - header.byteLength - AUTH_TAG_BYTES;
      if (plaintextBytes !== input.expectedPlaintextBytes) throw new ArtifactAuthenticationError();
      const decipher = createDecipheriv("aes-256-gcm", checkedKey(this.#keyRing, keyId), nonce);
      decipher.setAAD(
        additionalAuthenticatedData(header, objectKey, input.mediaType, this.#keyRing.purpose),
      );
      const digest = createHash("sha256");
      let observedBytes = 0;
      let tail = Buffer.alloc(0);
      for await (const chunk of reader.remaining()) {
        input.signal?.throwIfAborted();
        const combined = Buffer.concat([tail, chunk]);
        if (combined.byteLength <= AUTH_TAG_BYTES) {
          tail = combined;
          continue;
        }
        const ciphertext = combined.subarray(0, combined.byteLength - AUTH_TAG_BYTES);
        tail = Buffer.from(combined.subarray(combined.byteLength - AUTH_TAG_BYTES));
        const plaintext = decipher.update(ciphertext);
        observedBytes += plaintext.byteLength;
        if (observedBytes > plaintextBytes) throw new ArtifactAuthenticationError();
        digest.update(plaintext);
      }
      if (tail.byteLength !== AUTH_TAG_BYTES) throw new ArtifactAuthenticationError();
      decipher.setAuthTag(tail);
      const final = decipher.final();
      observedBytes += final.byteLength;
      digest.update(final);
      const actualDigest = digest.digest();
      const expectedDigest = Buffer.from(input.expectedPlaintextSha256, "hex");
      if (
        observedBytes !== plaintextBytes ||
        expectedDigest.byteLength !== actualDigest.byteLength ||
        !timingSafeEqual(expectedDigest, actualDigest)
      ) {
        throw new ArtifactAuthenticationError();
      }
      return {
        ciphertextBytes: raw.contentLength,
        encryptionKeyId: keyId,
        envelopeVersion: 1,
        mediaType: input.mediaType,
        objectKey,
        plaintextBytes,
        plaintextSha256: actualDigest.toString("hex"),
      };
    } catch (error) {
      raw.stream.destroy();
      if (error instanceof ArtifactAuthenticationError) throw error;
      throw new ArtifactAuthenticationError();
    }
  }

  async #openAuthenticatedEnvelope(input: {
    readonly objectKey: string;
    readonly mediaType: ExportArtifactMediaType;
    readonly expected?: EncryptedArtifactMetadata;
    readonly signal?: AbortSignal;
  }): Promise<DiscoveredAuthenticatedArtifactRead | null> {
    const { objectKey } = input;
    const raw = await this.#rawStore.open({
      objectKey,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (!raw) return null;
    if (
      !Number.isSafeInteger(raw.contentLength) ||
      raw.contentLength < ENVELOPE_MAGIC.byteLength + 1 + 1 + NONCE_BYTES + AUTH_TAG_BYTES + 1 ||
      raw.contentLength >
        ENVELOPE_MAGIC.byteLength +
          1 +
          MAX_KEY_ID_BYTES +
          NONCE_BYTES +
          AUTH_TAG_BYTES +
          this.#maxPlaintextBytes ||
      (input.expected && raw.contentLength !== input.expected.ciphertextBytes)
    ) {
      raw.stream.destroy();
      throw new ArtifactAuthenticationError();
    }
    const directory = await mkdtemp(join(this.#temporaryDirectory, "nutrition-artifact-read-"));
    await chmod(directory, 0o700);
    const path = join(directory, "artifact.plaintext");
    const output = createWriteStream(path, { flags: "wx", mode: 0o600 });
    let succeeded = false;
    try {
      const reader = new ChunkReader(raw.stream);
      const prefix = await reader.exactly(ENVELOPE_MAGIC.byteLength + 1);
      if (!prefix.subarray(0, ENVELOPE_MAGIC.byteLength).equals(ENVELOPE_MAGIC)) {
        throw new ArtifactAuthenticationError();
      }
      const keyIdLength = prefix[ENVELOPE_MAGIC.byteLength];
      if (!keyIdLength || keyIdLength > MAX_KEY_ID_BYTES) throw new ArtifactAuthenticationError();
      const keyAndNonce = await reader.exactly(keyIdLength + NONCE_BYTES);
      const keyId = keyAndNonce.subarray(0, keyIdLength).toString("ascii");
      if (
        !KEY_ID_PATTERN.test(keyId) ||
        (input.expected !== undefined && keyId !== input.expected.encryptionKeyId)
      ) {
        throw new ArtifactAuthenticationError();
      }
      const nonce = keyAndNonce.subarray(keyIdLength);
      const header = Buffer.concat([prefix, keyAndNonce]);
      const expectedPlaintextBytes = raw.contentLength - header.byteLength - AUTH_TAG_BYTES;
      if (
        expectedPlaintextBytes < 1 ||
        expectedPlaintextBytes > this.#maxPlaintextBytes ||
        (input.expected !== undefined && expectedPlaintextBytes !== input.expected.plaintextBytes)
      ) {
        throw new ArtifactAuthenticationError();
      }
      const decipher = createDecipheriv("aes-256-gcm", checkedKey(this.#keyRing, keyId), nonce);
      decipher.setAAD(
        additionalAuthenticatedData(header, objectKey, input.mediaType, this.#keyRing.purpose),
      );
      const digest = createHash("sha256");
      let plaintextBytes = 0;
      let tail = Buffer.alloc(0);
      for await (const chunk of reader.remaining()) {
        if (input.signal?.aborted) throw input.signal.reason;
        const combined = Buffer.concat([tail, chunk]);
        if (combined.byteLength <= AUTH_TAG_BYTES) {
          tail = combined;
          continue;
        }
        const ciphertext = combined.subarray(0, combined.byteLength - AUTH_TAG_BYTES);
        tail = Buffer.from(combined.subarray(combined.byteLength - AUTH_TAG_BYTES));
        const plaintext = decipher.update(ciphertext);
        plaintextBytes += plaintext.byteLength;
        if (plaintextBytes > expectedPlaintextBytes) throw new ArtifactAuthenticationError();
        digest.update(plaintext);
        await writeChunk(output, plaintext);
      }
      if (tail.byteLength !== AUTH_TAG_BYTES) throw new ArtifactAuthenticationError();
      decipher.setAuthTag(tail);
      const final = decipher.final();
      plaintextBytes += final.byteLength;
      digest.update(final);
      await writeChunk(output, final);
      await endWritable(output);
      const actualDigest = digest.digest();
      const actualDigestHex = actualDigest.toString("hex");
      if (plaintextBytes !== expectedPlaintextBytes) {
        throw new ArtifactAuthenticationError();
      }
      if (input.expected) {
        const expectedDigest = Buffer.from(input.expected.plaintextSha256, "hex");
        if (
          expectedDigest.byteLength !== actualDigest.byteLength ||
          !timingSafeEqual(expectedDigest, actualDigest)
        ) {
          throw new ArtifactAuthenticationError();
        }
      }
      succeeded = true;
      const stream = createReadStream(path);
      let disposePromise: Promise<void> | null = null;
      const dispose = async () => {
        disposePromise ??= (async () => {
          stream.destroy();
          await rm(directory, { force: true, recursive: true });
        })();
        await disposePromise;
      };
      stream.once("close", () => void dispose());
      return {
        contentLength: plaintextBytes,
        dispose,
        metadata: {
          ciphertextBytes: raw.contentLength,
          encryptionKeyId: keyId,
          envelopeVersion: 1,
          mediaType: input.mediaType,
          objectKey,
          plaintextBytes,
          plaintextSha256: actualDigestHex,
        },
        stream,
      };
    } catch (error) {
      // A writable can still be waiting for its asynchronous open when an
      // envelope is rejected. Attach a terminal listener before removing the
      // private directory so the expected open failure cannot escape cleanup.
      output.on("error", () => undefined);
      raw.stream.destroy();
      output.destroy();
      if (error instanceof ArtifactAuthenticationError) throw error;
      throw new ArtifactAuthenticationError();
    } finally {
      if (!succeeded) await rm(directory, { force: true, recursive: true });
    }
  }
}

function safeFilePath(rootDirectory: string, objectKey: string): string {
  const root = resolve(rootDirectory);
  const result = resolve(root, ...checkedObjectKey(objectKey).split("/"));
  const pathFromRoot = relative(root, result);
  if (pathFromRoot.startsWith(`..${sep}`) || pathFromRoot === ".." || pathFromRoot === "") {
    throw new TypeError("Invalid export artifact object key");
  }
  return result;
}

/** Raw filesystem storage for development. Only encrypted envelope bytes are accepted by callers. */
export class FileRawArtifactStore implements RawArtifactStore {
  readonly #rootDirectory: string;

  constructor(rootDirectory: string) {
    this.#rootDirectory = resolve(rootDirectory);
  }

  async put(input: {
    readonly objectKey: string;
    readonly source: Readable;
    readonly contentLength: number;
    readonly signal?: AbortSignal;
  }): Promise<void> {
    const path = safeFilePath(this.#rootDirectory, input.objectKey);
    await mkdir(dirname(path), { mode: 0o700, recursive: true });
    const temporaryPath = join(
      dirname(path),
      `.${basename(path)}.${randomBytes(12).toString("hex")}`,
    );
    try {
      const output = createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 });
      if (input.signal) await pipeline(input.source, output, { signal: input.signal });
      else await pipeline(input.source, output);
      const written = await stat(temporaryPath);
      if (!written.isFile() || written.size !== input.contentLength) {
        throw new ArtifactAuthenticationError();
      }
      await link(temporaryPath, path);
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }

  async open(input: {
    readonly objectKey: string;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly stream: Readable; readonly contentLength: number } | null> {
    const path = safeFilePath(this.#rootDirectory, input.objectKey);
    try {
      const details = await stat(path);
      if (!details.isFile() || !Number.isSafeInteger(details.size)) {
        throw new ArtifactAuthenticationError();
      }
      const stream = createReadStream(path, input.signal ? { signal: input.signal } : undefined);
      return { contentLength: details.size, stream };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async delete(input: { readonly objectKey: string }): Promise<void> {
    const path = safeFilePath(this.#rootDirectory, input.objectKey);
    await unlink(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
