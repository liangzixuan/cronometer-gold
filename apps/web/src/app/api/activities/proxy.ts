import {
  parseActivityCreateBody,
  parseActivityDay,
  parseActivityMutation,
  parseActivityUpdateBody,
} from "../../../lib/activity";
import { isLocalDate, isUuid } from "../../../lib/diary";
import {
  authenticatedFetch,
  isTrustedMutationRequest,
  PRIVATE_RESPONSE_HEADERS,
  privateJsonError,
  readBoundedJson,
  safeUpstreamProblem,
  validatedIdempotencyKey,
  validatedIfMatch,
} from "../../../lib/private-api";

const ACTIVITY_DAY_ETAG = /^"a-[A-Za-z0-9_-]{43}"$/u;

function activityDate(request: Request): string | null {
  const values = new URL(request.url).searchParams;
  return [...values.keys()].every((key) => key === "date") && values.getAll("date").length === 1
    ? isLocalDate(values.get("date"))
      ? values.get("date")
      : null
    : null;
}

function hasNoQuery(request: Request): boolean {
  return [...new URL(request.url).searchParams.keys()].length === 0;
}

function expectedOwnerUserId(request: Request): string | null {
  const value = request.headers.get("x-expected-owner-user-id");
  return value && isUuid(value) ? value.toLowerCase() : null;
}

function guardedMutationTimeZone(request: Request): string | null {
  const query = new URL(request.url).searchParams;
  const values = query.getAll("profileTimeZonePrecondition");
  const candidate = request.headers.get("x-expected-profile-time-zone");
  if (
    [...query.keys()].some((key) => key !== "profileTimeZonePrecondition") ||
    values.length !== 1 ||
    values[0] !== "v1" ||
    !candidate ||
    candidate.length > 63
  ) {
    return null;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(new Date(0));
    return candidate;
  } catch {
    return null;
  }
}

function requireActivityDayEtag(upstream: Response): string {
  const etag = upstream.headers.get("etag");
  if (!etag || !ACTIVITY_DAY_ETAG.test(etag)) {
    throw new TypeError("The activity service returned an invalid representation ETag.");
  }
  return etag;
}

function mutationResponseHeaders(revision?: string): Record<string, string> {
  return {
    ...PRIVATE_RESPONSE_HEADERS,
    ...(revision === undefined ? {} : { etag: `"${revision}"` }),
  };
}

export async function proxyActivityGet(request: Request): Promise<Response> {
  const date = activityDate(request);
  const expectedOwner = expectedOwnerUserId(request);
  if (!date || !expectedOwner) {
    return privateJsonError(400, "Choose a valid activity local date and account.");
  }
  const upstream = await authenticatedFetch(
    request,
    `/v1/activities?date=${encodeURIComponent(date)}`,
    { headers: { "x-expected-owner-user-id": expectedOwner } },
  );
  if (!upstream.ok) {
    return safeUpstreamProblem(upstream, "Activity entries could not be loaded.");
  }
  try {
    const day = parseActivityDay(await upstream.json());
    if (day.localDate !== date) throw new TypeError("The activity service returned another day.");
    const etag = requireActivityDayEtag(upstream);
    return Response.json(
      { data: day },
      { status: upstream.status, headers: { ...PRIVATE_RESPONSE_HEADERS, etag } },
    );
  } catch {
    return privateJsonError(502, "The activity service returned an invalid response.");
  }
}

async function activityMutationResponse(upstream: Response): Promise<Response> {
  if (!upstream.ok) {
    return safeUpstreamProblem(upstream, "The activity entry could not be changed.");
  }
  try {
    const mutation = parseActivityMutation(await upstream.json());
    return Response.json(
      { data: mutation },
      {
        status: upstream.status,
        headers: mutationResponseHeaders(mutation.entry?.revision),
      },
    );
  } catch {
    return privateJsonError(502, "The activity service returned an invalid response.");
  }
}

export async function proxyActivityCreate(request: Request): Promise<Response> {
  if (!isTrustedMutationRequest(request)) {
    return privateJsonError(403, "This activity request did not come from this application.");
  }
  const operationId = validatedIdempotencyKey(request);
  const expectedTimeZone = guardedMutationTimeZone(request);
  const expectedOwner = expectedOwnerUserId(request);
  if (!operationId || !expectedTimeZone || !expectedOwner) {
    return privateJsonError(400, "The activity request is invalid.");
  }
  let body: unknown;
  try {
    body = parseActivityCreateBody(await readBoundedJson(request, 2_048));
  } catch {
    return privateJsonError(400, "Enter a valid activity name, duration, calories, and time.");
  }
  const upstream = await authenticatedFetch(
    request,
    "/v1/activities/entries?profileTimeZonePrecondition=v1",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": operationId,
        "x-expected-owner-user-id": expectedOwner,
        "x-expected-profile-time-zone": expectedTimeZone,
      },
      body: JSON.stringify(body),
    },
  );
  return activityMutationResponse(upstream);
}

export async function proxyActivityChange(
  request: Request,
  entryId: string,
  method: "DELETE" | "PATCH",
): Promise<Response> {
  if (!isTrustedMutationRequest(request)) {
    return privateJsonError(403, "This activity request did not come from this application.");
  }
  if (method === "DELETE" && request.body !== null) {
    return privateJsonError(400, "An activity delete request cannot include a body.");
  }
  const operationId = validatedIdempotencyKey(request);
  const ifMatch = validatedIfMatch(request);
  const expectedOwner = expectedOwnerUserId(request);
  if (!operationId || !ifMatch || !expectedOwner) {
    return privateJsonError(400, "The activity request is missing its revision or operation key.");
  }
  let body: string | undefined;
  let expectedTimeZone: string | null = null;
  if (method === "PATCH") {
    try {
      const parsed = parseActivityUpdateBody(await readBoundedJson(request, 4_096));
      const changesOccurredAt = parsed.occurredAt !== undefined;
      expectedTimeZone = changesOccurredAt ? guardedMutationTimeZone(request) : null;
      if (
        (changesOccurredAt && !expectedTimeZone) ||
        (!changesOccurredAt &&
          (!hasNoQuery(request) || request.headers.has("x-expected-profile-time-zone")))
      ) {
        return privateJsonError(400, "The activity time-zone precondition is invalid.");
      }
      body = JSON.stringify(parsed);
    } catch {
      return privateJsonError(400, "Enter a valid activity update.");
    }
  } else if (!hasNoQuery(request) || request.headers.has("x-expected-profile-time-zone")) {
    return privateJsonError(400, "The activity delete request is invalid.");
  }
  const query = expectedTimeZone ? "?profileTimeZonePrecondition=v1" : "";
  const upstream = await authenticatedFetch(request, `/v1/activities/entries/${entryId}${query}`, {
    method,
    headers: {
      ...(method === "PATCH" ? { "content-type": "application/json" } : {}),
      "idempotency-key": operationId,
      "if-match": ifMatch,
      "x-expected-owner-user-id": expectedOwner,
      ...(expectedTimeZone ? { "x-expected-profile-time-zone": expectedTimeZone } : {}),
    },
    ...(body === undefined ? {} : { body }),
  });
  return activityMutationResponse(upstream);
}
