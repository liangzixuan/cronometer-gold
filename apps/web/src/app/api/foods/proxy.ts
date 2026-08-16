import { buildAllowedUpstreamUrl, resolveInternalApiBase } from "../../../lib/food-search";

interface ProxyFoodGetInput<T> {
  readonly request: Request;
  readonly upstreamPath: string;
  readonly allowedQueryFields: readonly string[];
  readonly parser: (value: unknown) => T;
  readonly notFoundAllowed?: boolean;
}

const safeHeaders = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
} as const;

function jsonError(status: number, message: string): Response {
  return Response.json(
    { error: message },
    {
      status,
      headers: safeHeaders,
    },
  );
}

export async function proxyFoodGet<T>(input: ProxyFoodGetInput<T>): Promise<Response> {
  let apiBase: URL;
  try {
    apiBase = resolveInternalApiBase(process.env.API_INTERNAL_URL);
  } catch {
    return jsonError(503, "Food search is temporarily unavailable.");
  }

  let target: URL;
  try {
    target = buildAllowedUpstreamUrl(
      input.request.url,
      input.upstreamPath,
      input.allowedQueryFields,
      apiBase.href,
    );
  } catch {
    return jsonError(400, "The food-search request is invalid.");
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: "GET",
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: input.request.signal,
    });
  } catch {
    return jsonError(503, "Food search is temporarily unavailable.");
  }

  if (upstream.status === 404 && input.notFoundAllowed) {
    return jsonError(404, "No current public food matches this barcode.");
  }
  if (upstream.status === 400) {
    return jsonError(400, "The food-search request is invalid.");
  }
  if (upstream.status === 503) {
    return jsonError(503, "Food search is temporarily unavailable.");
  }
  if (upstream.status !== 200) {
    return jsonError(502, "Food search returned an invalid response.");
  }

  try {
    const body: unknown = await upstream.json();
    const parsed = input.parser(body);
    return Response.json(parsed, {
      status: 200,
      headers: {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return jsonError(502, "Food search returned an invalid response.");
  }
}
