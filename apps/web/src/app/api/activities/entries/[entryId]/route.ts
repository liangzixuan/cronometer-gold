import { validatedEntryId } from "../../../../../lib/private-api";
import { proxyActivityChange } from "../../proxy";

export const dynamic = "force-dynamic";

interface ActivityEntryRouteContext {
  readonly params: Promise<{ readonly entryId: string }>;
}

async function handle(
  request: Request,
  context: ActivityEntryRouteContext,
  method: "DELETE" | "PATCH",
): Promise<Response> {
  const { entryId: rawEntryId } = await context.params;
  const entryId = validatedEntryId(rawEntryId);
  if (!entryId) {
    return Response.json(
      { error: "The activity entry identifier is invalid." },
      {
        status: 400,
        headers: {
          "cache-control": "no-store, max-age=0",
          pragma: "no-cache",
          "x-content-type-options": "nosniff",
        },
      },
    );
  }
  return proxyActivityChange(request, entryId, method);
}

export async function PATCH(
  request: Request,
  context: ActivityEntryRouteContext,
): Promise<Response> {
  return handle(request, context, "PATCH");
}

export async function DELETE(
  request: Request,
  context: ActivityEntryRouteContext,
): Promise<Response> {
  return handle(request, context, "DELETE");
}
