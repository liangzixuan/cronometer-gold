import { Readable } from "node:stream";
import {
  createHttpHeaders,
  type PipelineRequest,
  type PipelineResponse,
} from "@azure/core-rest-pipeline";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  runAzureBlobCredentialCanary as runCanary,
  validateAzureBlobCredentialCanaryConfiguration,
} from "./azure-blob-credential-canary.js";

const wire = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@azure/core-rest-pipeline", async (original) => {
  const actual = await original<typeof import("@azure/core-rest-pipeline")>();
  return { ...actual, createDefaultHttpClient: () => ({ sendRequest: wire.send }) };
});
function runAzureBlobCredentialCanary(input: Parameters<typeof runCanary>[0]) {
  return runCanary(input, { onStart() {} });
}
const now = Date.UTC(2026, 9, 17, 20);
function sas(permission: string, role: string) {
  return new URLSearchParams({
    sv: "2026-04-06",
    spr: "https",
    st: "2026-10-17T19:00:00Z",
    se: "2026-10-17T23:00:00Z",
    sr: "c",
    sp: permission,
    sig: `synthetic-${role}`,
    skoid: role,
    sktid: "synthetic-tenant",
    skt: "2026-10-17T18:00:00Z",
    ske: "2026-10-18T00:00:00Z",
    sks: "b",
    skv: "2026-04-06",
  }).toString();
}
function config() {
  return {
    exports: {
      containerUrl: "https://canaryexports.blob.core.windows.net/exports",
      prefix: "development/exports/",
      writerSas: sas("rcd", "export-writer"),
      readerSas: sas("r", "export-reader"),
      observerSas: sas("l", "export-observer"),
    },
    ledger: {
      containerUrl: "https://canaryledger.blob.core.windows.net/ledger",
      prefix: "development/ledger/",
      writerSas: sas("rc", "ledger-writer"),
      restoreSas: sas("rl", "ledger-restore"),
    },
  };
}
type Stored = { payload: Buffer; version: string | undefined };
const objects = new Map<string, Stored>();
const staged = new Map<string, Buffer>();
const owned: Readable[] = [];
const requests: PipelineRequest[] = [];
let mutate:
  | ((
      request: PipelineRequest,
      result: PipelineResponse,
    ) => PipelineResponse | Promise<PipelineResponse>)
  | undefined;
function response(
  request: PipelineRequest,
  status: number,
  body: Buffer | string = "",
  headers: Record<string, string> = {},
) {
  const stream = Readable.from([Buffer.from(body)]);
  owned.push(stream);
  return {
    request,
    status,
    headers: createHttpHeaders({
      etag: '"synthetic"',
      "x-ms-request-id": "synthetic-request",
      ...headers,
    }),
    readableStreamBody: stream,
  } satisfies PipelineResponse;
}
function denial(request: PipelineRequest, code = "AuthorizationPermissionMismatch", status = 403) {
  return response(
    request,
    status,
    `<Error><Code>${code}</Code><Message>private response</Message></Error>`,
    {
      "x-ms-error-code": code,
      "content-type": "application/xml",
    },
  );
}
function listing(request: PipelineRequest, copies = 1) {
  const u = new URL(request.url);
  const prefix = u.searchParams.get("prefix") ?? "";
  const rows = [...objects].filter(([key]) => key.startsWith(`${u.origin}${u.pathname}/${prefix}`));
  const blobs = rows
    .map(
      ([key, value]) =>
        `<Blob><Name>${key.slice(`${u.origin}${u.pathname}/`.length)}</Name>` +
        `<Deleted>false</Deleted><Snapshot/>${value.version ? `<VersionId>${value.version}</VersionId><IsCurrentVersion>true</IsCurrentVersion>` : ""}` +
        `<Properties><Content-Length>${value.payload.length}</Content-Length><BlobType>BlockBlob</BlobType></Properties></Blob>`,
    )
    .join("")
    .repeat(copies);
  return response(
    request,
    200,
    `<EnumerationResults ServiceEndpoint="${u.origin}/" ContainerName="${u.pathname.slice(1)}">` +
      `<Prefix>${prefix}</Prefix><MaxResults>${u.searchParams.get("maxresults")}</MaxResults><Blobs>${blobs}</Blobs><NextMarker/></EnumerationResults>`,
    { "content-type": "application/xml" },
  );
}
async function service(request: PipelineRequest) {
  requests.push(request);
  const u = new URL(request.url);
  const role = u.searchParams.get("skoid") ?? "";
  const isExport = u.hostname.startsWith("canaryexports.");
  const inScope = role.startsWith(isExport ? "export-" : "ledger-");
  const key = u.origin + u.pathname;
  let result: PipelineResponse;
  if (!inScope) result = denial(request, "AuthenticationFailed");
  else if (request.method === "GET" && u.searchParams.get("comp") === "list") {
    result = ["export-observer", "ledger-restore"].includes(role)
      ? listing(request)
      : denial(request);
  } else if (request.method === "GET") {
    const item = objects.get(key);
    result =
      role === "export-observer"
        ? denial(request)
        : item
          ? response(request, 200, item.payload, {
              "content-length": String(item.payload.length),
              ...(item.version ? { "x-ms-version-id": item.version } : {}),
            })
          : response(request, 404);
  } else if (request.method === "DELETE") {
    if (role === "export-writer") {
      objects.delete(key);
      result = response(request, 202);
    } else result = denial(request);
  } else if (request.method === "PUT" && !["export-writer", "ledger-writer"].includes(role))
    result = denial(request);
  else if (request.method === "PUT" && objects.has(key))
    result = denial(request, "UnauthorizedBlobOverwrite");
  else if (request.method === "PUT" && u.searchParams.get("comp") === "block") {
    staged.set(key, Buffer.from(request.body as Uint8Array));
    result = response(request, 201);
  } else if (request.method === "PUT" && u.searchParams.get("comp") === "blocklist") {
    const payload = staged.get(key);
    if (!payload) throw new Error("missing synthetic block");
    objects.set(key, { payload, version: isExport ? undefined : "native-version-1" });
    result = response(request, 201, "", {
      etag: '"synthetic"',
      "x-ms-version-id": "native-version-1",
    });
  } else result = denial(request);
  return mutate ? mutate(request, result) : result;
}
beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(now);
  wire.send.mockReset();
  objects.clear();
  staged.clear();
  requests.length = 0;
  mutate = undefined;
  wire.send.mockImplementation(service);
});
afterEach(() => {
  for (const stream of owned.splice(0)) stream.destroy();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const directDenial = (r: PipelineRequest) =>
  r.method === "PUT" && !new URL(r.url).searchParams.has("comp");
const exportCleanup = () =>
  requests.filter(
    (r) => r.method === "DELETE" && new URL(r.url).searchParams.get("skoid") === "export-writer",
  );

describe("executable Azure credential canary through the actual SDK", () => {
  it("uses actual allow/deny requests, exact native-version reads and observed export cleanup", async () => {
    await expect(runAzureBlobCredentialCanary(config())).resolves.toEqual({
      exportCleanupVerified: true,
      ledgerCanaryRetained: true,
      ledgerVersionVerified: true,
      canaryId: expect.stringMatching(/^[a-f0-9]{32}$/),
    });
    expect([...objects.keys()]).toHaveLength(1);
    expect([...objects.keys()][0]).toMatch(
      /^https:\/\/canaryledger\.blob\.core\.windows\.net\/ledger\/development\/ledger\/erasure-ledger\/v1\/credential-canary\/[a-f0-9]{32}$/,
    );
    expect(exportCleanup()).toHaveLength(1);
    expect(requests.filter((r) => new URL(r.url).searchParams.has("versionid"))).toHaveLength(2);
    expect(requests.filter(directDenial)).toHaveLength(4);
    const nativeDenials = requests.filter(
      (r) => r.method === "DELETE" && new URL(r.url).searchParams.get("skoid") !== "export-writer",
    );
    expect(nativeDenials).toHaveLength(4);
    for (const r of requests) {
      expect(r.allowInsecureConnection).toBe(false);
      expect(r.requestOverrides).toEqual({ maxHeaderSize: 8192, rejectUnauthorized: true });
      expect(r.headers.get("x-ms-version")).toBe("2026-04-06");
    }
    expect(requests.at(-1)?.method).toBe("GET");
    expect(new URL(requests.at(-1)?.url ?? "").searchParams.get("skoid")).toBe("export-observer");
  });
  it.each([
    [403, "AuthenticationFailed"],
    [403, "AuthorizationFailure"],
    [403, "UnauthorizedBlobOverwrite"],
    [404, "BlobNotFound"],
    [500, "InternalError"],
    [412, "ConditionNotMet"],
    [409, "BlobAlreadyExists"],
  ])("rejects unrelated denial %s/%s and retains both artifacts", async (status, code) => {
    mutate = (r, result) => (directDenial(r) ? denial(r, code, status) : result);
    await expect(runAzureBlobCredentialCanary(config())).rejects.toThrow(
      "Azure artifact storage operation failed",
    );
    expect(exportCleanup()).toHaveLength(0);
    expect(objects.size).toBe(2);
  });
  it("rejects success on a forbidden operation", async () => {
    mutate = (r, result) => (directDenial(r) ? response(r, 201) : result);
    await expect(runAzureBlobCredentialCanary(config())).rejects.toThrow();
    expect(exportCleanup()).toHaveLength(0);
  });
  it("does not accept a locally thrown status/code as a provider denial", async () => {
    mutate = (r, result) => {
      if (directDenial(r))
        throw Object.assign(new Error("private SAS"), {
          code: "AuthorizationPermissionMismatch",
          statusCode: 403,
        });
      return result;
    };
    await expect(runAzureBlobCredentialCanary(config())).rejects.toThrow(
      "Azure artifact storage operation failed",
    );
    expect(requests.filter(directDenial)).toHaveLength(1);
    expect(exportCleanup()).toHaveLength(0);
  });
  it("requires provider request identity and matching denial header", async () => {
    mutate = (r, result) => {
      if (directDenial(r)) result.headers.delete("x-ms-request-id");
      return result;
    };
    await expect(runAzureBlobCredentialCanary(config())).rejects.toThrow();
    expect(exportCleanup()).toHaveLength(0);
  });
  it("rejects redirects without following them", async () => {
    mutate = (r, result) =>
      directDenial(r) ? response(r, 307, "", { location: "https://unrelated.invalid" }) : result;
    await expect(runAzureBlobCredentialCanary(config())).rejects.toThrow();
    expect(requests.filter(directDenial)).toHaveLength(1);
  });
  it("fails on a changed native version after negative probes", async () => {
    let reads = 0;
    mutate = (r, result) => {
      const u = new URL(r.url);
      if (u.searchParams.has("versionid") && ++reads === 2)
        result.headers.set("x-ms-version-id", "different");
      return result;
    };
    await expect(runAzureBlobCredentialCanary(config())).rejects.toThrow();
    expect(exportCleanup()).toHaveLength(0);
  });
  it("fails on a changed ledger inventory even when payloads match", async () => {
    let lists = 0;
    mutate = (r, result) => {
      const u = new URL(r.url);
      if (
        u.hostname.startsWith("canaryledger.") &&
        u.searchParams.get("comp") === "list" &&
        ++lists === 2
      ) {
        for (const [key, value] of objects)
          if (key.includes("canaryledger")) value.version = "native-version-2";
        return listing(r);
      }
      return result;
    };
    await expect(runAzureBlobCredentialCanary(config())).rejects.toThrow();
    expect(exportCleanup()).toHaveLength(0);
  });
  it("requires positive controls after the denials", async () => {
    let reads = 0;
    mutate = (r, result) => {
      const u = new URL(r.url);
      if (
        r.method === "GET" &&
        u.hostname.startsWith("canaryexports.") &&
        u.searchParams.get("skoid") === "export-reader" &&
        ++reads === 2
      )
        return denial(r, "AuthenticationFailed");
      return result;
    };
    await expect(runAzureBlobCredentialCanary(config())).rejects.toThrow();
    expect(exportCleanup()).toHaveLength(0);
  });
  it("publishes exact reconciliation names before the first mutation", async () => {
    let identity: { canaryId: string; exportKey: string; ledgerKey: string } | undefined;
    await runCanary(config(), {
      onStart(value) {
        expect(wire.send).not.toHaveBeenCalled();
        identity = value;
        expect(value.exportKey).toBe(`exports/v1/credential-canary/${value.canaryId}`);
        expect(value.ledgerKey).toBe(`erasure-ledger/v1/credential-canary/${value.canaryId}`);
      },
    });
    expect([...objects.keys()][0]).toContain(identity?.ledgerKey);
  });
  it("bounds a stalled reconciliation publication by the whole operation deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const outcome = runCanary(config(), { onStart: () => new Promise<void>(() => {}) });
    const assertion = expect(outcome).rejects.toThrow("Azure artifact storage operation failed");
    await vi.advanceTimersByTimeAsync(60001);
    await assertion;
    expect(wire.send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("cancels a stalled reconciliation publication before any mutation", async () => {
    const controller = new AbortController();
    await expect(
      runCanary(config(), {
        signal: controller.signal,
        onStart: () => {
          queueMicrotask(() => controller.abort());
          return new Promise<void>(() => {});
        },
      }),
    ).rejects.toThrow("Azure artifact storage operation failed");
    expect(wire.send).not.toHaveBeenCalled();
  });
  it("does not mutate storage when recording reconciliation identity fails", async () => {
    await expect(
      runCanary(config(), {
        onStart() {
          throw new Error("private log unavailable");
        },
      }),
    ).rejects.toThrow("Azure artifact storage operation failed");
    expect(wire.send).not.toHaveBeenCalled();
  });
  it("settles ordinary cancellation and preserves uncertain objects", async () => {
    const controller = new AbortController();
    mutate = (r, result) => {
      if (new URL(r.url).searchParams.get("comp") === "blocklist") controller.abort();
      return result;
    };
    await expect(runCanary(config(), { signal: controller.signal, onStart() {} })).rejects.toThrow(
      "Azure artifact storage operation failed",
    );
    expect(exportCleanup()).toHaveLength(0);
    expect(objects.size).toBe(1);
  });
  it("retains the original admitted credential horizon after six seconds", async () => {
    const c = config();
    for (const location of [c.exports, c.ledger])
      for (const field of Object.keys(location)) {
        if (!field.endsWith("Sas")) continue;
        const record = location as unknown as Record<string, string>;
        const q = new URLSearchParams(record[field]);
        q.set("se", "2026-10-17T20:01:10Z");
        record[field] = q.toString();
      }
    mutate = (r, result) => {
      if (directDenial(r)) vi.spyOn(Date, "now").mockReturnValue(now + 6000);
      return result;
    };
    await expect(runAzureBlobCredentialCanary(c)).resolves.toMatchObject({
      exportCleanupVerified: true,
    });
  });
  it("does not delete after ambiguous publication", async () => {
    mutate = (r, result) => {
      if (new URL(r.url).searchParams.get("comp") === "blocklist")
        throw new Error("lost response private URL");
      return result;
    };
    await expect(runAzureBlobCredentialCanary(config())).rejects.toThrow(
      "Azure artifact storage operation failed",
    );
    expect(exportCleanup()).toHaveLength(0);
    expect(objects.size).toBe(1);
  });
  it.each([1, 2])(
    "requires the observer's allowed inventory before cleanup, control %s",
    async (failAt) => {
      let lists = 0;
      mutate = (r, result) => {
        const u = new URL(r.url);
        if (
          u.searchParams.get("skoid") === "export-observer" &&
          u.searchParams.get("comp") === "list" &&
          ++lists === failAt
        )
          return denial(r);
        return result;
      };
      const error = await runAzureBlobCredentialCanary(config()).catch((error) => error);
      expect(error.message).toBe("Azure artifact storage operation failed");
      expect(error.canaryId).toMatch(/^[a-f0-9]{32}$/);
      expect([...objects.keys()].every((key) => key.endsWith(error.canaryId))).toBe(true);
      expect(exportCleanup()).toHaveLength(0);
      expect(objects.size).toBe(2);
    },
  );
  it("requires actual inventory absence after successful delete", async () => {
    mutate = (r, result) => {
      if (r.method === "DELETE" && new URL(r.url).searchParams.get("skoid") === "export-writer") {
        const key = new URL(r.url).origin + new URL(r.url).pathname;
        objects.set(key, { payload: Buffer.alloc(64), version: "retained-version" });
      }
      return result;
    };
    await expect(runAzureBlobCredentialCanary(config())).rejects.toThrow();
    expect(exportCleanup()).toHaveLength(1);
    expect(objects.size).toBe(2);
  });
  it("rejects a wrong complete payload", async () => {
    mutate = (r, result) =>
      r.method === "GET" && !new URL(r.url).searchParams.has("comp")
        ? response(r, 200, Buffer.alloc(64), {
            "content-length": "64",
            "x-ms-version-id": "native-version-1",
          })
        : result;
    await expect(runAzureBlobCredentialCanary(config())).rejects.toThrow();
    expect(exportCleanup()).toHaveLength(0);
  });
  it("rejects duplicate ledger native versions", async () => {
    mutate = (r, result) =>
      new URL(r.url).searchParams.get("skoid") === "ledger-restore" ? listing(r, 2) : result;
    await expect(runAzureBlobCredentialCanary(config())).rejects.toThrow();
    expect(exportCleanup()).toHaveLength(0);
  });
  it("rejects an incomplete denial body", async () => {
    mutate = (r, result) => {
      if (directDenial(r)) {
        const broken = Readable.from(
          (async function* () {
            yield Buffer.from("<Error><Code>AuthorizationPermissionMismatch</Code>");
            throw new Error("late private socket failure");
          })(),
        );
        owned.push(broken);
        result.readableStreamBody = broken;
      }
      return result;
    };
    await expect(runAzureBlobCredentialCanary(config())).rejects.toThrow(
      "Azure artifact storage operation failed",
    );
    expect(exportCleanup()).toHaveLength(0);
  });
  it("bounds and aborts a stalled payload without cleanup or a retry", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    mutate = (r, result) => {
      if (r.method === "GET" && !new URL(r.url).searchParams.has("comp")) {
        const stalled = new Readable({ read() {} });
        owned.push(stalled);
        result.readableStreamBody = stalled;
      }
      return result;
    };
    const outcome = runAzureBlobCredentialCanary(config());
    const assertion = expect(outcome).rejects.toThrow("Azure artifact storage operation failed");
    await vi.advanceTimersByTimeAsync(5001);
    await assertion;
    expect(requests.filter((r) => r.method === "GET")).toHaveLength(1);
    expect(exportCleanup()).toHaveLength(0);
    vi.useRealTimers();
  });
  it.each(["readerSas", "writerSas", "observerSas"] as const)(
    "rejects expired export %s before any request",
    async (field) => {
      const c = config();
      const q = new URLSearchParams(c.exports[field]);
      q.set("se", "2026-10-17T19:59:59Z");
      c.exports[field] = q.toString();
      await expect(runAzureBlobCredentialCanary(c)).rejects.toThrow();
      expect(wire.send).not.toHaveBeenCalled();
    },
  );
  it("requires enough credential lifetime for the whole finite command", () => {
    const c = config();
    const q = new URLSearchParams(c.ledger.restoreSas);
    q.set("se", "2026-10-17T20:01:00Z");
    c.ledger.restoreSas = q.toString();
    expect(() => validateAzureBlobCredentialCanaryConfiguration(c)).toThrow();
  });
  it("rejects shared account retention scope", () => {
    const c = config();
    c.ledger.containerUrl = "https://canaryexports.blob.core.windows.net/ledger";
    expect(() => validateAzureBlobCredentialCanaryConfiguration(c)).toThrow();
  });
});
