import assert from "node:assert/strict";
import test from "node:test";

import {
  prepareHostedWebDevelopment,
  runHostedWebDevelopment,
} from "./run-hosted-web-development.mjs";

const arguments_ = [
  "--https-key",
  "/trust/key.pem",
  "--https-cert",
  "/trust/cert.pem",
  "--https-ca",
  "/trust/ca.pem",
];
function dependencies(overrides = {}) {
  return {
    environment: {},
    readdir: () => ["src", "package.json"],
    realpath: (path) => path,
    lstat: () => ({ isFile: () => true, isSymbolicLink: () => false, nlink: 1, size: 100 }),
    resolveNext: () => "/installed/next/dist/bin/next",
    nextVersion: "16.3.6",
    readManifest: () => '{"dependencies":{"next":"16.3.6"}}',
    ...overrides,
  };
}

test("launches only pinned foreground Next with explicit loopback HTTPS", async () => {
  let plan;
  await runHostedWebDevelopment(
    arguments_,
    dependencies({
      enterNext: async (value) => {
        plan = value;
      },
    }),
  );
  assert.equal(plan.nextEntry, "/installed/next/dist/bin/next");
  assert.deepEqual(plan.arguments, [
    "dev",
    "--hostname",
    "127.0.0.1",
    "--port",
    "3443",
    "--experimental-https",
    "--experimental-https-key",
    "/trust/key.pem",
    "--experimental-https-cert",
    "/trust/cert.pem",
    "--experimental-https-ca",
    "/trust/ca.pem",
  ]);
  assert.equal(plan.environment.API_INTERNAL_URL, "https://dev-api.nourishing.app");
  assert.equal(plan.environment.NOURISHING_WEB_PROFILE, "hosted-development");
  assert.equal(plan.environment.WEB_PUBLIC_ORIGIN, "https://localhost:3443");
  assert.equal(plan.environment.NEXT_TELEMETRY_DISABLED, "1");
});

test("projects necessary Windows runtime fields without server secrets or parent CA override", () => {
  const plan = prepareHostedWebDevelopment(
    arguments_,
    dependencies({
      environment: {
        PATH: "/bin",
        SystemRoot: "C:/Windows",
        USERPROFILE: "C:/Users/test",
        DATABASE_URL: "secret-canary",
        DOPPLER_TOKEN: "secret-canary",
        SEARCH_CURSOR_SECRET: "secret-canary",
        NEXT_PUBLIC_ACCIDENT: "secret-canary",
        EXPO_PUBLIC_API_URL: "https://api.nourishing.app",
        AWS_SECRET_ACCESS_KEY: "secret-canary",
        NODE_EXTRA_CA_CERTS: "/unselected/root.pem",
        SSL_CERT_FILE: "/unselected/root.pem",
      },
    }),
  );
  assert.equal(plan.environment.SystemRoot, "C:/Windows");
  assert.equal(plan.environment.USERPROFILE, "C:/Users/test");
  assert.equal(plan.environment.NODE_EXTRA_CA_CERTS, "/trust/ca.pem");
  assert.equal(JSON.stringify(plan).includes("secret-canary"), false);
  assert.equal(JSON.stringify(plan).includes("unselected"), false);
  assert.equal(plan.environment.EXPO_PUBLIC_API_URL, undefined);
});
test("never reads inherited environment fields", () => {
  const plan = prepareHostedWebDevelopment(
    arguments_,
    dependencies({
      environment: Object.create({ PATH: "/inherited", DATABASE_URL: "secret-canary" }),
    }),
  );
  assert.equal(plan.environment.PATH, undefined);
  assert.equal(JSON.stringify(plan).includes("secret-canary"), false);
});

for (const environment of [
  { API_INTERNAL_URL: "" },
  { API_INTERNAL_URL: "http://127.0.0.1:4000" },
  { API_INTERNAL_URL: "https://api.nourishing.app" },
  { WEB_PUBLIC_ORIGIN: "http://localhost:3443" },
  { NOURISHING_WEB_PROFILE: "production" },
  { NODE_OPTIONS: "" },
  { node_options: "--require /injected.js" },
  { NODE_TLS_REJECT_UNAUTHORIZED: "0" },
  { GIT_SSL_NO_VERIFY: "1" },
  { CURL_INSECURE: "true" },
  { npm_config_strict_ssl: "false" },
]) {
  test(
    "rejects unsafe environment field " +
      Object.keys(environment)[0] +
      ":" +
      Object.values(environment)[0],
    async () => {
      let entered = false;
      await assert.rejects(
        () =>
          runHostedWebDevelopment(
            arguments_,
            dependencies({
              environment,
              enterNext: async () => {
                entered = true;
              },
            }),
          ),
        TypeError,
      );
      assert.equal(entered, false);
    },
  );
}
for (const name of [
  ".env",
  ".env.local",
  ".env.development",
  ".env.development.local",
  ".ENV.production",
]) {
  test("refuses implicit environment file " + name + " without reading it", () => {
    assert.throws(
      () =>
        prepareHostedWebDevelopment(
          arguments_,
          dependencies({
            readdir: () => [name],
            readManifest: () => {
              throw new Error("must not read");
            },
          }),
        ),
      /implicit web dotenv/,
    );
  });
}
for (const args of [
  [],
  arguments_.slice(0, 4),
  [...arguments_, "--api-origin", "https://other.test"],
  [...arguments_, "--https-key", "/another.pem"],
]) {
  test("rejects incomplete, duplicate or extra arguments " + JSON.stringify(args), () => {
    assert.throws(() => prepareHostedWebDevelopment(args, dependencies()), TypeError);
  });
}
test("refuses mismatched installed Next before entering it", () => {
  assert.throws(
    () => prepareHostedWebDevelopment(arguments_, dependencies({ nextVersion: "16.3.8" })),
    /exact source pin/,
  );
});
test("refuses missing, linked, oversized or aliased trust inputs", () => {
  for (const metadata of [
    { isFile: () => false },
    { isSymbolicLink: () => true },
    { nlink: 2 },
    { size: 0 },
    { size: 1_048_577 },
  ]) {
    const original = dependencies().lstat();
    assert.throws(
      () =>
        prepareHostedWebDevelopment(
          arguments_,
          dependencies({
            lstat: () => ({ ...original, ...metadata }),
          }),
        ),
      TypeError,
    );
  }
  assert.throws(
    () =>
      prepareHostedWebDevelopment(arguments_, dependencies({ realpath: () => "/elsewhere.pem" })),
    TypeError,
  );
  assert.throws(
    () =>
      prepareHostedWebDevelopment(
        ["--https-key", "relative.pem", ...arguments_.slice(2)],
        dependencies(),
      ),
    TypeError,
  );
});
test("preserves the actual Next entry failure for callers", async () => {
  const failure = new Error("synthetic Next startup failure");
  await assert.rejects(
    () =>
      runHostedWebDevelopment(
        arguments_,
        dependencies({
          enterNext: async () => {
            throw failure;
          },
        }),
      ),
    (error) => error === failure,
  );
});
