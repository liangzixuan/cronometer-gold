import { apiUrl, authenticatedHeaders, jsonBody, responseError } from "../api/private-api";
import type { PendingErasureEnvelope } from "./pending-erasure";
import { parseErasureResponse } from "./retention";

export async function submitPendingErasure(
  input: {
    readonly apiBase: URL;
    readonly accessToken: string;
    readonly pending: PendingErasureEnvelope;
  },
  fetcher: (url: string, init?: RequestInit) => Promise<Response> = fetch,
) {
  let response: Response;
  try {
    response = await fetcher(apiUrl(input.apiBase, "/v1/account/erasure").toString(), {
      method: "POST",
      headers: authenticatedHeaders(input.accessToken, {
        "content-type": "application/json",
        "idempotency-key": input.pending.operationId,
        "x-reauthentication-token": input.pending.reauthenticationToken,
      }),
      body: input.pending.serializedBody,
    });
  } catch {
    throw new Error("The exact protected account-erasure response was not received.");
  }
  const body = await jsonBody(response);
  if (!response.ok) {
    throw new Error(responseError(body, "The exact protected erasure replay was not accepted."));
  }
  const result = parseErasureResponse(body);
  if (!result.statusCapability) {
    throw new TypeError("The exact protected erasure replay omitted its status capability.");
  }
  return result;
}
