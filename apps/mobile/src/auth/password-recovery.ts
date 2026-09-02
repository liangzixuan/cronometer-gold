import { apiUrl } from "../api/private-api";

const MAXIMUM_RESPONSE_BYTES = 4_096;
const RECOVERY_EMAIL =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/u;

export const PASSWORD_RECOVERY_REQUEST_PATH = "/v1/auth/password-recovery/request";
export const PASSWORD_RECOVERY_ACCEPTED_MESSAGE =
  "If the email belongs to an eligible account, look for recovery instructions. Delivery can take a few minutes.";

export type PasswordRecoveryFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface PasswordRecoveryRequestOptions {
  readonly fetcher?: PasswordRecoveryFetch;
  readonly signal?: AbortSignal;
}

export class PasswordRecoveryRequestError extends Error {
  constructor() {
    super("Password recovery could not be requested. Please try again.");
    this.name = "PasswordRecoveryRequestError";
  }
}

class PasswordRecoveryResponseTooLargeError extends Error {
  constructor() {
    super("The password-recovery response exceeded its hard byte limit.");
    this.name = "PasswordRecoveryResponseTooLargeError";
  }
}

export function normalizePasswordRecoveryEmail(value: string): string {
  const email = value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
  if (email.length < 3 || email.length > 254 || !RECOVERY_EMAIL.test(email)) {
    throw new RangeError("Enter a valid email address.");
  }
  return email;
}

function cancelBody(body: ReadableStream<Uint8Array> | null): void {
  if (!body) return;
  void body.cancel().catch(() => undefined);
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d{1,10}$/u.test(declaredLength) || Number(declaredLength) > MAXIMUM_RESPONSE_BYTES)
  ) {
    cancelBody(response.body);
    throw new PasswordRecoveryResponseTooLargeError();
  }
  if (!response.body) throw new TypeError("The password-recovery response was empty.");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (totalBytes + next.value.byteLength > MAXIMUM_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new PasswordRecoveryResponseTooLargeError();
      }
      chunks.push(next.value);
      totalBytes += next.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}

function isAcceptedResponse(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  if (Object.keys(value).length !== 1) return false;
  const data = (value as Record<string, unknown>).data;
  return (
    typeof data === "object" &&
    data !== null &&
    !Array.isArray(data) &&
    Object.keys(data).length === 1 &&
    (data as Record<string, unknown>).status === "accepted"
  );
}

export async function requestPasswordRecovery(
  apiBase: URL,
  emailInput: string,
  options: PasswordRecoveryRequestOptions = {},
): Promise<void> {
  const email = normalizePasswordRecoveryEmail(emailInput);
  const fetcher = options.fetcher ?? fetch;
  const response = await fetcher(apiUrl(apiBase, PASSWORD_RECOVERY_REQUEST_PATH).toString(), {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ email }),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (response.status !== 202) {
    cancelBody(response.body);
    throw new PasswordRecoveryRequestError();
  }

  try {
    const body = await readBoundedJson(response);
    if (!isAcceptedResponse(body)) throw new TypeError("Invalid password-recovery response.");
  } catch {
    throw new PasswordRecoveryRequestError();
  }
}
