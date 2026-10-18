import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { runAzureObjectStorageCredentialCanaryFromEnvironment } from "../apps/worker/dist/azure-object-storage-credential-canary.js";
import { runScopedMeiliKeysCli, scopedMeiliKeyPolicies } from "./scoped-meili-keys.mjs";

/** Actual SDK/issuer operations; only raw Azure and Meili HTTP responses are controlled. */
export function runtimeWireServices(t, state) {
  const exportHost = new URL(
    state.config.model.services.api.environment.EXPORT_ARTIFACT_AZURE_CONTAINER_URL,
  ).hostname;
  const ledgerHost = new URL(
    state.config.ownerEnvironment.ERASURE_REPLAY_LEDGER_AZURE_CONTAINER_URL,
  ).hostname;
  const objects = new Map(),
    staged = new Map(),
    streams = [],
    requests = [],
    issuerRequests = [];
  t.after(() => {
    for (const stream of streams) stream.destroy();
    for (const value of objects.values()) value.payload.fill(0);
    for (const value of staged.values()) value.fill(0);
  });
  const response = async (request, status, body = "", headers = {}) => {
    const { createHttpHeaders } = await import(globalThis.runtimeRunAzureCoreUrl);
    const stream = Readable.from([Buffer.from(body)]);
    streams.push(stream);
    return {
      request,
      status,
      headers: createHttpHeaders({
        etag: '"synthetic"',
        "x-ms-request-id": "synthetic-controller-canary",
        ...headers,
      }),
      readableStreamBody: stream,
    };
  };
  const denial = (request, code = "AuthorizationPermissionMismatch") =>
    response(
      request,
      403,
      `<Error><Code>${code}</Code><Message>Controlled denial</Message></Error>`,
      { "x-ms-error-code": code, "content-type": "application/xml" },
    );
  const roles = {
    r: "export-reader",
    rcd: "export-writer",
    l: "export-observer",
    rc: "ledger-writer",
    rl: "ledger-restore",
  };
  const sendRequest = async (request) => {
    const u = new URL(request.url),
      role = roles[u.searchParams.get("sp")],
      isExport = u.hostname === exportHost;
    assert([exportHost, ledgerHost].includes(u.hostname));
    assert.equal(request.allowInsecureConnection, false);
    assert.equal(request.requestOverrides.rejectUnauthorized, true);
    requests.push({ url: u.href, method: request.method, role });
    if (!role?.startsWith(isExport ? "export-" : "ledger-"))
      return denial(request, "AuthenticationFailed");
    const key = u.origin + u.pathname;
    if (request.method === "GET" && u.searchParams.get("comp") === "list") {
      if (!["export-observer", "ledger-restore"].includes(role)) return denial(request);
      const prefix = u.searchParams.get("prefix") ?? "",
        rows = [...objects].filter(([name]) =>
          name.startsWith(`${u.origin}${u.pathname}/${prefix}`),
        );
      const blobs = rows
        .map(
          ([name, value]) =>
            `<Blob><Name>${name.slice(`${u.origin}${u.pathname}/`.length)}</Name><Deleted>false</Deleted><Snapshot/>${value.version ? `<VersionId>${value.version}</VersionId><IsCurrentVersion>true</IsCurrentVersion>` : ""}<Properties><Content-Length>${value.payload.length}</Content-Length><BlobType>BlockBlob</BlobType></Properties></Blob>`,
        )
        .join("");
      return response(
        request,
        200,
        `<EnumerationResults ServiceEndpoint="${u.origin}/" ContainerName="${u.pathname.slice(1)}"><Prefix>${prefix}</Prefix><MaxResults>${u.searchParams.get("maxresults")}</MaxResults><Blobs>${blobs}</Blobs><NextMarker/></EnumerationResults>`,
        { "content-type": "application/xml" },
      );
    }
    if (request.method === "GET") {
      if (role === "export-observer") return denial(request);
      const item = objects.get(key);
      return item
        ? response(request, 200, item.payload, {
            "content-length": String(item.payload.length),
            ...(item.version ? { "x-ms-version-id": item.version } : {}),
          })
        : response(request, 404);
    }
    if (request.method === "DELETE") {
      if (role !== "export-writer") return denial(request);
      objects.delete(key);
      return response(request, 202);
    }
    if (
      request.method !== "PUT" ||
      !["export-writer", "ledger-writer"].includes(role) ||
      objects.has(key)
    )
      return denial(request);
    if (u.searchParams.get("comp") === "block") {
      staged.set(key, Buffer.from(request.body));
      return response(request, 201);
    }
    if (u.searchParams.get("comp") === "blocklist") {
      assert(staged.has(key));
      objects.set(key, {
        payload: Buffer.from(staged.get(key)),
        version: isExport ? undefined : "synthetic-native-canary-v1",
      });
      return response(request, 201, "", { "x-ms-version-id": "synthetic-native-canary-v1" });
    }
    return denial(request);
  };
  const env = state.config.model.services["search-bootstrap"].environment;
  const keys = ["MEILI_SEARCH_KEY", "MEILI_ADMIN_KEY", "MEILI_TASK_OBSERVER_KEY"];
  const policies = Object.values(scopedMeiliKeyPolicies);
  const issuerFetch = async (input, init = {}) => {
    const u = new URL(input),
      method = init.method ?? "GET",
      key = new Headers(init.headers).get("authorization");
    assert.equal(u.origin, "http://127.0.0.1:7700");
    issuerRequests.push([method, u.pathname, key]);
    if (u.pathname.startsWith("/keys/") && key === `Bearer ${env.MEILI_MASTER_KEY}`) {
      const at = policies.findIndex((row) => u.pathname === `/keys/${row.uid}`);
      assert(at >= 0);
      return Response.json({
        ...policies[at],
        key: env[keys[at]],
        createdAt: "2026-10-17T00:00:00Z",
        updatedAt: "2026-10-17T00:00:00Z",
      });
    }
    if (u.pathname.startsWith("/keys"))
      return Response.json(
        {
          code: "invalid_api_key",
          message: "Controlled denied management",
          type: "auth",
          link: "https://docs.meilisearch.com/errors#invalid_api_key",
        },
        { status: 403 },
      );
    if (u.pathname === "/indexes" && key === `Bearer ${env.MEILI_ADMIN_KEY}`)
      return state.options.missingIssuerGrant
        ? Response.json({ code: "invalid_api_key" }, { status: 403 })
        : Response.json({ results: [], limit: 1, offset: 0, total: 0 });
    if (u.pathname === "/tasks" && key === `Bearer ${env.MEILI_TASK_OBSERVER_KEY}`)
      return Response.json({ results: [], limit: 1, from: null, next: null, total: 0 });
    if (
      u.pathname === "/indexes/foods/search" &&
      method === "POST" &&
      key === `Bearer ${env.MEILI_SEARCH_KEY}`
    )
      return Response.json(
        {
          code: "index_not_found",
          message: "No index yet",
          type: "invalid_request",
          link: "https://docs.meilisearch.com/errors#index_not_found",
        },
        { status: 404 },
      );
    assert.fail(`Unexpected issuer request ${method} ${u.pathname}`);
  };
  const run = async (name, signal) => {
    if (name === "azure-canary") {
      const events = [];
      const result = await runAzureObjectStorageCredentialCanaryFromEnvironment(
        state.config.model.services[name].environment,
        {
          signal,
          onStart: (identity) => {
            events.push({ event: "azure_object_storage.credentials.started", ...identity });
          },
        },
      );
      events.push({ event: "azure_object_storage.credentials.attested", ...result });
      return events.map((row) => JSON.stringify(row)).join("\n") + "\n";
    }
    assert.equal(name, "search-bootstrap");
    await runScopedMeiliKeysCli({ environment: env, argv: [], fetchImpl: issuerFetch });
    return "";
  };
  return { run, sendRequest, requests, issuerRequests, objects };
}
