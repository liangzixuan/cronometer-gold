import { validatedEntryId } from "../../../../../lib/private-api";
import { proxyDiaryChange } from "../../proxy";

export const dynamic = "force-dynamic";

interface EntryRouteContext {
  readonly params: Promise<{ readonly entryId: string }>;
}

async function handle(
  request: Request,
  context: EntryRouteContext,
  method: "DELETE" | "PATCH",
): Promise<Response> {
  const { entryId: rawEntryId } = await context.params;
  const entryId = validatedEntryId(rawEntryId);
  if (!entryId) {
    return Response.json(
      { error: "The diary entry identifier is invalid." },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }
  return proxyDiaryChange(request, entryId, method);
}

export async function PATCH(request: Request, context: EntryRouteContext): Promise<Response> {
  return handle(request, context, "PATCH");
}

export async function DELETE(request: Request, context: EntryRouteContext): Promise<Response> {
  return handle(request, context, "DELETE");
}
