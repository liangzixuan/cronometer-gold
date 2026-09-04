import { isLocalDate } from "../../../lib/diary";
import {
  parseHydrationCreateBody,
  parseHydrationDay,
  parseHydrationMutation,
  parseHydrationUpdateBody,
} from "../../../lib/hydration";
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

const HYDRATION_DAY_ETAG = /^"h-[A-Za-z0-9_-]{43}"$/u;

function hydrationDate(request: Request): string | null {
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

function guardedCreateTimeZone(request: Request): string | null {
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

function requireHydrationDayEtag(upstream: Response): string {
  const etag = upstream.headers.get("etag");
  if (!etag || !HYDRATION_DAY_ETAG.test(etag)) {
    throw new TypeError("The hydration service returned an invalid representation ETag.");
  }
  return etag;
}

function mutationResponseHeaders(revision?: string): Record<string, string> {
  return {
    ...PRIVATE_RESPONSE_HEADERS,
    ...(revision === undefined ? {} : { etag: `"${revision}"` }),
  };
}

export async function proxyHydrationGet(request: Request): Promise<Response> {
  const date = hydrationDate(request);
  if (!date) return privateJsonError(400, "Choose a valid hydration local date.");
  const upstream = await authenticatedFetch(
    request,
    `/v1/hydration?date=${encodeURIComponent(date)}`,
  );
  if (!upstream.ok) {
    return safeUpstreamProblem(upstream, "Hydration entries could not be loaded.");
  }
  try {
    const day = parseHydrationDay(await upstream.json());
    if (day.localDate !== date) throw new TypeError("The hydration service returned another day.");
    const etag = requireHydrationDayEtag(upstream);
    return Response.json(
      { data: day },
      { status: upstream.status, headers: { ...PRIVATE_RESPONSE_HEADERS, etag } },
    );
  } catch {
    return privateJsonError(502, "The hydration service returned an invalid response.");
  }
}

async function hydrationMutationResponse(upstream: Response): Promise<Response> {
  if (!upstream.ok) {
    return safeUpstreamProblem(upstream, "The hydration entry could not be changed.");
  }
  try {
    const mutation = parseHydrationMutation(await upstream.json());
    return Response.json(
      { data: mutation },
      {
        status: upstream.status,
        headers: mutationResponseHeaders(mutation.entry?.revision),
      },
    );
  } catch {
    return privateJsonError(502, "The hydration service returned an invalid response.");
  }
}

export async function proxyHydrationCreate(request: Request): Promise<Response> {
  if (!isTrustedMutationRequest(request)) {
    return privateJsonError(403, "This hydration request did not come from this application.");
  }
  const operationId = validatedIdempotencyKey(request);
  const expectedTimeZone = guardedCreateTimeZone(request);
  if (!operationId || !expectedTimeZone) {
    return privateJsonError(400, "The hydration request is invalid.");
  }
  let body: unknown;
  try {
    body = parseHydrationCreateBody(await readBoundedJson(request, 2_048));
  } catch {
    return privateJsonError(400, "Enter a valid hydration amount and time.");
  }
  const upstream = await authenticatedFetch(
    request,
    "/v1/hydration/entries?profileTimeZonePrecondition=v1",
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
  return hydrationMutationResponse(upstream);
}

export async function proxyHydrationChange(
  request: Request,
  entryId: string,
  method: "DELETE" | "PATCH",
): Promise<Response> {
  if (!isTrustedMutationRequest(request)) {
    return privateJsonError(403, "This hydration request did not come from this application.");
  }
  if (method === "DELETE" && request.body !== null) {
    return privateJsonError(400, "A hydration delete request cannot include a body.");
  }
  const operationId = validatedIdempotencyKey(request);
  const ifMatch = validatedIfMatch(request);
  if (!operationId || !ifMatch || !hasNoQuery(request)) {
    return privateJsonError(400, "The hydration request is missing its revision or operation key.");
  }
  let body: string | undefined;
  if (method === "PATCH") {
    try {
      body = JSON.stringify(parseHydrationUpdateBody(await readBoundedJson(request, 2_048)));
    } catch {
      return privateJsonError(400, "Enter a valid hydration update.");
    }
  }
  const upstream = await authenticatedFetch(request, `/v1/hydration/entries/${entryId}`, {
    method,
    headers: {
      ...(method === "PATCH" ? { "content-type": "application/json" } : {}),
      "idempotency-key": operationId,
      "if-match": ifMatch,
    },
    ...(body === undefined ? {} : { body }),
  });
  return hydrationMutationResponse(upstream);
}
