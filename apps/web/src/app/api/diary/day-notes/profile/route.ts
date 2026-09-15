import { isUuid, parseSession } from "../../../../../lib/diary";
import {
  authenticatedFetch,
  PRIVATE_RESPONSE_HEADERS,
  privateJsonError,
  safeUpstreamProblem,
} from "../../../../../lib/private-api";

export const dynamic = "force-dynamic";

// The note conflict flow needs current profile metadata without granting a
// delayed note-owned response authority to clear another login's cookie.
export async function GET(request: Request): Promise<Response> {
  const expected = request.headers.get("x-expected-owner-user-id");
  if (!expected || !isUuid(expected) || new URL(request.url).search) {
    return privateJsonError(400, "Choose the initiating note account.");
  }
  const upstream = await authenticatedFetch(request, "/v1/auth/me");
  if (!upstream.ok) {
    const safe = await safeUpstreamProblem(upstream, "The note profile could not be verified.");
    const problem = await safe.json();
    return privateJsonError(safe.status, "The note profile could not be verified.", problem.code);
  }
  try {
    if (upstream.status !== 200) throw new TypeError("Invalid profile status.");
    const session = parseSession(await upstream.json());
    if (session.user.id !== expected.toLowerCase()) {
      return privateJsonError(409, "The signed-in account changed.", "DAY_NOTE_OWNER_CHANGED");
    }
    return Response.json({ data: session }, { headers: PRIVATE_RESPONSE_HEADERS });
  } catch {
    return privateJsonError(502, "The note profile service returned an invalid response.");
  }
}
