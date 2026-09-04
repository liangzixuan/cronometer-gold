import { proxyHydrationGet } from "./proxy";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return proxyHydrationGet(request);
}
