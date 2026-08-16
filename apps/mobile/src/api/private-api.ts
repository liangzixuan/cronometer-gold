export async function jsonBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export function responseError(value: unknown, fallback: string): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fallback;
  const candidate =
    (value as Record<string, unknown>).detail ?? (value as Record<string, unknown>).error;
  return typeof candidate === "string" && candidate.length <= 500 ? candidate : fallback;
}

export function authenticatedHeaders(
  accessToken: string,
  extra: Readonly<Record<string, string>> = {},
): Readonly<Record<string, string>> {
  return { accept: "application/json", authorization: `Bearer ${accessToken}`, ...extra };
}

export function apiUrl(base: URL, path: string): URL {
  if (!path.startsWith("/v1/") || path.includes("..")) throw new TypeError("Invalid API path.");
  return new URL(path, base);
}
