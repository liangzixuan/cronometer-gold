import { observeServer } from "../../../../lib/appwrite-runtime.cjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = {
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
};

export function GET(request: Request): Response {
  if (new URL(request.url).search) {
    return Response.json({ error: "Invalid observation request" }, { status: 400, headers });
  }
  try {
    return Response.json(observeServer(), { headers });
  } catch {
    return Response.json({ error: "Runtime observation unavailable" }, { status: 503, headers });
  }
}
