import assert from "node:assert/strict";
import { Readable } from "node:stream";

export function azureBackupFixture({ hosted = false } = {}) {
  const container = hosted ? "nourishing-development-backup" : "backups";
  const now = Date.now();
  const credential = (permission) =>
    new URLSearchParams({
      sv: "2026-04-06",
      spr: "https",
      st: new Date(now - 60_000).toISOString(),
      se: new Date(now + 3_600_000).toISOString(),
      sr: "c",
      sp: permission,
      sig: "synthetic-backup-sas",
      skoid: "synthetic-operator",
      sktid: "synthetic-tenant",
      skt: new Date(now - 120_000).toISOString(),
      ske: new Date(now + 7_200_000).toISOString(),
      sks: "b",
      skv: "2026-04-06",
    }).toString();
  const state = {
    requests: [],
    bodies: [],
    blocks: new Map(),
    ciphertext: undefined,
    name: undefined,
    ambiguous: false,
    denied: false,
    stalled: false,
    version: "synthetic-version-1",
    storage(permission) {
      return {
        kind: "azure-blob",
        containerUrl: "https://nourishingbackup.blob.core.windows.net/" + container,
        prefix: hosted ? "development/backup/" : "development/",
        sasToken: credential(permission),
        requestTimeoutMs: 1000,
      };
    },
    async send(request, headers) {
      const url = new URL(request.url);
      assert.equal(url.origin, "https://nourishingbackup.blob.core.windows.net");
      assert.equal(request.headers.get("x-ms-version"), "2026-04-06");
      state.requests.push({
        method: request.method,
        url: url.href,
        headers: request.headers.toJSON(),
      });
      const respond = (status, bytes = "", extra = {}) => {
        const body = bytes instanceof Readable ? bytes : Readable.from([Buffer.from(bytes)]);
        state.bodies.push(body);
        return {
          request,
          status,
          headers: headers({ etag: '"synthetic"', ...extra }),
          readableStreamBody: body,
        };
      };
      if (state.denied) return respond(403, "synthetic-backup-sas must be redacted");
      if (state.stalled)
        return respond(200, new Readable({ read() {} }), {
          "content-length": String(state.ciphertext.length),
          "x-ms-version-id": state.version,
        });
      const comp = url.searchParams.get("comp");
      if (request.method === "PUT" && comp === "block") {
        assert.equal(url.searchParams.get("sp"), "c");
        state.blocks.set(url.searchParams.get("blockid"), Buffer.from(request.body));
        return respond(201);
      }
      if (request.method === "PUT" && comp === "blocklist") {
        assert.equal(request.headers.get("if-none-match"), "*");
        if (state.ciphertext) return respond(412);
        const xml = String(request.body);
        const ids = [...xml.matchAll(/<Latest>([^<]+)<\/Latest>/gu)].map((x) => x[1]);
        assert.ok(ids.length);
        state.ciphertext = Buffer.concat(
          ids.map((id) => {
            assert.ok(state.blocks.has(id));
            return state.blocks.get(id);
          }),
        );
        state.name = decodeURIComponent(url.pathname.slice(("/" + container + "/").length));
        return respond(201);
      }
      if (request.method === "GET" && comp === "list") {
        assert.equal(url.searchParams.get("sp"), "rl");
        const name = url.searchParams.get("prefix");
        const item =
          "<Blob><Name>" +
          name +
          "</Name><Deleted>false</Deleted><Snapshot/><VersionId>" +
          state.version +
          "</VersionId><IsCurrentVersion>true</IsCurrentVersion><Properties><Content-Length>" +
          state.ciphertext.length +
          "</Content-Length><BlobType>BlockBlob</BlobType></Properties></Blob>";
        return respond(
          200,
          '<?xml version="1.0" encoding="utf-8"?><EnumerationResults ServiceEndpoint="https://nourishingbackup.blob.core.windows.net/" ContainerName="' +
            container +
            '"><Prefix>' +
            name +
            "</Prefix><MaxResults>16</MaxResults><Blobs>" +
            item +
            (state.ambiguous ? item.replace(state.version, "another-version") : "") +
            "</Blobs><NextMarker/></EnumerationResults>",
          { "content-type": "application/xml" },
        );
      }
      if (request.method === "GET") {
        assert.equal(url.searchParams.get("versionid"), state.version);
        return respond(200, state.ciphertext, {
          "content-length": String(state.ciphertext.length),
          "x-ms-version-id": state.version,
        });
      }
      assert.fail("Unexpected Azure request");
    },
    dispose() {
      for (const body of state.bodies) body.destroy();
      for (const b of state.blocks.values()) b.fill(0);
      state.ciphertext?.fill(0);
    },
  };
  return state;
}

export function azureLedgerSettings({
  containerUrl = "https://nourishingledger.blob.core.windows.net/ledger",
  prefix = "development/ledger/",
} = {}) {
  const sas = new URLSearchParams(azureBackupFixture().storage("rl").sasToken);
  sas.set("sig", "synthetic-ledger-sas");
  return {
    kind: "azure-blob",
    containerUrl,
    prefix,
    sasToken: sas.toString(),
    encryptionKeyRing: {
      currentKeyId: "ledger-current",
      keys: {
        "ledger-old": Buffer.alloc(32, 21).toString("base64"),
        "ledger-current": Buffer.alloc(32, 22).toString("base64"),
      },
    },
    locatorKeyRing: {
      currentKeyId: "locator-current",
      keys: {
        "locator-old": Buffer.alloc(32, 31).toString("base64"),
        "locator-current": Buffer.alloc(32, 32).toString("base64"),
      },
    },
  };
}
