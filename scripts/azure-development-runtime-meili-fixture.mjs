import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

/** Raw Node request/response seam; real bounded transport, Meili client and rebuild remain active. */
export function runtimeMeiliWire(state) {
  const indexes = new Map(),
    tasks = new Set(),
    requests = [];
  let nextTask = 0;
  const respond = async (options, raw) => {
    assert.equal(options.hostname, "172.28.0.4");
    assert.equal(options.port, 8443);
    assert.equal(options.servername, "meili.internal");
    assert.equal(options.rejectUnauthorized, true);
    assert.equal(options.ca, state.config.input.caCertificate);
    assert.equal(options.headers.host, "meili.internal:8443");
    const url = new URL(options.path, "https://meili.internal:8443"),
      path = url.pathname,
      method = options.method;
    const key = path.startsWith("/tasks/")
      ? state.config.model.services.worker.environment.MEILI_TASK_OBSERVER_KEY
      : state.config.model.services.worker.environment.MEILI_ADMIN_KEY;
    assert.equal(options.headers.authorization, `Bearer ${key}`);
    requests.push([method, path]);
    const body = raw === undefined ? null : JSON.parse(raw.toString());
    if (path.startsWith("/tasks/")) {
      const uid = Number(path.split("/").at(-1));
      assert(tasks.has(uid));
      return Response.json({ uid, status: "succeeded" });
    }
    if (path === "/indexes" && method === "POST") {
      assert(!indexes.has(body.uid));
      indexes.set(body.uid, []);
    } else if (path === "/swap-indexes") {
      const [left, right] = body[0].indexes;
      assert(indexes.has(left) && indexes.has(right));
      const previous = indexes.get(left);
      indexes.set(left, indexes.get(right));
      indexes.set(right, previous);
    } else {
      const uid = path.split("/")[2];
      if (method === "GET" && path.endsWith("/stats")) {
        assert(indexes.has(uid));
        return Response.json({ numberOfDocuments: indexes.get(uid).length });
      }
      if (method === "GET")
        return indexes.has(uid)
          ? Response.json({ uid })
          : Response.json({ code: "index_not_found" }, { status: 404 });
      assert(indexes.has(uid));
      if (method === "POST" && path.endsWith("/documents")) {
        assert.equal(url.search, "?primaryKey=id");
        assert(Array.isArray(body));
        indexes.get(uid).push(...body);
      } else if (method === "DELETE") indexes.delete(uid);
      else assert(method === "PATCH" && path.endsWith("/settings"));
    }
    const taskUid = ++nextTask;
    tasks.add(taskUid);
    return Response.json({ taskUid }, { status: 202 });
  };
  const request = (secure, options, callback) => {
    assert.equal(secure, true);
    const req = new EventEmitter();
    req.destroy = () => {
      req.destroyed = true;
    };
    req.end = (raw) => {
      void (async () => {
        try {
          const response = await respond(options, raw),
            bytes = Buffer.from(await response.arrayBuffer());
          const incoming = new PassThrough();
          Object.assign(incoming, {
            statusCode: response.status,
            complete: true,
            headers: Object.fromEntries(response.headers),
            rawHeaders: [],
            trailers: {},
          });
          callback(incoming);
          incoming.end(bytes);
        } catch (error) {
          req.emit("error", error);
        }
      })();
    };
    return req;
  };
  const fetch = async (input, init = {}) => {
    const url = new URL(input);
    assert.equal(url.origin, state.config.model.services.worker.environment.MEILI_URL);
    return respond(
      {
        hostname: "172.28.0.4",
        port: 8443,
        servername: "meili.internal",
        rejectUnauthorized: true,
        ca: state.config.input.caCertificate,
        path: url.pathname + url.search,
        method: init.method ?? "GET",
        headers: {
          host: "meili.internal:8443",
          authorization: new Headers(init.headers).get("authorization"),
        },
      },
      init.body === undefined ? undefined : Buffer.from(init.body),
    );
  };
  return { request, fetch, indexes, requests };
}
