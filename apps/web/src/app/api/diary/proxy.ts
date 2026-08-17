import { parseDiaryDay, parseDiaryMutation } from "../../../lib/diary";
import {
  authenticatedFetch,
  isTrustedMutationRequest,
  PRIVATE_RESPONSE_HEADERS,
  privateJsonError,
  readBoundedJson,
  safeUpstreamProblem,
  validatedDiaryDate,
  validatedIdempotencyKey,
  validatedIfMatch,
} from "../../../lib/private-api";

async function diaryResponse(upstream: Response): Promise<Response> {
  if (!upstream.ok)
    return safeUpstreamProblem(upstream, "The diary request could not be completed.");
  try {
    const diary = parseDiaryDay(await upstream.json());
    const etag = upstream.headers.get("etag") ?? `"${diary.revision}"`;
    return Response.json(
      { data: diary },
      { status: upstream.status, headers: { ...PRIVATE_RESPONSE_HEADERS, etag } },
    );
  } catch {
    return privateJsonError(502, "The diary service returned an invalid response.");
  }
}

export async function proxyDiaryGet(request: Request): Promise<Response> {
  const date = validatedDiaryDate(request);
  if (!date) return privateJsonError(400, "Choose a valid diary date.");
  const upstream = await authenticatedFetch(request, `/v1/diary?date=${encodeURIComponent(date)}`);
  return diaryResponse(upstream);
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

export async function proxyDiaryCreate(request: Request): Promise<Response> {
  if (!isTrustedMutationRequest(request)) {
    return privateJsonError(403, "This diary request did not come from this application.");
  }
  const date = validatedDiaryDate(request);
  const operationId = validatedIdempotencyKey(request);
  if (!date || !operationId) return privateJsonError(400, "The diary request is invalid.");
  let body: unknown;
  try {
    body = await readBoundedJson(request, 16_384);
  } catch {
    return privateJsonError(400, "The diary request must contain valid JSON.");
  }
  const upstream = await authenticatedFetch(request, "/v1/diary/entries", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": operationId },
    body: JSON.stringify(body),
  });
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
  const date = validatedDiaryDate(request);
  const operationId = validatedIdempotencyKey(request);
  const ifMatch = validatedIfMatch(request);
  if (!date || !operationId || !ifMatch) {
    return privateJsonError(400, "The diary request is missing its revision or operation key.");
  }
  let body: string | undefined;
  if (method === "PATCH") {
    try {
      body = JSON.stringify(await readBoundedJson(request, 16_384));
    } catch {
      return privateJsonError(400, "The diary request must contain valid JSON.");
    }
  }
  const upstream = await authenticatedFetch(request, `/v1/diary/entries/${entryId}`, {
    method,
    headers: {
      ...(method === "PATCH" ? { "content-type": "application/json" } : {}),
      "idempotency-key": operationId,
      "if-match": ifMatch,
    },
    ...(body === undefined ? {} : { body }),
  });
  return mutationResponse(upstream);
}

export async function proxyDiaryRepeat(request: Request, entryId: string): Promise<Response> {
  if (!isTrustedMutationRequest(request)) {
    return privateJsonError(403, "This diary request did not come from this application.");
  }
  const operationId = validatedIdempotencyKey(request);
  const ifMatch = validatedIfMatch(request);
  if (!operationId || !ifMatch) {
    return privateJsonError(
      400,
      "The repeat request is missing its source revision or operation key.",
    );
  }
  let body: string;
  try {
    body = JSON.stringify(await readBoundedJson(request, 4_096));
  } catch {
    return privateJsonError(400, "The repeat request must contain valid JSON.");
  }
  const upstream = await authenticatedFetch(request, `/v1/diary/entries/${entryId}/repeat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": operationId,
      "if-match": ifMatch,
    },
    body,
  });
  return mutationResponse(upstream);
}
