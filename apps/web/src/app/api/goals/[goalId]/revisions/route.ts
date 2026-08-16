import { proxyGoalRevision } from "../../proxy";

export const dynamic = "force-dynamic";

interface Context {
  readonly params: Promise<{ readonly goalId: string }>;
}

export async function POST(request: Request, context: Context): Promise<Response> {
  const { goalId } = await context.params;
  return proxyGoalRevision(request, goalId);
}
