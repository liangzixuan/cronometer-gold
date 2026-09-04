import { validatedEntryId } from "../../../../../lib/private-api";
import { proxyHydrationChange } from "../../proxy";

export const dynamic = "force-dynamic";

interface HydrationEntryRouteContext {
  readonly params: Promise<{ readonly entryId: string }>;
}

async function handle(
  request: Request,
  context: HydrationEntryRouteContext,
  method: "DELETE" | "PATCH",
): Promise<Response> {
  const { entryId: rawEntryId } = await context.params;
  const entryId = validatedEntryId(rawEntryId);
  if (!entryId) {
    return Response.json(
      { error: "The hydration entry identifier is invalid." },
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
  return proxyHydrationChange(request, entryId, method);
}

export async function PATCH(
  request: Request,
  context: HydrationEntryRouteContext,
): Promise<Response> {
  return handle(request, context, "PATCH");
}

export async function DELETE(
  request: Request,
  context: HydrationEntryRouteContext,
): Promise<Response> {
  return handle(request, context, "DELETE");
}
