import { X509Certificate } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { checkServerIdentity } from "node:tls";

const failure = () => new Error("Development runtime HTTP request failed");
const requireValue = (value) => {
  if (!value) throw failure();
};
const endpoints = Object.freeze({
  api: Object.freeze({ origin: "http://api:4000", name: "api", port: 4000, secure: false }),
  capture: Object.freeze({
    origin: "https://mail-capture:8025",
    name: "mail-capture",
    port: 8025,
    secure: true,
  }),
  meili: Object.freeze({
    origin: "https://meili.internal:8443",
    name: "meili.internal",
    port: 8443,
    secure: true,
  }),
});
const MAX_BODY = 2_097_152;
const privateAddress = (value) =>
  typeof value === "string" &&
  isIP(value) === 4 &&
  (/^10\./u.test(value) ||
    /^192\.168\./u.test(value) ||
    /^172\.(1[6-9]|2[0-9]|3[01])\./u.test(value));

/** Use only addresses just bound to inspected owned Docker containers. No resolver or proxy is used. */
export function createDevelopmentRuntimeHttp(configuration, execution = {}) {
  const { ca, signal, assertOwnership } = configuration;
  requireValue(typeof assertOwnership === "function" && signal instanceof AbortSignal);
  requireValue(
    typeof ca === "string" && Buffer.byteLength(ca) <= 65_536 && new X509Certificate(ca).ca,
  );
  const addresses = Object.freeze({ ...configuration.addresses });
  requireValue(Object.keys(addresses).sort().join(",") === "api,capture,meili");
  requireValue(Object.values(addresses).every(privateAddress));
  const stop = Date.parse(configuration.notAfterUtc),
    started = Date.now(),
    mono = performance.now();
  requireValue(
    Number.isFinite(stop) &&
      new Date(stop).toISOString() === configuration.notAfterUtc &&
      stop > started &&
      stop - started <= 3_600_000,
  );
  const guard = () => {
    signal.throwIfAborted();
    requireValue(
      Date.now() >= started && Date.now() < stop && performance.now() - mono < stop - started,
    );
  };
  const nativeRequest =
    execution.request ??
    ((secure, options, callback) => (secure ? httpsRequest : httpRequest)(options, callback));

  async function fetchOwned(channel, path, init = {}) {
    let request, response;
    try {
      requireValue(Object.hasOwn(endpoints, channel));
      const endpoint = endpoints[channel];
      requireValue(
        endpoint &&
          typeof path === "string" &&
          path.length <= 4096 &&
          path.startsWith("/") &&
          !path.startsWith("//") &&
          !/[\s#\\]/u.test(path),
      );
      const method = init.method ?? "GET";
      requireValue(["GET", "POST", "PATCH", "DELETE"].includes(method));
      requireValue(channel !== "capture" || method === "GET");
      requireValue(
        method !== "DELETE" ||
          (channel === "meili" && /^\/indexes\/[A-Za-z0-9_-]{1,400}$/u.test(path)),
      );
      requireValue(init.redirect === undefined || init.redirect === "error");
      requireValue(init.signal === undefined || init.signal instanceof AbortSignal);
      const headers = new Headers(init.headers);
      requireValue(
        [...headers].length <= 16 &&
          [...headers].every(
            ([name, value]) =>
              [
                "authorization",
                "content-type",
                "accept",
                "idempotency-key",
                "if-match",
                "x-expected-profile-time-zone",
              ].includes(name) &&
              value.length <= 8192 &&
              !/[\r\n]/u.test(value),
          ),
      );
      requireValue(init.body === undefined || typeof init.body === "string");
      const body = init.body === undefined ? undefined : Buffer.from(init.body);
      requireValue(body === undefined || body.length <= 65_536);
      requireValue(method !== "GET" || body === undefined);
      guard();
      init.signal?.throwIfAborted();
      const cancellation = AbortSignal.any([
        signal,
        ...(init.signal ? [init.signal] : []),
        AbortSignal.timeout(Math.max(1, Math.min(5000, stop - Date.now()))),
      ]);
      cancellation.throwIfAborted();
      await assertOwnership(channel, addresses[channel], cancellation);
      cancellation.throwIfAborted();
      guard();
      const result = await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error, value) => {
          if (settled) return;
          settled = true;
          cancellation.removeEventListener("abort", abort);
          if (error) {
            response?.destroy();
            request?.destroy();
            reject(failure());
          } else resolve(value);
        };
        const abort = () => finish(failure());
        cancellation.addEventListener("abort", abort, { once: true });
        if (cancellation.aborted) {
          abort();
          return;
        }
        request = nativeRequest(
          endpoint.secure,
          {
            protocol: endpoint.secure ? "https:" : "http:",
            hostname: addresses[channel],
            port: endpoint.port,
            path,
            method,
            headers: {
              ...Object.fromEntries(headers),
              host: new URL(endpoint.origin).host,
              ...(body ? { "content-length": String(body.length) } : {}),
            },
            agent: false,
            maxHeaderSize: 8192,
            ...(endpoint.secure
              ? {
                  ca,
                  rejectUnauthorized: true,
                  servername: endpoint.name,
                  checkServerIdentity: (_host, certificate) =>
                    checkServerIdentity(endpoint.name, certificate),
                }
              : {}),
          },
          (incoming) => {
            response = incoming;
            const chunks = [];
            let count = 0;
            incoming.on("error", () => finish(failure()));
            incoming.on("aborted", () => finish(failure()));
            incoming.on("data", (chunk) => {
              count += chunk.length;
              if (count > MAX_BODY) finish(failure());
              else chunks.push(Buffer.from(chunk));
            });
            incoming.on("end", () => {
              try {
                requireValue(
                  !cancellation.aborted &&
                    incoming.complete === true &&
                    Number.isInteger(incoming.statusCode) &&
                    incoming.statusCode >= 200 &&
                    incoming.statusCode <= 599 &&
                    !(incoming.statusCode >= 300 && incoming.statusCode < 400),
                );
                requireValue(
                  (incoming.rawHeaders ?? []).length <= 128 &&
                    Object.keys(incoming.trailers ?? {}).length === 0,
                );
                requireValue(
                  incoming.headers["content-encoding"] === undefined ||
                    incoming.headers["content-encoding"] === "identity",
                );
                const declared = incoming.headers["content-length"];
                requireValue(
                  declared === undefined ||
                    (/^(0|[1-9][0-9]*)$/u.test(declared) && Number(declared) === count),
                );
                const raw = Buffer.concat(chunks);
                new TextDecoder("utf-8", { fatal: true }).decode(raw);
                const value = new Response(incoming.statusCode === 204 ? null : raw, {
                  status: incoming.statusCode,
                  headers: incoming.headers,
                });
                requireValue(incoming.statusCode !== 204 || count === 0);
                finish(undefined, value);
              } catch {
                finish(failure());
              }
            });
            incoming.on("close", () => {
              if (!settled) finish(failure());
            });
          },
        );
        request.on("error", () => finish(failure()));
        if (cancellation.aborted) abort();
        else request.end(body);
      });
      guard();
      await assertOwnership(channel, addresses[channel], cancellation);
      cancellation.throwIfAborted();
      guard();
      init.signal?.throwIfAborted();
      return result;
    } catch {
      response?.destroy();
      request?.destroy();
      throw failure();
    }
  }
  return Object.freeze({
    request: fetchOwned,
    async meiliFetch(input, init) {
      const url = new URL(input);
      requireValue(
        url.origin === endpoints.meili.origin && !url.username && !url.password && !url.hash,
      );
      return fetchOwned("meili", url.pathname + url.search, init);
    },
  });
}
