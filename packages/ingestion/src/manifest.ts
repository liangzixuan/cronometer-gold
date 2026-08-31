import { safeArchivePath } from "./archive.js";
import { canonicalJson } from "./deterministic.js";
import { IngestionError, invariant } from "./errors.js";

export const INGESTION_PARSER_PACKAGE = "@nutrition-tracker/ingestion" as const;
export const INGESTION_PARSER_VERSION = "0.1.0" as const;

export interface FoodSourceManifestV3 {
  readonly $schema?: string;
  readonly manifestVersion: 3;
  readonly templateOnly: boolean;
  readonly source: {
    readonly code: string;
    readonly displayName: string;
    readonly kind: "commercial" | "government" | "open" | "partner";
    readonly homepageUrl: string;
    readonly accessUrl: string;
  };
  readonly release: {
    readonly releaseKey: string;
    readonly publishedOn: string | null;
    readonly acquiredAt: string | null;
    readonly upstreamSchemaVersion: string | null;
  };
  readonly artifact: {
    readonly downloadUrl: string | null;
    readonly permittedResolvedUrls: readonly string[];
    readonly objectUri: string | null;
    readonly mediaType: string;
    readonly sha256: string | null;
    readonly byteSize: number | null;
    readonly publisherIntegrity: {
      readonly publisherProvidesSha256: boolean;
      readonly sha256: string | null;
      readonly sha256EvidenceUrl: string | null;
      readonly exactByteSize: number | null;
      readonly reportedSize: string | null;
      readonly metadataUrl: string;
      readonly notes: string;
    };
    readonly acquisitionObservations: readonly {
      readonly acquisitionId: string;
      readonly observedAt: string;
      readonly operatorPrincipalId: string;
      readonly tool: string;
      readonly transport: "https";
      readonly freshDownload: true;
      readonly downloadUrl: string;
      readonly resolvedUrl: string;
      readonly etag: string | null;
      readonly lastModified: string | null;
      readonly sha256: string;
      readonly byteSize: number;
    }[];
  };
  readonly rights: {
    readonly licenseExpression: string;
    readonly licenseName: string;
    readonly licenseUrl: string;
    readonly termsUrl: string;
    readonly commercialUseAllowed: boolean | null;
    readonly redistributionAllowed: boolean | null;
    readonly licenseAttributionRequired: boolean;
    readonly productAttributionRequired: boolean;
    readonly attributionFixture: string;
    readonly databaseRightsNotes: string;
    readonly review: {
      readonly status: "approved" | "blocked" | "pending" | "restricted" | "template";
      readonly reviewedAt: string | null;
      readonly reviewedBy: string | null;
      readonly evidenceUrls: readonly string[];
      readonly notes: string;
    };
  };
  readonly ingestion: {
    readonly parserPackage: string;
    readonly parserVersion: string | null;
    readonly parserBuildSha256: string | null;
    readonly dataTypes: readonly string[];
    readonly languages: readonly string[];
    readonly markets: readonly string[];
    readonly sourceIdentityFields: readonly string[];
    readonly missingValuePolicy: "absent-is-unknown-never-zero";
  };
  readonly validation: {
    readonly rules: readonly string[];
    readonly expectedFiles: readonly string[];
    readonly releaseSpecificExpectations: Readonly<Record<string, boolean | number | string>>;
  };
}

export type ImportReadyFoodSourceManifest = FoodSourceManifestV3 & {
  readonly templateOnly: false;
  readonly release: FoodSourceManifestV3["release"] & {
    readonly acquiredAt: string;
    readonly upstreamSchemaVersion: string;
  };
  readonly artifact: FoodSourceManifestV3["artifact"] & {
    readonly downloadUrl: string;
    readonly objectUri: string;
    readonly sha256: string;
    readonly byteSize: number;
  };
  readonly ingestion: FoodSourceManifestV3["ingestion"] & {
    readonly parserVersion: string;
    readonly parserBuildSha256: string;
  };
};

const ROOT_KEYS = [
  "$schema",
  "manifestVersion",
  "templateOnly",
  "source",
  "release",
  "artifact",
  "rights",
  "ingestion",
  "validation",
] as const;

export function parseFoodSourceManifest(input: unknown): FoodSourceManifestV3 {
  const root = exactObject(
    input,
    "$",
    ROOT_KEYS,
    ROOT_KEYS.filter((key) => key !== "$schema"),
  );
  equal(root.manifestVersion, 3, "$.manifestVersion");
  boolean(root.templateOnly, "$.templateOnly");

  const source = exactObject(root.source, "$.source", [
    "code",
    "displayName",
    "kind",
    "homepageUrl",
    "accessUrl",
  ]);
  patternString(source.code, "$.source.code", /^[A-Z][A-Z0-9_]{1,31}$/);
  requiredString(source.displayName, "$.source.displayName");
  enumeration(source.kind, "$.source.kind", ["commercial", "government", "open", "partner"]);
  uri(source.homepageUrl, "$.source.homepageUrl");
  uri(source.accessUrl, "$.source.accessUrl");

  const release = exactObject(root.release, "$.release", [
    "releaseKey",
    "publishedOn",
    "acquiredAt",
    "upstreamSchemaVersion",
  ]);
  requiredString(release.releaseKey, "$.release.releaseKey");
  nullableDate(release.publishedOn, "$.release.publishedOn");
  nullableDateTime(release.acquiredAt, "$.release.acquiredAt");
  nullableString(release.upstreamSchemaVersion, "$.release.upstreamSchemaVersion");

  const artifact = exactObject(root.artifact, "$.artifact", [
    "downloadUrl",
    "permittedResolvedUrls",
    "objectUri",
    "mediaType",
    "sha256",
    "byteSize",
    "publisherIntegrity",
    "acquisitionObservations",
  ]);
  nullableUri(artifact.downloadUrl, "$.artifact.downloadUrl");
  const permittedResolvedUrls = stringArray(
    artifact.permittedResolvedUrls,
    "$.artifact.permittedResolvedUrls",
    { min: 0, urls: true },
  );
  for (const [index, permittedUrl] of permittedResolvedUrls.entries()) {
    networkArtifactUrl(permittedUrl, `$.artifact.permittedResolvedUrls[${index}]`);
  }
  if (artifact.downloadUrl !== null) {
    const canonicalDownloadUrl = networkArtifactUrl(artifact.downloadUrl, "$.artifact.downloadUrl");
    invariant(
      permittedResolvedUrls.map(canonicalNetworkUrl).includes(canonicalDownloadUrl),
      "INVALID_MANIFEST",
      "Artifact download URL must be included in permittedResolvedUrls",
    );
  }
  if (artifact.objectUri !== null) {
    patternString(artifact.objectUri, "$.artifact.objectUri", /^s3:\/\/.+/);
  }
  requiredString(artifact.mediaType, "$.artifact.mediaType");
  nullableSha256(artifact.sha256, "$.artifact.sha256");
  nullablePositiveInteger(artifact.byteSize, "$.artifact.byteSize");

  const publisher = exactObject(artifact.publisherIntegrity, "$.artifact.publisherIntegrity", [
    "publisherProvidesSha256",
    "sha256",
    "sha256EvidenceUrl",
    "exactByteSize",
    "reportedSize",
    "metadataUrl",
    "notes",
  ]);
  boolean(
    publisher.publisherProvidesSha256,
    "$.artifact.publisherIntegrity.publisherProvidesSha256",
  );
  nullableSha256(publisher.sha256, "$.artifact.publisherIntegrity.sha256");
  nullableUri(publisher.sha256EvidenceUrl, "$.artifact.publisherIntegrity.sha256EvidenceUrl");
  nullablePositiveInteger(publisher.exactByteSize, "$.artifact.publisherIntegrity.exactByteSize");
  nullableString(publisher.reportedSize, "$.artifact.publisherIntegrity.reportedSize");
  uri(publisher.metadataUrl, "$.artifact.publisherIntegrity.metadataUrl");
  plainString(publisher.notes, "$.artifact.publisherIntegrity.notes");
  if (publisher.publisherProvidesSha256) {
    invariant(
      publisher.sha256 !== null && publisher.sha256EvidenceUrl !== null,
      "INVALID_MANIFEST",
      "Publisher SHA-256 evidence is required when publisherProvidesSha256 is true",
    );
  } else {
    invariant(
      publisher.sha256 === null && publisher.sha256EvidenceUrl === null,
      "INVALID_MANIFEST",
      "Publisher SHA-256 fields must be null when the publisher does not provide one",
    );
  }

  const observations = array(
    artifact.acquisitionObservations,
    "$.artifact.acquisitionObservations",
  );
  const observationKeys = new Set<string>();
  for (const [index, candidate] of observations.entries()) {
    const path = `$.artifact.acquisitionObservations[${index}]`;
    const item = exactObject(candidate, path, [
      "acquisitionId",
      "observedAt",
      "operatorPrincipalId",
      "tool",
      "transport",
      "freshDownload",
      "downloadUrl",
      "resolvedUrl",
      "etag",
      "lastModified",
      "sha256",
      "byteSize",
    ]);
    stableIdentifier(item.acquisitionId, `${path}.acquisitionId`);
    patternString(
      item.acquisitionId,
      `${path}.acquisitionId`,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    dateTime(item.observedAt, `${path}.observedAt`);
    stableIdentifier(item.operatorPrincipalId, `${path}.operatorPrincipalId`, 3);
    requiredString(item.tool, `${path}.tool`);
    equal(item.transport, "https", `${path}.transport`);
    equal(item.freshDownload, true, `${path}.freshDownload`);
    networkArtifactUrl(item.downloadUrl, `${path}.downloadUrl`);
    networkArtifactUrl(item.resolvedUrl, `${path}.resolvedUrl`);
    nullableString(item.etag, `${path}.etag`);
    nullableDateTime(item.lastModified, `${path}.lastModified`);
    if (item.lastModified !== null) {
      invariant(
        Date.parse(item.lastModified) <= Date.parse(item.observedAt as string),
        "INVALID_MANIFEST",
        "Artifact Last-Modified cannot be later than its observation",
        { path },
      );
    }
    sha256(item.sha256, `${path}.sha256`);
    positiveInteger(item.byteSize, `${path}.byteSize`);
    const key = canonicalJson(item);
    invariant(
      !observationKeys.has(key),
      "INVALID_MANIFEST",
      "Acquisition observations must be unique",
      {
        path,
      },
    );
    observationKeys.add(key);
  }

  const rights = exactObject(root.rights, "$.rights", [
    "licenseExpression",
    "licenseName",
    "licenseUrl",
    "termsUrl",
    "commercialUseAllowed",
    "redistributionAllowed",
    "licenseAttributionRequired",
    "productAttributionRequired",
    "attributionFixture",
    "databaseRightsNotes",
    "review",
  ]);
  requiredString(rights.licenseExpression, "$.rights.licenseExpression");
  requiredString(rights.licenseName, "$.rights.licenseName");
  uri(rights.licenseUrl, "$.rights.licenseUrl");
  uri(rights.termsUrl, "$.rights.termsUrl");
  nullableBoolean(rights.commercialUseAllowed, "$.rights.commercialUseAllowed");
  nullableBoolean(rights.redistributionAllowed, "$.rights.redistributionAllowed");
  boolean(rights.licenseAttributionRequired, "$.rights.licenseAttributionRequired");
  boolean(rights.productAttributionRequired, "$.rights.productAttributionRequired");
  requiredString(rights.attributionFixture, "$.rights.attributionFixture");
  plainString(rights.databaseRightsNotes, "$.rights.databaseRightsNotes");
  const review = exactObject(rights.review, "$.rights.review", [
    "status",
    "reviewedAt",
    "reviewedBy",
    "evidenceUrls",
    "notes",
  ]);
  enumeration(review.status, "$.rights.review.status", [
    "approved",
    "blocked",
    "pending",
    "restricted",
    "template",
  ]);
  nullableDateTime(review.reviewedAt, "$.rights.review.reviewedAt");
  nullableString(review.reviewedBy, "$.rights.review.reviewedBy");
  stringArray(review.evidenceUrls, "$.rights.review.evidenceUrls", { min: 1, urls: true });
  plainString(review.notes, "$.rights.review.notes");

  const ingestion = exactObject(root.ingestion, "$.ingestion", [
    "parserPackage",
    "parserVersion",
    "parserBuildSha256",
    "dataTypes",
    "languages",
    "markets",
    "sourceIdentityFields",
    "missingValuePolicy",
  ]);
  requiredString(ingestion.parserPackage, "$.ingestion.parserPackage");
  nullableString(ingestion.parserVersion, "$.ingestion.parserVersion");
  nullableSha256(ingestion.parserBuildSha256, "$.ingestion.parserBuildSha256");
  stringArray(ingestion.dataTypes, "$.ingestion.dataTypes", { min: 1 });
  stringArray(ingestion.languages, "$.ingestion.languages", { min: 1, minLength: 2 });
  const markets = stringArray(ingestion.markets, "$.ingestion.markets", { min: 1 });
  for (const market of markets) {
    invariant(/^[A-Z0-9]{2,3}$/.test(market), "INVALID_MANIFEST", "Market code is invalid", {
      market,
    });
  }
  stringArray(ingestion.sourceIdentityFields, "$.ingestion.sourceIdentityFields", { min: 1 });
  equal(
    ingestion.missingValuePolicy,
    "absent-is-unknown-never-zero",
    "$.ingestion.missingValuePolicy",
  );

  const validation = exactObject(root.validation, "$.validation", [
    "rules",
    "expectedFiles",
    "releaseSpecificExpectations",
  ]);
  stringArray(validation.rules, "$.validation.rules", { min: 1 });
  const expectedFiles = array(validation.expectedFiles, "$.validation.expectedFiles");
  const seenExpectedFiles = new Set<string>();
  for (const [index, expectedFile] of expectedFiles.entries()) {
    requiredString(expectedFile, `$.validation.expectedFiles[${index}]`);
    invariant(
      !seenExpectedFiles.has(expectedFile),
      "INVALID_MANIFEST",
      "Manifest expected file paths must be unique",
      { expectedFile },
    );
    seenExpectedFiles.add(expectedFile);
    try {
      safeArchivePath(expectedFile, false);
    } catch (error) {
      throw new IngestionError(
        "INVALID_MANIFEST",
        "Manifest expected file path is unsafe",
        { expectedFile },
        { cause: error },
      );
    }
  }
  const expectations = exactObject(
    validation.releaseSpecificExpectations,
    "$.validation.releaseSpecificExpectations",
    Object.keys(asLooseObject(validation.releaseSpecificExpectations)),
  );
  for (const [key, value] of Object.entries(expectations)) {
    invariant(
      typeof value === "boolean" ||
        typeof value === "string" ||
        (typeof value === "number" && Number.isFinite(value)),
      "INVALID_MANIFEST",
      "Release expectation values must be finite JSON scalars",
      { key },
    );
  }

  if (review.status === "approved" || review.status === "restricted") {
    invariant(
      review.reviewedAt !== null && review.reviewedBy !== null,
      "INVALID_MANIFEST",
      "Completed rights review requires reviewer and review time",
    );
    stableIdentifier(review.reviewedBy, "$.rights.review.reviewedBy");
  }

  if (root.templateOnly === false) {
    invariant(
      release.acquiredAt !== null &&
        typeof release.upstreamSchemaVersion === "string" &&
        release.upstreamSchemaVersion.length > 0 &&
        typeof artifact.downloadUrl === "string" &&
        typeof artifact.objectUri === "string" &&
        typeof artifact.sha256 === "string" &&
        typeof artifact.byteSize === "number" &&
        typeof ingestion.parserVersion === "string" &&
        ingestion.parserVersion.length > 0 &&
        typeof ingestion.parserBuildSha256 === "string",
      "INVALID_MANIFEST",
      "Non-template manifest is missing pinned release or artifact fields",
    );
    validateObservationConsensus(artifact, observations);
    const acquiredTime = Date.parse(release.acquiredAt as string);
    for (const candidate of observations) {
      const observedTime = Date.parse((candidate as Record<string, unknown>).observedAt as string);
      invariant(
        observedTime <= acquiredTime,
        "INVALID_MANIFEST",
        "Acquisition observation occurs after the final release acquisition time",
      );
    }
    if (release.publishedOn !== null) {
      invariant(
        Date.parse(`${release.publishedOn}T00:00:00.000Z`) <= acquiredTime,
        "INVALID_MANIFEST",
        "Release acquisition time predates its publication date",
      );
    }
    if (publisher.sha256 !== null) {
      invariant(
        publisher.sha256 === artifact.sha256,
        "INVALID_MANIFEST",
        "Publisher SHA-256 does not match the canonical artifact SHA-256",
      );
    }
    if (publisher.exactByteSize !== null) {
      invariant(
        publisher.exactByteSize === artifact.byteSize,
        "INVALID_MANIFEST",
        "Publisher byte size does not match the canonical artifact byte size",
      );
    }
  }
  return deepFreeze(structuredClone(input)) as FoodSourceManifestV3;
}

export function assertImportReadyManifest(
  manifest: FoodSourceManifestV3,
): asserts manifest is ImportReadyFoodSourceManifest {
  invariant(!manifest.templateOnly, "INVALID_MANIFEST", "Template manifest cannot be imported");
  invariant(
    manifest.rights.review.status === "approved" || manifest.rights.review.status === "restricted",
    "INVALID_MANIFEST",
    "Manifest does not have a completed rights review",
  );
  assertManifestParserIdentity(manifest);
  invariant(
    manifest.rights.commercialUseAllowed === true,
    "INVALID_MANIFEST",
    "Manifest does not explicitly permit commercial use",
  );
  invariant(
    manifest.artifact.downloadUrl !== null &&
      manifest.artifact.objectUri !== null &&
      manifest.artifact.sha256 !== null &&
      manifest.artifact.byteSize !== null &&
      manifest.ingestion.parserVersion !== null &&
      manifest.ingestion.parserBuildSha256 !== null,
    "INVALID_MANIFEST",
    "Manifest artifact or parser is not pinned",
  );
  assertContentAddressedObjectUri(manifest.artifact.objectUri, manifest.artifact.sha256);
  invariant(
    manifest.validation.expectedFiles.length > 0 &&
      Object.keys(manifest.validation.releaseSpecificExpectations).length > 0,
    "INVALID_MANIFEST",
    "Import-ready manifest requires expected files and release-specific expectations",
  );
}

function assertContentAddressedObjectUri(objectUri: string, sha256: string): void {
  const url = new URL(objectUri);
  const pathSegments = url.pathname.split("/").filter(Boolean);
  const digestIsBound = pathSegments.some(
    (segment, index) => segment === "sha256" && pathSegments[index + 1] === sha256,
  );
  invariant(
    url.protocol === "s3:" &&
      url.hostname.length > 0 &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      digestIsBound,
    "INVALID_MANIFEST",
    "Artifact objectUri must be a credential-free content-addressed S3 URI",
  );
}

export function assertManifestParserIdentity(manifest: FoodSourceManifestV3): void {
  invariant(
    manifest.ingestion.parserPackage === INGESTION_PARSER_PACKAGE &&
      manifest.ingestion.parserVersion === INGESTION_PARSER_VERSION,
    "INVALID_MANIFEST",
    "Manifest parser identity does not match the executing ingestion package",
    {
      expectedPackage: INGESTION_PARSER_PACKAGE,
      expectedVersion: INGESTION_PARSER_VERSION,
      actualPackage: manifest.ingestion.parserPackage,
      actualVersion: manifest.ingestion.parserVersion,
    },
  );
}

export function importReadyManifest(input: unknown): ImportReadyFoodSourceManifest {
  const manifest = parseFoodSourceManifest(input);
  assertImportReadyManifest(manifest);
  return manifest;
}

function validateObservationConsensus(
  artifact: Readonly<Record<string, unknown>>,
  observations: readonly unknown[],
): void {
  invariant(
    observations.length >= 2,
    "INVALID_MANIFEST",
    "Pinned artifact requires two observations",
  );
  const observers = new Set<string>();
  const acquisitionIds = new Set<string>();
  const canonicalDownload = canonicalNetworkUrl(artifact.downloadUrl as string);
  const permittedResolvedUrls = new Set(
    (artifact.permittedResolvedUrls as readonly string[]).map(canonicalNetworkUrl),
  );
  for (const candidate of observations) {
    const item = candidate as Record<string, unknown>;
    const principal = (item.operatorPrincipalId as string).normalize("NFKC").trim().toLowerCase();
    const acquisitionId = item.acquisitionId as string;
    invariant(
      !observers.has(principal),
      "INVALID_MANIFEST",
      "Observation operators must be distinct",
      {
        principal,
      },
    );
    invariant(
      !acquisitionIds.has(acquisitionId),
      "INVALID_MANIFEST",
      "Observation acquisition IDs must be distinct",
      { acquisitionId },
    );
    observers.add(principal);
    acquisitionIds.add(acquisitionId);
    const resolved = canonicalNetworkUrl(item.resolvedUrl as string);
    invariant(
      item.sha256 === artifact.sha256 &&
        item.byteSize === artifact.byteSize &&
        canonicalNetworkUrl(item.downloadUrl as string) === canonicalDownload &&
        item.transport === "https" &&
        item.freshDownload === true &&
        permittedResolvedUrls.has(resolved),
      "INVALID_MANIFEST",
      "Acquisition observation does not match the canonical artifact",
      { principal },
    );
  }
}

function networkArtifactUrl(value: unknown, path: string): string {
  uri(value, path);
  const url = new URL(value as string);
  invariant(
    url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "",
    "INVALID_MANIFEST",
    `${path} must be a credential-free HTTPS URL without a query or fragment`,
    { path },
  );
  return url.href;
}

function canonicalNetworkUrl(value: string): string {
  return new URL(value).href;
}

function exactObject(
  value: unknown,
  path: string,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[] = allowedKeys,
): Readonly<Record<string, unknown>> {
  const record = asLooseObject(value, path);
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(record)) {
    invariant(allowed.has(key), "INVALID_MANIFEST", `Unexpected manifest field ${path}.${key}`, {
      path: `${path}.${key}`,
    });
  }
  for (const key of requiredKeys) {
    invariant(
      Object.hasOwn(record, key),
      "INVALID_MANIFEST",
      `Missing manifest field ${path}.${key}`,
      {
        path: `${path}.${key}`,
      },
    );
  }
  return record;
}

function asLooseObject(value: unknown, path = "$value"): Readonly<Record<string, unknown>> {
  invariant(
    typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null),
    "INVALID_MANIFEST",
    `${path} must be an object`,
    { path },
  );
  return value as Readonly<Record<string, unknown>>;
}

function array(value: unknown, path: string): readonly unknown[] {
  invariant(Array.isArray(value), "INVALID_MANIFEST", `${path} must be an array`, { path });
  return value;
}

function stringArray(
  value: unknown,
  path: string,
  options: { readonly min: number; readonly minLength?: number; readonly urls?: boolean },
): readonly string[] {
  const values = array(value, path);
  invariant(values.length >= options.min, "INVALID_MANIFEST", `${path} has too few entries`, {
    path,
  });
  const seen = new Set<string>();
  for (const [index, item] of values.entries()) {
    requiredString(item, `${path}[${index}]`, options.minLength);
    const text = item as string;
    if (options.urls) {
      uri(text, `${path}[${index}]`);
    }
    invariant(!seen.has(text), "INVALID_MANIFEST", `${path} must contain unique values`, { path });
    seen.add(text);
  }
  return values as readonly string[];
}

function requiredString(value: unknown, path: string, minLength = 1): asserts value is string {
  invariant(
    typeof value === "string" && value === value.trim() && value.length >= minLength,
    "INVALID_MANIFEST",
    `${path} must be a non-empty string without surrounding whitespace`,
    { path },
  );
}

function plainString(value: unknown, path: string): asserts value is string {
  invariant(typeof value === "string", "INVALID_MANIFEST", `${path} must be a string`, { path });
}

function nullableString(value: unknown, path: string): asserts value is string | null {
  invariant(
    value === null || (typeof value === "string" && value === value.trim()),
    "INVALID_MANIFEST",
    `${path} is invalid or has surrounding whitespace`,
    { path },
  );
}

function boolean(value: unknown, path: string): asserts value is boolean {
  invariant(typeof value === "boolean", "INVALID_MANIFEST", `${path} must be boolean`, { path });
}

function nullableBoolean(value: unknown, path: string): asserts value is boolean | null {
  invariant(
    value === null || typeof value === "boolean",
    "INVALID_MANIFEST",
    `${path} is invalid`,
    {
      path,
    },
  );
}

function positiveInteger(value: unknown, path: string): asserts value is number {
  invariant(
    Number.isSafeInteger(value) && (value as number) > 0,
    "INVALID_MANIFEST",
    `${path} must be a positive safe integer`,
    { path },
  );
}

function nullablePositiveInteger(value: unknown, path: string): asserts value is number | null {
  if (value !== null) {
    positiveInteger(value, path);
  }
}

function sha256(value: unknown, path: string): asserts value is string {
  patternString(value, path, /^[0-9a-f]{64}$/);
}

function nullableSha256(value: unknown, path: string): asserts value is string | null {
  if (value !== null) {
    sha256(value, path);
  }
}

function patternString(value: unknown, path: string, pattern: RegExp): asserts value is string {
  invariant(
    typeof value === "string" && pattern.test(value),
    "INVALID_MANIFEST",
    `${path} has an invalid format`,
    { path },
  );
}

function enumeration<T extends string>(
  value: unknown,
  path: string,
  choices: readonly T[],
): asserts value is T {
  invariant(
    typeof value === "string" && choices.includes(value as T),
    "INVALID_MANIFEST",
    `${path} is not an allowed value`,
    { path },
  );
}

function equal<T>(value: unknown, expected: T, path: string): asserts value is T {
  invariant(value === expected, "INVALID_MANIFEST", `${path} must equal ${String(expected)}`, {
    path,
  });
}

function uri(value: unknown, path: string): asserts value is string {
  requiredString(value, path);
  try {
    new URL(value);
  } catch (error) {
    throw new IngestionError(
      "INVALID_MANIFEST",
      `${path} must be an absolute URI`,
      { path },
      {
        cause: error,
      },
    );
  }
}

function nullableUri(value: unknown, path: string): asserts value is string | null {
  if (value !== null) {
    uri(value, path);
  }
}

function nullableDate(value: unknown, path: string): asserts value is string | null {
  if (value === null) {
    return;
  }
  patternString(value, path, /^\d{4}-\d{2}-\d{2}$/);
  const date = new Date(`${value}T00:00:00.000Z`);
  invariant(
    !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value,
    "INVALID_MANIFEST",
    `${path} is not a real calendar date`,
    { path },
  );
}

function dateTime(value: unknown, path: string): asserts value is string {
  requiredString(value, path);
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  invariant(
    match !== null && !Number.isNaN(Date.parse(value)),
    "INVALID_MANIFEST",
    `${path} must be a strict RFC3339 date-time`,
    { path },
  );
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  invariant(
    year >= 1 &&
      month >= 1 &&
      month <= 12 &&
      day >= 1 &&
      day <= daysInMonth &&
      hour <= 23 &&
      minute <= 59 &&
      second <= 59,
    "INVALID_MANIFEST",
    `${path} is not a real calendar instant`,
    { path },
  );
  if (match[7] !== "Z") {
    const [offsetHours = 99, offsetMinutes = 99] = match[7]?.slice(1).split(":").map(Number) ?? [];
    invariant(
      offsetHours <= 14 && offsetMinutes <= 59 && !(offsetHours === 14 && offsetMinutes !== 0),
      "INVALID_MANIFEST",
      `${path} has an invalid RFC3339 offset`,
      { path },
    );
  }
}

function nullableDateTime(value: unknown, path: string): asserts value is string | null {
  if (value !== null) {
    dateTime(value, path);
  }
}

function stableIdentifier(value: unknown, path: string, minLength = 1): asserts value is string {
  requiredString(value, path, minLength);
  invariant(
    value.normalize("NFKC") === value && /^[A-Za-z0-9][A-Za-z0-9@._:+/-]{0,254}$/.test(value),
    "INVALID_MANIFEST",
    `${path} must be a normalized stable identifier`,
    { path },
  );
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}
