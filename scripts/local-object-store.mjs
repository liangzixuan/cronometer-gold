import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "..");
const roles = [
  ["export-writer", "EXPORT_ARTIFACT_WRITE"],
  ["export-reader", "EXPORT_ARTIFACT_READ"],
  ["erasure-writer", "ERASURE_REPLAY_LEDGER_WRITE"],
  ["erasure-restore", "ERASURE_REPLAY_LEDGER_RESTORE"],
  ["fixture-admin", "ARTIFACT_STORE_ADMIN"],
];
const adminPolicy = {
  Version: "2012-10-17",
  Statement: [{ Effect: "Allow", Action: ["s3:*"], Resource: ["*"] }],
};
const credentialPattern = /^[a-f0-9]{64}$/u;
function fail() {
  throw new Error("Local object-store configuration or bootstrap failed.");
}
function portNumber(value) {
  const text = String(value);
  if (!/^[1-9][0-9]{0,4}$/u.test(text) || Number(text) > 65535) fail();
  return Number(text);
}
function policies() {
  return roles.map(([name]) => ({
    name,
    content: JSON.stringify(
      name === "fixture-admin"
        ? adminPolicy
        : JSON.parse(
            readFileSync(resolve(repositoryRoot, `infra/object-store/${name}-policy.json`), "utf8"),
          ),
    ),
  }));
}
function assertDirectory(path, privateDirectory = true) {
  const metadata = lstatSync(path);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== process.getuid() ||
    (privateDirectory ? (metadata.mode & 0o777) !== 0o700 : (metadata.mode & 0o022) !== 0)
  )
    fail();
}
function readOwned(path, mode) {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = fstatSync(descriptor);
    if (
      !metadata.isFile() ||
      metadata.uid !== process.getuid() ||
      metadata.nlink !== 1 ||
      (metadata.mode & 0o777) !== mode ||
      metadata.size > 65536
    )
      fail();
    return readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
}
function writeOwned(path, value, mode) {
  const descriptor = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    mode,
  );
  try {
    writeFileSync(descriptor, value);
    fchmodSync(descriptor, mode);
  } finally {
    closeSync(descriptor);
  }
}
function environmentValues(config, port) {
  const values = {
    OBJECT_STORE_PORT: String(port),
    EXPORT_ARTIFACT_STORE: "s3",
    EXPORT_ARTIFACT_ENDPOINT: `http://127.0.0.1:${port}`,
    EXPORT_ARTIFACT_REGION: "us-east-1",
    EXPORT_ARTIFACT_BUCKET: "nutrition-private-exports",
    EXPORT_ARTIFACT_DELETE_VERSION_POLICY: "suspended_null",
    ERASURE_REPLAY_LEDGER_STORE: "s3",
    ERASURE_REPLAY_LEDGER_ENDPOINT: `http://127.0.0.1:${port}`,
    ERASURE_REPLAY_LEDGER_REGION: "us-east-1",
    ERASURE_REPLAY_LEDGER_BUCKET: "nutrition-erasure-ledger",
  };
  for (const [index, [, prefix]] of roles.entries()) {
    values[`${prefix}_ACCESS_KEY_ID`] = config.identities[index].credentials[0].accessKey;
    values[`${prefix}_SECRET_ACCESS_KEY`] = config.identities[index].credentials[0].secretKey;
  }
  return values;
}
function environmentText(config, port) {
  return `${Object.entries(environmentValues(config, port))
    .map(([name, value]) => `${name}=${value}`)
    .join("\n")}\n`;
}
export function readLocalObjectStore(root = repositoryRoot) {
  const parent = resolve(root, ".local-data");
  const directory = resolve(parent, "object-store");
  assertDirectory(parent, false);
  assertDirectory(directory);
  const config = JSON.parse(readOwned(resolve(directory, "s3.json"), 0o444));
  const expectedPolicies = policies();
  if (!Array.isArray(config.identities) || config.identities.length !== roles.length) fail();
  const keys = new Set();
  const identities = roles.map(([name], index) => {
    const credential = config.identities[index]?.credentials?.[0];
    if (
      !credentialPattern.test(credential?.accessKey) ||
      !credentialPattern.test(credential?.secretKey) ||
      keys.has(credential.accessKey) ||
      keys.has(credential.secretKey) ||
      credential.accessKey === credential.secretKey
    )
      fail();
    keys.add(credential.accessKey);
    keys.add(credential.secretKey);
    return {
      name,
      credentials: [{ accessKey: credential.accessKey, secretKey: credential.secretKey }],
      policyNames: [name],
    };
  });
  if (JSON.stringify(config) !== JSON.stringify({ identities, policies: expectedPolicies })) fail();
  const environment = readOwned(resolve(directory, "runtime.env"), 0o600);
  const port = portNumber(/^OBJECT_STORE_PORT=([^\n]+)\n/u.exec(environment)?.[1]);
  if (environment !== environmentText(config, port)) fail();
  return { config, port };
}
export function localObjectStoreEnvironment(root = repositoryRoot) {
  const { config, port } = readLocalObjectStore(root);
  return environmentValues(config, port);
}
export function prepareLocalObjectStore({ root = repositoryRoot, port = 9000 } = {}) {
  port = portNumber(port);
  const parent = resolve(root, ".local-data");
  if (!lstatSync(parent, { throwIfNoEntry: false })) mkdirSync(parent, { mode: 0o700 });
  assertDirectory(parent, false);
  const directory = resolve(parent, "object-store");
  if (lstatSync(directory, { throwIfNoEntry: false })) {
    const existing = readLocalObjectStore(root);
    if (existing.port !== port) fail();
    return;
  }
  mkdirSync(directory, { mode: 0o700 });
  const config = {
    identities: roles.map(([name]) => ({
      name,
      credentials: [
        { accessKey: randomBytes(32).toString("hex"), secretKey: randomBytes(32).toString("hex") },
      ],
      policyNames: [name],
    })),
    policies: policies(),
  };
  // The owner-only parent protects this host file; the read-only file bind lets
  // the image's UID 1000 read it even when the host runner has another UID.
  writeOwned(resolve(directory, "s3.json"), `${JSON.stringify(config, null, 2)}\n`, 0o444);
  writeOwned(resolve(directory, "runtime.env"), environmentText(config, port), 0o600);
  readLocalObjectStore(root);
}
export function cleanupLocalObjectStore(root = repositoryRoot) {
  const parent = resolve(root, ".local-data");
  if (!lstatSync(parent, { throwIfNoEntry: false })) return;
  assertDirectory(parent, false);
  const directory = resolve(parent, "object-store");
  if (!lstatSync(directory, { throwIfNoEntry: false })) return;
  assertDirectory(directory);
  const entries = readdirSync(directory);
  for (const name of entries) {
    if (!["s3.json", "runtime.env"].includes(name)) fail();
    readOwned(resolve(directory, name), name === "s3.json" ? 0o444 : 0o600);
  }
  for (const name of entries) unlinkSync(resolve(directory, name));
  rmdirSync(directory);
}
export function signedRequest({
  credential,
  port,
  method,
  bucket,
  versioning = false,
  body = "",
  run = spawnSync,
}) {
  if (
    !credentialPattern.test(credential?.accessKey) ||
    !credentialPattern.test(credential?.secretKey) ||
    !["GET", "PUT"].includes(method) ||
    !["nutrition-private-exports", "nutrition-erasure-ledger"].includes(bucket) ||
    typeof body !== "string" ||
    !/^[<>/="a-zA-Z0-9: .-]*$/u.test(body)
  )
    fail();
  const url = `http://127.0.0.1:${portNumber(port)}/${bucket}${versioning ? "?versioning" : ""}`;
  const config = [
    `url = "${url}"`,
    `request = "${method}"`,
    'aws-sigv4 = "aws:amz:us-east-1:s3"',
    `user = "${credential.accessKey}:${credential.secretKey}"`,
    'header = "Content-Type: application/xml"',
    ...(method === "PUT" && !versioning ? ['header = "x-amz-acl: private"'] : []),
    ...(method === "PUT" ? [`data-binary = "${body.replaceAll('"', '\\"')}"`] : []),
  ].join("\n");
  const result = run(
    "curl",
    [
      "--disable",
      "--silent",
      "--show-error",
      "--max-time",
      "10",
      "--connect-timeout",
      "3",
      "--noproxy",
      "*",
      "--proto",
      "=http",
      "--config",
      "-",
      "--write-out",
      "\\n%{http_code}",
    ],
    {
      encoding: "utf8",
      env: { PATH: process.env.PATH, LANG: "C" },
      input: config,
      maxBuffer: 1024 * 1024,
      shell: false,
      timeout: 15000,
      windowsHide: true,
    },
  );
  if (
    result.error ||
    result.signal !== null ||
    result.status !== 0 ||
    typeof result.stdout !== "string"
  )
    fail();
  const parsed = /\n([0-9]{3})$/u.exec(result.stdout);
  if (!parsed) fail();
  return { status: Number(parsed[1]), body: result.stdout.slice(0, parsed.index) };
}
export function bootstrapLocalObjectStore({ root = repositoryRoot, run = spawnSync } = {}) {
  const { config, port } = readLocalObjectStore(root);
  const capability = run("curl", ["--disable", "--help", "all"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, LANG: "C" },
    shell: false,
    maxBuffer: 1024 * 1024,
    timeout: 5000,
  });
  if (
    capability.error ||
    capability.signal !== null ||
    capability.status !== 0 ||
    !capability.stdout?.includes("--aws-sigv4")
  )
    fail();
  const credential = config.identities[4].credentials[0];
  for (const [bucket, status] of [
    ["nutrition-private-exports", "Suspended"],
    ["nutrition-erasure-ledger", "Enabled"],
  ]) {
    const request = (method, versioning, body) =>
      signedRequest({ credential, port, method, bucket, versioning, body, run });
    let response = request("GET", true);
    if (response.status === 404) {
      if (request("PUT", false).status !== 200) fail();
      if (
        request(
          "PUT",
          true,
          `<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>${status}</Status></VersioningConfiguration>`,
        ).status !== 200
      )
        fail();
      response = request("GET", true);
    }
    // Existing buckets must already have the reviewed state; never change retained history.
    const xml = response.body.replace(/^\s*<\?xml[^?]*\?>/u, "").trim();
    const match =
      /^<VersioningConfiguration(?: xmlns="http:\/\/s3\.amazonaws\.com\/doc\/2006-03-01\/")?>\s*<Status>(Enabled|Suspended)<\/Status>\s*<\/VersioningConfiguration>$/u.exec(
        xml,
      );
    if (response.status !== 200 || match?.[1] !== status) fail();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    if (process.argv.length !== 3 || !["prepare", "bootstrap", "cleanup"].includes(process.argv[2]))
      fail();
    if (process.argv[2] === "prepare")
      // biome-ignore lint/suspicious/noUndeclaredEnvVars: This standalone fixture CLI runs outside Turbo.
      prepareLocalObjectStore({ port: process.env.OBJECT_STORE_PORT ?? 9000 });
    else if (process.argv[2] === "bootstrap") bootstrapLocalObjectStore();
    else cleanupLocalObjectStore();
    process.stdout.write(`[local-object-store] ${process.argv[2]} completed.\n`);
  } catch {
    process.stderr.write(
      "[local-object-store] Configuration or bootstrap failed; private inputs were not printed.\n",
    );
    process.exitCode = 1;
  }
}
