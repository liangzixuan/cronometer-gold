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
import {
  parseCurrentGoal,
  parseGoalMutation,
  parseGoalProgress,
  parseTargetableNutrients,
} from "../../../lib/recipes-goals";

function datePath(request: Request, upstreamPath: string): string | null {
  const incoming = new URL(request.url);
  if ([...incoming.searchParams.keys()].some((key) => key !== "date")) return null;
  const dates = incoming.searchParams.getAll("date");
  const date = dates.length === 1 ? dates[0] : null;
  return isLocalDate(date) ? `${upstreamPath}?date=${encodeURIComponent(date)}` : null;
}

async function checked(
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
    return privateJsonError(502, "The nutrition-goal service returned an invalid response.");
  }
}

export async function proxyCurrentGoal(request: Request): Promise<Response> {
  const path = datePath(request, "/v1/goals/current");
  if (!path) return privateJsonError(400, "Choose a valid local goal date.");
  return checked(
    await authenticatedFetch(request, path),
    parseCurrentGoal,
    "The current goal could not be loaded.",
  );
}

export async function proxyGoalProgress(request: Request): Promise<Response> {
  const path = datePath(request, "/v1/goals/progress");
  if (!path) return privateJsonError(400, "Choose a valid local progress date.");
  return checked(
    await authenticatedFetch(request, path),
    parseGoalProgress,
    "Goal progress could not be loaded.",
  );
}

export async function proxyTargetableNutrients(request: Request): Promise<Response> {
  return checked(
    await authenticatedFetch(request, "/v1/nutrients/targetable"),
    parseTargetableNutrients,
    "Targetable nutrients could not be loaded.",
  );
}

async function mutationInput(
  request: Request,
): Promise<{ readonly operationId: string; readonly body: string } | Response> {
  if (!isTrustedMutationRequest(request)) {
    return privateJsonError(403, "This goal request did not come from this application.");
  }
  const operationId = validatedIdempotencyKey(request);
  if (!operationId) return privateJsonError(400, "The goal operation key is invalid.");
  try {
    return { operationId, body: JSON.stringify(await readBoundedJson(request, 131_072)) };
  } catch {
    return privateJsonError(400, "The goal request must contain bounded JSON.");
  }
}

export async function proxyGoalCreate(request: Request): Promise<Response> {
  const input = await mutationInput(request);
  if (input instanceof Response) return input;
  return checked(
    await authenticatedFetch(request, "/v1/goals", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": input.operationId },
      body: input.body,
    }),
    parseGoalMutation,
    "The nutrition goal could not be created.",
  );
}

export async function proxyGoalRevision(request: Request, goalId: string): Promise<Response> {
  if (!isUuid(goalId)) return privateJsonError(400, "The goal identifier is invalid.");
  const input = await mutationInput(request);
  if (input instanceof Response) return input;
  const ifMatch = validatedIfMatch(request);
  if (!ifMatch) return privateJsonError(400, "The goal revision precondition is missing.");
  return checked(
    await authenticatedFetch(request, `/v1/goals/${goalId}/revisions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": input.operationId,
        "if-match": ifMatch,
      },
      body: input.body,
    }),
    parseGoalMutation,
    "The nutrition goal could not be revised.",
  );
}
