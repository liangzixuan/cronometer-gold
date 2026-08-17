import { privateJsonError, validatedEntryId } from "../../../../../../lib/private-api";
import { proxyDiaryRepeat } from "../../../proxy";

export const dynamic = "force-dynamic";

interface EntryRouteContext {
  readonly params: Promise<{ readonly entryId: string }>;
}

export async function POST(request: Request, context: EntryRouteContext): Promise<Response> {
  const entryId = validatedEntryId((await context.params).entryId);
  if (!entryId) return privateJsonError(400, "The diary entry identifier is invalid.");
  return proxyDiaryRepeat(request, entryId);
}
