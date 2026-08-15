import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { createReadStream } from "node:fs";
import { link, mkdir, open, realpath, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { abortError, IngestionError, invariant } from "./errors.js";

export interface ArtifactExpectation {
  /** Independently pinned expectation, not a hash learned from this call. */
  readonly sha256: string;
  readonly byteSize: number;
  readonly provenance: string;
}

export type ArtifactVerificationRequest =
  | { readonly mode: "observe-only" }
  | { readonly mode: "verified"; readonly expected: ArtifactExpectation };

export interface AcquireArtifactOptions {
  readonly source: string | URL;
  readonly cacheDirectory: string;
  readonly verification: ArtifactVerificationRequest;
  readonly operatorPrincipalId: string;
  readonly tool: string;
  readonly freshness?: "allow-cache" | "require-fresh-network";
  readonly sourceMode?: "local-test" | "release";
  readonly signal?: AbortSignal;
  readonly maxBytes?: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly remotePolicy?: {
    readonly allowedSources: readonly {
      readonly host: string;
      readonly pathExact?: string;
      readonly pathPrefix?: string;
    }[];
    readonly allowInsecureHttpForTesting?: boolean;
    readonly allowPrivateNetworkForTesting?: boolean;
  };
  readonly now?: () => Date;
}

export interface ArtifactAcquisitionObservation {
  readonly acquisitionId: string;
  readonly observedAt: string;
  readonly operatorPrincipalId: string;
  readonly tool: string;
  readonly transport: "cache" | "file" | "http" | "https";
  readonly freshDownload: boolean;
  readonly downloadUrl: string;
  readonly resolvedUrl: string;
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly sha256: string;
  readonly byteSize: number;
}

export type ArtifactVerification =
  | { readonly status: "unverified-observation" }
  | {
      readonly status: "verified-against-expectation";
      readonly expectedSha256: string;
      readonly expectedByteSize: number;
      readonly expectationProvenance: string;
    };

export interface AcquiredArtifact {
  readonly path: string;
  readonly cacheHit: boolean;
  readonly observation: ArtifactAcquisitionObservation;
  readonly verification: ArtifactVerification;
}

interface OpenArtifact {
  readonly chunks: AsyncIterable<Uint8Array>;
  readonly sourceLocator: string;
  readonly resolvedLocator: string;
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly transport: "file" | "http" | "https";
}

export async function acquireArtifact(options: AcquireArtifactOptions): Promise<AcquiredArtifact> {
  const operatorPrincipalId = requiredPrincipal(options.operatorPrincipalId);
  const tool = requiredLabel(options.tool, "tool");
  const maxBytes = options.maxBytes ?? 20_000_000_000;
  invariant(
    Number.isSafeInteger(maxBytes) && maxBytes > 0,
    "INVALID_ARTIFACT",
    "maxBytes must be a positive safe integer",
  );
  validateVerification(options.verification, maxBytes);
  throwIfAborted(options.signal);

  const cacheDirectory = resolve(options.cacheDirectory);
  const temporaryDirectory = join(cacheDirectory, ".tmp");
  await mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });

  if (options.verification.mode === "verified" && options.freshness !== "require-fresh-network") {
    const existingPath = cachePath(cacheDirectory, options.verification.expected.sha256);
    const existing = await verifyExistingCache(
      existingPath,
      options.verification.expected,
      options.signal,
    );
    if (existing) {
      return freezeResult({
        path: existingPath,
        cacheHit: true,
        observation: observation({
          options,
          operatorPrincipalId,
          tool,
          transport: "cache",
          freshDownload: false,
          downloadUrl: redactUrl(sourceLocator(options.source)),
          resolvedUrl: pathToFileURL(existingPath).href,
          sha256: existing.sha256,
          byteSize: existing.byteSize,
          etag: null,
          lastModified: null,
        }),
        verification: verifiedResult(options.verification.expected),
      });
    }
  }

  const temporaryPath = join(temporaryDirectory, `${randomUUID()}.partial`);
  let temporaryExists = false;
  try {
    const artifact = await openArtifactSource(options);
    invariant(
      options.freshness !== "require-fresh-network" || artifact.transport === "https",
      "UNSUPPORTED_SOURCE",
      "Independent release observations require a fresh HTTPS network acquisition",
    );
    const handle = await open(temporaryPath, "wx", 0o600);
    temporaryExists = true;
    const hash = createHash("sha256");
    let byteSize = 0;
    try {
      for await (const rawChunk of artifact.chunks) {
        throwIfAborted(options.signal);
        const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
        byteSize += chunk.byteLength;
        const allowedBytes =
          options.verification.mode === "verified"
            ? Math.min(maxBytes, options.verification.expected.byteSize)
            : maxBytes;
        invariant(
          Number.isSafeInteger(byteSize) && byteSize <= allowedBytes,
          "INVALID_ARTIFACT",
          "Artifact exceeds its allowed byte size",
          { byteSize, allowedBytes },
        );
        hash.update(chunk);
        await writeAll(handle, chunk);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    throwIfAborted(options.signal);
    const sha256 = hash.digest("hex");

    let verification: ArtifactVerification;
    if (options.verification.mode === "verified") {
      const expected = options.verification.expected;
      if (sha256 !== expected.sha256 || byteSize !== expected.byteSize) {
        throw new IngestionError(
          "CHECKSUM_MISMATCH",
          "Artifact does not match its pinned expectation",
          {
            expectedSha256: expected.sha256,
            observedSha256: sha256,
            expectedByteSize: expected.byteSize,
            observedByteSize: byteSize,
          },
        );
      }
      verification = verifiedResult(expected);
    } else {
      verification = Object.freeze({ status: "unverified-observation" });
    }

    const finalPath = cachePath(cacheDirectory, sha256);
    await mkdir(dirname(finalPath), { recursive: true, mode: 0o700 });
    try {
      // A hard link is an atomic no-replace promotion on the same filesystem.
      await link(temporaryPath, finalPath);
    } catch (error) {
      if (!isAlreadyExists(error)) {
        throw error;
      }
      const expected = { sha256, byteSize, provenance: "concurrent acquisition" };
      const winner = await verifyExistingCache(finalPath, expected, options.signal);
      invariant(winner, "INVALID_ARTIFACT", "Concurrent cache promotion produced no artifact");
    }
    await unlink(temporaryPath);
    temporaryExists = false;
    return freezeResult({
      path: finalPath,
      cacheHit: false,
      observation: observation({
        options,
        operatorPrincipalId,
        tool,
        transport: artifact.transport,
        freshDownload: true,
        downloadUrl: redactUrl(artifact.sourceLocator),
        resolvedUrl: redactUrl(artifact.resolvedLocator),
        sha256,
        byteSize,
        etag: artifact.etag,
        lastModified: artifact.lastModified,
      }),
      verification,
    });
  } catch (error) {
    if (options.signal?.aborted && !(error instanceof IngestionError && error.code === "ABORTED")) {
      throw abortError(options.signal);
    }
    throw error;
  } finally {
    if (temporaryExists) {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
}

async function openArtifactSource(options: AcquireArtifactOptions): Promise<OpenArtifact> {
  const locator = sourceLocator(options.source);
  let url: URL | null = null;
  try {
    url = options.source instanceof URL ? options.source : new URL(options.source);
  } catch {
    // A non-URL string is a local path.
  }
  if (url?.protocol === "http:" || url?.protocol === "https:") {
    const { response, resolvedUrl } = await fetchRemote(url, options);
    if (!response.ok || response.body === null) {
      throw new IngestionError(
        "HTTP_ERROR",
        `Artifact request failed with HTTP ${response.status}`,
        {
          status: response.status,
          url: redactUrl(resolvedUrl.href),
        },
      );
    }
    const contentEncoding = response.headers.get("content-encoding");
    invariant(
      contentEncoding === null || contentEncoding.toLowerCase() === "identity",
      "INVALID_ARTIFACT",
      "Server applied content encoding; byte identity cannot be verified safely",
      { contentEncoding },
    );
    return {
      chunks: response.body as unknown as AsyncIterable<Uint8Array>,
      sourceLocator: url.href,
      resolvedLocator: resolvedUrl.href,
      etag: response.headers.get("etag"),
      lastModified: normalizeHttpDate(response.headers.get("last-modified")),
      transport: resolvedUrl.protocol === "https:" ? "https" : "http",
    };
  }
  invariant(
    url === null || url.protocol === "file:",
    "UNSUPPORTED_SOURCE",
    "Artifact source must be a local path, file URL, or HTTP(S) URL",
    { source: locator },
  );
  invariant(
    options.sourceMode === "local-test",
    "UNSUPPORTED_SOURCE",
    "Local and file artifact sources require explicit local-test mode",
  );
  const localPath = url ? fileURLToPath(url) : resolve(String(options.source));
  const resolvedPath = await realpath(localPath);
  const metadata = await stat(resolvedPath);
  invariant(metadata.isFile(), "INVALID_ARTIFACT", "Local artifact source is not a regular file", {
    path: resolvedPath,
  });
  return {
    chunks: createReadStream(resolvedPath),
    sourceLocator: locator,
    resolvedLocator: pathToFileURL(resolvedPath).href,
    etag: null,
    lastModified: metadata.mtime.toISOString(),
    transport: "file",
  };
}

async function fetchRemote(
  initialUrl: URL,
  options: AcquireArtifactOptions,
): Promise<{ readonly response: Response; readonly resolvedUrl: URL }> {
  const policy = options.remotePolicy;
  invariant(
    policy,
    "UNSUPPORTED_SOURCE",
    "HTTP(S) acquisition requires an explicit remote allowlist",
  );
  invariant(
    policy.allowedSources.length > 0,
    "UNSUPPORTED_SOURCE",
    "Remote allowlist cannot be empty",
  );
  if (
    options.fetch !== undefined ||
    policy.allowInsecureHttpForTesting === true ||
    policy.allowPrivateNetworkForTesting === true
  ) {
    invariant(
      options.sourceMode === "local-test",
      "UNSUPPORTED_SOURCE",
      "Custom fetch and insecure/private network allowances require local-test mode",
    );
  }
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  let current = new URL(initialUrl.href);
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    await validateRemoteUrl(current, policy);
    const response = await fetchImplementation(current, {
      headers: { "accept-encoding": "identity" },
      redirect: "manual",
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return { response, resolvedUrl: current };
    }
    const location = response.headers.get("location");
    invariant(location, "HTTP_ERROR", "Artifact redirect is missing Location", {
      status: response.status,
    });
    invariant(redirects < 5, "HTTP_ERROR", "Artifact request exceeded the redirect limit");
    const redirected = new URL(location, current);
    invariant(
      !(current.protocol === "https:" && redirected.protocol === "http:"),
      "UNSUPPORTED_SOURCE",
      "HTTPS artifact redirects cannot downgrade to HTTP",
    );
    current = redirected;
  }
  throw new IngestionError("HTTP_ERROR", "Artifact request exceeded the redirect limit");
}

async function validateRemoteUrl(
  url: URL,
  policy: NonNullable<AcquireArtifactOptions["remotePolicy"]>,
): Promise<void> {
  invariant(
    url.username === "" && url.password === "",
    "UNSUPPORTED_SOURCE",
    "Artifact URL credentials are not allowed",
  );
  invariant(
    url.protocol === "https:" ||
      (url.protocol === "http:" && policy.allowInsecureHttpForTesting === true),
    "UNSUPPORTED_SOURCE",
    "Release artifact transport must use HTTPS",
    { protocol: url.protocol },
  );
  const allowed = policy.allowedSources.some((source) => {
    const pathMatches = source.pathExact
      ? source.pathExact.startsWith("/") && url.pathname === source.pathExact
      : source.pathPrefix
        ? source.pathPrefix.startsWith("/") && url.pathname.startsWith(source.pathPrefix)
        : false;
    return source.host.toLowerCase() === url.host.toLowerCase() && pathMatches;
  });
  invariant(allowed, "UNSUPPORTED_SOURCE", "Artifact URL is outside its source allowlist", {
    host: url.host,
    path: url.pathname,
  });
  if (!policy.allowPrivateNetworkForTesting) {
    invariant(
      url.hostname.toLowerCase() !== "localhost" && !url.hostname.toLowerCase().endsWith(".local"),
      "UNSUPPORTED_SOURCE",
      "Local artifact network targets are not allowed",
    );
    const addresses = await lookup(url.hostname, { all: true, verbatim: true });
    invariant(addresses.length > 0, "UNSUPPORTED_SOURCE", "Artifact hostname did not resolve");
    for (const address of addresses) {
      invariant(
        isPublicAddress(address.address),
        "UNSUPPORTED_SOURCE",
        "Artifact hostname resolves to a private or link-local address",
        { address: address.address },
      );
    }
  }
}

async function verifyExistingCache(
  path: string,
  expected: ArtifactExpectation,
  signal?: AbortSignal,
): Promise<{ readonly sha256: string; readonly byteSize: number } | null> {
  let metadata: Awaited<ReturnType<typeof stat>>;
  try {
    metadata = await stat(path);
  } catch (error) {
    if (isNotFound(error)) {
      return null;
    }
    throw error;
  }
  invariant(metadata.isFile(), "INVALID_ARTIFACT", "Cache object is not a regular file", { path });
  const hash = createHash("sha256");
  let byteSize = 0;
  for await (const chunk of createReadStream(path)) {
    throwIfAborted(signal);
    byteSize += chunk.byteLength;
    hash.update(chunk);
  }
  const sha256 = hash.digest("hex");
  if (sha256 !== expected.sha256 || byteSize !== expected.byteSize) {
    throw new IngestionError("CHECKSUM_MISMATCH", "Cached artifact failed integrity verification", {
      path,
      expectedSha256: expected.sha256,
      observedSha256: sha256,
      expectedByteSize: expected.byteSize,
      observedByteSize: byteSize,
    });
  }
  return Object.freeze({ sha256, byteSize });
}

function validateVerification(verification: ArtifactVerificationRequest, maxBytes: number): void {
  if (verification.mode === "observe-only") {
    return;
  }
  invariant(
    /^[0-9a-f]{64}$/.test(verification.expected.sha256),
    "INVALID_ARTIFACT",
    "Expected SHA-256 must be 64 lowercase hexadecimal characters",
  );
  invariant(
    Number.isSafeInteger(verification.expected.byteSize) &&
      verification.expected.byteSize > 0 &&
      verification.expected.byteSize <= maxBytes,
    "INVALID_ARTIFACT",
    "Expected byte size is invalid or exceeds maxBytes",
  );
  requiredLabel(verification.expected.provenance, "expectation provenance");
}

function cachePath(cacheDirectory: string, sha256: string): string {
  return join(cacheDirectory, "sha256", sha256.slice(0, 2), sha256);
}

function sourceLocator(source: string | URL): string {
  if (source instanceof URL) {
    return source.href;
  }
  try {
    return new URL(source).href;
  } catch {
    return pathToFileURL(resolve(source)).href;
  }
}

function observation(input: {
  readonly options: AcquireArtifactOptions;
  readonly operatorPrincipalId: string;
  readonly tool: string;
  readonly transport: "cache" | "file" | "http" | "https";
  readonly freshDownload: boolean;
  readonly downloadUrl: string;
  readonly resolvedUrl: string;
  readonly sha256: string;
  readonly byteSize: number;
  readonly etag: string | null;
  readonly lastModified: string | null;
}): ArtifactAcquisitionObservation {
  const observedAt = (input.options.now?.() ?? new Date()).toISOString();
  return Object.freeze({
    acquisitionId: randomUUID(),
    observedAt,
    operatorPrincipalId: input.operatorPrincipalId,
    tool: input.tool,
    transport: input.transport,
    freshDownload: input.freshDownload,
    downloadUrl: input.downloadUrl,
    resolvedUrl: input.resolvedUrl,
    etag: input.etag,
    lastModified: input.lastModified,
    sha256: input.sha256,
    byteSize: input.byteSize,
  });
}

function verifiedResult(expected: ArtifactExpectation): ArtifactVerification {
  return Object.freeze({
    status: "verified-against-expectation",
    expectedSha256: expected.sha256,
    expectedByteSize: expected.byteSize,
    expectationProvenance: expected.provenance,
  });
}

function freezeResult(result: AcquiredArtifact): AcquiredArtifact {
  return Object.freeze(result);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw abortError(signal);
  }
}

function requiredLabel(value: string, field: string): string {
  const normalized = value.trim();
  invariant(
    normalized === value && normalized.length > 0 && normalized.length <= 256,
    "INVALID_ARTIFACT",
    `${field} is required and cannot have surrounding whitespace`,
  );
  return normalized;
}

function requiredPrincipal(value: string): string {
  const normalized = requiredLabel(value.normalize("NFC"), "operatorPrincipalId");
  invariant(
    /^[A-Za-z0-9][A-Za-z0-9@._:/-]{0,254}$/.test(normalized),
    "INVALID_ARTIFACT",
    "operatorPrincipalId must be a stable principal identifier",
  );
  return normalized;
}

function redactUrl(locator: string): string {
  const url = new URL(locator);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.href;
}

function isPublicAddress(address: string): boolean {
  const lower = address.toLowerCase();
  if (lower.includes(":")) {
    if (
      lower === "::" ||
      lower === "::1" ||
      lower.startsWith("fc") ||
      lower.startsWith("fd") ||
      /^fe[89ab]/.test(lower)
    ) {
      return false;
    }
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    return mapped?.[1] ? isPublicAddress(mapped[1]) : true;
  }
  const octets = address.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)
  ) {
    return false;
  }
  const [first = 0, second = 0] = octets;
  return !(
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    first >= 224
  );
}

function normalizeHttpDate(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const parsed = Date.parse(value);
  invariant(!Number.isNaN(parsed), "INVALID_ARTIFACT", "HTTP Last-Modified is not a valid date");
  return new Date(parsed).toISOString();
}

async function writeAll(
  handle: Awaited<ReturnType<typeof open>>,
  chunk: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const result = await handle.write(chunk, offset, chunk.byteLength - offset, null);
    invariant(result.bytesWritten > 0, "INVALID_ARTIFACT", "Artifact cache write made no progress");
    offset += result.bytesWritten;
  }
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export function artifactCacheBasename(result: AcquiredArtifact): string {
  return basename(result.path);
}
