import {
  type DiaryCorrectionRequestEvidence,
  diaryCorrectionMatchesRequest,
  diaryDayOrderDigest,
  isLocalDate,
  isSupportedTimeZone,
  parseDiaryCorrectionMutation,
  parseDiaryDayReorder,
  parseDiaryMutation,
  parseDiaryPage,
} from "../../../lib/diary";
import {
  authenticatedFetch,
  isTrustedMutationRequest,
  PRIVATE_RESPONSE_HEADERS,
  privateJsonError,
  readBoundedJson,
  safeUpstreamProblem,
  validatedDiaryReadQuery,
  validatedIdempotencyKey,
  validatedIfMatch,
} from "../../../lib/private-api";

async function diaryResponse(upstream: Response, expectedDate: string): Promise<Response> {
  if (!upstream.ok)
    return safeUpstreamProblem(upstream, "The diary request could not be completed.");
  try {
    const diary = parseDiaryPage(await upstream.json());
    if (diary.data.localDate !== expectedDate) {
      throw new TypeError("The diary service returned a different day.");
    }
    const etag = upstream.headers.get("etag") ?? `"${diary.data.revision}"`;
    return Response.json(
      diary.legacy ? { data: diary.data } : { data: diary.data, page: diary.page },
      { status: upstream.status, headers: { ...PRIVATE_RESPONSE_HEADERS, etag } },
    );
  } catch {
    return privateJsonError(502, "The diary service returned an invalid response.");
  }
}

export async function proxyDiaryGet(request: Request): Promise<Response> {
  const query = validatedDiaryReadQuery(request);
  if (!query) return privateJsonError(400, "Choose a valid paged diary request.");
  const params = new URLSearchParams({ date: query.date });
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.cursor !== undefined) params.set("cursor", query.cursor);
  const upstream = await authenticatedFetch(request, `/v1/diary?${params.toString()}`);
  return diaryResponse(upstream, query.date);
}

async function mutationResponse(upstream: Response): Promise<Response> {
  if (!upstream.ok)
    return safeUpstreamProblem(upstream, "The diary request could not be completed.");
  try {
    const result = parseDiaryMutation(await upstream.json());
    return Response.json(
      { data: result },
      { status: upstream.status, headers: PRIVATE_RESPONSE_HEADERS },
    );
  } catch {
    return privateJsonError(502, "The diary service returned an invalid response.");
  }
}

async function correctionMutationResponse(
  upstream: Response,
  expected: DiaryCorrectionRequestEvidence,
): Promise<Response> {
  if (!upstream.ok)
    return safeUpstreamProblem(upstream, "The diary request could not be completed.");
  try {
    const result = parseDiaryCorrectionMutation(await upstream.json());
    if (!diaryCorrectionMatchesRequest(result, expected)) {
      throw new TypeError("The diary correction receipt did not match the request.");
    }
    return Response.json(
      { data: result },
      { status: upstream.status, headers: PRIVATE_RESPONSE_HEADERS },
    );
  } catch {
    return privateJsonError(502, "The diary service returned an invalid correction receipt.");
  }
}

function revisionFromIfMatch(ifMatch: string): string {
  return ifMatch.slice(1, -1);
}

function guardedDiaryCorrectionContext(
  request: Request,
  requireTimeZone: boolean,
): { readonly date: string; readonly expectedTimeZone: string | null } | null {
  const query = new URL(request.url).searchParams;
  if ([...query.keys()].some((key) => key !== "date" && key !== "profileTimeZonePrecondition")) {
    return null;
  }
  const dates = query.getAll("date");
  const markers = query.getAll("profileTimeZonePrecondition");
  const expectedTimeZone = request.headers.get("x-expected-profile-time-zone");
  if (dates.length !== 1 || !isLocalDate(dates[0])) return null;
  if (!requireTimeZone) {
    return markers.length === 0 && expectedTimeZone === null
      ? { date: dates[0], expectedTimeZone: null }
      : null;
  }
  return markers.length === 1 &&
    markers[0] === "v1" &&
    expectedTimeZone !== null &&
    isSupportedTimeZone(expectedTimeZone)
    ? { date: dates[0], expectedTimeZone }
    : null;
}

function guardedDiaryReorderTimeZone(request: Request): string | null {
  const query = new URL(request.url).searchParams;
  const markers = query.getAll("profileTimeZonePrecondition");
  const expectedTimeZone = request.headers.get("x-expected-profile-time-zone");
  return [...query.keys()].every((key) => key === "profileTimeZonePrecondition") &&
    markers.length === 1 &&
    markers[0] === "v1" &&
    expectedTimeZone !== null &&
    isSupportedTimeZone(expectedTimeZone)
    ? expectedTimeZone
    : null;
}

function guardedDiaryCreateTimeZone(request: Request): string | null {
  const query = new URL(request.url).searchParams;
  const allowed = new Set(["date", "profileTimeZonePrecondition"]);
  if ([...query.keys()].some((key) => !allowed.has(key))) return null;
  const dates = query.getAll("date");
  const markers = query.getAll("profileTimeZonePrecondition");
  const expectedTimeZone = request.headers.get("x-expected-profile-time-zone");
  if (
    dates.length !== 1 ||
    !isLocalDate(dates[0]) ||
    markers.length !== 1 ||
    markers[0] !== "v1" ||
    expectedTimeZone === null ||
    !isSupportedTimeZone(expectedTimeZone)
  ) {
    return null;
  }
  return expectedTimeZone;
}

export async function proxyDiaryCreate(request: Request): Promise<Response> {
  if (!isTrustedMutationRequest(request)) {
    return privateJsonError(403, "This diary request did not come from this application.");
  }
  const expectedTimeZone = guardedDiaryCreateTimeZone(request);
  const operationId = validatedIdempotencyKey(request);
  if (!expectedTimeZone || !operationId) {
    return privateJsonError(400, "The diary request is invalid.");
  }
  let body: unknown;
  try {
    body = await readBoundedJson(request, 16_384);
  } catch {
    return privateJsonError(400, "The diary request must contain valid JSON.");
  }
  const upstream = await authenticatedFetch(
    request,
    "/v1/diary/entries?profileTimeZonePrecondition=v1",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": operationId,
        "x-expected-profile-time-zone": expectedTimeZone,
      },
      body: JSON.stringify(body),
    },
  );
  return mutationResponse(upstream);
}

export async function proxyDiaryChange(
  request: Request,
  entryId: string,
  method: "DELETE" | "PATCH",
): Promise<Response> {
  if (!isTrustedMutationRequest(request)) {
    return privateJsonError(403, "This diary request did not come from this application.");
  }
  const operationId = validatedIdempotencyKey(request);
  const ifMatch = validatedIfMatch(request);
  if (!operationId || !ifMatch) {
    return privateJsonError(400, "The diary request is missing its revision or operation key.");
  }
  let body: unknown = null;
  let changesTimestamp = false;
  if (method === "PATCH") {
    try {
      const parsed = await readBoundedJson(request, 16_384);
      changesTimestamp =
        typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed) &&
        Object.hasOwn(parsed, "occurredAt");
      body = parsed;
    } catch {
      return privateJsonError(400, "The diary request must contain valid JSON.");
    }
  }
  const context = guardedDiaryCorrectionContext(request, changesTimestamp);
  if (!context) return privateJsonError(400, "The diary correction guard is invalid.");
  const marker = `?diaryCorrectionProtocol=v1${
    context.expectedTimeZone ? "&profileTimeZonePrecondition=v1" : ""
  }`;
  const upstream = await authenticatedFetch(request, `/v1/diary/entries/${entryId}${marker}`, {
    method,
    headers: {
      ...(method === "PATCH" ? { "content-type": "application/json" } : {}),
      "idempotency-key": operationId,
      "if-match": ifMatch,
      ...(context.expectedTimeZone
        ? { "x-expected-profile-time-zone": context.expectedTimeZone }
        : {}),
    },
    ...(method === "PATCH" ? { body: JSON.stringify(body) } : {}),
  });
  const common = {
    entryId,
    entryRevision: revisionFromIfMatch(ifMatch),
    operationId,
    sourceLocalDate: context.date,
  } as const;
  return method === "DELETE"
    ? correctionMutationResponse(upstream, {
        ...common,
        body: null,
        expectedTimeZone: null,
        kind: "delete",
      })
    : correctionMutationResponse(upstream, {
        ...common,
        body,
        expectedTimeZone: context.expectedTimeZone,
        kind: "update",
      });
}

export async function proxyDiaryRepeat(request: Request, entryId: string): Promise<Response> {
  if (!isTrustedMutationRequest(request)) {
    return privateJsonError(403, "This diary request did not come from this application.");
  }
  const operationId = validatedIdempotencyKey(request);
  const ifMatch = validatedIfMatch(request);
  const context = guardedDiaryCorrectionContext(request, true);
  if (!operationId || !ifMatch || !context?.expectedTimeZone) {
    return privateJsonError(
      400,
      "The repeat request is missing its source revision, operation key, or time-zone guard.",
    );
  }
  let body: unknown;
  try {
    body = await readBoundedJson(request, 4_096);
  } catch {
    return privateJsonError(400, "The repeat request must contain valid JSON.");
  }
  const upstream = await authenticatedFetch(
    request,
    `/v1/diary/corrections/entries/${entryId}/repeat?profileTimeZonePrecondition=v1`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": operationId,
        "if-match": ifMatch,
        "x-expected-profile-time-zone": context.expectedTimeZone,
      },
      body: JSON.stringify(body),
    },
  );
  return correctionMutationResponse(upstream, {
    entryId,
    entryRevision: revisionFromIfMatch(ifMatch),
    body,
    expectedTimeZone: context.expectedTimeZone,
    kind: "repeat",
    operationId,
    sourceLocalDate: context.date,
  });
}

export async function proxyDiaryReorder(request: Request, localDate: string): Promise<Response> {
  if (!isTrustedMutationRequest(request)) {
    return privateJsonError(403, "This diary request did not come from this application.");
  }
  if (!isLocalDate(localDate)) return privateJsonError(400, "The diary date is invalid.");
  const operationId = validatedIdempotencyKey(request);
  const ifMatch = validatedIfMatch(request);
  const expectedTimeZone = guardedDiaryReorderTimeZone(request);
  const expectedOrderDigest = request.headers.get("x-expected-diary-order-digest");
  if (
    !operationId ||
    !ifMatch ||
    !expectedTimeZone ||
    expectedOrderDigest === null ||
    !/^[0-9a-f]{64}$/u.test(expectedOrderDigest)
  ) {
    return privateJsonError(400, "The diary reorder preconditions are invalid.");
  }
  let body: unknown;
  try {
    body = await readBoundedJson(request, 4_096);
  } catch {
    return privateJsonError(400, "The diary reorder must contain valid compact JSON.");
  }
  const upstream = await authenticatedFetch(
    request,
    `/v1/diary/days/${localDate}/order?profileTimeZonePrecondition=v1`,
    {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "idempotency-key": operationId,
        "if-match": ifMatch,
        "x-expected-diary-order-digest": expectedOrderDigest,
        "x-expected-profile-time-zone": expectedTimeZone,
      },
      body: JSON.stringify(body),
    },
  );
  if (!upstream.ok) return safeUpstreamProblem(upstream, "The diary order could not be saved.");
  try {
    const result = parseDiaryDayReorder(await upstream.json());
    const receipt = result.receipt;
    const canonicalDigest = await diaryDayOrderDigest(
      receipt.localDate,
      receipt.timeZone,
      receipt.groups,
    );
    if (
      receipt.operationId !== operationId ||
      receipt.localDate !== localDate ||
      receipt.expectedDayRevision !== revisionFromIfMatch(ifMatch) ||
      receipt.resultingDayRevision !== String(BigInt(receipt.expectedDayRevision) + 1n) ||
      receipt.previousOrderDigest !== expectedOrderDigest ||
      receipt.orderDigest !== canonicalDigest
    ) {
      throw new TypeError("The diary reorder receipt did not match the request.");
    }
    return Response.json(
      { data: result },
      {
        status: upstream.status,
        headers: { ...PRIVATE_RESPONSE_HEADERS, etag: `"${receipt.resultingDayRevision}"` },
      },
    );
  } catch {
    return privateJsonError(502, "The diary service returned an invalid reorder receipt.");
  }
}
