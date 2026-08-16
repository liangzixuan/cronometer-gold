import { proxyRecipeRevision } from "../../proxy";

export const dynamic = "force-dynamic";

interface Context {
  readonly params: Promise<{ readonly recipeId: string }>;
}

export async function POST(request: Request, context: Context): Promise<Response> {
  const { recipeId } = await context.params;
  return proxyRecipeRevision(request, recipeId);
}
