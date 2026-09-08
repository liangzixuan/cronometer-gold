import { proxyNutritionReport } from "../proxy";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return proxyNutritionReport(request);
}
