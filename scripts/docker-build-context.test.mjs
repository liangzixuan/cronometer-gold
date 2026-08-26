import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const supplyChainWorkflow = join(repositoryRoot, ".github/workflows/container-supply-chain.yml");
const skippedDirectories = new Set([
  ".git",
  ".direnv",
  ".expo",
  ".local-data",
  ".next",
  ".terraform",
  ".turbo",
  "coverage",
  "dist",
  "node_modules",
  "test-results",
]);

const reviewedWholeContextDockerfiles = [
  "infra/docker/api.Dockerfile",
  "infra/docker/migrator.Dockerfile",
  "infra/docker/web.Dockerfile",
  "infra/docker/worker.Dockerfile",
];

const reviewedExposureRules = [
  "**",
  "!package.json",
  "!pnpm-lock.yaml",
  "!pnpm-workspace.yaml",
  "!tsconfig.base.json",
  "!turbo.json",
  "!apps/",
  "apps/*",
  "!apps/api/",
  "!apps/api/**",
  "!apps/web/",
  "!apps/web/**",
  "!apps/worker/",
  "!apps/worker/**",
  "!packages/",
  "packages/*",
  "!packages/artifact-store/",
  "!packages/artifact-store/**",
  "!packages/contracts/",
  "!packages/contracts/**",
  "!packages/db/",
  "!packages/db/**",
  "!packages/domain/",
  "!packages/domain/**",
  "!packages/search/",
  "!packages/search/**",
  "!infra/",
  "infra/*",
  "!infra/docker/",
  "infra/docker/*",
  "!infra/docker/node-release-CC68F5A3106FF448322E48ED27F5E38D5B0A215F.asc",
];

const requiredExclusions = [
  ".local-data",
  ".local-data/**",
  "**/.local-data",
  "**/.local-data/**",
  "infra/azure",
  "infra/azure/**",
  "infra/localstack",
  "infra/localstack/**",
  "infra/tailscale",
  "infra/tailscale/**",
  "infra/minio",
  "infra/minio/**",
  "infra/oci",
  "infra/oci/**",
  "infra/runbooks",
  "infra/runbooks/**",
  "**/.terraform",
  "**/.terraform/**",
  "**/.terraform.lock.hcl",
  "**/*.tfstate",
  "**/*.tfstate.*",
  "**/*.tfplan",
  "**/*.tfplan.*",
  "**/tfplan",
  "**/tfplan.*",
  "**/*.plan",
  "**/*.plan.*",
  "**/plan.out",
  "**/*.tfvars",
  "**/*.tfvars.*",
  "**/.terraformrc",
  "**/terraform.rc",
  "**/*.log",
  "**/logs",
  "**/logs/**",
  ".env",
  ".env.*",
  "**/.env",
  "**/.env.*",
  "**/*.env",
  "**/*.env.*",
  "**/*.pem",
  "**/*.PEM",
  "**/*.key",
  "**/*.KEY",
  "**/*.p12",
  "**/*.pfx",
  "**/*.p8",
  "**/*.jks",
  "**/*.keystore",
  "**/*.mobileprovision",
  "**/*.provisionprofile",
  "**/*.kdbx",
  "**/*.age",
  "**/*.gpg",
  "**/*.ovpn",
  "**/*credential*.json",
  "**/*credentials*.json",
  "**/*service-account*.json",
  "**/*secret*.json",
  "**/*credential*.yaml",
  "**/*credentials*.yaml",
  "**/*service-account*.yaml",
  "**/*secret*.yaml",
  "**/*credential*.yml",
  "**/*credentials*.yml",
  "**/*service-account*.yml",
  "**/*secret*.yml",
  "**/id_rsa",
  "**/id_rsa.*",
  "**/id_ed25519",
  "**/id_ed25519.*",
  "**/id_ecdsa",
  "**/id_ecdsa.*",
  "**/id_dsa",
  "**/id_dsa.*",
  "**/*.ppk",
  "**/.aws",
  "**/.aws/**",
  "**/.azure",
  "**/.azure/**",
  "**/.ssh",
  "**/.ssh/**",
  "**/.gnupg",
  "**/.gnupg/**",
  "**/.docker",
  "**/.docker/**",
  "**/.kube",
  "**/.kube/**",
  "**/.oci",
  "**/.oci/**",
  "**/.config/gcloud",
  "**/.config/gcloud/**",
  "**/.config/gh",
  "**/.config/gh/**",
  "**/.terraform.d",
  "**/.terraform.d/**",
  "**/.envrc",
  "**/.direnv",
  "**/.direnv/**",
  "**/.netrc",
  "**/_netrc",
  "**/.git-credentials",
  "**/.vault-token",
  "**/.npmrc",
  "**/.yarnrc",
  "**/.yarnrc.yml",
  "**/.pnpmfile.cjs",
  "**/.git",
  "**/.git/**",
  "**/.hg",
  "**/.hg/**",
  "**/.svn",
  "**/.svn/**",
];

const requiredGeneratedExclusions = [
  "**/.DS_Store",
  "**/.next",
  "**/.next/**",
  "**/.turbo",
  "**/.turbo/**",
  "**/coverage",
  "**/coverage/**",
  "**/dist",
  "**/dist/**",
  "**/node_modules",
  "**/node_modules/**",
  "**/test-results",
  "**/test-results/**",
  "**/*.tsbuildinfo",
  "**/next-env.d.ts",
  "**/*.test.ts",
  "**/*.test.tsx",
  "**/*.integration.test.ts",
  "**/test",
  "**/test/**",
  "**/vitest.config.*",
  "**/README.md",
];

function repositoryDockerfiles(directory = repositoryRoot) {
  const dockerfiles = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!skippedDirectories.has(entry.name)) {
        dockerfiles.push(...repositoryDockerfiles(join(directory, entry.name)));
      }
      continue;
    }
    if (!entry.isFile()) continue;
    const name = basename(entry.name);
    if (name === "Dockerfile" || name.startsWith("Dockerfile.") || name.endsWith(".Dockerfile")) {
      dockerfiles.push(join(directory, entry.name));
    }
  }
  return dockerfiles;
}

function logicalInstructions(source) {
  return source
    .replace(/\\\r?\n[\t ]*/gu, " ")
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function shellOperands(source) {
  const values = [];
  let current = "";
  let escaped = false;
  let quote;
  let started = false;

  for (const character of source) {
    if (escaped) {
      current += character;
      escaped = false;
      started = true;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      else current += character;
      started = true;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/u.test(character)) {
      if (started) values.push(current);
      current = "";
      started = false;
      continue;
    }
    current += character;
    started = true;
  }

  if (escaped || quote !== undefined) return undefined;
  if (started) values.push(current);
  return values;
}

function transferUsesWholeContext(instruction) {
  const matched = /^(?:ADD|COPY)\s+(.+)$/iu.exec(instruction);
  if (!matched) return false;
  let operands = matched[1];
  while (operands.startsWith("--")) {
    const option = /^--\S+\s+/u.exec(operands);
    if (!option) return false;
    if (/^--from(?:=|\s)/u.test(option[0])) return false;
    operands = operands.slice(option[0].length);
  }

  if (operands.startsWith("[")) {
    try {
      const values = JSON.parse(operands);
      return (
        Array.isArray(values) &&
        values.length >= 2 &&
        values.slice(0, -1).some((value) => value === "." || value === "./")
      );
    } catch {
      return false;
    }
  }

  const values = shellOperands(operands);
  return (
    values !== undefined &&
    values.length >= 2 &&
    values.slice(0, -1).some((value) => value === "." || value === "./")
  );
}

function repositoryPath(path) {
  return relative(repositoryRoot, path).split(sep).join("/");
}

function dockerignoreRules() {
  return readFileSync(join(repositoryRoot, ".dockerignore"), "utf8")
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function leadingSpaces(line) {
  return /^ */u.exec(line)?.[0].length ?? 0;
}

test("recognizes whole-context COPY and ADD instructions without confusing stage copies", () => {
  assert.equal(transferUsesWholeContext("COPY . ."), true);
  assert.equal(transferUsesWholeContext("copy --link . /workspace"), true);
  assert.equal(transferUsesWholeContext('COPY "." /workspace'), true);
  assert.equal(transferUsesWholeContext("ADD './' /workspace"), true);
  assert.equal(transferUsesWholeContext('ADD ["package.json", ".", "/workspace"]'), true);
  assert.equal(transferUsesWholeContext("COPY --from=build . /app"), false);
  assert.equal(transferUsesWholeContext("COPY --from=build /workspace/dist /app"), false);
  assert.equal(transferUsesWholeContext("COPY package.json pnpm-lock.yaml ./"), false);
});

test("discovers every reviewed Dockerfile with a whole-context transfer", () => {
  const actual = repositoryDockerfiles()
    .filter((path) =>
      logicalInstructions(readFileSync(path, "utf8")).some(transferUsesWholeContext),
    )
    .map(repositoryPath)
    .sort();
  assert.deepEqual(actual, reviewedWholeContextDockerfiles);
});

test("rejects a companion ignore override for every repository Dockerfile", () => {
  for (const dockerfile of repositoryDockerfiles()) {
    const path = repositoryPath(dockerfile);
    assert.equal(
      existsSync(join(repositoryRoot, `${path}.dockerignore`)),
      false,
      `${path}.dockerignore would override the reviewed root containment policy.`,
    );
  }
});

test("binds every supply-chain Buildx action to the literal root context", () => {
  const lines = readFileSync(supplyChainWorkflow, "utf8").split(/\r?\n/gu);
  const actionLines = lines
    .map((line, index) => ({ index, line }))
    .filter(({ line }) => line.includes("docker/build-push-action@"));
  assert.equal(
    actionLines.length,
    3,
    "The supply-chain workflow must retain exactly the three reviewed Buildx steps.",
  );
  assert.doesNotMatch(
    readFileSync(supplyChainWorkflow, "utf8"),
    /^\s+build-contexts:/mu,
    "Named Buildx contexts bypass the reviewed root .dockerignore policy.",
  );
  assert.doesNotMatch(
    readFileSync(supplyChainWorkflow, "utf8"),
    /uses:\s*["']?docker\/bake-action@|^\s+docker(?:\s+buildx)?\s+build(?:\s|$)/gmu,
    "Alternate Docker builders bypass the three reviewed root-context steps.",
  );

  for (const { index, line } of actionLines) {
    const matched = /^( *)uses:\s*["']?docker\/build-push-action@[^\s"'#]+["']?(?:\s+#.*)?$/u.exec(
      line,
    );
    assert.ok(
      matched,
      `Buildx action at workflow line ${index + 1} must remain a direct step use.`,
    );
    const usesIndent = matched[1].length;
    let stepEnd = lines.length;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const candidate = lines[cursor];
      if (candidate.trim().length === 0 || candidate.trimStart().startsWith("#")) continue;
      if (leadingSpaces(candidate) < usesIndent) {
        stepEnd = cursor;
        break;
      }
    }

    const withLine = `${" ".repeat(usesIndent)}with:`;
    const withIndices = [];
    for (let cursor = index + 1; cursor < stepEnd; cursor += 1) {
      if (lines[cursor] === withLine) withIndices.push(cursor);
    }
    assert.deepEqual(
      withIndices,
      [index + 1],
      `Buildx action at workflow line ${index + 1} must have one direct with mapping immediately after uses.`,
    );

    let withEnd = stepEnd;
    for (let cursor = withIndices[0] + 1; cursor < stepEnd; cursor += 1) {
      const candidate = lines[cursor];
      if (candidate.trim().length === 0 || candidate.trimStart().startsWith("#")) continue;
      if (leadingSpaces(candidate) <= usesIndent) {
        withEnd = cursor;
        break;
      }
    }
    const contextLines = lines
      .slice(withIndices[0] + 1, withEnd)
      .filter((candidate) => /^\s*context:/u.test(candidate));
    assert.deepEqual(
      contextLines,
      [`${" ".repeat(usesIndent + 2)}context: .`],
      `Buildx action at workflow line ${index + 1} must use exactly one literal root context.`,
    );
  }
});

test("keeps the root Docker context deny-by-default with only reviewed build inputs", () => {
  const rules = dockerignoreRules();
  assert.deepEqual(
    rules.slice(0, reviewedExposureRules.length),
    reviewedExposureRules,
    "Docker context traversal, sibling re-exclusions, or inclusions changed; review every newly exposed path explicitly.",
  );
  assert.deepEqual(
    rules.slice(reviewedExposureRules.length),
    [...requiredExclusions, ...requiredGeneratedExclusions],
    "Docker context security, generated-output, cache, test, or documentation exclusions changed.",
  );
  assert.deepEqual(
    rules.filter((rule) => rule.startsWith("!")),
    reviewedExposureRules.filter((rule) => rule.startsWith("!")),
    "Docker context inclusions changed; review every newly exposed path explicitly.",
  );

  const finalInclusionIndex = rules.reduce(
    (last, rule, index) => (rule.startsWith("!") ? index : last),
    -1,
  );
  for (const exclusion of requiredExclusions) {
    const index = rules.indexOf(exclusion);
    assert.ok(index > finalInclusionIndex, `${exclusion} must remain after every inclusion rule.`);
  }
});
