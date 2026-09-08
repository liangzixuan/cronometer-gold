import { createHash } from "node:crypto";

import {
  type CreateDiaryEntryHeaders,
  type CreateDiaryEntryQuery,
  type CreateDiaryEntryRequest,
  createDiaryEntryHeadersSchema,
  createDiaryEntryQuerySchema,
  createDiaryEntryRequestSchema,
  type DiaryCorrectionMutationResponse,
  type DiaryDay,
  type DiaryDayResponse,
  type DiaryEntry,
  type DiaryMutationResponse,
  type DiaryNutrientAggregate,
  diaryCorrectionMutationResponseSchema,
  diaryDayOrderDigestPayload,
  diaryDayResponseSchema,
  diaryMutationResponseSchema,
  MAX_DIARY_NOTE_INPUT_CODE_POINTS,
  MAX_NUTRIENT_AGGREGATE_OUTPUT_LENGTH,
  type ProfileTimeZonePreconditionHeaders,
  problemDetailsSchema,
  type ReorderDiaryDayHeaders,
  type ReorderDiaryDayRequest,
  type ReorderDiaryDayResponse,
  type RepeatDiaryEntryRequest,
  reorderDiaryDayHeadersSchema,
  reorderDiaryDayRequestSchema,
  reorderDiaryDayResponseSchema,
  repeatDiaryEntryRequestSchema,
  type UpdateDiaryEntryRequest,
  updateDiaryEntryRequestSchema,
} from "@nutrition-tracker/contracts";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";

import { authenticatedPrincipal, requireAuthentication } from "../../http/authentication.js";
import { requireIdempotencyKey, requireRevision, revisionEtag } from "../../http/preconditions.js";
import { HttpProblem } from "../../http/problem.js";
import {
  expectedProfileTimeZone,
  rejectUnpairedProfileTimeZonePrecondition,
} from "../../http/profile-time-zone-precondition.js";
import {
  rejectUnexpectedBodyKeys,
  rejectUnexpectedQueryKeys,
} from "../../http/request-validation.js";
import type { AuthService } from "../auth/auth-service.js";

export interface DiaryService {
  getDay(input: {
    readonly userId: string;
    readonly localDate: string;
    readonly signal?: AbortSignal;
  }): Promise<DiaryDay>;
  getDayPage?(input: {
    readonly userId: string;
    readonly localDate: string;
    readonly limit: number;
    readonly cursor?: string;
    readonly signal?: AbortSignal;
  }): Promise<DiaryDayResponse>;
  createEntry(input: {
    readonly userId: string;
    readonly clientOperationId: string;
    readonly requestDigest: string;
    readonly expectedProfileTimeZone?: string;
    readonly entry: CreateDiaryEntryRequest;
    readonly signal?: AbortSignal;
  }): Promise<DiaryMutationResponse>;
  updateEntry(input: {
    readonly userId: string;
    readonly entryId: string;
    readonly expectedRevision: string;
    readonly clientOperationId: string;
    readonly requestDigest: string;
    readonly patch: UpdateDiaryEntryRequest;
    readonly signal?: AbortSignal;
  }): Promise<DiaryMutationResponse>;
  updateEntryCorrection?(input: {
    readonly userId: string;
    readonly entryId: string;
    readonly expectedRevision: string;
    readonly clientOperationId: string;
    readonly requestDigest: string;
    readonly expectedProfileTimeZone?: string;
    readonly patch: UpdateDiaryEntryRequest;
    readonly signal?: AbortSignal;
  }): Promise<DiaryCorrectionMutationResponse>;
  deleteEntry(input: {
    readonly userId: string;
    readonly entryId: string;
    readonly expectedRevision: string;
    readonly clientOperationId: string;
    readonly requestDigest: string;
    readonly signal?: AbortSignal;
  }): Promise<DiaryMutationResponse>;
  deleteEntryCorrection?(input: {
    readonly userId: string;
    readonly entryId: string;
    readonly expectedRevision: string;
    readonly clientOperationId: string;
    readonly requestDigest: string;
    readonly signal?: AbortSignal;
  }): Promise<DiaryCorrectionMutationResponse>;
  repeatEntryCorrection?(input: {
    readonly userId: string;
    readonly sourceEntryId: string;
    readonly expectedSourceRevision: string;
    readonly clientOperationId: string;
    readonly requestDigest: string;
    readonly expectedProfileTimeZone: string;
    readonly request: RepeatDiaryEntryRequest;
    readonly signal?: AbortSignal;
  }): Promise<DiaryCorrectionMutationResponse>;
  reorderDay?(input: {
    readonly userId: string;
    readonly localDate: string;
    readonly expectedDayRevision: string;
    readonly expectedOrderDigest: string;
    readonly expectedProfileTimeZone: string;
    readonly clientOperationId: string;
    readonly requestDigest: string;
    readonly groups: ReorderDiaryDayRequest["groups"];
    readonly signal?: AbortSignal;
  }): Promise<ReorderDiaryDayResponse>;
}

export interface DiaryRoutesOptions {
  readonly authService?: AuthService;
  readonly diaryService?: DiaryService;
}

export class DiaryNotFoundServiceError extends Error {
  constructor() {
    super("Diary entry not found");
    this.name = "DiaryNotFoundServiceError";
  }
}

export class DiaryRevisionConflictServiceError extends Error {
  constructor() {
    super("Diary entry revision conflict");
    this.name = "DiaryRevisionConflictServiceError";
  }
}

export class DiaryIdempotencyConflictServiceError extends Error {
  constructor() {
    super("Diary idempotency conflict");
    this.name = "DiaryIdempotencyConflictServiceError";
  }
}

export class DiaryTimeZoneChangedServiceError extends Error {
  constructor() {
    super("Diary profile time zone changed");
    this.name = "DiaryTimeZoneChangedServiceError";
  }
}

export class DiaryValidationServiceError extends Error {
  constructor() {
    super("Diary validation failed");
    this.name = "DiaryValidationServiceError";
  }
}

export class DiaryLockedServiceError extends Error {
  constructor() {
    super("Diary day is locked");
    this.name = "DiaryLockedServiceError";
  }
}

export class DiaryPageCursorServiceError extends Error {
  constructor() {
    super("Diary page cursor is invalid");
    this.name = "DiaryPageCursorServiceError";
  }
}

export class DiaryPageStaleServiceError extends Error {
  constructor() {
    super("Diary page is stale");
    this.name = "DiaryPageStaleServiceError";
  }
}

interface DiaryQuerystring {
  date: string;
  cursor?: string;
  limit?: number;
}

interface EntryParams {
  entryId: string;
}

interface DiaryCorrectionQuery {
  diaryCorrectionProtocol?: "v1";
  profileTimeZonePrecondition?: "v1";
}

interface RequiredProfileTimeZoneQuery {
  profileTimeZonePrecondition: "v1";
}

interface DayParams {
  localDate: string;
}

const dateQuerySchema = {
  type: "object",
  additionalProperties: false,
  required: ["date"],
  properties: {
    date: {
      type: "string",
      format: "date",
      pattern: "^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}$",
    },
    cursor: {
      type: "string",
      minLength: 1,
      maxLength: 512,
      pattern: "^d1\\.[A-Za-z0-9_-]+$",
    },
    limit: { type: "integer", minimum: 1, maximum: 20 },
  },
  dependencies: { cursor: ["limit"] },
} as const;

const entryParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["entryId"],
  properties: {
    entryId: {
      type: "string",
      pattern:
        "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
    },
  },
} as const;

const diaryCorrectionQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    diaryCorrectionProtocol: { type: "string", const: "v1" },
    profileTimeZonePrecondition: { type: "string", const: "v1" },
  },
} as const;

const requiredProfileTimeZoneQuerySchema = {
  type: "object",
  additionalProperties: false,
  required: ["profileTimeZonePrecondition"],
  properties: {
    profileTimeZonePrecondition: { type: "string", const: "v1" },
  },
} as const;

const dayParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["localDate"],
  properties: {
    localDate: {
      type: "string",
      format: "date",
      pattern: "^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}$",
    },
  },
} as const;

const diaryMutationOrCorrectionResponseSchema = {
  ...diaryCorrectionMutationResponseSchema,
  $id: "DiaryMutationOrCorrectionResponse",
  properties: {
    data: {
      ...diaryCorrectionMutationResponseSchema.properties.data,
      required: ["replayed", "entry", "affectedDays"],
    },
  },
} as const;

// Fastify's response serializer cannot compile the contract's allOf/contains
// membership assertions; assertReorderResponse enforces the same canonical
// four-group invariant before this serializer runs.
const reorderReceiptSchema = reorderDiaryDayResponseSchema.properties.data.properties.receipt;
const reorderDiaryDayApiResponseSchema = {
  ...reorderDiaryDayResponseSchema,
  $id: "ReorderDiaryDayApiResponse",
  properties: {
    data: {
      ...reorderDiaryDayResponseSchema.properties.data,
      properties: {
        ...reorderDiaryDayResponseSchema.properties.data.properties,
        receipt: {
          ...reorderReceiptSchema,
          properties: {
            ...reorderReceiptSchema.properties,
            groups: {
              type: "array",
              minItems: 4,
              maxItems: 4,
              items: reorderReceiptSchema.properties.groups.items,
            },
          },
        },
      },
    },
  },
} as const;

function containsOnlyUnicodeScalarValues(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

async function rejectInvalidDiaryNote(request: FastifyRequest): Promise<void> {
  const body = request.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) return;
  const note = (body as Readonly<Record<string, unknown>>).note;
  if (note === undefined || note === null) return;
  if (
    typeof note === "string" &&
    note.length > 0 &&
    !note.includes("\u0000") &&
    containsOnlyUnicodeScalarValues(note) &&
    [...note].length <= MAX_DIARY_NOTE_INPUT_CODE_POINTS
  ) {
    return;
  }
  throw new HttpProblem({
    statusCode: 400,
    code: "VALIDATION_ERROR",
    title: "Bad Request",
    detail: "One or more request fields are invalid.",
    issues: [{ path: "/note", code: "invalid", message: "Invalid value." }],
    expose: true,
  });
}

function invalidCorrectionProtocol(): never {
  throw new HttpProblem({
    statusCode: 400,
    code: "VALIDATION_ERROR",
    title: "Bad Request",
    detail: "One or more request fields are invalid.",
    expose: true,
  });
}

async function rejectDiaryCorrectionPreconditions(request: FastifyRequest): Promise<void> {
  const query = request.query as Readonly<Record<string, unknown>>;
  const protocol = query.diaryCorrectionProtocol;
  const timeZoneMarker = query.profileTimeZonePrecondition;
  const timeZoneHeader = request.headers["x-expected-profile-time-zone"];
  const body = request.body;
  const movesAcrossLocalDate =
    typeof body === "object" &&
    body !== null &&
    !Array.isArray(body) &&
    Object.hasOwn(body, "occurredAt");
  if (protocol === undefined && timeZoneMarker === undefined && timeZoneHeader === undefined)
    return;
  if (protocol !== "v1") invalidCorrectionProtocol();
  if (
    movesAcrossLocalDate
      ? timeZoneMarker === "v1" && typeof timeZoneHeader === "string"
      : timeZoneMarker === undefined && timeZoneHeader === undefined
  ) {
    return;
  }
  invalidCorrectionProtocol();
}

async function rejectDeleteCorrectionPreconditions(request: FastifyRequest): Promise<void> {
  const query = request.query as Readonly<Record<string, unknown>>;
  const protocol = query.diaryCorrectionProtocol;
  const hasTimeZoneSignal =
    query.profileTimeZonePrecondition !== undefined ||
    request.headers["x-expected-profile-time-zone"] !== undefined;
  if (!hasTimeZoneSignal && (protocol === undefined || protocol === "v1")) return;
  invalidCorrectionProtocol();
}

async function requireProfileTimeZonePreconditionV1(request: FastifyRequest): Promise<void> {
  await rejectUnpairedProfileTimeZonePrecondition(request);
  const query = request.query as Readonly<Record<string, unknown>>;
  if (
    query.profileTimeZonePrecondition !== "v1" ||
    expectedProfileTimeZone(request.headers["x-expected-profile-time-zone"]) === undefined
  ) {
    invalidCorrectionProtocol();
  }
}

function requireOrderDigest(value: string | string[] | undefined): string {
  if (typeof value === "string" && /^[0-9a-f]{64}$/u.test(value)) return value;
  throw new HttpProblem({
    statusCode: 400,
    code: "VALIDATION_ERROR",
    title: "Bad Request",
    detail: "A lowercase SHA-256 diary order digest header is required.",
    issues: [
      {
        path: "/headers/x-expected-diary-order-digest",
        code: "invalid",
        message: "Invalid value.",
      },
    ],
    expose: true,
  });
}

function unavailable(cause?: unknown): HttpProblem {
  return new HttpProblem({
    statusCode: 503,
    code: "SERVICE_NOT_READY",
    title: "Service Unavailable",
    detail: "Diary services are temporarily unavailable.",
    expose: true,
    cause,
  });
}

function mapDiaryError(error: unknown): HttpProblem {
  if (error instanceof HttpProblem) return error;
  if (error instanceof DiaryNotFoundServiceError) {
    return new HttpProblem({
      statusCode: 404,
      code: "NOT_FOUND",
      title: "Not Found",
      detail: "The diary entry was not found.",
      expose: true,
    });
  }
  if (error instanceof DiaryRevisionConflictServiceError) {
    return new HttpProblem({
      statusCode: 412,
      code: "PRECONDITION_FAILED",
      title: "Precondition Failed",
      detail: "The diary entry changed. Refresh the day and retry your edit.",
      expose: true,
    });
  }
  if (error instanceof DiaryIdempotencyConflictServiceError) {
    return new HttpProblem({
      statusCode: 409,
      code: "CONFLICT",
      title: "Conflict",
      detail: "The Idempotency-Key was already used for a different operation.",
      expose: true,
    });
  }
  if (error instanceof DiaryTimeZoneChangedServiceError) {
    return new HttpProblem({
      statusCode: 409,
      code: "DIARY_TIME_ZONE_CHANGED",
      title: "Conflict",
      detail:
        "The profile time zone changed before the diary entry was saved. Review the date and try again.",
      expose: true,
    });
  }
  if (error instanceof DiaryLockedServiceError) {
    return new HttpProblem({
      statusCode: 409,
      code: "CONFLICT",
      title: "Conflict",
      detail: "The diary day is locked and cannot be changed.",
      expose: true,
    });
  }
  if (error instanceof DiaryPageCursorServiceError) {
    return new HttpProblem({
      statusCode: 400,
      code: "VALIDATION_ERROR",
      title: "Bad Request",
      detail: "One or more request fields are invalid.",
      issues: [{ path: "/cursor", code: "invalid", message: "Invalid value." }],
      expose: true,
    });
  }
  if (error instanceof DiaryPageStaleServiceError) {
    return new HttpProblem({
      statusCode: 409,
      code: "DIARY_PAGE_STALE",
      title: "Conflict",
      detail: "The diary day changed while loading more entries. Refresh the day and try again.",
      expose: true,
    });
  }
  if (error instanceof DiaryValidationServiceError) {
    return new HttpProblem({
      statusCode: 400,
      code: "VALIDATION_ERROR",
      title: "Bad Request",
      detail: "The diary entry is invalid for this account.",
      expose: true,
    });
  }
  return unavailable(error);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function requestDigest(operation: string, value: unknown): string {
  return createHash("sha256").update(canonicalJson({ operation, value }), "utf8").digest("hex");
}

function diaryPageEtag(response: DiaryDayResponse): string {
  const digest = createHash("sha256").update(canonicalJson(response), "utf8").digest("base64url");
  return `"p-${digest}"`;
}

export function assertNutrientAggregate(aggregate: DiaryNutrientAggregate): void {
  const reconciled = aggregate.quantifiedCount + aggregate.traceCount + aggregate.unknownCount;
  const unknownReasonTotal = Object.values(aggregate.unknownReasonCounts).reduce(
    (total, count) => total + count,
    0,
  );
  const completenessIsValid =
    (aggregate.completeness === "complete" && aggregate.unknownCount === 0) ||
    (aggregate.completeness === "partial" &&
      aggregate.unknownCount > 0 &&
      aggregate.quantifiedCount + aggregate.traceCount > 0) ||
    (aggregate.completeness === "unknown" &&
      aggregate.unknownCount > 0 &&
      aggregate.quantifiedCount + aggregate.traceCount === 0);
  const exactnessIsValid =
    aggregate.isExact === (aggregate.unknownCount === 0 && aggregate.traceCount === 0);
  if (
    reconciled !== aggregate.contributorCount ||
    unknownReasonTotal !== aggregate.unknownCount ||
    !completenessIsValid ||
    !exactnessIsValid ||
    aggregate.knownAmount.length > MAX_NUTRIENT_AGGREGATE_OUTPUT_LENGTH
  ) {
    throw new HttpProblem({
      statusCode: 500,
      code: "INTERNAL_ERROR",
      title: "Invalid diary aggregate",
      detail: "Diary aggregate invariants failed.",
    });
  }
}

export function assertDiaryEntry(entry: DiaryEntry): void {
  for (const nutrient of entry.nutrients) assertNutrientAggregate(nutrient);
  if (entry.entryKind === "food") {
    if (entry.foodProvenance.kind === "private_custom") {
      if (entry.source !== null) {
        throw new Error("Private custom food must not expose public source provenance");
      }
      return;
    }
    const source = entry.source;
    if (
      source === null ||
      source.code !== entry.foodProvenance.source.code ||
      source.releaseId !== entry.foodProvenance.source.releaseId ||
      source.displayName !== entry.foodProvenance.source.displayName ||
      source.licenseExpression !== entry.foodProvenance.source.licenseExpression ||
      source.attributionRequired !== entry.foodProvenance.source.attributionRequired ||
      source.attributionText !== entry.foodProvenance.source.attributionText
    ) {
      throw new Error("Public diary food provenance is inconsistent");
    }
    return;
  }
  if (
    (entry.recipe.servingCount === null) !== (entry.recipe.servingLabel === null) ||
    (entry.portion.kind === "serving" && entry.recipe.servingCount === null) ||
    (entry.portion.kind === "serving" && entry.portion.servingLabel !== entry.recipe.servingLabel)
  ) {
    throw new HttpProblem({
      statusCode: 500,
      code: "INTERNAL_ERROR",
      title: "Invalid recipe diary entry",
      detail: "Recipe serving invariants failed.",
    });
  }
  const sourceKeys = entry.sources.map((source) => `${source.code}\u0000${source.releaseId}`);
  if (
    sourceKeys.length === 0 ||
    new Set(sourceKeys).size !== sourceKeys.length ||
    sourceKeys.some((key, index) => index > 0 && (sourceKeys[index - 1] ?? "") > key) ||
    entry.recipe.retentionPolicy.code !== "identity-retention-default" ||
    entry.recipe.retentionPolicy.version !== "1" ||
    entry.recipe.retentionPolicy.assumption.trim().length === 0 ||
    !entry.recipe.warnings.some((warning) => warning.code === "RETENTION_FACTORS_DEFAULTED")
  ) {
    throw new HttpProblem({
      statusCode: 500,
      code: "INTERNAL_ERROR",
      title: "Invalid recipe diary entry",
      detail: "Recipe provenance invariants failed.",
    });
  }
}

function assertDiaryDay(day: DiaryDay): void {
  for (const total of day.totals) assertNutrientAggregate(total);
  for (const entry of day.entries) assertDiaryEntry(entry);
}

function invalidDiaryPageResponse(): HttpProblem {
  return new HttpProblem({
    statusCode: 500,
    code: "INTERNAL_ERROR",
    title: "Invalid diary page",
    detail: "Diary pagination invariants failed.",
  });
}

function assertDiaryDayResponse(
  response: DiaryDayResponse,
  request: Readonly<{ limit: number | undefined; hasCursor: boolean }>,
): void {
  assertDiaryDay(response.data);
  if (request.limit === undefined) {
    if (response.page !== undefined) throw invalidDiaryPageResponse();
    return;
  }

  const page = response.page;
  if (page === undefined) throw invalidDiaryPageResponse();
  const entryCount = response.data.entries.length;
  if (
    entryCount > request.limit ||
    entryCount > page.totalEntries ||
    (page.totalEntries > 0 && entryCount === 0) ||
    (page.nextCursor !== null && entryCount >= page.totalEntries) ||
    (!request.hasCursor && page.nextCursor === null && entryCount < page.totalEntries)
  ) {
    throw invalidDiaryPageResponse();
  }
}

function assertMutation(result: DiaryMutationResponse): void {
  if (!result.data.entry) return;
  assertDiaryEntry(result.data.entry);
}

function invalidPersistenceReceipt(detail: string): never {
  throw new HttpProblem({
    statusCode: 500,
    code: "INTERNAL_ERROR",
    title: "Invalid diary mutation receipt",
    detail,
  });
}

function isNextRevision(candidate: string, expected: string): boolean {
  return (
    /^[1-9][0-9]*$/u.test(candidate) &&
    /^[1-9][0-9]*$/u.test(expected) &&
    BigInt(candidate) === BigInt(expected) + 1n
  );
}

function assertCorrectionMutation(
  result: DiaryCorrectionMutationResponse,
  expected: Readonly<{
    operationId: string;
    kind: "delete" | "repeat" | "update";
    entryId: string;
    revision: string;
  }>,
): void {
  assertMutation(result);
  const { receipt } = result.data;
  if (receipt.expectedSubjects.length !== 1 || receipt.resultSubjects.length !== 1) {
    invalidPersistenceReceipt("Diary correction receipt subject count is inconsistent.");
  }
  const expectedSubject = receipt.expectedSubjects[0];
  const resultSubject = receipt.resultSubjects[0];
  if (
    receipt.protocol !== "v1" ||
    receipt.operationId !== expected.operationId ||
    receipt.kind !== expected.kind ||
    expectedSubject.entryId !== expected.entryId ||
    expectedSubject.revision !== expected.revision ||
    canonicalJson(receipt.affectedDays) !== canonicalJson(result.data.affectedDays)
  ) {
    invalidPersistenceReceipt("Diary correction receipt identity is inconsistent.");
  }
  const affectedDays = result.data.affectedDays;
  if (
    affectedDays.length < 1 ||
    affectedDays.length > (expected.kind === "update" ? 2 : 1) ||
    new Set(affectedDays.map((day) => day.localDate)).size !== affectedDays.length
  ) {
    invalidPersistenceReceipt("Diary correction affected days are inconsistent.");
  }
  if (expected.kind === "delete") {
    if (
      result.data.entry !== null ||
      resultSubject.entryId !== expected.entryId ||
      resultSubject.state !== "deleted" ||
      !isNextRevision(resultSubject.revision, expected.revision)
    ) {
      invalidPersistenceReceipt("Diary delete receipt result is inconsistent.");
    }
    return;
  }
  const entry = result.data.entry;
  if (
    entry === null ||
    resultSubject.state !== "active" ||
    resultSubject.entryId !== entry.id ||
    resultSubject.revision !== entry.revision ||
    !affectedDays.some((day) => day.localDate === entry.localDate) ||
    (expected.kind === "repeat" &&
      (entry.id.toLowerCase() === expected.entryId || entry.revision !== "1")) ||
    (expected.kind === "update" &&
      (entry.id !== expected.entryId || !isNextRevision(entry.revision, expected.revision)))
  ) {
    invalidPersistenceReceipt("Diary correction receipt result is inconsistent.");
  }
}

function assertReorderResponse(
  result: ReorderDiaryDayResponse,
  expected: Readonly<{
    operationId: string;
    localDate: string;
    dayRevision: string;
    orderDigest: string;
  }>,
): void {
  const { receipt } = result.data;
  const mealSlots = ["breakfast", "lunch", "dinner", "snacks"] as const;
  if (
    !Array.isArray(receipt.groups) ||
    receipt.groups.length !== mealSlots.length ||
    receipt.groups.some(
      (group, index) =>
        typeof group !== "object" ||
        group === null ||
        group.mealSlot !== mealSlots[index] ||
        !Array.isArray(group.entries) ||
        group.entries.some(
          (entry) =>
            typeof entry !== "object" ||
            entry === null ||
            typeof entry.entryId !== "string" ||
            typeof entry.entryRevision !== "string" ||
            !Number.isSafeInteger(entry.position),
        ),
    )
  ) {
    invalidPersistenceReceipt("Diary day reorder receipt group shape is inconsistent.");
  }
  const entries = receipt.groups.flatMap((group) => group.entries);
  let computedOrderDigest: string;
  try {
    computedOrderDigest = createHash("sha256")
      .update(
        diaryDayOrderDigestPayload(receipt.localDate, receipt.timeZone, receipt.groups),
        "utf8",
      )
      .digest("hex");
  } catch {
    invalidPersistenceReceipt("Diary day reorder receipt group shape is inconsistent.");
  }
  if (
    receipt.operationId !== expected.operationId ||
    receipt.localDate !== expected.localDate ||
    receipt.expectedDayRevision !== expected.dayRevision ||
    !isNextRevision(receipt.resultingDayRevision, expected.dayRevision) ||
    receipt.previousOrderDigest !== expected.orderDigest ||
    receipt.orderDigest !== computedOrderDigest ||
    entries.length < 1 ||
    entries.length > 50 ||
    new Set(entries.map((entry) => entry.entryId.toLowerCase())).size !== entries.length ||
    receipt.groups.some((group) =>
      group.entries.some((entry, position) => entry.position !== position),
    )
  ) {
    invalidPersistenceReceipt("Diary day reorder receipt is inconsistent.");
  }
}

async function withRequestSignal<T>(
  request: FastifyRequest,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort("request-aborted");
  if (request.raw.aborted) abort();
  else request.raw.once("aborted", abort);
  try {
    return await operation(controller.signal);
  } finally {
    request.raw.off("aborted", abort);
  }
}

export const diaryRoutes: FastifyPluginAsync<DiaryRoutesOptions> = async (app, options) => {
  const requireAuth = requireAuthentication(options.authService);

  app.get<{ Querystring: DiaryQuerystring }>(
    "/",
    {
      preHandler: requireAuth,
      preValidation: rejectUnexpectedQueryKeys(["date", "cursor", "limit"]),
      schema: {
        querystring: dateQuerySchema,
        response: {
          200: diaryDayResponseSchema,
          400: problemDetailsSchema,
          401: problemDetailsSchema,
          409: problemDetailsSchema,
          503: problemDetailsSchema,
        },
      },
    },
    async (request, reply): Promise<DiaryDayResponse> => {
      if (!options.diaryService) throw unavailable();
      const principal = authenticatedPrincipal(request);
      try {
        const response = await withRequestSignal(request, async (signal) => {
          if (request.query.limit === undefined) {
            const day = await options.diaryService?.getDay({
              userId: principal.userId,
              localDate: request.query.date,
              signal,
            });
            if (!day) throw unavailable();
            return { data: day };
          }
          const diaryService = options.diaryService;
          if (!diaryService?.getDayPage) throw unavailable();
          return diaryService.getDayPage({
            userId: principal.userId,
            localDate: request.query.date,
            limit: request.query.limit,
            ...(request.query.cursor === undefined ? {} : { cursor: request.query.cursor }),
            signal,
          });
        });
        assertDiaryDayResponse(response, {
          limit: request.query.limit,
          hasCursor: request.query.cursor !== undefined,
        });
        reply
          .header("cache-control", "no-store")
          .header(
            "etag",
            response.page === undefined
              ? revisionEtag(response.data.revision)
              : diaryPageEtag(response),
          );
        return response;
      } catch (error) {
        throw mapDiaryError(error);
      }
    },
  );

  app.post<{
    Body: CreateDiaryEntryRequest;
    Headers: CreateDiaryEntryHeaders;
    Querystring: CreateDiaryEntryQuery;
  }>(
    "/entries",
    {
      preHandler: requireAuth,
      preValidation: [
        rejectUnexpectedQueryKeys(["profileTimeZonePrecondition"]),
        rejectUnexpectedBodyKeys([
          "foodVersionId",
          "portion",
          "mealSlot",
          "occurredAt",
          "position",
        ]),
        rejectUnpairedProfileTimeZonePrecondition,
      ],
      schema: {
        headers: createDiaryEntryHeadersSchema,
        querystring: createDiaryEntryQuerySchema,
        body: createDiaryEntryRequestSchema,
        response: {
          200: diaryMutationResponseSchema,
          201: diaryMutationResponseSchema,
          400: problemDetailsSchema,
          401: problemDetailsSchema,
          409: problemDetailsSchema,
          503: problemDetailsSchema,
        },
      },
    },
    async (request, reply): Promise<DiaryMutationResponse> => {
      if (!options.diaryService) throw unavailable();
      const principal = authenticatedPrincipal(request);
      const clientOperationId = requireIdempotencyKey(request.headers["idempotency-key"]);
      try {
        const expectedTimeZone = expectedProfileTimeZone(
          request.headers["x-expected-profile-time-zone"],
        );
        const digest =
          expectedTimeZone === undefined
            ? requestDigest("create-diary-entry", request.body)
            : requestDigest("create-diary-entry-with-expected-profile-time-zone-v1", {
                entry: request.body,
                expectedProfileTimeZone: expectedTimeZone,
              });
        const result = await withRequestSignal(
          request,
          (signal) =>
            options.diaryService?.createEntry({
              userId: principal.userId,
              clientOperationId,
              requestDigest: digest,
              ...(expectedTimeZone === undefined
                ? {}
                : { expectedProfileTimeZone: expectedTimeZone }),
              entry: request.body,
              signal,
            }) ?? Promise.reject(unavailable()),
        );
        assertMutation(result);
        reply.header("cache-control", "no-store").status(result.data.replayed ? 200 : 201);
        if (result.data.entry) reply.header("etag", revisionEtag(result.data.entry.revision));
        return result;
      } catch (error) {
        throw mapDiaryError(error);
      }
    },
  );

  app.patch<{
    Params: EntryParams;
    Body: UpdateDiaryEntryRequest;
    Headers: ProfileTimeZonePreconditionHeaders;
    Querystring: DiaryCorrectionQuery;
  }>(
    "/entries/:entryId",
    {
      preHandler: requireAuth,
      preValidation: [
        rejectUnexpectedQueryKeys(["diaryCorrectionProtocol", "profileTimeZonePrecondition"]),
        rejectUnexpectedBodyKeys(["portion", "mealSlot", "occurredAt", "position", "note"]),
        rejectInvalidDiaryNote,
        rejectDiaryCorrectionPreconditions,
      ],
      schema: {
        headers: createDiaryEntryHeadersSchema,
        params: entryParamsSchema,
        querystring: diaryCorrectionQuerySchema,
        body: updateDiaryEntryRequestSchema,
        response: {
          200: diaryMutationOrCorrectionResponseSchema,
          400: problemDetailsSchema,
          401: problemDetailsSchema,
          404: problemDetailsSchema,
          409: problemDetailsSchema,
          412: problemDetailsSchema,
          428: problemDetailsSchema,
          503: problemDetailsSchema,
        },
      },
    },
    async (request, reply): Promise<DiaryMutationResponse | DiaryCorrectionMutationResponse> => {
      if (!options.diaryService) throw unavailable();
      const principal = authenticatedPrincipal(request);
      const clientOperationId = requireIdempotencyKey(request.headers["idempotency-key"]);
      const expectedRevision = requireRevision(request.headers["if-match"]);
      try {
        if (request.query.diaryCorrectionProtocol === "v1") {
          const diaryService = options.diaryService;
          if (!diaryService.updateEntryCorrection) throw unavailable();
          const entryId = request.params.entryId.toLowerCase();
          const expectedTimeZone =
            request.body.occurredAt === undefined
              ? undefined
              : expectedProfileTimeZone(request.headers["x-expected-profile-time-zone"]);
          const digest = requestDigest("update-diary-entry-correction-v1", {
            entryId,
            expectedRevision,
            ...(expectedTimeZone === undefined
              ? {}
              : { expectedProfileTimeZone: expectedTimeZone }),
            patch: request.body,
          });
          const result = await withRequestSignal(
            request,
            (signal) =>
              diaryService.updateEntryCorrection?.({
                userId: principal.userId,
                entryId,
                expectedRevision,
                clientOperationId,
                requestDigest: digest,
                ...(expectedTimeZone === undefined
                  ? {}
                  : { expectedProfileTimeZone: expectedTimeZone }),
                patch: request.body,
                signal,
              }) ?? Promise.reject(unavailable()),
          );
          assertCorrectionMutation(result, {
            operationId: clientOperationId,
            kind: "update",
            entryId,
            revision: expectedRevision,
          });
          reply.header("cache-control", "no-store");
          if (result.data.entry) reply.header("etag", revisionEtag(result.data.entry.revision));
          return result;
        }
        const digest = requestDigest("update-diary-entry", {
          entryId: request.params.entryId,
          expectedRevision,
          patch: request.body,
        });
        const result = await withRequestSignal(
          request,
          (signal) =>
            options.diaryService?.updateEntry({
              userId: principal.userId,
              entryId: request.params.entryId,
              expectedRevision,
              clientOperationId,
              requestDigest: digest,
              patch: request.body,
              signal,
            }) ?? Promise.reject(unavailable()),
        );
        assertMutation(result);
        reply.header("cache-control", "no-store");
        if (result.data.entry) reply.header("etag", revisionEtag(result.data.entry.revision));
        return result;
      } catch (error) {
        throw mapDiaryError(error);
      }
    },
  );

  app.post<{
    Params: EntryParams;
    Body: RepeatDiaryEntryRequest;
    Headers: ProfileTimeZonePreconditionHeaders;
    Querystring: RequiredProfileTimeZoneQuery;
  }>(
    "/corrections/entries/:entryId/repeat",
    {
      preHandler: requireAuth,
      preValidation: [
        rejectUnexpectedQueryKeys(["profileTimeZonePrecondition"]),
        rejectUnexpectedBodyKeys(["occurredAt", "mealSlot", "position"]),
        requireProfileTimeZonePreconditionV1,
      ],
      schema: {
        headers: createDiaryEntryHeadersSchema,
        params: entryParamsSchema,
        querystring: requiredProfileTimeZoneQuerySchema,
        body: repeatDiaryEntryRequestSchema,
        response: {
          200: diaryCorrectionMutationResponseSchema,
          201: diaryCorrectionMutationResponseSchema,
          400: problemDetailsSchema,
          401: problemDetailsSchema,
          404: problemDetailsSchema,
          409: problemDetailsSchema,
          412: problemDetailsSchema,
          428: problemDetailsSchema,
          503: problemDetailsSchema,
        },
      },
    },
    async (request, reply): Promise<DiaryCorrectionMutationResponse> => {
      const diaryService = options.diaryService;
      if (!diaryService?.repeatEntryCorrection) throw unavailable();
      const principal = authenticatedPrincipal(request);
      const clientOperationId = requireIdempotencyKey(request.headers["idempotency-key"]);
      const expectedSourceRevision = requireRevision(request.headers["if-match"]);
      try {
        const sourceEntryId = request.params.entryId.toLowerCase();
        const expectedTimeZone = expectedProfileTimeZone(
          request.headers["x-expected-profile-time-zone"],
        );
        if (expectedTimeZone === undefined) invalidCorrectionProtocol();
        const digest = requestDigest("repeat-diary-entry-correction-v1", {
          sourceEntryId,
          expectedSourceRevision,
          expectedProfileTimeZone: expectedTimeZone,
          request: request.body,
        });
        const result = await withRequestSignal(
          request,
          (signal) =>
            diaryService.repeatEntryCorrection?.({
              userId: principal.userId,
              sourceEntryId,
              expectedSourceRevision,
              clientOperationId,
              requestDigest: digest,
              expectedProfileTimeZone: expectedTimeZone,
              request: request.body,
              signal,
            }) ?? Promise.reject(unavailable()),
        );
        assertCorrectionMutation(result, {
          operationId: clientOperationId,
          kind: "repeat",
          entryId: sourceEntryId,
          revision: expectedSourceRevision,
        });
        reply.header("cache-control", "no-store").status(result.data.replayed ? 200 : 201);
        if (result.data.entry) reply.header("etag", revisionEtag(result.data.entry.revision));
        return result;
      } catch (error) {
        throw mapDiaryError(error);
      }
    },
  );

  app.put<{
    Params: DayParams;
    Body: ReorderDiaryDayRequest;
    Headers: ReorderDiaryDayHeaders;
    Querystring: RequiredProfileTimeZoneQuery;
  }>(
    "/days/:localDate/order",
    {
      preHandler: requireAuth,
      preValidation: [
        rejectUnexpectedQueryKeys(["profileTimeZonePrecondition"]),
        rejectUnexpectedBodyKeys(["groups"]),
        requireProfileTimeZonePreconditionV1,
      ],
      schema: {
        headers: reorderDiaryDayHeadersSchema,
        params: dayParamsSchema,
        querystring: requiredProfileTimeZoneQuerySchema,
        body: reorderDiaryDayRequestSchema,
        response: {
          200: reorderDiaryDayApiResponseSchema,
          400: problemDetailsSchema,
          401: problemDetailsSchema,
          404: problemDetailsSchema,
          409: problemDetailsSchema,
          412: problemDetailsSchema,
          428: problemDetailsSchema,
          503: problemDetailsSchema,
        },
      },
    },
    async (request, reply): Promise<ReorderDiaryDayResponse> => {
      const diaryService = options.diaryService;
      if (!diaryService?.reorderDay) throw unavailable();
      const principal = authenticatedPrincipal(request);
      const clientOperationId = requireIdempotencyKey(request.headers["idempotency-key"]);
      const expectedDayRevision = requireRevision(request.headers["if-match"]);
      const expectedOrderDigest = requireOrderDigest(
        request.headers["x-expected-diary-order-digest"],
      );
      try {
        const expectedTimeZone = expectedProfileTimeZone(
          request.headers["x-expected-profile-time-zone"],
        );
        if (expectedTimeZone === undefined) invalidCorrectionProtocol();
        const digest = requestDigest("reorder-diary-day-v1", {
          localDate: request.params.localDate,
          expectedDayRevision,
          expectedOrderDigest,
          expectedProfileTimeZone: expectedTimeZone,
          groups: request.body.groups,
        });
        const result = await withRequestSignal(
          request,
          (signal) =>
            diaryService.reorderDay?.({
              userId: principal.userId,
              localDate: request.params.localDate,
              expectedDayRevision,
              expectedOrderDigest,
              expectedProfileTimeZone: expectedTimeZone,
              clientOperationId,
              requestDigest: digest,
              groups: request.body.groups,
              signal,
            }) ?? Promise.reject(unavailable()),
        );
        assertReorderResponse(result, {
          operationId: clientOperationId,
          localDate: request.params.localDate,
          dayRevision: expectedDayRevision,
          orderDigest: expectedOrderDigest,
        });
        reply
          .header("cache-control", "no-store")
          .header("etag", revisionEtag(result.data.receipt.resultingDayRevision));
        return result;
      } catch (error) {
        throw mapDiaryError(error);
      }
    },
  );

  app.delete<{ Params: EntryParams; Querystring: DiaryCorrectionQuery }>(
    "/entries/:entryId",
    {
      preHandler: requireAuth,
      preValidation: [
        rejectUnexpectedQueryKeys(["diaryCorrectionProtocol", "profileTimeZonePrecondition"]),
        rejectDeleteCorrectionPreconditions,
      ],
      schema: {
        params: entryParamsSchema,
        querystring: diaryCorrectionQuerySchema,
        response: {
          200: diaryMutationOrCorrectionResponseSchema,
          400: problemDetailsSchema,
          401: problemDetailsSchema,
          404: problemDetailsSchema,
          409: problemDetailsSchema,
          412: problemDetailsSchema,
          428: problemDetailsSchema,
          503: problemDetailsSchema,
        },
      },
    },
    async (request, reply): Promise<DiaryMutationResponse | DiaryCorrectionMutationResponse> => {
      if (!options.diaryService) throw unavailable();
      const principal = authenticatedPrincipal(request);
      const clientOperationId = requireIdempotencyKey(request.headers["idempotency-key"]);
      const expectedRevision = requireRevision(request.headers["if-match"]);
      try {
        if (request.query.diaryCorrectionProtocol === "v1") {
          const diaryService = options.diaryService;
          if (!diaryService.deleteEntryCorrection) throw unavailable();
          const entryId = request.params.entryId.toLowerCase();
          const digest = requestDigest("delete-diary-entry-correction-v1", {
            entryId,
            expectedRevision,
          });
          const result = await withRequestSignal(
            request,
            (signal) =>
              diaryService.deleteEntryCorrection?.({
                userId: principal.userId,
                entryId,
                expectedRevision,
                clientOperationId,
                requestDigest: digest,
                signal,
              }) ?? Promise.reject(unavailable()),
          );
          assertCorrectionMutation(result, {
            operationId: clientOperationId,
            kind: "delete",
            entryId,
            revision: expectedRevision,
          });
          reply.header("cache-control", "no-store");
          return result;
        }
        const digest = requestDigest("delete-diary-entry", {
          entryId: request.params.entryId,
          expectedRevision,
        });
        const result = await withRequestSignal(
          request,
          (signal) =>
            options.diaryService?.deleteEntry({
              userId: principal.userId,
              entryId: request.params.entryId,
              expectedRevision,
              clientOperationId,
              requestDigest: digest,
              signal,
            }) ?? Promise.reject(unavailable()),
        );
        assertMutation(result);
        reply.header("cache-control", "no-store");
        return result;
      } catch (error) {
        throw mapDiaryError(error);
      }
    },
  );
};
