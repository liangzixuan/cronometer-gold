import { parseFoodBarcodeResponse } from "../../../../../lib/food-search";
import { proxyFoodGet } from "../../proxy";

export const dynamic = "force-dynamic";

interface BarcodeRouteContext {
  readonly params: Promise<{ readonly gtin: string }>;
}

export async function GET(request: Request, context: BarcodeRouteContext): Promise<Response> {
  const { gtin } = await context.params;
  if (!/^(?:[0-9]{8}|[0-9]{12}|[0-9]{13}|[0-9]{14})$/u.test(gtin)) {
    return Response.json(
      { error: "A barcode must contain exactly 8, 12, 13, or 14 digits." },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }

  return proxyFoodGet({
    request,
    upstreamPath: `/v1/foods/barcodes/${gtin}`,
    allowedQueryFields: ["market"],
    parser: parseFoodBarcodeResponse,
    notFoundAllowed: true,
  });
}
