import { parseFoodAutocompleteResponse } from "../../../../lib/food-search";
import { proxyFoodGet } from "../proxy";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return proxyFoodGet({
    request,
    upstreamPath: "/v1/foods/autocomplete",
    allowedQueryFields: ["query", "intent", "market", "language", "limit"],
    parser: parseFoodAutocompleteResponse,
  });
}
