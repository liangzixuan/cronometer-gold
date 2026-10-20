import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { devNull } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  owner,
  project,
  references,
  revision,
  runtimeDockerFixture,
} from "./azure-development-runtime-fixture.mjs";

const source = resolve(fileURLToPath(new URL("../", import.meta.url)));

test("installed Compose gates public access on migration, replay and healthy applications without leaking maintenance credentials", async (t) => {
  const f = await runtimeDockerFixture(t);
  await writeFile(join(f.root, "config/restore.env"), "RESTORE_ONLY=synthetic-restore\n", {
    mode: 0o600,
    flag: "wx",
  });
  await writeFile(join(f.root, "config/canary.env"), "CANARY_ONLY=synthetic-canary\n");
  const parsed = spawnSync(
    "docker",
    [
      "compose",
      "--profile",
      "*",
      "--env-file",
      devNull,
      "-f",
      join(source, "infra/development/azure/runtime/compose.yaml"),
      "-f",
      join(source, "infra/development/azure/hosted/compose.yaml"),
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
        ...references,
        RUNTIME_ROOT: f.root,
        RUNTIME_SOURCE: source,
        RUNTIME_PROJECT: project,
        RUNTIME_OWNER: owner,
        RUNTIME_REVISION: revision,
        ACME_EMAIL: "synthetic@example.invalid",
        ADMIN_IPV4_CIDR: "203.0.113.7/32",
        DEPLOYMENT_READINESS_TOKEN: "a".repeat(64),
      },
    },
  );
  assert.equal(parsed.status, 0, parsed.stderr);
  const { services } = JSON.parse(parsed.stdout);
  assert.equal(services.migrate.depends_on.postgres.condition, "service_healthy");
  assert.equal(
    services["restore-admission"].depends_on.migrate.condition,
    "service_completed_successfully",
  );
  assert.equal(services["restore-admission"].environment.RESTORE_ONLY, "synthetic-restore");
  assert.equal(services["restore-admission"].environment.CANARY_ONLY, undefined);
  assert.deepEqual(services["restore-admission"].command, [
    "node",
    "dist/erasure-ledger-restore.js",
  ]);
  for (const name of ["api", "worker"]) {
    assert.equal(
      services[name].depends_on["restore-admission"].condition,
      "service_completed_successfully",
    );
    assert.equal(
      services[name].depends_on["search-bootstrap"].condition,
      "service_completed_successfully",
    );
    assert.equal(services[name].environment.RESTORE_ONLY, undefined);
    assert.equal(services[name].environment.CANARY_ONLY, undefined);
    assert.equal(services[name].environment.NOURISHING_RUNTIME_NOT_AFTER_UTC, undefined);
    assert.equal(services["public-edge"].depends_on[name].condition, "service_healthy");
  }
  assert.equal(services.worker.environment.NODE_ENV, "production");
  assert.equal(services["public-edge"].environment.API_FQDN, "staging-api.nourishing.app");
  assert.equal(services["public-edge"].volumes.filter((v) => v.type === "bind").length, 2);
  assert(
    services["public-edge"].volumes.some(
      (v) => v.source === join(source, "infra/azure/files/Caddyfile"),
    ),
  );
  for (const [name, service] of Object.entries(services)) {
    assert.equal(service.restart, "no", name);
    if (name !== "public-edge") assert.equal(service.ports, undefined, name);
  }
  assert.deepEqual(
    services["public-edge"].ports.map((p) => [p.host_ip, p.published, p.target]),
    [["0.0.0.0", "443", 443]],
  );
  assert.equal(services.api.logging.driver, "journald");
  assert.equal(services.api.logging.options, undefined);
});

test("first-host installation shell parses without executing native operations", () => {
  const result = spawnSync(
    "bash",
    ["-n", join(source, "infra/development/azure/hosted/install-host.sh")],
    { encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(result.status, 0, result.stderr);
});
