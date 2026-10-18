import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createDevelopmentRuntimeHttp } from "./azure-development-runtime-http.mjs";

const source = await readFile(
  new URL("../apps/api/test/hosted-mailpit-email-delivery.test.ts", import.meta.url),
  "utf8",
);
const ca = JSON.parse(/const ca =\s*("(?:[^"\\]|\\.)*")/u.exec(source)[1]);
function fixture(input = {}) {
  const controller = new AbortController(),
    calls = [],
    ownership = [];
  let response, request;
  const transport = createDevelopmentRuntimeHttp(
    {
      addresses: { api: "172.25.0.2", capture: "172.26.0.2", meili: "172.25.0.3" },
      ca,
      signal: controller.signal,
      notAfterUtc: new Date(Date.now() + 60_000).toISOString(),
      async assertOwnership(channel, address, signal) {
        ownership.push([channel, address]);
        if (input.inspectOwnership) await input.inspectOwnership(ownership.length, signal);
        if (input.ownershipFail === ownership.length) throw new Error("private ownership evidence");
        if (input.afterOwnership && ownership.length === 2) input.afterOwnership();
      },
    },
    {
      request(secure, options, callback) {
        calls.push({ secure, options });
        request = new EventEmitter();
        request.destroy = () => {
          request.destroyed = true;
        };
        request.end = (body) => {
          calls.at(-1).body = body;
          queueMicrotask(() => {
            response = new PassThrough();
            Object.assign(response, {
              statusCode: input.status ?? 200,
              complete: input.complete ?? true,
              headers: input.headers ?? { "content-type": "application/json" },
              rawHeaders: [],
              trailers: input.trailers ?? {},
            });
            callback(response);
            if (!input.stall) response.end(input.body ?? '{"status":"ok"}');
            else input.started?.();
          });
        };
        return request;
      },
    },
  );
  return {
    ...transport,
    controller,
    calls,
    ownership,
    request: transport.request,
    native: () => ({ request, response }),
  };
}

test("uses inspected addresses with fixed Host/SNI, verified explicit CA and no agent or proxy", async () => {
  const f = fixture();
  const result = await f.request("capture", "/api/v1/messages?start=0&limit=50", {
    headers: { authorization: "Basic c3ludGhldGlj" },
  });
  assert.deepEqual(await result.json(), { status: "ok" });
  const { secure, options } = f.calls[0];
  assert.equal(secure, true);
  assert.equal(options.hostname, "172.26.0.2");
  assert.equal(options.servername, "mail-capture");
  assert.equal(options.headers.host, "mail-capture:8025");
  assert.equal(options.rejectUnauthorized, true);
  assert.equal(options.ca, ca);
  assert.equal(options.agent, false);
  assert.equal(options.maxHeaderSize, 8192);
  assert.equal(typeof options.checkServerIdentity, "function");
  assert.deepEqual(f.ownership, [
    ["capture", "172.26.0.2"],
    ["capture", "172.26.0.2"],
  ]);
});

test("Meili fetch uses the existing client origin while connecting only to the owned TLS address", async () => {
  const f = fixture();
  const result = await f.meiliFetch("https://meili.internal:8443/indexes/foods/search", {
    method: "POST",
    body: '{"q":"Blueberries"}',
    headers: { "content-type": "application/json" },
  });
  assert.equal(result.status, 200);
  assert.equal(f.calls[0].options.hostname, "172.25.0.3");
  assert.equal(f.calls[0].options.servername, "meili.internal");
  assert.equal(f.calls[0].body.toString(), '{"q":"Blueberries"}');
  await assert.rejects(f.meiliFetch("https://elsewhere.invalid/indexes"));
  assert.equal(f.calls.length, 1);
});

for (const [label, input] of Object.entries({
  redirect: { status: 302 },
  incomplete: { complete: false },
  compressed: { headers: { "content-encoding": "gzip" } },
  trailer: { trailers: { receipt: "unqualified" } },
  oversized: { body: Buffer.alloc(2_097_153) },
  invalidUtf8: { body: Buffer.from([255]) },
  wrongLength: { headers: { "content-length": "999" } },
}))
  test(`refuses ${label} instead of accepting an exit/status alone`, async () => {
    const f = fixture(input);
    await assert.rejects(
      f.request("api", "/ready"),
      /^Error: Development runtime HTTP request failed$/u,
    );
    assert.equal(f.native().request.destroyed, true);
  });

test("rejects inherited channel names, credential headers and mutation methods before dispatch", async () => {
  const f = fixture();
  for (const [channel, path, init] of [
    ["__proto__", "/ready", {}],
    ["toString", "/ready", {}],
    ["api", "//unowned.invalid", {}],
    ["api", "/ready#fragment", {}],
    ["api", "/ready", { headers: { host: "unowned.invalid" } }],
    ["capture", "/api/v1/messages", { method: "POST" }],
    ["api", "/ready", { method: "DELETE" }],
    ["api", "/ready", { body: "unexpected" }],
  ])
    await assert.rejects(f.request(channel, path, init));
  assert.equal(f.calls.length, 0);
});

test("ownership rejection before dispatch and after response suppresses successful observation", async () => {
  for (const ownershipFail of [1, 2]) {
    const f = fixture({ ownershipFail });
    await assert.rejects(f.request("api", "/ready"), /Development runtime HTTP request failed/u);
    assert.equal(f.calls.length, ownershipFail === 1 ? 0 : 1);
  }
});

test("cancels a stalled controlled response and destroys only its owned request", async () => {
  let started;
  const begun = new Promise((resolve) => {
    started = resolve;
  });
  const f = fixture({ stall: true, started });
  const work = f.request("api", "/ready");
  await begun;
  f.controller.abort();
  await assert.rejects(work, /Development runtime HTTP request failed/u);
  assert.equal(f.native().request.destroyed, true);
});

test("caller cancellation during post-response ownership readback cannot return success", async () => {
  const caller = new AbortController();
  const f = fixture({ afterOwnership: () => caller.abort() });
  await assert.rejects(f.request("api", "/ready", { signal: caller.signal }));
});

test("native permission denial remains a readable response for the caller's positive/negative protocol", async () => {
  const f = fixture({
    status: 401,
    headers: { "www-authenticate": 'Basic realm="Mailpit"' },
    body: "denied",
  });
  const result = await f.request("capture", "/api/v1/messages?start=0&limit=50");
  assert.equal(result.status, 401);
  assert.equal(result.headers.get("www-authenticate"), 'Basic realm="Mailpit"');
});

test("admits only the maintained Meili index cleanup DELETE shape", async () => {
  const f = fixture();
  await f.meiliFetch("https://meili.internal:8443/indexes/foods_generation_owned", {
    method: "DELETE",
  });
  assert.equal(f.calls[0].options.method, "DELETE");
  await assert.rejects(
    f.meiliFetch("https://meili.internal:8443/indexes/foods/documents", { method: "DELETE" }),
  );
  await assert.rejects(f.request("capture", "/api/v1/message/owned", { method: "DELETE" }));
  assert.equal(f.calls.length, 1);
});

for (const phase of [1, 2])
  test(`cancellation settles the same owned inspection before returning, phase ${phase}`, async () => {
    let begin;
    const started = new Promise((resolve) => {
      begin = resolve;
    });
    let settled = false,
      received;
    const f = fixture({
      async inspectOwnership(current, signal) {
        if (current !== phase) return;
        received = signal;
        begin();
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        settled = true;
      },
    });
    const work = f.request("api", "/ready");
    await started;
    assert(received instanceof AbortSignal);
    f.controller.abort();
    await assert.rejects(work, /Development runtime HTTP request failed/u);
    assert(settled && received.aborted);
    assert.equal(f.calls.length, phase === 1 ? 0 : 1);
  });
