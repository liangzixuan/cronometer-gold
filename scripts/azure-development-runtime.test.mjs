import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const source = resolve(fileURLToPath(new URL("../", import.meta.url)));
const compose = join(source, "infra/development/azure/runtime/compose.yaml");
const images = Object.fromEntries(
  [
    ["API", "api"],
    ["WORKER", "worker"],
    ["MIGRATOR", "migrator"],
    ["CADDY", "caddy"],
    ["POSTGRES", "postgres"],
    ["MEILI", "meilisearch"],
    ["MAILPIT", "mailpit"],
  ].map(([key, component], index) => [
    `${key}_IMAGE`,
    `ghcr.io/liangzixuan/cronometer-gold-${component}@sha256:${String(index + 1).repeat(64)}`,
  ]),
);
async function render(t) {
  const root = await mkdtemp(join(tmpdir(), "nourishing-runtime-compose-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "config"), { mode: 0o700 });
  for (const name of [
    "runtime",
    "postgres",
    "migrate",
    "database",
    "api",
    "worker",
    "canary",
    "meili",
    "scoped-meili",
    "restore",
    "probe",
  ])
    await writeFile(
      join(root, "config", `${name}.env`),
      "NODE_ENV=development\nNOURISHING_API_PROFILE=hosted-development\n",
      { mode: 0o600, flag: "wx" },
    );
  const rendered = spawnSync(
    "docker",
    [
      "compose",
      "--profile",
      "*",
      "--project-directory",
      source,
      "--env-file",
      devNull,
      "-f",
      compose,
      "config",
      "--format",
      "json",
    ],
    {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 2_097_152,
      env: {
        ...process.env,
        ...images,
        RUNTIME_ROOT: root,
        RUNTIME_SOURCE: source,
        RUNTIME_PROJECT: "nourishing-development-contract",
        RUNTIME_OWNER: "11111111-1111-4111-8111-111111111111",
        RUNTIME_REVISION: "a".repeat(40),
        DOCKER_HOST: "unix:///nonexistent-nourishing-contract.sock",
      },
    },
  );
  assert.ifError(rendered.error);
  assert.equal(rendered.status, 0, rendered.stderr);
  return { root, model: JSON.parse(rendered.stdout) };
}

test("development stack renders all fixed phases with exactly the seven development images", async (t) => {
  const { model } = await render(t);
  assert.deepEqual(Object.keys(model.services).sort(), [
    "api",
    "azure-canary",
    "capture",
    "internal-tls",
    "meilisearch",
    "migrate",
    "postgres",
    "search-bootstrap",
    "worker",
  ]);
  assert.deepEqual(
    [...new Set(Object.values(model.services).map((service) => service.image))].sort(),
    Object.values(images).sort(),
  );
  for (const service of Object.values(model.services)) {
    assert.equal(service.platform, "linux/arm64");
    assert.equal(service.pull_policy, "never");
    assert.equal(service.restart, "no");
    assert.equal(service.read_only, true);
    assert.equal(service.privileged ?? false, false);
    assert.equal(service.build, undefined);
    assert.equal(service.ports, undefined);
    assert.equal(
      service.labels["io.nourishing.runtime.owner"],
      "11111111-1111-4111-8111-111111111111",
    );
    assert.equal(service.labels["io.nourishing.runtime.revision"], "a".repeat(40));
  }
});

test("capture is HTTPS with separate review/send files and only its isolated private network", async (t) => {
  const { root, model } = await render(t);
  const capture = model.services.capture;
  assert.deepEqual(Object.keys(capture.networks), ["capture"]);
  assert.equal(model.networks.capture.internal, true);
  assert.equal(capture.environment.MP_UI_TLS_CERT, "/run/capture/server.crt");
  assert.equal(capture.environment.MP_UI_TLS_KEY, "/run/capture/server.key");
  assert.equal(capture.environment.MP_UI_AUTH_FILE, "/run/capture/review.htpasswd");
  assert.equal(capture.environment.MP_SEND_API_AUTH_FILE, "/run/capture/send.htpasswd");
  assert.equal(capture.environment.MP_SEND_API_AUTH_ACCEPT_ANY, undefined);
  assert.equal(capture.environment.MP_SMTP_RELAY_CONFIG, undefined);
  assert.equal(capture.environment.MP_SMTP_FORWARD_CONFIG, undefined);
  assert.equal(capture.environment.MP_ALLOWED_HOSTS, "mail-capture");
  for (const path of ["review.htpasswd", "send.htpasswd"])
    assert.ok(
      capture.volumes.some((mount) => mount.source === join(root, "mail", path) && mount.read_only),
    );
  assert.deepEqual(model.services.api.networks.capture?.aliases ?? [], []);
  for (const service of [
    "worker",
    "migrate",
    "azure-canary",
    "meilisearch",
    "internal-tls",
    "postgres",
  ])
    assert.equal(model.services[service].networks?.capture, undefined);
});

test("ordinary app start cannot implicitly start dependencies or maintenance", async (t) => {
  const { model } = await render(t);
  for (const name of ["api", "worker"]) {
    assert.deepEqual(model.services[name].profiles, ["application"]);
    assert.equal(model.services[name].depends_on, undefined);
  }
  assert.equal(model.services.api.stop_grace_period, "5m5s");
  assert.equal(model.services.worker.stop_grace_period, "10m10s");
  for (const name of ["migrate", "azure-canary", "search-bootstrap"])
    assert.deepEqual(model.services[name].profiles, ["maintenance"]);
  for (const name of ["postgres", "meilisearch", "internal-tls", "capture"])
    assert.deepEqual(model.services[name].profiles, ["dependencies"]);
});

test("issuer stays in the Meili loopback namespace and uses reviewed source read-only", async (t) => {
  const { model } = await render(t);
  const issuer = model.services["search-bootstrap"];
  assert.equal(issuer.network_mode, "service:meilisearch");
  assert.equal(issuer.networks, undefined);
  assert.equal(issuer.environment.MEILI_URL, "http://127.0.0.1:7700");
  assert.deepEqual(issuer.command, ["node", "/run/source/scoped-meili-keys.mjs"]);
  assert.ok(
    issuer.volumes.some(
      (mount) => mount.source === join(source, "scripts/scoped-meili-keys.mjs") && mount.read_only,
    ),
    JSON.stringify(issuer.volumes),
  );
});

test("all prepared bind mounts prohibit implicit path creation and retain data outside container cleanup", async (t) => {
  const { model } = await render(t);
  for (const service of Object.values(model.services)) {
    for (const mount of service.volumes ?? []) {
      assert.equal(mount.type, "bind");
      assert.equal(mount.bind.create_host_path, false);
      assert.ok(!mount.source.includes("docker.sock"));
    }
  }
  assert.equal(model.volumes, undefined);
  assert.equal(model.networks.backend.internal, true);
  assert.equal(model.networks.azure_egress.internal ?? false, false);
});

test("internal TLS source has no public listener, admin endpoint or automatic certificate issuance", async () => {
  const caddy = await readFile(
    join(source, "infra/development/azure/runtime/Caddyfile.internal"),
    "utf8",
  );
  assert.match(caddy, /admin off/u);
  assert.match(caddy, /auto_https off/u);
  assert.match(caddy, /https:\/\/meili\.internal:8443/u);
  assert.match(caddy, /reverse_proxy meilisearch:7700/u);
  assert.doesNotMatch(caddy, /acme|:80\b|:443\b|reverse_proxy api/iu);
});

test("prepared host native DNS addresses are fixed inside three reserved nonoverlapping bridges", async (t) => {
  const { model } = await render(t);
  const expected = {
    postgres: { backend: "172.28.0.2" },
    meilisearch: { backend: "172.28.0.3" },
    "internal-tls": { backend: "172.28.0.4" },
    capture: { capture: "172.29.0.2" },
    api: { backend: "172.28.0.5", capture: "172.29.0.3", azure_egress: "172.30.0.2" },
    worker: { backend: "172.28.0.6", azure_egress: "172.30.0.3" },
    migrate: { backend: "172.28.0.7" },
    "azure-canary": { azure_egress: "172.30.0.4" },
  };
  for (const [service, addresses] of Object.entries(expected))
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(model.services[service].networks).map(([name, value]) => [
          name,
          value.ipv4_address,
        ]),
      ),
      addresses,
    );
  for (const [name, octet] of [
    ["backend", 28],
    ["capture", 29],
    ["azure_egress", 30],
  ])
    assert.deepEqual(model.networks[name].ipam, {
      driver: "default",
      config: [{ subnet: `172.${octet}.0.0/24`, gateway: `172.${octet}.0.1` }],
    });
  assert.equal(model.services["search-bootstrap"].network_mode, "service:meilisearch");
});
