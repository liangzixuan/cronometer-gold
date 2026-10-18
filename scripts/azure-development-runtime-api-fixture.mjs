import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { PassThrough } from "node:stream";

// Actual API factory/services/repositories above raw private HTTP, Meili fetch and Mailpit replies.
export function runtimeApiWire(state) {
  let runtime, priorFetch;
  const applications = [],
    messages = [],
    requests = [];
  const auth = (credential) =>
    `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`;
  const respond = (callback, status, headers, body) => {
    const bytes = Buffer.from(body),
      incoming = new PassThrough();
    Object.assign(incoming, {
      statusCode: status,
      complete: true,
      headers,
      rawHeaders: Object.entries(headers).flat(),
      trailers: {},
    });
    callback(incoming);
    incoming.end(bytes);
  };
  const rawRequest = (perform, callback) => {
    const req = new EventEmitter();
    req.destroy = () => {
      req.destroyed = true;
    };
    req.end = (raw) => {
      void (async () => {
        try {
          await perform(raw, (status, headers, body) => {
            if (!req.destroyed) respond(callback, status, headers, body);
          });
        } catch (error) {
          if (!req.destroyed) req.emit("error", error);
        }
      })();
    };
    return req;
  };
  const sendMail = (url, options, callback) => {
    assert.equal(String(url), "https://mail-capture:8025/api/v1/send");
    assert.equal(options.method, "POST");
    assert.equal(options.servername, "mail-capture");
    assert.equal(options.ca, state.config.input.caCertificate);
    assert.equal(options.rejectUnauthorized, true);
    assert.equal(options.headers.authorization, auth(state.input.mail.send));
    return rawRequest(async (raw, done) => {
      assert(
        Buffer.isBuffer(raw) &&
          raw.length <= 32768 &&
          raw.length === options.headers["content-length"],
      );
      const value = JSON.parse(raw.toString());
      assert.deepEqual(Object.keys(value).sort(), ["From", "Subject", "Text", "To"]);
      assert.equal(value.To.length, 1);
      const id = String(messages.length + 1).padStart(22, "0");
      messages.push({
        ID: id,
        To: value.To.map(({ Email }) => ({ Address: Email })),
        Text: value.Text,
        raw: value,
      });
      requests.push({ channel: "send", method: "POST", path: "/api/v1/send" });
      done(200, { "content-type": "application/json" }, JSON.stringify({ ID: id }));
    }, callback);
  };
  const request = (secure, options, callback) => {
    if (options.hostname === "172.28.0.4") return state.meili.request(secure, options, callback);
    const capture = options.hostname === "172.29.0.2";
    assert(capture || options.hostname === "172.28.0.5");
    assert.equal(secure, capture);
    assert.equal(options.port, capture ? 8025 : 4000);
    assert.equal(options.headers.host, capture ? "mail-capture:8025" : "api:4000");
    if (capture) {
      assert.equal(options.servername, "mail-capture");
      assert.equal(options.ca, state.config.input.caCertificate);
      assert.equal(options.rejectUnauthorized, true);
    }
    return rawRequest(async (raw, done) => {
      const row = {
        channel: capture ? "capture" : "api",
        method: options.method,
        path: options.path,
      };
      requests.push(row);
      if (!capture) {
        assert(runtime, "Actual API must be constructed before application traffic");
        const response = await runtime.app.inject({
          method: options.method,
          url: options.path,
          headers: options.headers,
          ...(raw ? { payload: raw } : {}),
        });
        row.status = response.statusCode;
        if (response.statusCode >= 400) row.problem = response.body;
        done(response.statusCode, response.headers, response.body);
        return;
      }
      assert.equal(options.method, "GET");
      if (options.headers.authorization === auth(state.input.mail.send)) {
        done(401, { "www-authenticate": "Basic realm=controlled-capture" }, "");
        return;
      }
      assert.equal(options.headers.authorization, auth(state.input.mail.review));
      if (options.path === "/api/v1/messages?start=0&limit=50") {
        done(
          200,
          { "content-type": "application/json" },
          JSON.stringify({
            total: messages.length,
            messages: messages.map(({ ID, To }) => ({ ID, To })),
          }),
        );
        return;
      }
      const id = /^\/api\/v1\/message\/([A-Za-z0-9]+)$/u.exec(options.path)?.[1];
      const message = messages.find((row) => row.ID === id);
      assert(message);
      done(
        200,
        { "content-type": "application/json" },
        JSON.stringify({ ID: message.ID, To: message.To, Text: message.Text }),
      );
    }, callback);
  };
  const fetchMeili = async (input, init = {}) => {
    const url = new URL(input);
    assert.equal(url.origin, "https://meili.internal:8443");
    assert.equal(url.pathname, "/indexes/foods/search");
    assert.equal(init.method, "POST");
    assert.equal(
      new Headers(init.headers).get("authorization"),
      `Bearer ${state.config.model.services.api.environment.MEILI_SEARCH_KEY}`,
    );
    const body = JSON.parse(init.body);
    assert.equal(body.q, "Blueberries");
    const hits = state.meili.indexes.get("foods");
    assert(hits?.length === 1);
    return Response.json({
      hits: structuredClone(hits),
      query: body.q,
      processingTimeMs: 0,
      offset: body.offset ?? 0,
      limit: body.limit,
      estimatedTotalHits: hits.length,
    });
  };
  return {
    applications,
    messages,
    requests,
    request,
    sendMail,
    async start() {
      assert(!runtime && !priorFetch);
      priorFetch = globalThis.fetch;
      globalThis.fetch = fetchMeili;
      try {
        const { createApiApplicationRuntime } = await import("../apps/api/dist/server.js");
        runtime = await createApiApplicationRuntime(
          {
            ...state.config.model.services.api.environment,
            NODE_EXTRA_CA_CERTS: join(state.input.root, "pki/ca.crt"),
            EXPORT_ARTIFACT_READ_SPOOL_DIR: join(state.input.root, "data/api/export-read-spool"),
          },
          { logger: false },
        );
        applications.push(runtime);
      } catch (error) {
        globalThis.fetch = priorFetch;
        priorFetch = undefined;
        throw error;
      }
    },
    async close() {
      try {
        if (runtime) await runtime.close();
      } finally {
        runtime = undefined;
        if (priorFetch) globalThis.fetch = priorFetch;
        priorFetch = undefined;
      }
    },
  };
}
