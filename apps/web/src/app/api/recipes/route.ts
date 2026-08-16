import { proxyRecipeCreate, proxyRecipeList } from "./proxy";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return proxyRecipeList(request);
}

export async function POST(request: Request): Promise<Response> {
  return proxyRecipeCreate(request);
}
