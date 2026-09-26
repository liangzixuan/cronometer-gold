import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { OBJECT_STORE_IMAGE } from "./verify-local-object-store-image.mjs";
import { PATCHED_STORE } from "./verify-patched-object-store-image.mjs";

const read = (name) => readFileSync(new URL(`../infra/docker/${name}`, import.meta.url), "utf8");
const dockerfile = read("object-store.Dockerfile");
const lockText = read("object-store-modules.json");
const lock = JSON.parse(lockText);
const hash = (text) => createHash("sha256").update(text).digest("hex");
test("pins original release source, approved builder and upstream runtime without installing packages", () => {
  assert.ok(dockerfile.includes(`ARG GO_IMAGE=${PATCHED_STORE.goImage}`));
  assert.doesNotMatch(dockerfile, /-trimpath/);
  assert.ok(
    dockerfile.includes(
      `ARG UPSTREAM_IMAGE=${OBJECT_STORE_IMAGE.repository}:4.47@${OBJECT_STORE_IMAGE.digest}`,
    ),
  );
  assert.ok(dockerfile.includes(`ADD --checksum=sha256:${lock.sourceArchiveSha256}`));
  assert.ok(
    dockerfile.includes(
      `https://codeload.github.com/seaweedfs/seaweedfs/tar.gz/${OBJECT_STORE_IMAGE.sourceRevision}`,
    ),
  );
  assert.doesNotMatch(
    dockerfile,
    /\b(?:apk add|apt-get|go mod tidy|go mod edit|go get|GOSUMDB=off)\b/,
  );
});
test("runtime preserves the entrypoint privilege drop and adds only weed and required notices", () => {
  const runtime = dockerfile.split(/FROM \$\{UPSTREAM_IMAGE\} AS runtime/)[1];
  assert.ok(runtime);
  assert.doesNotMatch(runtime, /^(?:RUN|USER|ENTRYPOINT|CMD|ENV|WORKDIR|VOLUME|EXPOSE)\s/m);
  assert.deepEqual(runtime.match(/^COPY .+$/gm), [
    "COPY --from=build /out/weed /usr/bin/weed",
    "COPY --from=build /review/NOTICES.txt /usr/share/licenses/nourishing-object-store/NOTICES.txt",
  ]);
  assert.ok(runtime.includes(`io.cronometer.module-lock.sha256="${hash(lockText)}"`));
  assert.ok(read("object-store-NOTICES.txt").includes("Apache"));
});
test("authenticates signed module checksums before resolving/building with frozen inputs", () => {
  const statements = [
    "/review/verify-modules inputs /review/modules-lock.json go.mod go.sum",
    "/review/verify-modules authenticate /review/modules-lock.json",
    "go mod download all",
    "go mod verify",
    "go list -mod=readonly -m -json all > /out/modules.json",
    "/review/verify-modules graph /review/modules-lock.json go.sum /out/modules.json",
    "GOOS=linux GOARCH=arm64 go build -mod=readonly",
    "go version -m /out/weed",
  ];
  let previous = -1;
  for (const statement of statements) {
    const index = dockerfile.indexOf(statement);
    assert.ok(index > previous, statement);
    previous = index;
  }
  assert.equal(dockerfile.match(/verify-modules inputs/g)?.length, 3);
  for (const value of [
    "GOENV=off",
    "GOWORK=off",
    'GOPRIVATE=""',
    'GONOSUMDB=""',
    'GONOPROXY=""',
    "GOPROXY=https://proxy.golang.org",
    "GOSUMDB=sum.golang.org",
    "GOTOOLCHAIN=local",
  ])
    assert.ok(dockerfile.includes(value));
  assert.doesNotMatch(dockerfile, /(?:^|[;\s])\/out\/weed (?:version|mini|server)/m);
});
test("native parser tests are mandatory and build evidence is outside runtime", () => {
  assert.match(
    dockerfile,
    /GO111MODULE=off go test -count=1 -v verify-object-store-modules\.go verify-object-store-modules_test\.go/,
  );
  assert.match(dockerfile, /FROM scratch AS build-evidence/);
  assert.match(
    dockerfile,
    /COPY --from=build \/out\/go\.mod \/out\/go\.sum \/out\/modules\.json \/out\/weed-buildinfo\.txt \/out\/weed\.sha256 \//,
  );
  assert.match(dockerfile, /COPY --from=build \/review\/NOTICES\.txt \/licenses\/NOTICES\.txt/);
});
test("reviewed module inputs match their frozen hashes and exact candidate version map", () => {
  const mod = read("object-store.go.mod");
  const sums = read("object-store.go.sum");
  assert.equal(hash(mod), lock.goModSha256);
  assert.equal(hash(sums), lock.goSumSha256);
  assert.equal(lock.grpcVersion, PATCHED_STORE.grpcVersion);
  assert.equal(lock.expectedSelectedVersions["google.golang.org/grpc"], PATCHED_STORE.grpcVersion);
  const requires = [...mod.matchAll(/^(?:require\s+|\t)(\S+)\s+(v\S+)(?:\s+\/\/ indirect)?$/gm)];
  assert.equal(requires.length, 503);
  for (const [, path, version] of requires)
    assert.equal(lock.expectedSelectedVersions[path], version);
  assert.equal(Object.keys(lock.expectedSelectedVersions).length, 508);
  assert.deepEqual(lock.allowedReplacements, [
    {
      path: "github.com/tyler-smith/go-bip39",
      replacementPath: "github.com/cosmos/go-bip39",
      replacementVersion: "v1.0.0",
    },
  ]);
});
test("new module evidence is old enough and pins official checksums and licenses", () => {
  assert.equal(lock.reviewedModules.length, 10);
  const sums = read("object-store.go.sum");
  for (const module of lock.reviewedModules) {
    assert.ok(Date.now() - Date.parse(module.publishedAt) >= 86_400_000);
    assert.ok(sums.includes(`${module.path} ${module.version} ${module.sum}\n`));
    assert.ok(sums.includes(`${module.path} ${module.version}/go.mod ${module.goModSum}\n`));
    assert.ok(module.sumdbUrl.startsWith("https://sum.golang.org/lookup/"));
    assert.ok(module.zipUrl.startsWith("https://proxy.golang.org/"));
    assert.match(module.licenseSha256, /^[0-9a-f]{64}$/);
    assert.ok(module.licenseIdentifiers.length > 0);
  }
  assert.equal(lock.nativeGoGraphVerified, false);
  assert.equal(lock.sumdbSignatureVerificationPending, true);
});
