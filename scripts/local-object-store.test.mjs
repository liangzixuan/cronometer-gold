import assert from "node:assert/strict";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  bootstrapLocalObjectStore,
  cleanupLocalObjectStore,
  prepareLocalObjectStore,
  readLocalObjectStore,
  signedRequest,
} from "./local-object-store.mjs";

function fixture(t) {
  const root = mkdtempSync(resolve(tmpdir(), "object-store-offline-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function file(root, name) {
  return resolve(root, ".local-data/object-store", name);
}
function rewriteConfig(root, mutate) {
  const path = file(root, "s3.json");
  const value = JSON.parse(readFileSync(path, "utf8"));
  mutate(value);
  chmodSync(path, 0o600);
  writeFileSync(path, JSON.stringify(value));
  chmodSync(path, 0o444);
}
const success = (stdout = "") => ({ status: 0, signal: null, stdout, stderr: "" });
const xml = (status) =>
  `<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>${status}</Status></VersioningConfiguration>`;
function runner(responses) {
  const calls = [];
  return {
    calls,
    run(command, args, options) {
      calls.push({ command, args, options });
      assert.ok(responses.length > 0, "unexpected request");
      return responses.shift();
    },
  };
}

test("generates five separate principals with exactly attached policies, protected files, and retained credentials", (t) => {
  const root = fixture(t);
  prepareLocalObjectStore({ root, port: 19000 });
  const { config, port } = readLocalObjectStore(root);
  assert.equal(port, 19000);
  assert.equal(config.identities.length, 5);
  assert.equal(config.policies.length, 5);
  assert.equal(
    new Set(config.identities.flatMap(({ credentials }) => Object.values(credentials[0]))).size,
    10,
  );
  assert.ok(
    config.identities.every(
      ({ name, policyNames, actions }) =>
        policyNames.length === 1 && policyNames[0] === name && actions === undefined,
    ),
  );
  for (const policy of config.policies.slice(0, 4)) {
    assert.deepEqual(
      JSON.parse(policy.content),
      JSON.parse(
        readFileSync(
          new URL(`../infra/object-store/${policy.name}-policy.json`, import.meta.url),
          "utf8",
        ),
      ),
    );
  }
  assert.equal(lstatSync(file(root, ".")).mode & 0o777, 0o700);
  assert.equal(lstatSync(file(root, "s3.json")).mode & 0o777, 0o444);
  assert.equal(lstatSync(file(root, "runtime.env")).mode & 0o777, 0o600);
  const previous = readFileSync(file(root, "runtime.env"), "utf8");
  assert.match(previous, /^ARTIFACT_STORE_ADMIN_ACCESS_KEY_ID=[a-f0-9]{64}$/mu);
  assert.match(previous, /^ERASURE_REPLAY_LEDGER_RESTORE_SECRET_ACCESS_KEY=[a-f0-9]{64}$/mu);
  assert.match(previous, /^EXPORT_ARTIFACT_DELETE_VERSION_POLICY=suspended_null$/mu);
  prepareLocalObjectStore({ root, port: 19000 });
  assert.ok(previous === readFileSync(file(root, "runtime.env"), "utf8"));
  assert.throws(() => prepareLocalObjectStore({ root, port: 9000 }));
});

test("rejects invalid ports before writing configuration", (t) => {
  const root = fixture(t);
  for (const port of [0, -1, 65536, "09000", "9000\n", "http://example.invalid", 1.5]) {
    assert.throws(() => prepareLocalObjectStore({ root, port }));
  }
  assert.equal(lstatSync(resolve(root, ".local-data"), { throwIfNoEntry: false }), undefined);
});

test("refuses linked, public, incomplete, or substituted private inputs", (t) => {
  const cases = [
    (root) => chmodSync(file(root, "."), 0o755),
    (root) => chmodSync(file(root, "runtime.env"), 0o644),
    (root) => {
      linkSync(file(root, "runtime.env"), resolve(root, "copy"));
    },
    (root) => {
      unlinkSync(file(root, "runtime.env"));
      symlinkSync(resolve(root, "outside"), file(root, "runtime.env"));
    },
    (root) => unlinkSync(file(root, "runtime.env")),
    (root) => writeFileSync(file(root, "runtime.env"), "OBJECT_STORE_PORT=9000\n"),
    (root) =>
      rewriteConfig(root, (config) => {
        config.identities[0].actions = ["Admin"];
      }),
    (root) =>
      rewriteConfig(root, (config) => {
        config.identities[0].credentials[0].secretKey = "";
      }),
    (root) =>
      rewriteConfig(root, (config) => {
        config.identities[0].credentials[0] = config.identities[1].credentials[0];
      }),
    (root) =>
      rewriteConfig(root, (config) => {
        config.policies[0].content = config.policies[4].content;
      }),
    (root) =>
      rewriteConfig(root, (config) => {
        config.identities.push({ name: "anonymous", actions: ["Read"] });
      }),
  ];
  for (const mutate of cases) {
    const root = fixture(t);
    prepareLocalObjectStore({ root });
    mutate(root);
    assert.throws(() => readLocalObjectStore(root));
    assert.throws(() => prepareLocalObjectStore({ root }));
  }
});

test("refuses symlinked state parents before writes", (t) => {
  const root = fixture(t);
  const target = resolve(root, "target");
  mkdirSync(target);
  symlinkSync(target, resolve(root, ".local-data"));
  assert.throws(() => prepareLocalObjectStore({ root }));
  assert.equal(lstatSync(resolve(target, "object-store"), { throwIfNoEntry: false }), undefined);
});

test("uses curl's signer through bounded stdin, without credentials in arguments or environment", () => {
  const credential = { accessKey: "a".repeat(64), secretKey: "b".repeat(64) };
  const mocked = runner([success("\n200")]);
  signedRequest({
    credential,
    port: 9000,
    method: "PUT",
    bucket: "nutrition-private-exports",
    run: mocked.run,
  });
  const call = mocked.calls[0];
  assert.equal(call.command, "curl");
  assert.equal(call.args[0], "--disable");
  assert.ok(call.args.includes("--noproxy") && call.args.includes("--max-time"));
  assert.ok(
    !JSON.stringify({ args: call.args, env: call.options.env }).includes(credential.secretKey),
  );
  assert.match(call.options.input, /aws-sigv4 = "aws:amz:us-east-1:s3"/u);
  assert.match(call.options.input, /x-amz-acl: private/u);
  assert.equal(call.options.shell, false);
  assert.equal(call.options.timeout, 15000);
  assert.ok(!call.args.includes("--location"));
});

test("rejects unreviewed request inputs and suppresses child failures", () => {
  const base = {
    credential: { accessKey: "a".repeat(64), secretKey: "b".repeat(64) },
    port: 9000,
    method: "GET",
    bucket: "nutrition-erasure-ledger",
    run: () => {
      throw new Error("must not run");
    },
  };
  for (const override of [
    { bucket: "outside" },
    { method: "DELETE" },
    { port: 65536 },
    { body: '\nurl = "http://example.invalid"' },
  ])
    assert.throws(() => signedRequest({ ...base, ...override }));
  assert.throws(
    () =>
      signedRequest({
        ...base,
        run: () => ({ status: 1, signal: null, stderr: "private-child-output" }),
      }),
    { message: "Local object-store configuration or bootstrap failed." },
  );
});

test("bootstraps fresh private buckets and verifies both versioning states", (t) => {
  const root = fixture(t);
  prepareLocalObjectStore({ root });
  const mocked = runner([
    success("--aws-sigv4"),
    success("\n404"),
    success("\n200"),
    success("\n200"),
    success(`${xml("Suspended")}\n200`),
    success("\n404"),
    success("\n200"),
    success("\n200"),
    success(`${xml("Enabled")}\n200`),
  ]);
  bootstrapLocalObjectStore({ root, run: mocked.run });
  assert.equal(mocked.calls.length, 9);
  assert.match(mocked.calls[3].options.input, /<Status>Suspended<\/Status>/u);
  assert.match(mocked.calls[7].options.input, /<Status>Enabled<\/Status>/u);
});

test("existing correct buckets are verified without mutations", (t) => {
  const root = fixture(t);
  prepareLocalObjectStore({ root });
  const mocked = runner([
    success("--aws-sigv4"),
    success(`${xml("Suspended")}\n200`),
    success(`${xml("Enabled")}\n200`),
  ]);
  bootstrapLocalObjectStore({ root, run: mocked.run });
  assert.equal(mocked.calls.length, 3);
  assert.ok(mocked.calls.slice(1).every((call) => call.options.input.includes('request = "GET"')));
});

test("existing incompatible or inaccessible buckets fail without changing history", (t) => {
  const root = fixture(t);
  prepareLocalObjectStore({ root });
  for (const response of [
    `${xml("Enabled")}\n200`,
    "\n403",
    `${xml("Suspended")}${xml("Enabled")}\n200`,
    "\n301",
  ]) {
    const mocked = runner([success("--aws-sigv4"), success(response)]);
    assert.throws(() => bootstrapLocalObjectStore({ root, run: mocked.run }));
    assert.equal(mocked.calls.length, 2);
  }
});

test("missing curl signing capability fails before requests", (t) => {
  const root = fixture(t);
  prepareLocalObjectStore({ root });
  const mocked = runner([success("old curl help")]);
  assert.throws(() => bootstrapLocalObjectStore({ root, run: mocked.run }));
  assert.equal(mocked.calls.length, 1);
});

test("cleanup removes only owned generated files and tolerates absence", (t) => {
  const root = fixture(t);
  cleanupLocalObjectStore(root);
  prepareLocalObjectStore({ root });
  cleanupLocalObjectStore(root);
  cleanupLocalObjectStore(root);
  assert.equal(lstatSync(file(root, "."), { throwIfNoEntry: false }), undefined);
});

test("cleanup refuses extra files, symlinks and hardlinks before removing anything", (t) => {
  for (const mutate of [
    (root) => writeFileSync(file(root, "unexpected"), "keep"),
    (root) => {
      unlinkSync(file(root, "runtime.env"));
      symlinkSync(resolve(root, "outside"), file(root, "runtime.env"));
    },
    (root) => linkSync(file(root, "runtime.env"), resolve(root, "copy")),
  ]) {
    const root = fixture(t);
    prepareLocalObjectStore({ root });
    mutate(root);
    assert.throws(() => cleanupLocalObjectStore(root));
    assert.ok(lstatSync(file(root, "s3.json")).isFile());
  }
});
