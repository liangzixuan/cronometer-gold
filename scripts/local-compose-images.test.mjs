import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { devNull } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";

const localCompose = readFileSync(new URL("../infra/docker/compose.yml", import.meta.url), "utf8");
const composeProjectDirectory = fileURLToPath(new URL("../infra/docker/", import.meta.url));

const POSTGRES_IMAGE =
  "postgres:17.6-alpine@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94";
const MEILISEARCH_IMAGE =
  "getmeili/meilisearch:v1.32.0@sha256:61b1c86c459fa52d0653516f573702791e611574737dc76175ae9d2628c911f5";
const MINIO_IMAGE =
  "quay.io/minio/minio:RELEASE.2025-04-22T22-12-26Z@sha256:a1ea29fa28355559ef137d71fc570e508a214ec84ff8083e39bc5428980b015e";
const MAILPIT_IMAGE =
  "axllent/mailpit:v1.29.4@sha256:0530ab1c658a0f225f148e617522db84053bd1e4879e664c23de5fee44ad6819";
const ATTACKER_IMAGE = `busybox:latest@sha256:${"0".repeat(64)}`;

const EXPECTED_IMAGES = [
  { service: "postgres", image: POSTGRES_IMAGE },
  { service: "meilisearch", image: MEILISEARCH_IMAGE },
  { service: "minio", image: MINIO_IMAGE },
  { service: "minio-bootstrap", image: MINIO_IMAGE },
  { service: "mailpit", image: MAILPIT_IMAGE },
].map(({ service, image }) => ({ service, declaration: `    image: ${image}` }));

function imageKeyLines(source) {
  const keyPattern = /(?:^|[\s#{,])(?:image|"image"|'image')\s*:/gimu;
  const lines = [];
  for (const match of source.matchAll(keyPattern)) {
    const start = source.lastIndexOf("\n", match.index) + 1;
    const relativeEnd = source.slice(start).indexOf("\n");
    const end = relativeEnd === -1 ? source.length : start + relativeEnd;
    lines.push(source.slice(start, end).replace(/\r$/u, ""));
  }
  return lines;
}

function serviceBlockLines(source, service) {
  const lines = source.split(/\r?\n/u);
  const heading = `  ${service}:`;
  const starts = lines.flatMap((line, index) => (line === heading ? [index] : []));
  assert.equal(starts.length, 1, `${service} must be declared exactly once`);

  const start = starts[0];
  const relativeEnd = lines.slice(start + 1).findIndex((line) => {
    return /^ {2}\S.*:\s*$/u.test(line) || /^\S.*:\s*$/u.test(line);
  });
  const end = relativeEnd === -1 ? lines.length : start + 1 + relativeEnd;
  return lines.slice(start, end);
}

function renderLocalCompose(source) {
  const rendered = spawnSync(
    "docker",
    [
      "compose",
      "--profile",
      "*",
      "--project-directory",
      composeProjectDirectory,
      "--env-file",
      devNull,
      "-f",
      "-",
      "config",
      "--format",
      "json",
    ],
    {
      encoding: "utf8",
      env: { ...process.env, LOCALSTACK_PROFILE_NAMESPACE: "compose-contract" },
      input: source,
    },
  );

  assert.equal(rendered.error, undefined, "Docker Compose must be available for image policy");
  assert.equal(
    rendered.status,
    0,
    `Docker Compose must render the policy fixture: ${rendered.stderr.trim()}`,
  );

  const model = JSON.parse(rendered.stdout);
  assert.equal(typeof model.services, "object", "rendered Compose services must be an object");
  return model;
}

function renderLocalComposeImages(source) {
  const model = renderLocalCompose(source);
  const forbiddenArtifactFields = ["build", "provider", "pull_policy", "platform"];

  for (const configuration of Object.values(model.services)) {
    assert.deepEqual(
      forbiddenArtifactFields.filter((field) => configuration[field] !== undefined),
      [],
      "rendered services must not define build, provider, pull-policy, or platform overrides",
    );
  }

  return Object.entries(model.services)
    .map(([service, configuration]) => ({
      service,
      image: configuration.image,
    }))
    .sort((left, right) => left.service.localeCompare(right.service));
}

function validateLocalComposeImages(source) {
  const expectedDeclarations = EXPECTED_IMAGES.map(({ declaration }) => declaration);
  assert.deepEqual(
    imageKeyLines(source),
    expectedDeclarations,
    "compose image keys must be the five exact canonical declarations in order",
  );

  for (const { service, declaration } of EXPECTED_IMAGES) {
    const block = serviceBlockLines(source, service);
    assert.equal(
      block.filter((line) => line === declaration).length,
      1,
      `${service} must use its exact reviewed image declaration`,
    );
  }

  const expectedServiceImages = EXPECTED_IMAGES.map(({ service, declaration }) => ({
    service,
    image: declaration.trim().slice("image: ".length),
  })).sort((left, right) => left.service.localeCompare(right.service));
  assert.deepEqual(
    renderLocalComposeImages(source),
    expectedServiceImages,
    "rendered Compose model must contain exactly the five reviewed services and images",
  );
}

function replaceExactlyOnce(source, from, to) {
  assert.equal(source.split(from).length - 1, 1, `mutation source must occur once: ${from}`);
  return source.replace(from, to);
}

function assertRejected(source, label) {
  assert.notEqual(source, localCompose, `${label} must mutate the compose source`);
  assert.throws(
    () => validateLocalComposeImages(source),
    { name: "AssertionError" },
    `${label} must be rejected`,
  );
}

test("binds every local Compose service to the five reviewed image declarations", () => {
  validateLocalComposeImages(localCompose);
});

test("rejects missing, wrong, or tag-only PostgreSQL and Mailpit image locks", () => {
  const cases = [
    {
      label: "missing PostgreSQL image",
      source: replaceExactlyOnce(localCompose, `    image: ${POSTGRES_IMAGE}\n`, ""),
    },
    {
      label: "wrong PostgreSQL digest",
      source: replaceExactlyOnce(
        localCompose,
        POSTGRES_IMAGE,
        `${POSTGRES_IMAGE.slice(0, -64)}${"0".repeat(64)}`,
      ),
    },
    {
      label: "tag-only PostgreSQL image",
      source: replaceExactlyOnce(localCompose, POSTGRES_IMAGE, "postgres:17.6-alpine"),
    },
    {
      label: "missing Mailpit image",
      source: replaceExactlyOnce(localCompose, `    image: ${MAILPIT_IMAGE}\n`, ""),
    },
    {
      label: "wrong Mailpit digest",
      source: replaceExactlyOnce(
        localCompose,
        MAILPIT_IMAGE,
        `${MAILPIT_IMAGE.slice(0, -64)}${"0".repeat(64)}`,
      ),
    },
    {
      label: "tag-only Mailpit image",
      source: replaceExactlyOnce(localCompose, MAILPIT_IMAGE, "axllent/mailpit:v1.29.4"),
    },
  ];

  for (const { source, label } of cases) assertRejected(source, label);
});

test("rejects added, commented, quoted, flow-style, duplicate, or mixed-case image keys", () => {
  const postgresDeclaration = `    image: ${POSTGRES_IMAGE}`;
  const cases = [
    {
      label: "another service image",
      source: replaceExactlyOnce(
        localCompose,
        "services:\n",
        `services:\n  attacker:\n    image: ${ATTACKER_IMAGE}\n`,
      ),
    },
    {
      label: "duplicate image key",
      source: replaceExactlyOnce(
        localCompose,
        postgresDeclaration,
        `${postgresDeclaration}\n    image: ${ATTACKER_IMAGE}`,
      ),
    },
    {
      label: "commented image key",
      source: replaceExactlyOnce(
        localCompose,
        postgresDeclaration,
        `${postgresDeclaration}\n    # image: ${ATTACKER_IMAGE}`,
      ),
    },
    {
      label: "quoted image key",
      source: replaceExactlyOnce(
        localCompose,
        postgresDeclaration,
        `${postgresDeclaration}\n    "image": ${ATTACKER_IMAGE}`,
      ),
    },
    {
      label: "flow-style image key",
      source: replaceExactlyOnce(
        localCompose,
        "name: nutrition-tracker-local",
        `name: nutrition-tracker-local\nx-attacker: { image: ${ATTACKER_IMAGE} }`,
      ),
    },
    {
      label: "mixed-case image key",
      source: replaceExactlyOnce(
        localCompose,
        postgresDeclaration,
        `${postgresDeclaration}\n    ImAgE: ${ATTACKER_IMAGE}`,
      ),
    },
    {
      label: "hidden escaped image key",
      renderable: true,
      source: replaceExactlyOnce(
        localCompose,
        "services:\n",
        [
          "services:",
          "  attacker:",
          "    profiles: [hidden]",
          `    "im\\u0061ge": ${ATTACKER_IMAGE}`,
          "",
        ].join("\n"),
      ),
    },
    {
      label: "included service",
      renderable: true,
      source: replaceExactlyOnce(
        localCompose,
        "name: nutrition-tracker-local\n",
        ["name: nutrition-tracker-local", "include:", "  - ../localstack/compose.dev.yml", ""].join(
          "\n",
        ),
      ),
    },
    {
      label: "extended service",
      renderable: true,
      source: replaceExactlyOnce(
        localCompose,
        "services:\n",
        ["services:", "  attacker:", "    extends:", "      service: postgres", ""].join("\n"),
      ),
    },
    {
      label: "alternate build source",
      renderable: true,
      source: replaceExactlyOnce(
        localCompose,
        postgresDeclaration,
        [
          postgresDeclaration,
          "    pull_policy: build",
          "    build:",
          "      context: https://example.invalid/unreviewed.git",
        ].join("\n"),
      ),
    },
    {
      label: "platform override",
      renderable: true,
      source: replaceExactlyOnce(
        localCompose,
        postgresDeclaration,
        [postgresDeclaration, "    platform: linux/386"].join("\n"),
      ),
    },
  ];

  for (const { source, label, renderable } of cases) {
    if (renderable) {
      assert.doesNotThrow(
        () => renderLocalCompose(source),
        "semantic mutation must be valid Compose",
      );
    }
    assertRejected(source, label);
  }
});
