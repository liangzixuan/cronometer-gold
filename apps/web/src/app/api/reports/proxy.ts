import { nutritionReportDates, parseNutritionReport } from "../../../lib/nutrition-reports";
import {
  authenticatedFetch,
  PRIVATE_RESPONSE_HEADERS,
  privateJsonError,
  safeUpstreamProblem,
} from "../../../lib/private-api";

export function validatedNutritionReportRange(
  request: Request,
): { readonly from: string; readonly to: string } | null {
  const incoming = new URL(request.url);
  if ([...incoming.searchParams.keys()].some((key) => key !== "from" && key !== "to")) {
    return null;
  }
  const fromValues = incoming.searchParams.getAll("from");
  const toValues = incoming.searchParams.getAll("to");
  if (fromValues.length !== 1 || toValues.length !== 1) return null;
  const from = fromValues[0];
  const to = toValues[0];
  if (!from || !to) return null;
  try {
    nutritionReportDates(from, to);
    return { from, to };
  } catch {
    return null;
  }
}

export async function proxyNutritionReport(request: Request): Promise<Response> {
  const range = validatedNutritionReportRange(request);
  if (!range) {
    return privateJsonError(400, "Choose an inclusive report range of 1 to 31 local days.");
  }
  const upstream = await authenticatedFetch(
    request,
    `/v1/reports/nutrition?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`,
  );
  if (!upstream.ok) {
    return safeUpstreamProblem(upstream, "The nutrition report could not be loaded.");
  }
  try {
    const raw: unknown = await upstream.json();
    parseNutritionReport(raw, range);
    return Response.json(raw, { status: upstream.status, headers: PRIVATE_RESPONSE_HEADERS });
  } catch {
    return privateJsonError(502, "The nutrition-report service returned an invalid response.");
  }
}
