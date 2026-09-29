import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import {
  canonical,
  gitTreeIdentity,
  META_PATH,
  makeTar,
  parseArgs,
  prepareSourceArtifact,
  readTarGzip,
  SOURCE_LIMITS,
  type SourceArtifact,
  type SourceFile,
  sha256,
  sourcePath,
  type TarEntry,
  validateManifest,
  verifySourceArtifact,
} from "./source-artifact.ts";

const revision = "1".repeat(40);
function fixtureArtifact(content = "hello") {
  const data = Buffer.from(content);
  const entry: TarEntry = { path: "src/index.ts", mode: 0o644, type: "file", data };
  const files: SourceFile[] = [
    { path: entry.path, mode: "100644", size: data.length, sha256: sha256(data) },
  ];
  const tree = gitTreeIdentity(files, new Map([[entry.path, entry]]));
  const embedded = canonical({ schemaVersion: 1, revision, tree, files });
  const archive = gzipSync(
    makeTar([{ path: META_PATH, mode: 0o644, type: "file", data: embedded }, entry]),
  );
  const metadata: SourceArtifact = {
    schemaVersion: 1,
    revision,
    tree,
    files,
    archiveSha256: sha256(archive),
    archiveBytes: archive.length,
    manifestSha256: sha256(embedded),
  };
  return { metadata, archive, entry };
}
function temporaryRepo(run: (root: string, git: (...args: string[]) => string) => void) {
  const temp = mkdtempSync(join(tmpdir(), "nourishing-source-test-"));
  const root = join(temp, "repo");
  mkdirSync(root);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { stdio: ["ignore", "pipe", "pipe"] })
      .toString()
      .trim();
  git("init", "--quiet");
  try {
    run(root, git);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
const commit = (git: (...args: string[]) => string) => {
  git("add", "--all");
  git(
    "-c",
    "user.name=Offline Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "Offline archive fixture",
  );
  return git("rev-parse", "HEAD");
};

test("source archive round trip binds bytes, full tree, modes and embedded metadata", () => {
  const { metadata, archive } = fixtureArtifact();
  assert.deepEqual(verifySourceArtifact(metadata, archive), metadata);
  assert.equal(readTarGzip(archive).length, 2);
});
test("exact Git source is deterministic and excludes ignored local outputs", () =>
  temporaryRepo((root, git) => {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "index.ts"), "export const value = 3;\n", { mode: 0o644 });
    writeFileSync(join(root, "start.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(join(root, ".gitignore"), "ignored/\n", { mode: 0o644 });
    const head = commit(git);
    mkdirSync(join(root, "ignored"));
    writeFileSync(join(root, "ignored", "private-input.txt"), "do not package");
    const one = prepareSourceArtifact(root, head, join(root, "..", "one"));
    const two = prepareSourceArtifact(root, head, join(root, "..", "two"));
    assert.equal(one.archiveSha256, two.archiveSha256);
    assert.equal(one.tree, git("rev-parse", "HEAD^{tree}"));
    assert.equal(one.files.length, 3);
    assert.equal(one.files.find((file) => file.path === "start.sh")?.mode, "100755");
    assert.deepEqual(
      verifySourceArtifact(one, readFileSync(join(root, "..", "one", "source.tar.gz"))),
      one,
    );
  }));
for (const path of [
  "../escape",
  "/absolute",
  "a/../b",
  "a//b",
  "a\\b",
  "file\nname",
  ".git/config",
  ".local-data/value",
  "node_modules/a",
  ".env",
  ".env.production",
  "secret.pem",
  "state.tfstate.backup",
  META_PATH,
]) {
  test(`source rejects unsafe/private path ${JSON.stringify(path)}`, () =>
    assert.throws(() => sourcePath(path)));
}
test("public example environment templates remain explicit tracked source", () =>
  assert.equal(sourcePath("apps/api/.env.example"), "apps/api/.env.example"));
test("archive digest and byte length changes fail", () => {
  const { metadata, archive } = fixtureArtifact();
  assert.throws(
    () => verifySourceArtifact({ ...metadata, archiveSha256: "0".repeat(64) }, archive),
    /identity_mismatch/,
  );
  assert.throws(
    () => verifySourceArtifact({ ...metadata, archiveBytes: archive.length + 1 }, archive),
    /identity_mismatch/,
  );
});
test("self-consistent forged file manifest cannot retain original Git tree", () => {
  const original = fixtureArtifact("original");
  const changed = fixtureArtifact("tampered");
  const files = changed.metadata.files;
  const embedded = canonical({ schemaVersion: 1, revision, tree: original.metadata.tree, files });
  const archive = gzipSync(
    makeTar([{ path: META_PATH, mode: 0o644, type: "file", data: embedded }, changed.entry]),
  );
  const metadata = {
    ...changed.metadata,
    tree: original.metadata.tree,
    manifestSha256: sha256(embedded),
    archiveSha256: sha256(archive),
    archiveBytes: archive.length,
  };
  assert.throws(() => verifySourceArtifact(metadata, archive), /source_git_tree_mismatch/);
});
test("source rejects duplicate entries, symlink replacement, altered mode, missing entries and extra files", () => {
  const { metadata, archive } = fixtureArtifact();
  const entries = readTarGzip(archive) as [TarEntry, TarEntry];
  const variants: TarEntry[][] = [
    [...entries, entries[1]],
    [entries[0], { ...entries[1], type: "symlink", target: "../escape", data: Buffer.alloc(0) }],
    [entries[0], { ...entries[1], mode: 0o755 }],
    entries.slice(0, 1),
    [...entries, { path: "extra", mode: 0o644, type: "file", data: Buffer.alloc(0) }],
  ];
  for (const variant of variants) {
    const modified = gzipSync(makeTar(variant));
    assert.throws(() =>
      verifySourceArtifact(
        { ...metadata, archiveSha256: sha256(modified), archiveBytes: modified.length },
        modified,
      ),
    );
  }
});
test("tar checksum, terminal block and compressed expansion are bounded", () => {
  const { entry } = fixtureArtifact();
  const raw = makeTar([entry]);
  const corrupt = Buffer.from(raw);
  corrupt[0] = (corrupt[0] ?? 0) ^ 1;
  assert.throws(() => readTarGzip(gzipSync(corrupt)), /invalid_tar_header/);
  assert.throws(
    () => readTarGzip(gzipSync(raw.subarray(0, raw.length - 512))),
    /invalid_tar_terminator/,
  );
  assert.throws(
    () =>
      readTarGzip(gzipSync(Buffer.alloc(20000)), {
        archiveBytes: 10000,
        totalBytes: 100,
        files: 1,
      }),
    /oversize_archive/,
  );
  assert.throws(
    () => readTarGzip(gzipSync(raw), { archiveBytes: 1, totalBytes: 10000, files: 10 }),
    /archive_size_limit/,
  );
});
test("manifest rejects reordered rows and oversize entries before reading bodies", () => {
  const { metadata } = fixtureArtifact();
  assert.throws(
    () =>
      validateManifest({
        ...metadata,
        files: [{ ...metadata.files[0], size: SOURCE_LIMITS.fileBytes + 1 }],
      }),
    /invalid_source_entry/,
  );
  assert.throws(
    () => validateManifest({ ...metadata, files: [...metadata.files, metadata.files[0]] }),
    /invalid_source_entry/,
  );
  assert.throws(
    () => validateManifest({ ...metadata, revision: "HEAD" }),
    /invalid_source_revision/,
  );
});
test("source preparation rejects dirty and untracked inputs", () =>
  temporaryRepo((root, git) => {
    writeFileSync(join(root, "file.txt"), "original", { mode: 0o644 });
    const head = commit(git);
    writeFileSync(join(root, "file.txt"), "changed");
    assert.throws(
      () => prepareSourceArtifact(root, head, join(root, "..", "out")),
      /source_must_be_clean/,
    );
    git("checkout", "--", "file.txt");
    writeFileSync(join(root, "untracked.txt"), "new");
    assert.throws(
      () => prepareSourceArtifact(root, head, join(root, "..", "out")),
      /source_must_be_clean/,
    );
  }));
test("source preparation rejects tracked symlink and source metadata collision", () =>
  temporaryRepo((root, git) => {
    writeFileSync(join(root, "file.txt"), "original", { mode: 0o644 });
    symlinkSync("file.txt", join(root, "link"));
    const head = commit(git);
    assert.throws(
      () => prepareSourceArtifact(root, head, join(root, "..", "out")),
      /unsupported_tracked_mode/,
    );
    git("rm", "link");
    writeFileSync(join(root, META_PATH), "{}", { mode: 0o644 });
    const second = commit(git);
    assert.throws(
      () => prepareSourceArtifact(root, second, join(root, "..", "out")),
      /private_or_generated/,
    );
  }));
test("source preparation rejects private committed file and unusual physical mode", () =>
  temporaryRepo((root, git) => {
    writeFileSync(join(root, ".env"), "fixture only", { mode: 0o644 });
    const head = commit(git);
    assert.throws(
      () => prepareSourceArtifact(root, head, join(root, "..", "out")),
      /private_or_generated/,
    );
    git("rm", ".env");
    writeFileSync(join(root, "file.txt"), "x", { mode: 0o644 });
    const second = commit(git);
    chmodSync(join(root, "file.txt"), 0o664);
    assert.throws(
      () => prepareSourceArtifact(root, second, join(root, "..", "out")),
      /source_file_type_size_or_mode/,
    );
  }));
test("output must be outside source and must not already exist", () =>
  temporaryRepo((root, git) => {
    writeFileSync(join(root, "file.txt"), "x", { mode: 0o644 });
    const head = commit(git);
    assert.throws(
      () => prepareSourceArtifact(root, head, join(root, "output")),
      /artifact_output_inside_source/,
    );
    const out = join(root, "..", "out");
    prepareSourceArtifact(root, head, out);
    assert.throws(() => prepareSourceArtifact(root, head, out), /EEXIST/);
  }));
test("CLI rejects unknown and duplicate argument names", () => {
  assert.throws(() => parseArgs(["prepare", "--out", "x", "--out", "y"], "prepare", ["out"]));
  assert.throws(() => parseArgs(["prepare", "--key", "never"], "prepare", ["out"]));
  assert.deepEqual(parseArgs(["prepare", "--out", "x"], "prepare", ["out"]), { out: "x" });
});

test("actual source preparation CLI executes and produces a verified archive", () =>
  temporaryRepo((root, git) => {
    writeFileSync(join(root, "file.txt"), "CLI fixture", { mode: 0o644 });
    const head = commit(git);
    const out = join(root, "..", "cli-output");
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(new URL("./source-artifact.ts", import.meta.url)),
        "prepare",
        "--repo",
        root,
        "--revision",
        head,
        "--out",
        out,
      ],
      { encoding: "utf8", timeout: 10000 },
    );
    assert.equal(result.status, 0, result.stderr);
    const metadata = JSON.parse(readFileSync(join(out, "source-artifact.json"), "utf8"));
    assert.equal(
      verifySourceArtifact(metadata, readFileSync(join(out, "source.tar.gz"))).revision,
      head,
    );
    assert.equal(JSON.parse(result.stdout).status, "prepared");
  }));

test("Next dynamic and catch-all route source paths round trip through exact Git archive", () =>
  temporaryRepo((root, git) => {
    const route = "apps/web/src/app/api/retention/[...segments]/route.ts";
    mkdirSync(join(root, "apps/web/src/app/api/retention/[...segments]"), { recursive: true });
    writeFileSync(join(root, route), "export const GET = () => null;", { mode: 0o644 });
    const head = commit(git);
    const out = join(root, "..", "dynamic-output");
    const artifact = prepareSourceArtifact(root, head, out);
    assert.equal(
      verifySourceArtifact(artifact, readFileSync(join(out, "source.tar.gz"))).files[0]?.path,
      route,
    );
  }));

test("output cannot enter the source through a symlinked parent", () =>
  temporaryRepo((root, git) => {
    writeFileSync(join(root, "file.txt"), "x", { mode: 0o644 });
    const head = commit(git);
    const alias = join(root, "..", "source-alias");
    symlinkSync(root, alias);
    assert.throws(
      () => prepareSourceArtifact(root, head, join(alias, "out")),
      /artifact_output_inside_source/,
    );
  }));

function independentTarFixture(
  format: "gnu" | "pax",
  run: (root: string, archive: (extra?: string[]) => Buffer, path: string, target: string) => void,
) {
  const root = mkdtempSync(join(tmpdir(), "nourishing-tar-interop-"));
  const path = `payload/${"segment".repeat(12)}/${"nested".repeat(12)}/${"module".repeat(12)}/module.js`;
  const target = path.slice("payload/".length);
  try {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), "actual long-path payload", { mode: 0o644 });
    symlinkSync(target, join(root, "payload", "alias"));
    const archive = (extra: string[] = []) =>
      execFileSync("tar", [`--format=${format}`, ...extra, "-czf", "-", "-C", root, "."], {
        maxBuffer: 2 * 1024 * 1024,
        timeout: 10000,
        stdio: ["ignore", "pipe", "pipe"],
      });
    run(root, archive, path, target);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
for (const format of ["gnu", "pax"] as const) {
  test(`independent ${format} tar preserves long paths and long relative symlinks`, () =>
    independentTarFixture(format, (_root, archive, path, target) => {
      assert.equal(path.length > 240, true);
      assert.equal(target.length > 100, true);
      const entries = readTarGzip(archive());
      const file = entries.find((entry) => entry.path === path);
      const link = entries.find((entry) => entry.path === "payload/alias");
      assert.equal(file?.data.toString(), "actual long-path payload");
      assert.equal(file?.mode, 0o644);
      assert.equal(link?.type, "symlink");
      assert.equal(link?.target, target);
    }));
  test(`independent ${format} tar hard links remain forbidden`, () =>
    independentTarFixture(format, (root, archive, path) => {
      linkSync(join(root, path), join(root, "payload", "hard-link"));
      assert.throws(() => readTarGzip(archive()), /unsupported_tar_entry/);
    }));
}
test("PAX path metadata cannot escape the artifact root", () =>
  independentTarFixture("pax", (_root, archive) => {
    assert.throws(
      () => readTarGzip(archive(["--pax-option=path:=../outside"])),
      /unsafe_archive_path/,
    );
  }));
test("PAX metadata cannot exceed its bounded decode size", () =>
  independentTarFixture("pax", (_root, archive) => {
    assert.throws(
      () => readTarGzip(archive([`--pax-option=comment=${"x".repeat(9000)}`])),
      /unsupported_or_oversize_tar_metadata/,
    );
  }));
test("PAX effective size cannot exceed the expanded-byte limit", () =>
  independentTarFixture("pax", (root, archive) => {
    writeFileSync(join(root, "large"), Buffer.alloc(4096), { mode: 0o644 });
    assert.throws(
      () => readTarGzip(archive(), { archiveBytes: 2 * 1024 * 1024, totalBytes: 128, files: 30 }),
      /archive_entry_limit_or_duplicate/,
    );
  }));
test("entries hidden after a complete archive terminator remain forbidden", () => {
  const { entry } = fixtureArtifact();
  const first = makeTar([entry]);
  const second = makeTar([{ ...entry, path: "hidden-file" }]);
  assert.throws(
    () => readTarGzip(gzipSync(Buffer.concat([first, second]))),
    /invalid_tar_terminator/,
  );
});
