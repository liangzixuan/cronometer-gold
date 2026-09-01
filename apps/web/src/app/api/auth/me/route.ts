import { parseSession } from "../../../../lib/diary";
import {
  authenticatedFetch,
  PRIVATE_RESPONSE_HEADERS,
  safeUpstreamProblem,
} from "../../../../lib/private-api";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const upstream = await authenticatedFetch(request, "/v1/auth/me");
  if (!upstream.ok) return safeUpstreamProblem(upstream, "The session could not be verified.");
  if (upstream.status !== 200) {
    if (upstream.body) void upstream.body.cancel().catch(() => undefined);
    return Response.json(
      { error: "The account service returned an invalid response." },
      { status: 502, headers: PRIVATE_RESPONSE_HEADERS },
    );
  }
  try {
    const session = parseSession(await upstream.json());
    return Response.json({ data: session }, { headers: PRIVATE_RESPONSE_HEADERS });
  } catch {
    return Response.json(
      { error: "The account service returned an invalid response." },
      { status: 502, headers: PRIVATE_RESPONSE_HEADERS },
    );
  }
}
