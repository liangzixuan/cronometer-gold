import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { workflowJob, workflowStep } from "./workflow-contract-helpers.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

function readSource(relativePath) {
  return readFileSync(join(repositoryRoot, relativePath), "utf8");
}

function readJson(relativePath) {
  return JSON.parse(readSource(relativePath));
}

const pnpmAction = "pnpm/action-setup@fc06bc1257f339d1d5d8b3a19a8cae5388b55320";
const setupNodeAction = "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38";
const pnpmUseLine = `        uses: ${pnpmAction} # v4.4.0`;
const setupNodeUseLine = `        uses: ${setupNodeAction} # v6.5.0`;
const nodeVersionLine = "          node-version: 22";
const pnpmVersionCheckLine = '          test "$(pnpm --version)" = "11.19.0"';
const installRunLine = "          pnpm install --frozen-lockfile --strict-peer-dependencies";
const pnpmSetupStep = ["      - name: Install pnpm", pnpmUseLine, ""].join("\n");
const nodeSetupStep = [
  "      - name: Set up Node.js",
  setupNodeUseLine,
  "        with:",
  nodeVersionLine,
  "          cache: pnpm",
  "",
].join("\n");
const lockedInstallStep = [
  "      - name: Install locked dependencies",
  "        run: |",
  pnpmVersionCheckLine,
  installRunLine,
  "",
].join("\n");
const nodeBuilderLine =
  "ARG NODE_BUILD_IMAGE=node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436";
const pnpmArchiveChecksumLine =
  "ADD --checksum=sha256:b9e49603540d04107b98e93917a30e6114970d403c23e40309a44ea9c2bca7fd \\";
const pnpmArchiveUrlLine = "    https://registry.npmjs.org/pnpm/-/pnpm-11.19.0.tgz /tmp/pnpm.tgz";
const applicationBuilderStageLine = `FROM \${NODE_BUILD_IMAGE} AS build`;
const applicationRuntimeStageLine = `FROM \${NODE_RUNTIME_IMAGE} AS runtime`;
const nodeSourceBuildStageLine = `FROM \${NODE_SOURCE_BUILD_IMAGE} AS node-build`;
const nodeCppRuntimeStageLine = `FROM \${NODE_CPP_RUNTIME_SOURCE_IMAGE} AS cxx-runtime-source`;
const nodeRuntimeStageLine = `FROM \${NODE_RUNTIME_BASE_IMAGE} AS runtime`;
const nodeSourceBuildArgLine =
  "ARG NODE_SOURCE_BUILD_IMAGE=docker.io/library/python:3.12.14-bookworm@sha256:80f5d259a5969c86f6c92145d572de4a68c68e0edd28d4367dec0fb411b42af3";
const nodeCppRuntimeArgLine =
  "ARG NODE_CPP_RUNTIME_SOURCE_IMAGE=gcr.io/distroless/nodejs22-debian13:nonroot@sha256:939d6f1671529d230f50b563578e9b5d206af58f038b10ebd7e1233023d4e167";
const nodeRuntimeBaseArgLine =
  "ARG NODE_RUNTIME_BASE_IMAGE=gcr.io/distroless/base-nossl-debian13:nonroot@sha256:86554c46a420d507ff2d678fd261ab8691fba4875a20302f38a49e684b42a33f";
const pnpmArchiveBlock = [pnpmArchiveChecksumLine, pnpmArchiveUrlLine].join("\n");
const pnpmConsumerBlock = [
  "RUN npm install --global --ignore-scripts /tmp/pnpm.tgz && \\",
  "    rm /tmp/pnpm.tgz && \\",
  '    test "$(pnpm --version)" = 11.19.0',
].join("\n");
const pnpmUseVersionLine = '    test "$(pnpm --version)" = 11.19.0 && \\';

function logicalDockerInstructions(source) {
  const lines = source.split("\n");
  const instructions = [];

  for (let index = 0; index < lines.length; index += 1) {
    const match = /^\s*(?<name>[a-z]+)\s/iu.exec(lines[index]);
    if (!match?.groups?.name) continue;

    const physicalLines = [lines[index]];
    while (/\\\s*$/u.test(physicalLines.at(-1) ?? "") && index + 1 < lines.length) {
      index += 1;
      physicalLines.push(lines[index]);
    }
    instructions.push({
      name: match.groups.name.toUpperCase(),
      text: physicalLines.join("\n"),
    });
  }

  return instructions;
}

function dockerInstructionTexts(source, instruction) {
  return logicalDockerInstructions(source)
    .filter(({ name }) => name === instruction)
    .map(({ text }) => text);
}

function continuationNormalizedLines(source) {
  return source.replace(/\\\r?\n[ \t]*/gu, " ").split("\n");
}

function isPackageManagerOverride(line, rejectIsolatedGlobalFlag = false) {
  const hasGlobalFlag = /(?:^|\s)(?:--global|-g)(?=\s|=|$)/iu.test(line);
  if (hasGlobalFlag && (rejectIsolatedGlobalFlag || /\bpnpm\b/iu.test(line))) {
    return true;
  }
  if (/\b(?:corepack|npm|npx|pnpx)\b/iu.test(line)) return true;
  if (/\bpnpm\s+(?:env|self-update|setup)\b/iu.test(line)) return true;
  return false;
}

const applicationImageToolchains = [
  ["infra/docker/api.Dockerfile", "@nutrition-tracker/api"],
  ["infra/docker/migrator.Dockerfile", "@nutrition-tracker/db"],
  ["infra/docker/web.Dockerfile", "@nutrition-tracker/web"],
  ["infra/docker/worker.Dockerfile", "@nutrition-tracker/worker"],
];

function assertCiToolchain(source) {
  const jobs = [
    ["quality", workflowJob(source, "quality")],
    ["database", workflowJob(source, "database")],
  ];

  for (const [name, job] of jobs) {
    assert.equal(
      workflowStep(job, "Install pnpm"),
      pnpmSetupStep,
      `${name} must derive exact pnpm 11.19.0 without a version override`,
    );
    assert.equal(
      workflowStep(job, "Set up Node.js"),
      nodeSetupStep,
      `${name} must select the reviewed Node 22 setup exactly`,
    );
    assert.equal(
      workflowStep(job, "Install locked dependencies"),
      lockedInstallStep,
      `${name} must install only the immutable lockfile`,
    );
  }

  const lines = source.split("\n");
  assert.deepEqual(
    lines.filter((line) => line.toLowerCase().includes("pnpm/action-setup")),
    [pnpmUseLine, pnpmUseLine],
    "CI must contain exactly the two reviewed pnpm setup references",
  );
  assert.deepEqual(
    lines.filter((line) => line.toLowerCase().includes("actions/setup-node")),
    [setupNodeUseLine, setupNodeUseLine],
    "CI must contain exactly the two reviewed Node setup references",
  );
  assert.deepEqual(
    lines.filter((line) => line.trimStart().startsWith("node-version:")),
    [nodeVersionLine, nodeVersionLine],
    "CI must contain only the two reviewed Node 22 selections",
  );
  assert.deepEqual(
    lines.filter((line) => line.includes("pnpm install")),
    [installRunLine, installRunLine],
    "CI must contain only the two reviewed frozen installs",
  );
  assert.deepEqual(
    continuationNormalizedLines(source).filter((line) => isPackageManagerOverride(line, true)),
    [],
    "CI must not contain a second package-manager installer or activator",
  );
}

function assertApplicationImageToolchain(source, scope, relativePath) {
  const lines = source.split("\n");
  const installLine = `    pnpm install --frozen-lockfile --strict-peer-dependencies --filter ${scope}... && \\`;

  assert.deepEqual(
    dockerInstructionTexts(source, "ARG").filter((line) => /\bNODE_BUILD_IMAGE=/iu.test(line)),
    [nodeBuilderLine],
    `${relativePath} must use the sole reviewed Node 22 builder digest`,
  );
  assert.deepEqual(
    dockerInstructionTexts(source, "FROM"),
    [applicationBuilderStageLine, applicationRuntimeStageLine],
    `${relativePath} must consume only the reviewed build and runtime stages`,
  );
  assert.deepEqual(
    dockerInstructionTexts(source, "ADD"),
    [pnpmArchiveBlock],
    `${relativePath} must bind the exact pnpm 11.19.0 archive checksum`,
  );
  assert.deepEqual(
    lines.filter((line) => line.includes("registry.npmjs.org/pnpm/-/pnpm-")),
    [pnpmArchiveUrlLine],
    `${relativePath} must fetch only exact pnpm 11.19.0 over HTTPS`,
  );
  assert.equal(
    source.split(pnpmArchiveBlock).length - 1,
    1,
    `${relativePath} must bind the approved pnpm checksum directly to its URL`,
  );
  assert.equal(
    source.split(pnpmConsumerBlock).length - 1,
    1,
    `${relativePath} must install, remove, and verify the approved pnpm archive`,
  );
  assert.deepEqual(
    continuationNormalizedLines(source).filter((line) => isPackageManagerOverride(line)),
    [continuationNormalizedLines(pnpmConsumerBlock)[0]],
    `${relativePath} must have only the reviewed pnpm installer or activator`,
  );
  assert.deepEqual(
    lines.filter((line) => line.includes("pnpm install")),
    [installLine],
    `${relativePath} must have one scope-filtered frozen install`,
  );
  assert.equal(
    source.split(`${pnpmUseVersionLine}\n${installLine}`).length - 1,
    1,
    `${relativePath} must verify exact pnpm immediately before its sole install`,
  );
}

function assertNodeRuntimeToolchain(source) {
  const lines = source.split("\n");
  const sourceChecksumLine =
    "ADD --checksum=sha256:bbe768df8d5815d7fa76124052985332452e0a4742d39f32027550d1aab8f6fb \\";
  const sourceManifestChecksumLine =
    "ADD --checksum=sha256:778ac5b2fcdbd68d9c0ae9f4310674faa3af0910bd0d18e7f6597787c40a3e39 \\";
  const sourceSignatureChecksumLine =
    "ADD --checksum=sha256:169f1452c14cd653247408352f1534b9f31e3d13f9c6399c3977368095e11eda \\";
  const opensslPatchChecksumLine =
    "ADD --checksum=sha256:3b4f3ff1e9d26ca3dd75f6d98cc5d30c7dbfc03892e4bc0037a7e14bec8c5087 \\";
  const sourceUrlLine =
    "    https://nodejs.org/dist/v22.23.2/node-v22.23.2.tar.xz /tmp/node-v22.23.2.tar.xz";
  const sourceManifestUrlLine =
    "    https://nodejs.org/dist/v22.23.2/SHASUMS256.txt /tmp/SHASUMS256.txt";
  const sourceSignatureUrlLine =
    "    https://nodejs.org/dist/v22.23.2/SHASUMS256.txt.sig /tmp/SHASUMS256.txt.sig";
  const opensslPatchUrlLine =
    "    https://github.com/openssl/openssl/commit/08e7756c3900bcfd77a720e7b74e27d6e4ed01a9.patch \\";
  const opensslPatchDestinationLine = "    /tmp/CVE-2026-14456.patch";
  const versionLabel = '      io.cronometer.upstream.node.version="22.23.2" \\';
  const runtimeStages = [nodeSourceBuildStageLine, nodeCppRuntimeStageLine, nodeRuntimeStageLine];
  const runtimeCopy = "COPY --from=node-build /opt/nodejs/ /nodejs/";
  const runtimeEntrypoint = "ENTRYPOINT []";
  const runtimeCommand = 'CMD ["/nodejs/bin/node"]';

  assert.ok(
    source.includes(`${sourceChecksumLine}\n${sourceUrlLine}`),
    "hardened Node must bind the reviewed 22.23.2 source checksum and URL",
  );
  assert.deepEqual(
    dockerInstructionTexts(source, "ARG"),
    [nodeSourceBuildArgLine, nodeCppRuntimeArgLine, nodeRuntimeBaseArgLine],
    "hardened Node must bind all three reviewed base images by digest",
  );
  assert.deepEqual(
    dockerInstructionTexts(source, "FROM"),
    runtimeStages,
    "hardened Node must consume only the reviewed build and runtime stages",
  );
  assert.deepEqual(
    dockerInstructionTexts(source, "ADD"),
    [
      [sourceChecksumLine, sourceUrlLine].join("\n"),
      [sourceManifestChecksumLine, sourceManifestUrlLine].join("\n"),
      [sourceSignatureChecksumLine, sourceSignatureUrlLine].join("\n"),
      [opensslPatchChecksumLine, opensslPatchUrlLine, opensslPatchDestinationLine].join("\n"),
    ],
    "hardened Node must bind all four reviewed checksum, HTTPS source, and destination tuples",
  );
  assert.deepEqual(
    dockerInstructionTexts(source, "COPY").filter((instruction) => instruction.includes("/nodejs")),
    [runtimeCopy],
    "hardened Node runtime must have one reviewed COPY touching /nodejs",
  );
  assert.deepEqual(
    dockerInstructionTexts(source, "ENTRYPOINT"),
    [runtimeEntrypoint],
    "hardened Node runtime must retain one exact empty entrypoint",
  );
  assert.deepEqual(
    dockerInstructionTexts(source, "CMD"),
    [runtimeCommand],
    "hardened Node runtime must execute only the reviewed Node binary",
  );
  assert.deepEqual(
    lines.filter(
      (line) => line.includes("nodejs.org/dist/") && line.includes(".tar.xz /tmp/node-"),
    ),
    [sourceUrlLine],
    "hardened Node must have one source archive",
  );
  assert.deepEqual(
    lines.filter((line) => line.includes("io.cronometer.upstream.node.version=")),
    [versionLabel],
    "hardened Node must have one exact runtime version label",
  );
  const runtimeAssertions = lines.filter((line) => line.includes("assert.equal(process.version,"));
  assert.equal(
    runtimeAssertions.length,
    1,
    "hardened Node must assert its executable version once",
  );
  assert.match(runtimeAssertions[0], /assert\.equal\(process\.version, "v22\.23\.2"\)/u);
}

function assertReadmeToolchain(readme) {
  const fence = String.fromCharCode(96).repeat(3);
  const opening = `## Getting started\n\n${fence}sh\n`;
  const start = readme.indexOf(opening);
  assert.notEqual(start, -1, "README must define one getting-started shell block");
  assert.equal(readme.indexOf(opening, start + 1), -1, "getting-started heading must be unique");

  const commandStart = start + opening.length;
  const commandEnd = readme.indexOf(`\n${fence}`, commandStart);
  assert.notEqual(commandEnd, -1, "getting-started shell block must close");
  assert.deepEqual(readme.slice(commandStart, commandEnd).split("\n"), [
    "install -m 600 .env.example .env",
    "corepack enable",
    "corepack install",
    'test "$(pnpm --version)" = "11.19.0"',
    "pnpm install --frozen-lockfile --strict-peer-dependencies",
    "pnpm infra:up",
    "pnpm db:migrate",
    "pnpm dev",
  ]);
  assert.deepEqual(
    readme.split("\n").filter((line) => line.startsWith("pnpm install")),
    ["pnpm install --frozen-lockfile --strict-peer-dependencies"],
    "README must contain exactly one strict frozen dependency install",
  );

  const tick = String.fromCharCode(96);
  for (const expected of [
    `| General source | Node ${tick}>=22.13.0${tick} |`,
    `| Hosted CI | Node ${tick}22${tick} |`,
    `| Hardened container evidence | Node ${tick}22.23.2${tick} |`,
    `| Package manager | pnpm ${tick}11.19.0${tick} |`,
    "| Mobile cloud builds | EAS CLI " +
      tick +
      "22.0.0" +
      tick +
      "; Node " +
      tick +
      "22.13.0" +
      tick +
      "; pnpm " +
      tick +
      "11.19.0" +
      tick +
      " |",
  ]) {
    assert.ok(readme.includes(expected), `README toolchain table must include ${expected}`);
  }

  assert.match(readme, /Node values are intentionally distinct and must not be unified/u);
  assert.match(readme, /EAS CLI is not a baseline development prerequisite/u);
  assert.match(readme, /official HTTPS registry with normal TLS\nverification/u);
}

function readWorkspacePatterns() {
  const source = readSource("pnpm-workspace.yaml");
  const lines = source.split(/\r?\n/u);
  const packagesIndex = lines.indexOf("packages:");
  assert.notEqual(packagesIndex, -1, "pnpm-workspace.yaml must define packages");

  const patterns = [];
  for (const line of lines.slice(packagesIndex + 1)) {
    if (line.length === 0 || line.trimStart().startsWith("#")) continue;
    if (!line.startsWith(" ")) break;

    const match = /^ {2}- ([A-Za-z0-9_./*-]+)$/u.exec(line);
    assert.ok(match, `Unsupported workspace package entry: ${line}`);
    patterns.push(match[1]);
  }

  assert.ok(patterns.length > 0, "pnpm-workspace.yaml must include workspace patterns");
  return patterns;
}

test("keeps development toolchain roles exact, distinct, and fail closed", () => {
  const rootPackage = readJson("package.json");
  const workspace = readSource("pnpm-workspace.yaml");
  const readme = readSource("README.md");
  const workflow = readSource(".github/workflows/ci.yml");
  const eas = readJson("apps/mobile/eas.json");
  const nodeRuntime = readSource("infra/docker/node-runtime.Dockerfile");

  assert.equal(rootPackage.packageManager, "pnpm@11.19.0");
  assert.equal(rootPackage.engines?.node, ">=22.13.0");
  assert.equal(workspace.match(/^pmOnFail: error$/gmu)?.length, 1);
  assert.equal(workspace.match(/^engineStrict: true$/gmu)?.length, 1);
  assert.equal(workspace.match(/^strictPeerDependencies: true$/gmu)?.length, 1);

  assertCiToolchain(workflow);

  const production = eas.build?.production;
  const physicalDevice = eas.build?.["physical-device"];
  assert.deepEqual(Object.keys(eas.build ?? {}).sort(), ["physical-device", "production"]);
  assert.equal(eas.cli?.version, "22.0.0");
  assert.equal(production?.node, "22.13.0");
  assert.equal(production?.corepack, true);
  assert.equal(production?.pnpm, "11.19.0");
  assert.equal(physicalDevice?.extends, "production");
  for (const key of ["node", "corepack", "pnpm"]) {
    assert.equal(
      Object.hasOwn(physicalDevice ?? {}, key),
      false,
      `physical-device must inherit the production ${key} pin`,
    );
  }

  assertNodeRuntimeToolchain(nodeRuntime);
  for (const [relativePath, scope] of applicationImageToolchains) {
    assertApplicationImageToolchain(readSource(relativePath), scope, relativePath);
  }
  assertReadmeToolchain(readme);
});

test("rejects CI package-manager, Node, and immutable-install drift", () => {
  const workflow = readSource(".github/workflows/ci.yml");
  const overriddenPnpmStep = [
    "      - name: Install pnpm",
    pnpmUseLine,
    "        with:",
    "          version: 10",
    "",
  ].join("\n");
  const mutations = [
    [
      "an alternate pnpm action revision",
      workflow.replace(pnpmAction, "pnpm/action-setup@0000000000000000000000000000000000000000"),
    ],
    ["an explicit pnpm version override", workflow.replace(pnpmSetupStep, overriddenPnpmStep)],
    ["Node 24", workflow.replace(nodeVersionLine, "          node-version: 24")],
    [
      "a missing point-of-use pnpm version check",
      workflow.replace(`${pnpmVersionCheckLine}\n${installRunLine}`, installRunLine),
    ],
    [
      "a later pnpm installer override",
      workflow.replace(
        lockedInstallStep,
        `${lockedInstallStep}      - name: Override pnpm\n        run: npm install --global pnpm@12\n`,
      ),
    ],
    [
      "a later global pnpm add override",
      workflow.replace(
        lockedInstallStep,
        `${lockedInstallStep}      - name: Override pnpm\n        run: pnpm add --global pnpm@12\n`,
      ),
    ],
    [
      "a later global pnpm install alias",
      workflow.replace(
        lockedInstallStep,
        `${lockedInstallStep}      - name: Override pnpm\n        run: pnpm i -g pnpm@12\n`,
      ),
    ],
    [
      "a continuation-wrapped pnpm override",
      workflow.replace(
        lockedInstallStep,
        [
          lockedInstallStep,
          "      - name: Override pnpm",
          "        run: |",
          "          pnpm add \\",
          "            --global pnpm@12",
          "",
        ].join("\n"),
      ),
    ],
    [
      "a YAML-folded pnpm override",
      workflow.replace(
        lockedInstallStep,
        [
          lockedInstallStep,
          "      - name: Override pnpm",
          "        run: >-",
          "          pnpm i",
          "          -g pnpm@12",
          "",
        ].join("\n"),
      ),
    ],
    ["missing strict-peer enforcement", workflow.replace(" --strict-peer-dependencies", "")],
    ["a mutable install", workflow.replace(installRunLine, "        run: pnpm install")],
  ];

  for (const [label, mutated] of mutations) {
    assert.throws(
      () => assertCiToolchain(mutated),
      { name: "AssertionError" },
      `must reject ${label}`,
    );
  }
});

test("rejects application-image toolchain and install drift", () => {
  const [relativePath, scope] = applicationImageToolchains[0];
  const source = readSource(relativePath);
  const installLine = `    pnpm install --frozen-lockfile --strict-peer-dependencies --filter ${scope}... && \\`;
  const mutations = [
    ["another Node builder", source.replace("node:22-bookworm-slim", "node:23-bookworm-slim")],
    [
      "a detached Node builder",
      source.replace(applicationBuilderStageLine, "FROM node:24-bookworm-slim AS build"),
    ],
    ["another pnpm archive", source.replace("pnpm-11.19.0.tgz", "pnpm-11.20.0.tgz")],
    [
      "a detached pnpm checksum",
      source.replace(
        pnpmArchiveBlock,
        `${pnpmArchiveChecksumLine}\n    # detached from the reviewed URL\n${pnpmArchiveUrlLine}`,
      ),
    ],
    [
      "another pnpm consumer",
      source.replace(pnpmConsumerBlock, "RUN npm install --global pnpm@12"),
    ],
    [
      "a later pnpm installer override",
      source.replace(pnpmConsumerBlock, `${pnpmConsumerBlock}\nRUN npm install --global pnpm@12`),
    ],
    [
      "a missing point-of-use pnpm version check",
      source.replace(`${pnpmUseVersionLine}\n${installLine}`, installLine),
    ],
    [
      "a global pnpm add override before the application build",
      source.replace(installLine, `${installLine}\n    pnpm add --global pnpm@12 && \\`),
    ],
    [
      "a global pnpm install alias before the application build",
      source.replace(installLine, `${installLine}\n    pnpm i -g pnpm@12 && \\`),
    ],
    [
      "a continuation-wrapped pnpm override before the application build",
      source.replace(
        installLine,
        [installLine, "    pnpm add \\", "      --global pnpm@12 && \\"].join("\n"),
      ),
    ],
    ["missing strict-peer enforcement", source.replace("--strict-peer-dependencies ", "")],
    [
      "a mutable install",
      source.replace("install --frozen-lockfile", "install --no-frozen-lockfile"),
    ],
  ];

  for (const [label, mutated] of mutations) {
    assert.throws(
      () => assertApplicationImageToolchain(mutated, scope, relativePath),
      { name: "AssertionError" },
      `must reject ${label}`,
    );
  }
});

test("rejects a detached hardened Node runtime", () => {
  const source = readSource("infra/docker/node-runtime.Dockerfile");
  const mutations = [
    [
      "an alternate Node source builder image",
      source.replace(nodeSourceBuildArgLine, "ARG NODE_SOURCE_BUILD_IMAGE=ubuntu:latest"),
    ],
    [
      "an alternate C++ runtime source image",
      source.replace(nodeCppRuntimeArgLine, "ARG NODE_CPP_RUNTIME_SOURCE_IMAGE=ubuntu:latest"),
    ],
    [
      "an alternate final runtime base image",
      source.replace(nodeRuntimeBaseArgLine, "ARG NODE_RUNTIME_BASE_IMAGE=ubuntu:latest"),
    ],
    [
      "a detached source-manifest destination",
      source.replace(
        "https://nodejs.org/dist/v22.23.2/SHASUMS256.txt /tmp/SHASUMS256.txt",
        "https://nodejs.org/dist/v22.23.2/SHASUMS256.txt /tmp/unreviewed-manifest.txt",
      ),
    ],
    ["an alternate final runtime", source.replace(nodeRuntimeStageLine, "from scratch AS runtime")],
    [
      "a detached source-built executable",
      source.replace(
        "COPY --from=node-build /opt/nodejs/ /nodejs/",
        "COPY --from=cxx-runtime-source /opt/nodejs/ /nodejs/",
      ),
    ],
    [
      "a later overwrite of the reviewed Node executable",
      source.replace(
        "COPY --from=node-build /opt/nodejs/ /nodejs/",
        [
          "COPY --from=node-build /opt/nodejs/ /nodejs/",
          "copy --from=cxx-runtime-source \\",
          "  /nodejs/bin/node \\",
          "  /nodejs/bin/node",
        ].join("\n"),
      ),
    ],
    [
      "a later lowercase runtime entrypoint override",
      source.replace("ENTRYPOINT []", 'ENTRYPOINT []\nentrypoint ["/bin/sh"]'),
    ],
    [
      "a later lowercase runtime command override",
      source.replace('CMD ["/nodejs/bin/node"]', 'CMD ["/nodejs/bin/node"]\ncmd ["/bin/sh"]'),
    ],
    [
      "a later lowercase ADD into the Node runtime",
      source.replace(
        'CMD ["/nodejs/bin/node"]',
        'add infra/docker/node-release-CC68F5A3106FF448322E48ED27F5E38D5B0A215F.asc /nodejs/bin/node\nCMD ["/nodejs/bin/node"]',
      ),
    ],
  ];

  for (const [label, mutated] of mutations) {
    assert.throws(
      () => assertNodeRuntimeToolchain(mutated),
      { name: "AssertionError" },
      `must reject ${label}`,
    );
  }
});
test("rejects unsafe getting-started dependency commands", () => {
  const readme = readSource("README.md");
  const mutated = readme.replace(
    "pnpm install --frozen-lockfile --strict-peer-dependencies",
    "pnpm install --no-frozen-lockfile",
  );
  assert.throws(() => assertReadmeToolchain(mutated), { name: "AssertionError" });
});

test("keeps root development concurrency one slot above persistent workspace tasks", () => {
  const rootPackage = readJson("package.json");
  const turbo = readJson("turbo.json");
  const devCommand = rootPackage.scripts?.dev;
  assert.equal(typeof devCommand, "string", "root package must define the dev script");

  const commandMatch =
    /^dotenv -e \.env -- turbo run dev --concurrency=(?<concurrency>[1-9]\d*)$/u.exec(devCommand);
  assert.ok(
    commandMatch?.groups?.concurrency,
    "root dev must use dotenv and one explicit numeric Turbo concurrency",
  );

  const genericDevTask = turbo.tasks?.dev;
  assert.equal(genericDevTask?.persistent, true, "Turbo's generic dev task must be persistent");

  const manifestPaths = [
    ...new Set(
      readWorkspacePatterns().flatMap((pattern) =>
        globSync(`${pattern}/package.json`, { cwd: repositoryRoot }),
      ),
    ),
  ].sort();
  assert.ok(manifestPaths.length > 0, "workspace patterns must resolve package manifests");

  const persistentDevPackages = manifestPaths.flatMap((manifestPath) => {
    const manifest = readJson(manifestPath);
    if (!Object.hasOwn(manifest.scripts ?? {}, "dev")) return [];
    assert.equal(typeof manifest.scripts.dev, "string", `${manifestPath} dev must be a string`);
    assert.equal(typeof manifest.name, "string", `${manifestPath} must define a package name`);

    const task = turbo.tasks?.[`${manifest.name}#dev`];
    const persistent = task?.persistent ?? genericDevTask.persistent;
    return persistent === true ? [manifest.name] : [];
  });

  assert.ok(persistentDevPackages.length > 0, "workspace must define persistent dev tasks");

  const persistentDevPackageNames = new Set(persistentDevPackages);
  for (const [taskName, taskDefinition] of Object.entries(turbo.tasks ?? {})) {
    if (taskName !== "dev" && !taskName.endsWith("#dev")) continue;

    assert.ok(
      taskDefinition !== null &&
        typeof taskDefinition === "object" &&
        !Array.isArray(taskDefinition),
      `${taskName} task definition must be an object`,
    );
    if (!Object.hasOwn(taskDefinition, "with")) continue;

    assert.ok(Array.isArray(taskDefinition.with), `${taskName} with must be an array`);
    for (const target of taskDefinition.with) {
      assert.equal(typeof target, "string", `${taskName} with targets must be strings`);
      const targetMatch = /^(?<packageName>[^#]+)#dev$/u.exec(target);
      assert.ok(
        targetMatch?.groups?.packageName,
        `${taskName} with target must be a package-qualified dev task: ${target}`,
      );
      assert.ok(
        persistentDevPackageNames.has(targetMatch.groups.packageName),
        `${taskName} with target must name a discovered persistent dev package: ${target}`,
      );
    }
  }

  assert.equal(
    Number(commandMatch.groups.concurrency),
    persistentDevPackages.length + 1,
    `root dev must reserve one slot above: ${persistentDevPackages.join(", ")}`,
  );
});
