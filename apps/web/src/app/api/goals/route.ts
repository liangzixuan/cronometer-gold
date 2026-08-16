import { proxyGoalCreate } from "./proxy";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return proxyGoalCreate(request);
}
