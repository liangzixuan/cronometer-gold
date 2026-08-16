import { proxyTargetableNutrients } from "../../goals/proxy";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return proxyTargetableNutrients(request);
}
