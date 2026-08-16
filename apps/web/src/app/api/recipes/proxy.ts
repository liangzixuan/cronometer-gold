import { isUuid, parseDiaryMutation } from "../../../lib/diary";
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
import {
  parseRecipeCollection,
  parseRecipeMutation,
  parseRecipeResponse,
} from "../../../lib/recipes-goals";

function recipeListPath(request: Request): string | null {
  const incoming = new URL(request.url);
  const values = new URLSearchParams();
  for (const key of incoming.searchParams.keys()) {
    if (!new Set(["cursor", "limit"]).has(key) || incoming.searchParams.getAll(key).length !== 1) {
      return null;
    }
  }
  const cursor = incoming.searchParams.get("cursor");
  const limit = incoming.searchParams.get("limit");
  if (cursor !== null) {
    if (cursor.length < 1 || cursor.length > 512) return null;
    values.set("cursor", cursor);
  }
  if (limit !== null) {
    if (!/^[1-9][0-9]?$/u.test(limit) || Number(limit) > 50) return null;
    values.set("limit", limit);
  }
  const query = values.toString();
  return `/v1/recipes${query ? `?${query}` : ""}`;
}

async function checkedResponse(
  upstream: Response,
  parser: (value: unknown) => unknown,
  fallback: string,
): Promise<Response> {
  if (!upstream.ok) return safeUpstreamProblem(upstream, fallback);
  try {
    const raw: unknown = await upstream.json();
    parser(raw);
    const etag = upstream.headers.get("etag");
    return Response.json(raw, {
      status: upstream.status,
      headers: { ...PRIVATE_RESPONSE_HEADERS, ...(etag ? { etag } : {}) },
    });
  } catch {
    return privateJsonError(502, "The recipe service returned an invalid response.");
  }
}

export async function proxyRecipeList(request: Request): Promise<Response> {
  const path = recipeListPath(request);
  if (!path) return privateJsonError(400, "The recipe list request is invalid.");
  return checkedResponse(
    await authenticatedFetch(request, path),
    parseRecipeCollection,
    "Recipes could not be loaded.",
  );
}

export async function proxyRecipeGet(request: Request, recipeId: string): Promise<Response> {
  if (!isUuid(recipeId)) return privateJsonError(400, "The recipe identifier is invalid.");
  return checkedResponse(
    await authenticatedFetch(request, `/v1/recipes/${recipeId}`),
    parseRecipeResponse,
    "The recipe could not be loaded.",
  );
}

async function mutationInput(
  request: Request,
): Promise<{ readonly operationId: string; readonly body: string } | Response> {
  if (!isTrustedMutationRequest(request)) {
    return privateJsonError(403, "This recipe request did not come from this application.");
  }
  const operationId = validatedIdempotencyKey(request);
  if (!operationId) return privateJsonError(400, "The recipe operation key is invalid.");
  try {
    return { operationId, body: JSON.stringify(await readBoundedJson(request, 131_072)) };
  } catch {
    return privateJsonError(400, "The recipe request must contain bounded JSON.");
  }
}

export async function proxyRecipeCreate(request: Request): Promise<Response> {
  const input = await mutationInput(request);
  if (input instanceof Response) return input;
  const upstream = await authenticatedFetch(request, "/v1/recipes", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": input.operationId },
    body: input.body,
  });
  return checkedResponse(upstream, parseRecipeMutation, "The recipe could not be created.");
}

export async function proxyRecipeRevision(request: Request, recipeId: string): Promise<Response> {
  if (!isUuid(recipeId)) return privateJsonError(400, "The recipe identifier is invalid.");
  const input = await mutationInput(request);
  if (input instanceof Response) return input;
  const ifMatch = validatedIfMatch(request);
  if (!ifMatch) return privateJsonError(400, "The recipe revision precondition is missing.");
  const upstream = await authenticatedFetch(request, `/v1/recipes/${recipeId}/revisions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": input.operationId,
      "if-match": ifMatch,
    },
    body: input.body,
  });
  return checkedResponse(upstream, parseRecipeMutation, "The recipe could not be revised.");
}

export async function proxyRecipeLog(request: Request, recipeId: string): Promise<Response> {
  if (!isUuid(recipeId)) return privateJsonError(400, "The recipe identifier is invalid.");
  const input = await mutationInput(request);
  if (input instanceof Response) return input;
  const upstream = await authenticatedFetch(request, `/v1/recipes/${recipeId}/log`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": input.operationId },
    body: input.body,
  });
  if (!upstream.ok) return safeUpstreamProblem(upstream, "The recipe could not be logged.");
  try {
    const raw: unknown = await upstream.json();
    parseDiaryMutation(raw);
    return Response.json(raw, { status: upstream.status, headers: PRIVATE_RESPONSE_HEADERS });
  } catch {
    return privateJsonError(502, "The diary service returned an invalid recipe log response.");
  }
}
