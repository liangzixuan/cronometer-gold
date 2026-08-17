import { privateJsonError } from "../../../../../../../lib/private-api";
import { proxyExportArtifact } from "../../../../proxy";

export const dynamic = "force-dynamic";

interface RouteContext {
  readonly params: Promise<{ readonly exportId: string; readonly format: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { exportId, format } = await context.params;
  try {
    return await proxyExportArtifact(request, exportId, format);
  } catch {
    return privateJsonError(503, "The export artifact is temporarily unavailable.");
  }
}
