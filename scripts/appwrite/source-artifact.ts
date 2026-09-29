import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { Parser } from "tar";

export const SOURCE_LIMITS = {
  files: 4000,
  fileBytes: 32 * 1024 * 1024,
  totalBytes: 128 * 1024 * 1024,
  archiveBytes: 64 * 1024 * 1024,
} as const;
export const META_PATH = ".nourishing-source.json";
export type SourceFile = { path: string; mode: "100644" | "100755"; size: number; sha256: string };
export type SourceManifest = {
  schemaVersion: 1;
  revision: string;
  tree: string;
  files: SourceFile[];
};
export type SourceArtifact = SourceManifest & {
  archiveSha256: string;
  archiveBytes: number;
  manifestSha256: string;
};
export type TarEntry = {
  path: string;
  mode: number;
  type: "file" | "symlink" | "directory";
  data: Buffer;
  target?: string;
};
export const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
export const canonical = (value: unknown) => Buffer.from(`${JSON.stringify(value)}\n`);
const hash = /^[a-f0-9]{64}$/;
const revisionPattern = /^[a-f0-9]{40}$/;
export function requireRevision(value: unknown): asserts value is string {
  if (typeof value !== "string" || !revisionPattern.test(value))
    throw new Error("invalid_source_revision");
}
export function safePath(path: string) {
  if (
    !path ||
    path.length > 1024 ||
    !/^[A-Za-z0-9_.@+()/[\]-]+$/.test(path) ||
    path.startsWith("/") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error("unsafe_archive_path");
  return path;
}
export function sourcePath(path: string) {
  safePath(path);
  const parts = path.toLowerCase().split("/");
  if (
    parts.some(
      (part) =>
        [
          ".git",
          ".ssh",
          ".local-data",
          ".takeover-edit",
          "node_modules",
          ".next",
          ".aws",
          ".azure",
          ".terraform",
        ].includes(part) ||
        (part.startsWith(".env") && part !== ".env.example" && part !== ".env.test.example"),
    ) ||
    /\.(pem|key|p12|pfx|jks|keystore|tfstate)(\.|$)/i.test(path) ||
    path === META_PATH
  )
    throw new Error("private_or_generated_source_path");
  return path;
}
function numberField(value: number, length: number) {
  const octal = value.toString(8);
  if (!Number.isSafeInteger(value) || value < 0 || octal.length >= length)
    throw new Error("invalid_tar_number");
  return `${octal.padStart(length - 1, "0")}\0`;
}
export function makeTar(entries: TarEntry[]) {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    safePath(entry.path);
    const header = Buffer.alloc(512);
    let name = entry.path;
    if (Buffer.byteLength(name) > 100) {
      const split = name.lastIndexOf("/", name.length - 1);
      if (
        split < 0 ||
        Buffer.byteLength(name.slice(0, split)) > 155 ||
        Buffer.byteLength(name.slice(split + 1)) > 100
      )
        throw new Error("tar_path_too_long");
      header.write(name.slice(0, split), 345, 155, "utf8");
      name = name.slice(split + 1);
    }
    header.write(name, 0, 100, "utf8");
    header.write(numberField(entry.mode, 8), 100, 8);
    header.write(numberField(0, 8), 108, 8);
    header.write(numberField(0, 8), 116, 8);
    header.write(numberField(entry.type === "file" ? entry.data.length : 0, 12), 124, 12);
    header.write(numberField(0, 12), 136, 12);
    header.fill(32, 148, 156);
    header[156] = entry.type === "file" ? 48 : entry.type === "symlink" ? 50 : 53;
    if (entry.target) {
      if (Buffer.byteLength(entry.target) > 100) throw new Error("tar_link_too_long");
      header.write(entry.target, 157, 100, "utf8");
    }
    header.write("ustar\0", 257, 6);
    header.write("00", 263, 2);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8);
    chunks.push(header);
    if (entry.type === "file")
      chunks.push(entry.data, Buffer.alloc((512 - (entry.data.length % 512)) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}
export function readTarGzip(
  archive: Buffer,
  limits = {
    archiveBytes: SOURCE_LIMITS.archiveBytes as number,
    totalBytes: SOURCE_LIMITS.totalBytes as number,
    files: SOURCE_LIMITS.files as number,
  },
): TarEntry[] {
  if (!archive.length || archive.length > limits.archiveBytes)
    throw new Error("archive_size_limit");
  let tar: Buffer;
  try {
    tar = gunzipSync(archive, { maxOutputLength: limits.totalBytes + (limits.files + 4) * 1024 });
  } catch {
    throw new Error("invalid_or_oversize_archive");
  }
  if (tar.length % 512) throw new Error("invalid_tar_terminator");
  const entries: TarEntry[] = [];
  const paths = new Set<string>();
  let total = 0;
  let pending = 0;
  let sawEof = false;
  const parser = new Parser({ strict: true, maxMetaEntrySize: 8192 });
  parser.on("error", () => {
    throw new Error("invalid_tar_header");
  });
  parser.on("ignoredEntry", () => {
    throw new Error("unsupported_or_oversize_tar_metadata");
  });
  parser.on("eof", () => {
    sawEof = true;
  });
  parser.on("entry", (entry) => {
    const type =
      entry.type === "File" || entry.type === "OldFile"
        ? "file"
        : entry.type === "SymbolicLink"
          ? "symlink"
          : entry.type === "Directory"
            ? "directory"
            : null;
    if (!type) throw new Error("unsupported_tar_entry");
    let path = entry.path;
    if (path.startsWith("./")) path = path.slice(2);
    if (type === "directory") path = path.replace(/\/$/, "");
    if (path !== "" && path !== ".") safePath(path);
    else if (type !== "directory") throw new Error("unsafe_archive_path");
    const size = entry.size;
    const mode = entry.mode;
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      !Number.isSafeInteger(mode) ||
      mode === undefined ||
      (mode & 0o7000) !== 0 ||
      (type !== "file" && size !== 0)
    )
      throw new Error("unsafe_archive_mode_or_size");
    total += size;
    if (total > limits.totalBytes || entries.length + pending >= limits.files || paths.has(path))
      throw new Error("archive_entry_limit_or_duplicate");
    if (type === "symlink" && (!entry.linkpath || Buffer.byteLength(entry.linkpath) > 1024))
      throw new Error("invalid_tar_link");
    paths.add(path);
    pending += 1;
    const chunks: Buffer[] = [];
    let received = 0;
    entry.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > size) throw new Error("tar_entry_size_mismatch");
      chunks.push(chunk);
    });
    entry.on("end", () => {
      if (received !== size) throw new Error("truncated_tar_entry");
      entries.push({
        path,
        mode,
        type,
        data: Buffer.concat(chunks, received),
        ...(type === "symlink" ? { target: entry.linkpath } : {}),
      });
      pending -= 1;
    });
    entry.resume();
  });
  // Feed complete tar blocks so an EOF event identifies the exact boundary.
  // The maintained parser handles USTAR, GNU long names/links and PAX headers;
  // trailing hidden members and nonzero data after the terminator remain invalid.
  for (let offset = 0; offset < tar.length; offset += 512) {
    parser.write(tar.subarray(offset, offset + 512));
    if (sawEof) {
      if (tar.subarray(offset + 512).some((byte) => byte !== 0))
        throw new Error("invalid_tar_terminator");
      break;
    }
  }
  parser.end();
  if (!sawEof) throw new Error("invalid_tar_terminator");
  if (pending) throw new Error("incomplete_tar_entries");
  return entries;
}
export function validateManifest(value: unknown): SourceManifest {
  const manifest = value as SourceManifest;
  if (
    manifest?.schemaVersion !== 1 ||
    !Array.isArray(manifest.files) ||
    !manifest.files.length ||
    manifest.files.length > SOURCE_LIMITS.files
  )
    throw new Error("invalid_source_manifest");
  requireRevision(manifest.revision);
  requireRevision(manifest.tree);
  let previous = "";
  let total = 0;
  for (const file of manifest.files) {
    sourcePath(file.path);
    if (
      file.path <= previous ||
      !["100644", "100755"].includes(file.mode) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      file.size > SOURCE_LIMITS.fileBytes ||
      !hash.test(file.sha256)
    )
      throw new Error("invalid_source_entry");
    previous = file.path;
    total += file.size;
  }
  if (total > SOURCE_LIMITS.totalBytes) throw new Error("source_size_limit");
  return manifest;
}
export function gitTreeIdentity(files: SourceFile[], entries: Map<string, TarEntry>) {
  type TreeNode = {
    files: Map<string, { mode: string; hash: string }>;
    children: Map<string, TreeNode>;
  };
  const node = (): TreeNode => ({ files: new Map(), children: new Map() });
  const root = node();
  for (const file of files) {
    let current = root;
    const parts = file.path.split("/");
    for (const part of parts.slice(0, -1)) {
      if (current.files.has(part)) throw new Error("source_tree_path_collision");
      if (!current.children.has(part)) current.children.set(part, node());
      current = current.children.get(part) as TreeNode;
    }
    const name = parts.at(-1) as string;
    if (current.children.has(name)) throw new Error("source_tree_path_collision");
    const data = entries.get(file.path)?.data;
    if (!data) throw new Error("source_tree_missing_file");
    current.files.set(name, {
      mode: file.mode,
      hash: createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex"),
    });
  }
  const digest = (current: TreeNode): string => {
    const rows = [...current.files.entries()].map(([name, value]) => ({
      name,
      sort: name,
      ...value,
    }));
    for (const [name, child] of current.children)
      rows.push({ name, sort: `${name}/`, mode: "40000", hash: digest(child) });
    rows.sort((a, b) => Buffer.compare(Buffer.from(a.sort), Buffer.from(b.sort)));
    const body = Buffer.concat(
      rows.map((row) =>
        Buffer.concat([Buffer.from(`${row.mode} ${row.name}\0`), Buffer.from(row.hash, "hex")]),
      ),
    );
    return createHash("sha1").update(`tree ${body.length}\0`).update(body).digest("hex");
  };
  return digest(root);
}
export function verifySourceArtifact(metadata: unknown, archive: Buffer): SourceArtifact {
  const value = metadata as SourceArtifact;
  const manifest = validateManifest(value);
  if (
    !hash.test(value.archiveSha256) ||
    !hash.test(value.manifestSha256) ||
    value.archiveBytes !== archive.length ||
    sha256(archive) !== value.archiveSha256
  )
    throw new Error("source_archive_identity_mismatch");
  const embedded = canonical({
    schemaVersion: 1,
    revision: manifest.revision,
    tree: manifest.tree,
    files: manifest.files,
  });
  if (sha256(embedded) !== value.manifestSha256)
    throw new Error("source_manifest_identity_mismatch");
  const entries = readTarGzip(archive);
  const actual = new Map(entries.map((entry) => [entry.path, entry]));
  if (actual.size !== manifest.files.length + 1) throw new Error("source_archive_entries_mismatch");
  const meta = actual.get(META_PATH);
  if (meta?.type !== "file" || meta.mode !== 0o644 || !meta.data.equals(embedded))
    throw new Error("source_embedded_manifest_mismatch");
  for (const file of manifest.files) {
    const entry = actual.get(file.path);
    if (
      entry?.type !== "file" ||
      entry.mode !== (file.mode === "100755" ? 0o755 : 0o644) ||
      entry.data.length !== file.size ||
      sha256(entry.data) !== file.sha256
    )
      throw new Error("source_archive_file_mismatch");
  }
  if (gitTreeIdentity(manifest.files, actual) !== manifest.tree)
    throw new Error("source_git_tree_mismatch");
  return value;
}
export function prepareSourceArtifact(
  repoPath: string,
  revision: string,
  outPath: string,
): SourceArtifact {
  requireRevision(revision);
  const repo = realpathSync(repoPath);
  const requestedOut = resolve(outPath);
  const out = join(realpathSync(dirname(requestedOut)), basename(requestedOut));
  if (out === repo || out.startsWith(repo + sep)) throw new Error("artifact_output_inside_source");
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], {
      maxBuffer: 8 * 1024 * 1024,
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  if (
    git("rev-parse", "HEAD").toString().trim() !== revision ||
    git("status", "--porcelain=v1", "--untracked-files=all").length
  )
    throw new Error("source_must_be_clean_exact_revision");
  const tree = git("rev-parse", `${revision}^{tree}`).toString().trim();
  requireRevision(tree);
  const rows = git("ls-tree", "-rz", "--full-tree", revision)
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  if (rows.length > SOURCE_LIMITS.files) throw new Error("source_file_count_limit");
  const files: SourceFile[] = [];
  const entries: TarEntry[] = [];
  let totalSourceBytes = 0;
  for (const row of rows) {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(row);
    if (!match) throw new Error("unsupported_tracked_mode");
    const mode = match[1];
    const blob = match[2];
    const path = match[3];
    if (!mode || !blob || !path) throw new Error("unsupported_tracked_mode");
    sourcePath(path);
    const absolute = join(repo, path);
    const stat = lstatSync(absolute);
    if (
      !stat.isFile() ||
      stat.size > SOURCE_LIMITS.fileBytes ||
      (stat.mode & 0o777) !== (mode === "100755" ? 0o755 : 0o644)
    )
      throw new Error("source_file_type_size_or_mode");
    totalSourceBytes += stat.size;
    if (totalSourceBytes > SOURCE_LIMITS.totalBytes) throw new Error("source_size_limit");
    const data = readFileSync(absolute);
    if (data.length !== stat.size) throw new Error("source_changed_during_archive");
    const actualBlob = createHash("sha1")
      .update(`blob ${data.length}\0`)
      .update(data)
      .digest("hex");
    if (actualBlob !== blob) throw new Error("source_changed_during_archive");
    files.push({ path, mode: mode as SourceFile["mode"], size: data.length, sha256: sha256(data) });
    entries.push({ path, mode: mode === "100755" ? 0o755 : 0o644, type: "file", data });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const manifest: SourceManifest = { schemaVersion: 1, revision, tree, files };
  validateManifest(manifest);
  const embedded = canonical(manifest);
  entries.push({ path: META_PATH, mode: 0o644, type: "file", data: embedded });
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const archive = gzipSync(makeTar(entries), { level: 9 });
  const metadata: SourceArtifact = {
    ...manifest,
    archiveSha256: sha256(archive),
    archiveBytes: archive.length,
    manifestSha256: sha256(embedded),
  };
  verifySourceArtifact(metadata, archive);
  if (
    git("rev-parse", "HEAD").toString().trim() !== revision ||
    git("status", "--porcelain=v1", "--untracked-files=all").length
  )
    throw new Error("source_changed_during_archive");
  mkdirSync(out, { recursive: false, mode: 0o700 });
  writeFileSync(join(out, "source.tar.gz"), archive, { flag: "wx", mode: 0o600 });
  writeFileSync(join(out, "source-artifact.json"), canonical(metadata), {
    flag: "wx",
    mode: 0o600,
  });
  return metadata;
}
export function parseArgs(argv: string[], command: string, names: string[]) {
  if (argv[0] !== command || (argv.length - 1) % 2) throw new Error("invalid_arguments");
  const values: Record<string, string> = {};
  for (let i = 1; i < argv.length; i += 2) {
    const argument = argv[i];
    const value = argv[i + 1];
    if (!argument || !value) throw new Error("invalid_arguments");
    const key = argument.replace(/^--/, "");
    if (!argument.startsWith("--") || !names.includes(key) || key in values)
      throw new Error("invalid_arguments");
    values[key] = value;
  }
  return values;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = parseArgs(process.argv.slice(2), "prepare", ["repo", "revision", "out"]);
    if (!args.repo || !args.revision || !args.out) throw new Error("invalid_arguments");
    const value = prepareSourceArtifact(args.repo, args.revision, args.out);
    console.log(
      JSON.stringify({
        status: "prepared",
        revision: value.revision,
        archiveSha256: value.archiveSha256,
        archiveBytes: value.archiveBytes,
        files: value.files.length,
      }),
    );
  } catch {
    console.error("Source artifact preparation failed; no deployment was attempted.");
    process.exitCode = 1;
  }
}
