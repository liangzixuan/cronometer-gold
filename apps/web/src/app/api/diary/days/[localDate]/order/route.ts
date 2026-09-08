import { isLocalDate } from "../../../../../../lib/diary";
import { privateJsonError } from "../../../../../../lib/private-api";
import { proxyDiaryReorder } from "../../../proxy";

export const dynamic = "force-dynamic";

interface DiaryOrderRouteContext {
  readonly params: Promise<{ readonly localDate: string }>;
}

export async function PUT(request: Request, context: DiaryOrderRouteContext): Promise<Response> {
  const localDate = (await context.params).localDate;
  if (!isLocalDate(localDate)) return privateJsonError(400, "The diary date is invalid.");
  return proxyDiaryReorder(request, localDate);
}
