export interface SecureSessionEnvelope {
  readonly accessToken: string;
  readonly expiresAt: string;
}

const TOKEN = /^[A-Za-z0-9_-]{43,128}$/u;

export function serializeSessionEnvelope(value: SecureSessionEnvelope): string {
  if (!TOKEN.test(value.accessToken)) throw new TypeError("Invalid access token.");
  const expiry = new Date(value.expiresAt);
  if (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= Date.now()) {
    throw new RangeError("The session expiry is invalid.");
  }
  return JSON.stringify(value);
}

export function parseSessionEnvelope(
  value: string | null,
  now = new Date(),
): SecureSessionEnvelope | null {
  if (value === null || value.length > 8_500) return null;
  try {
    const candidate: unknown = JSON.parse(value);
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate))
      return null;
    const record = candidate as Record<string, unknown>;
    if (
      Object.keys(record).length !== 2 ||
      typeof record.accessToken !== "string" ||
      !TOKEN.test(record.accessToken) ||
      typeof record.expiresAt !== "string"
    )
      return null;
    const expiry = new Date(record.expiresAt);
    if (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= now.getTime() + 30_000)
      return null;
    return { accessToken: record.accessToken, expiresAt: record.expiresAt };
  } catch {
    return null;
  }
}
