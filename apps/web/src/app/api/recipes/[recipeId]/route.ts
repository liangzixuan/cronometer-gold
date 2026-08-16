import { proxyRecipeGet } from "../proxy";

export const dynamic = "force-dynamic";

interface Context {
  readonly params: Promise<{ readonly recipeId: string }>;
}

export async function GET(request: Request, context: Context): Promise<Response> {
  const { recipeId } = await context.params;
  return proxyRecipeGet(request, recipeId);
}
