import { isDayNoteText, parseDayNoteMutationResponse } from "@nutrition-tracker/contracts";

import { readDayNote } from "../../../../../lib/day-notes";
import { isLocalDate, isUuid } from "../../../../../lib/diary";
import {
  authenticatedFetch,
  isTrustedMutationRequest,
  PRIVATE_RESPONSE_HEADERS,
  privateJsonError,
  readBoundedJson,
  safeUpstreamProblem,
  validatedIdempotencyKey,
} from "../../../../../lib/private-api";

export const dynamic = "force-dynamic";
interface Context {
  readonly params: Promise<{ readonly date: string }>;
}

function owner(request: Request, date: string): string | null {
  const value = request.headers.get("x-expected-owner-user-id");
  return isLocalDate(date) && !new URL(request.url).search && value && isUuid(value)
    ? value.toLowerCase()
    : null;
}

async function problem(upstream: Response): Promise<Response> {
  const response = await safeUpstreamProblem(upstream, "The day note service is unavailable.");
  // A delayed private request must not erase a newer login's cookie. The current
  // component owner handles 401; existing authentication routes retain cookie control.
  const safe = await response.json();
  return privateJsonError(response.status, "The day note service is unavailable.", safe.code);
}

export async function GET(request: Request, context: Context): Promise<Response> {
  const { date } = await context.params;
  const ownerUserId = owner(request, date);
  if (!ownerUserId) return privateJsonError(400, "Choose a valid note date and account.");
  const upstream = await authenticatedFetch(request, `/v1/diary/day-notes/${date}`, {
    headers: { "x-expected-owner-user-id": ownerUserId },
  });
  if (!upstream.ok) return problem(upstream);
  try {
    if (upstream.status !== 200) throw new TypeError("Invalid note status.");
    const note = readDayNote(
      await upstream.json(),
      upstream.headers.get("etag"),
      ownerUserId,
      date,
    );
    return Response.json(
      { data: note },
      {
        headers: { ...PRIVATE_RESPONSE_HEADERS, etag: `"${note.revision}"` },
      },
    );
  } catch {
    return privateJsonError(502, "The day note service returned an invalid response.");
  }
}

export async function PUT(request: Request, context: Context): Promise<Response> {
  if (!isTrustedMutationRequest(request)) {
    return privateJsonError(403, "This note request did not come from this application.");
  }
  const { date } = await context.params;
  const ownerUserId = owner(request, date);
  const key = validatedIdempotencyKey(request)?.toLowerCase();
  const match = request.headers.get("if-match");
  const zone = request.headers.get("x-expected-profile-time-zone");
  if (match === null)
    return privateJsonError(428, "A note revision is required.", "PRECONDITION_REQUIRED");
  let validZone = false;
  try {
    validZone =
      !!zone &&
      zone.length <= 63 &&
      new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone === zone;
  } catch {
    /* Invalid zones fail before a request. */
  }
  if (
    !ownerUserId ||
    !key ||
    !/^"(?:0|[1-9][0-9]{0,18})"$/u.test(match) ||
    BigInt(match.slice(1, -1)) > 9_223_372_036_854_775_807n ||
    !validZone ||
    !zone
  ) {
    return privateJsonError(400, "The note request guards are invalid.");
  }
  let body: { readonly note: string | null };
  try {
    const value = await readBoundedJson(request, 24_128);
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).length !== 1 ||
      !Object.hasOwn(value, "note")
    ) {
      return privateJsonError(400, "The note body is invalid.");
    }
    const note = (value as { note: unknown }).note;
    if (!isDayNoteText(note))
      return privateJsonError(
        422,
        "Use a valid note of up to 2,000 characters.",
        "DAY_NOTE_VALIDATION",
      );
    body = { note };
  } catch {
    return privateJsonError(400, "The note must contain bounded valid JSON.");
  }
  const upstream = await authenticatedFetch(request, `/v1/diary/day-notes/${date}`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      "x-expected-owner-user-id": ownerUserId,
      "x-expected-profile-time-zone": zone,
      "idempotency-key": key,
      "if-match": match,
    },
    body: JSON.stringify(body),
  });
  if (!upstream.ok) return problem(upstream);
  try {
    if (upstream.status !== 200) throw new TypeError("Invalid mutation status.");
    const result = parseDayNoteMutationResponse(await upstream.json());
    const { note, receipt } = result.data;
    if (
      receipt.operationId !== key ||
      receipt.ownerUserId !== ownerUserId ||
      receipt.localDate !== date ||
      receipt.expectedRevision !== match.slice(1, -1) ||
      receipt.expectedProfileTimeZone !== zone ||
      note.note !== body.note ||
      upstream.headers.get("etag") !== `"${note.revision}"`
    ) {
      throw new TypeError("Mismatched note receipt.");
    }
    return Response.json(result, {
      headers: { ...PRIVATE_RESPONSE_HEADERS, etag: `"${note.revision}"` },
    });
  } catch {
    return privateJsonError(502, "The day note service returned an invalid receipt.");
  }
}
