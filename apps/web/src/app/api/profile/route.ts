import { parseSession } from "../../../lib/diary";
import {
  authenticatedFetch,
  isTrustedMutationRequest,
  PRIVATE_RESPONSE_HEADERS,
  privateJsonError,
  readBoundedJson,
  safeUpstreamProblem,
  validatedIfMatch,
} from "../../../lib/private-api";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request): Promise<Response> {
  if (!isTrustedMutationRequest(request)) {
    return privateJsonError(403, "This profile request did not come from this application.");
  }
  const ifMatch = validatedIfMatch(request);
  if (!ifMatch) {
    return privateJsonError(400, "The profile request is missing its revision.");
  }
  let body: unknown;
  try {
    body = await readBoundedJson(request, 16_384);
  } catch {
    return privateJsonError(400, "The profile request must contain valid JSON.");
  }
  const upstream = await authenticatedFetch(request, "/v1/profile", {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "if-match": ifMatch,
    },
    body: JSON.stringify(body),
  });
  if (!upstream.ok) return safeUpstreamProblem(upstream, "The profile could not be updated.");
  try {
    const raw: unknown = await upstream.json();
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new TypeError();
    const data = (raw as Record<string, unknown>).data;
    if (typeof data !== "object" || data === null || Array.isArray(data)) throw new TypeError();
    const profile = (data as Record<string, unknown>).profile;
    const session = parseSession({
      data: { user: { id: "local", email: "local@invalid.test", emailVerified: false }, profile },
    });
    const etag = upstream.headers.get("etag") ?? `"${session.profile.revision}"`;
    return Response.json(
      { data: { profile: session.profile } },
      { headers: { ...PRIVATE_RESPONSE_HEADERS, etag } },
    );
  } catch {
    return privateJsonError(502, "The profile service returned an invalid response.");
  }
}
