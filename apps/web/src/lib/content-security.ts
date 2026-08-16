export function contentSecurityPolicy(nonce: string, production: boolean): string {
  if (!/^[A-Za-z0-9+/=_-]{16,128}$/u.test(nonce)) throw new TypeError("Invalid CSP nonce.");
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "connect-src 'self'",
    "font-src 'self' data:",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data: blob:",
    "object-src 'none'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${production ? "" : " 'unsafe-eval'"}`,
    "style-src 'self' 'unsafe-inline'",
    "upgrade-insecure-requests",
  ].join("; ");
}
