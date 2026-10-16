import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  parseArtifactEncryptionKeyRing,
  snapshotPostgresBackupReadExpectation,
} from "../packages/artifact-store/dist/index.js";
import { postgresBackupStorage } from "./postgres-backup-storage.mjs";
import { heldOperatorInput } from "./postgres-operator-input.mjs";
import { trustedPath } from "./postgres-operator-process.mjs";

const failure = () =>
  new Error("PostgreSQL operator failed; publication or a fenced target may remain");
const requireValue = (value) => {
  if (!value) throw failure();
};
const exact = (value, keys) =>
  requireValue(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).sort().join(",") === [...keys].sort().join(","),
  );
const RESERVE_MS = 60_000;
const MAX_INPUT = 262_144;

const MAX_RECEIPT = 16_384;
const MAX_EVIDENCE = 1_572_864;
const MAX_EVIDENCE_ENVELOPE = 32_768;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fileIdentity = (s) =>
  [s.dev, s.ino, s.mode, s.uid, s.gid, s.nlink, s.size, s.mtimeNs, s.ctimeNs].join(":");
const directoryIdentity = (s) => [s.dev, s.ino, s.mode, s.uid, s.gid, s.nlink].join(":");

async function claimRestoreHandoff(path, excluded, guard, maximum) {
  requireValue(
    typeof path === "string" &&
      path.length <= 4096 &&
      isAbsolute(path) &&
      resolve(path) === path &&
      !excluded.includes(path) &&
      [...path].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127) &&
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(basename(path)),
  );
  const parent = dirname(path);
  let directory, file, parentIdentity, identity;
  let expected = Buffer.alloc(0);
  const close = async () => {
    let failed = false;
    for (const handle of [file, directory]) {
      try {
        if (handle) await handle.close();
      } catch {
        failed = true;
      }
    }
    expected.fill(0);
    requireValue(!failed);
  };
  const conserveParent = async () => {
    guard();
    await trustedPath(parent, { directory: true, privateLeaf: true });
    const named = await lstat(parent, { bigint: true });
    requireValue((named.mode & 0o7777n) === 0o700n);
    requireValue(directoryIdentity(named) === parentIdentity);
    requireValue(directoryIdentity(await directory.stat({ bigint: true })) === parentIdentity);
    guard();
  };
  const conserve = async () => {
    await conserveParent();
    const named = await lstat(path, { bigint: true });
    requireValue(fileIdentity(named) === identity);
    requireValue(fileIdentity(await file.stat({ bigint: true })) === identity);
    const actual = Buffer.alloc(expected.length);
    try {
      let offset = 0;
      while (offset < actual.length) {
        guard();
        const read = await file.read(actual, offset, actual.length - offset, offset);
        requireValue(read.bytesRead > 0);
        offset += read.bytesRead;
      }
      requireValue(actual.equals(expected));
      requireValue(fileIdentity(await file.stat({ bigint: true })) === identity);
      requireValue(fileIdentity(await lstat(path, { bigint: true })) === identity);
      await conserveParent();
    } finally {
      actual.fill(0);
    }
    guard();
  };
  const checkFile = (info) =>
    requireValue(
      info.isFile() &&
        info.uid === BigInt(process.getuid()) &&
        info.nlink === 1n &&
        (info.mode & 0o7777n) === 0o600n,
    );
  try {
    guard();
    await trustedPath(parent, { directory: true, privateLeaf: true });
    const named = await lstat(parent, { bigint: true });
    directory = await open(
      parent,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    parentIdentity = directoryIdentity(named);
    await conserveParent();
    file = await open(
      "/proc/self/fd/" + directory.fd + "/" + basename(path),
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    const info = await file.stat({ bigint: true });
    checkFile(info);
    requireValue(info.size === 0n);
    identity = fileIdentity(info);
    await file.sync();
    guard();
    await directory.sync();
    await conserve();
    return {
      conserve,
      close,
      async publish(record) {
        await conserve();
        const bytes = Buffer.from(JSON.stringify(record));
        try {
          requireValue(bytes.length > 0 && bytes.length <= maximum && expected.length === 0);
          expected = Buffer.from(bytes);
          guard();
          const written = await file.write(bytes, 0, bytes.length, 0);
          requireValue(written.bytesWritten === bytes.length);
          guard();
          const info = await file.stat({ bigint: true });
          checkFile(info);
          requireValue(info.size === BigInt(bytes.length));
          identity = fileIdentity(info);
          guard();
          await file.sync();
          guard();
          await directory.sync();
          await conserve();
          return { path, bytes: bytes.length, sha256: digest(bytes) };
        } finally {
          bytes.fill(0);
        }
      },
    };
  } catch {
    await close();
    throw failure();
  }
}

function restoreRecord(outcome, settings, snapshotReplay) {
  const fields = [
    "status",
    "sourceStorage",
    "localOnly",
    "operationalRecoveryAccepted",
    "erasureReplayRequired",
    "applicationTrafficBlocked",
    "targetDatabase",
    "databaseOid",
    "restoreEpoch",
    "sourceRevision",
    "manifestSha256",
    "sourceEvidenceSha256",
    "erasureReplay",
  ];
  requireValue(outcome && Object.getPrototypeOf(outcome) === Object.prototype);
  const allowed = [...fields, "authenticatedBackup"];
  requireValue(
    Reflect.ownKeys(outcome).length === allowed.length &&
      Reflect.ownKeys(outcome).every((name) => allowed.includes(name)),
  );
  const value = Object.fromEntries(
    fields.map((name) => {
      const field = Object.getOwnPropertyDescriptor(outcome, name);
      requireValue(field && "value" in field);
      return [name, field.value];
    }),
  );
  value.erasureReplay = snapshotReplay(value.erasureReplay);
  requireValue(
    value.status ===
      (settings.replayAdmitted ? "local-restore-replayed" : "local-restore-verified") &&
      value.localOnly === true &&
      value.operationalRecoveryAccepted === false &&
      value.erasureReplayRequired === !settings.replayAdmitted &&
      (value.erasureReplay !== null) === settings.replayAdmitted &&
      value.applicationTrafficBlocked === true &&
      ["file", "azure-blob"].includes(value.sourceStorage) &&
      value.sourceStorage === settings.storage?.kind &&
      typeof value.targetDatabase === "string" &&
      /^nutrition_restore_[a-z0-9_]{1,45}$/u.test(value.targetDatabase) &&
      value.targetDatabase === settings.targetDatabase &&
      typeof value.databaseOid === "string" &&
      /^[1-9][0-9]{0,9}$/u.test(value.databaseOid) &&
      BigInt(value.databaseOid) <= 4294967295n &&
      typeof value.restoreEpoch === "string" &&
      /^[a-f0-9]{64}$/u.test(value.restoreEpoch) &&
      typeof value.sourceRevision === "string" &&
      /^[a-f0-9]{40}$/u.test(value.sourceRevision) &&
      value.sourceRevision === settings.expectedBackup?.sourceRevision &&
      value.manifestSha256 === settings.expectedBackup?.manifestSha256 &&
      ["manifestSha256", "sourceEvidenceSha256"].every(
        (name) => typeof value[name] === "string" && /^[a-f0-9]{64}$/u.test(value[name]),
      ),
  );
  return value;
}

function parseArguments(args) {
  requireValue(Array.isArray(args) && args.length === 5 && ["backup", "restore"].includes(args[0]));
  const values = {};
  for (let i = 1; i < args.length; i += 2) {
    requireValue(
      ["--input", "--input-sha256"].includes(args[i]) && !Object.hasOwn(values, args[i]),
    );
    values[args[i]] = args[i + 1];
  }
  const path = values["--input"];
  requireValue(
    typeof path === "string" &&
      isAbsolute(path) &&
      resolve(path) === path &&
      [...path].every(
        (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
      ),
  );
  requireValue(
    typeof values["--input-sha256"] === "string" &&
      /^[a-f0-9]{64}$/u.test(values["--input-sha256"]),
  );
  return { operation: args[0], path, sha256: values["--input-sha256"] };
}

const recoverySources = [
  "infra/development/azure/runtime-assembly.py",
  "infra/development/azure/runtime-installation-storage.py",
  "infra/development/azure/storage-acquisition.py",
  "scripts/postgres-operator.mjs",
];
function recoveryReferences(bundle, stop) {
  exact(bundle, [
    "schema_version",
    "kind",
    "contract",
    "target",
    "classification",
    "localOnly",
    "operationalAcceptance",
    "executable",
    "admitted_components",
    "source_revision",
    "source_files",
    "manifest_sha256",
    "policy_sha256",
    "assembly_sha256",
    "acquisition_sha256",
    "storage_context_sha256",
    "not_after_utc",
    "members",
  ]);
  requireValue(
    bundle.schema_version === 1 &&
      bundle.kind === "nutrition-storage-recovery-assembly-v1" &&
      bundle.contract === "nutrition-storage-recovery-v1" &&
      bundle.target === "development" &&
      bundle.classification === "synthetic" &&
      bundle.localOnly === true &&
      bundle.operationalAcceptance === false &&
      bundle.executable === false &&
      Array.isArray(bundle.admitted_components) &&
      bundle.admitted_components.length === 0 &&
      typeof bundle.source_revision === "string" &&
      /^[a-f0-9]{40}$/u.test(bundle.source_revision),
  );
  for (const key of [
    "manifest_sha256",
    "policy_sha256",
    "assembly_sha256",
    "acquisition_sha256",
    "storage_context_sha256",
  ])
    requireValue(typeof bundle[key] === "string" && /^[a-f0-9]{64}$/u.test(bundle[key]));
  const end = Date.parse(bundle.not_after_utc);
  requireValue(
    Number.isFinite(end) &&
      new Date(end).toISOString() === bundle.not_after_utc &&
      Date.now() < end &&
      stop <= end,
  );
  exact(bundle.source_files, recoverySources);
  let root;
  for (const name of recoverySources) {
    const ref = bundle.source_files[name];
    exact(ref, ["path", "sha256"]);
    requireValue(
      typeof ref.path === "string" &&
        isAbsolute(ref.path) &&
        resolve(ref.path) === ref.path &&
        ref.path.endsWith("/" + name) &&
        typeof ref.sha256 === "string" &&
        /^[a-f0-9]{64}$/u.test(ref.sha256),
    );
    const base = ref.path.slice(0, -name.length);
    root ??= base;
    requireValue(root === base);
  }
  exact(bundle.members, ["recovery-references.json"]);
  const member = bundle.members["recovery-references.json"];
  exact(member, ["mode", "sha256", "content"]);
  requireValue(
    member.mode === "0600" &&
      typeof member.content === "string" &&
      Buffer.byteLength(member.content) <= 98304 &&
      createHash("sha256").update(member.content).digest("hex") === member.sha256,
  );
  const refs = JSON.parse(member.content);
  exact(refs, [
    "contract",
    "executable",
    "admitted_components",
    "postgres_backup_destination",
    "ledger_consumers",
  ]);
  exact(refs.ledger_consumers, ["worker", "maintenance_worker"]);
  for (const name of ["worker", "maintenance_worker"]) {
    const env = refs.ledger_consumers[name];
    exact(env, [
      "ERASURE_REPLAY_LEDGER_STORE",
      "ERASURE_REPLAY_LEDGER_AZURE_CONTAINER_URL",
      "ERASURE_REPLAY_LEDGER_AZURE_PREFIX",
    ]);
    requireValue(
      env.ERASURE_REPLAY_LEDGER_STORE === "azure" &&
        typeof env.ERASURE_REPLAY_LEDGER_AZURE_CONTAINER_URL === "string" &&
        /^https:\/\/[a-z0-9]{3,24}\.blob\.core\.windows\.net\/nourishing-development-erasure$/u.test(
          env.ERASURE_REPLAY_LEDGER_AZURE_CONTAINER_URL,
        ) &&
        env.ERASURE_REPLAY_LEDGER_AZURE_PREFIX === "development/erasure/",
    );
  }
  requireValue(
    JSON.stringify(refs.ledger_consumers.worker) ===
      JSON.stringify(refs.ledger_consumers.maintenance_worker),
  );
  return refs;
}

// The independently bound bundle must already have passed maintained assembly
// regeneration. This reader checks its destination, not operational admission.
function assemblyDestination(raw, settings, operation, stop) {
  const bundle = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  let references, ledgerConsumers;
  if (bundle.kind === "nutrition-storage-recovery-assembly-v1") {
    references = recoveryReferences(bundle, stop);
    ledgerConsumers = references.ledger_consumers;
  } else {
    exact(bundle, [
      "schema_version",
      "kind",
      "contract",
      "target",
      "localOnly",
      "operationalAcceptance",
      "executable",
      "admitted_components",
      "blockers",
      "source_revision",
      "manifest_sha256",
      "policy_sha256",
      "assembly_sha256",
      "members",
      "phases",
    ]);
    requireValue(
      bundle.schema_version === 1 &&
        bundle.kind === "nutrition-development-assembly-v1" &&
        bundle.contract === "nutrition-hosted-development-runtime-v1" &&
        bundle.target === "development" &&
        bundle.localOnly === true &&
        bundle.operationalAcceptance === false &&
        bundle.executable === false &&
        Array.isArray(bundle.admitted_components) &&
        bundle.admitted_components.length === 0 &&
        typeof bundle.source_revision === "string" &&
        /^[a-f0-9]{40}$/u.test(bundle.source_revision),
    );
    exact(bundle.blockers, [
      "protected_bootstrap",
      "destination_egress_transaction",
      "credential_install_transaction",
      "provider_capacity_allowance_admission",
      "off_host_restore_erasure_executor",
      "owned_lifecycle_cleanup",
    ]);
    requireValue(
      Object.values(bundle.blockers).every((value) => value === "BLOCKED_NOT_IMPLEMENTED"),
    );
    for (const name of ["manifest_sha256", "policy_sha256", "assembly_sha256"])
      requireValue(typeof bundle[name] === "string" && /^[a-f0-9]{64}$/u.test(bundle[name]));
    exact(bundle.members, [
      "compose.json",
      "Caddyfile",
      "Caddyfile.internal",
      "runtime-references.json",
    ]);
    for (const member of Object.values(bundle.members)) {
      exact(member, ["mode", "sha256", "content"]);
      requireValue(
        member.mode === "0600" &&
          typeof member.content === "string" &&
          Buffer.byteLength(member.content) <= 98304 &&
          createHash("sha256").update(member.content).digest("hex") === member.sha256,
      );
    }
    references = JSON.parse(bundle.members["runtime-references.json"].content);
    if (operation === "restore") {
      const compose = JSON.parse(bundle.members["compose.json"].content);
      ledgerConsumers = Object.fromEntries(
        ["worker", "maintenance_worker"].map((name) => [
          name,
          compose.services?.[name]?.environment,
        ]),
      );
    }
  }
  requireValue(
    references.contract === bundle.contract &&
      references.executable === false &&
      Array.isArray(references.admitted_components) &&
      references.admitted_components.length === 0,
  );
  const destination = references.postgres_backup_destination;
  exact(destination, ["kind", "containerUrl", "prefix"]);
  requireValue(
    destination.kind === "azure-blob" &&
      typeof destination.containerUrl === "string" &&
      /^https:\/\/[a-z0-9]{3,24}\.blob\.core\.windows\.net\/nourishing-development-backup$/u.test(
        destination.containerUrl,
      ) &&
      destination.prefix === "development/backup/" &&
      settings.storage?.kind === destination.kind &&
      settings.storage?.containerUrl === destination.containerUrl &&
      settings.storage?.prefix === destination.prefix,
  );
  if (operation === "restore") {
    const replay = settings.erasureReplay;
    requireValue(replay && replay.kind === "azure-blob");
    for (const name of ["worker", "maintenance_worker"]) {
      const environment = ledgerConsumers[name];
      requireValue(
        environment?.ERASURE_REPLAY_LEDGER_STORE === "azure" &&
          environment.ERASURE_REPLAY_LEDGER_AZURE_CONTAINER_URL === replay.containerUrl &&
          environment.ERASURE_REPLAY_LEDGER_AZURE_PREFIX === replay.prefix,
      );
    }
    requireValue(
      replay.containerUrl !== destination.containerUrl || replay.prefix !== destination.prefix,
    );
  }
  if (operation === "backup")
    requireValue(
      settings.sourceRevision === bundle.source_revision &&
        settings.deploymentTarget === bundle.target,
    );
}

function rejectAmbient() {
  requireValue(process.platform === "linux" && typeof process.getuid === "function");
  const denied =
    /^(NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|NODE_TLS_REJECT_UNAUTHORIZED|SSL_CERT_FILE|SSL_CERT_DIR|OPENSSL_CONF|OPENSSL_MODULES|AZURE_.*|PG.*|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY)$/iu;
  requireValue(!Object.keys(process.env).some((name) => denied.test(name)));
}

export async function runPostgresOperator(args, { signal } = {}) {
  const cli = parseArguments(args);
  rejectAmbient();
  requireValue(signal === undefined || signal instanceof AbortSignal);
  const started = Date.now(),
    mono = performance.now();
  const controller = new AbortController();
  const abort = () => controller.abort(failure());
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  let held,
    handoff,
    evidence,
    authenticatedBackup,
    assemblyHeld,
    assemblySha256 = null,
    keys,
    result,
    failed = false,
    timer,
    deadline = started + 20_000,
    failureObserved = false;
  const guard = () => {
    const now = Date.now();
    if (
      now < started ||
      now >= deadline ||
      performance.now() - mono >= deadline - started ||
      signal?.aborted
    )
      abort();
    controller.signal.throwIfAborted();
  };
  const interval = setInterval(() => {
    try {
      guard();
    } catch {
      failureObserved = true;
    }
  }, 100);
  interval.unref();
  try {
    guard();
    held = await heldOperatorInput(cli.path, cli.sha256, {
      privateFile: true,
      maximum: MAX_INPUT,
    });
    guard();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(held.raw);
    const document = JSON.parse(text);
    requireValue(JSON.stringify(document) === text);
    exact(document, [
      "schemaVersion",
      "operation",
      "notAfterUtc",
      "assembly",
      "settings",
      ...(cli.operation === "restore" ? ["restoreHandoffPath", "restoreEvidencePath"] : []),
    ]);
    requireValue(
      document.schemaVersion === 1 &&
        document.operation === cli.operation &&
        typeof document.notAfterUtc === "string" &&
        new Date(document.notAfterUtc).toISOString() === document.notAfterUtc,
    );
    const stop = Date.parse(document.notAfterUtc);
    const settings = document.settings;
    requireValue(
      settings &&
        typeof settings === "object" &&
        !Array.isArray(settings) &&
        !Object.hasOwn(settings, "signal") &&
        Number.isSafeInteger(settings.timeoutMs) &&
        settings.timeoutMs >= 1 &&
        settings.timeoutMs <= 1_800_000,
    );
    requireValue(
      stop > Date.now() + settings.timeoutMs + RESERVE_MS && stop - started <= 1_880_000,
    );
    if (document.assembly === null) {
      requireValue(settings.storage?.kind === "file");
    } else {
      exact(document.assembly, ["path", "sha256"]);
      requireValue(
        typeof document.assembly.path === "string" &&
          isAbsolute(document.assembly.path) &&
          resolve(document.assembly.path) === document.assembly.path &&
          document.assembly.path !== cli.path &&
          [...document.assembly.path].every(
            (c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127,
          ) &&
          typeof document.assembly.sha256 === "string" &&
          /^[a-f0-9]{64}$/u.test(document.assembly.sha256),
      );
      assemblyHeld = await heldOperatorInput(document.assembly.path, document.assembly.sha256, {
        privateFile: true,
        maximum: 65536,
      });
      guard();
      assemblyDestination(assemblyHeld.raw, settings, cli.operation, stop);
      assemblySha256 = document.assembly.sha256;
    }
    exact(settings.keyRing, ["currentKeyId", "keys"]);
    const supplied = settings.keyRing.keys;
    requireValue(
      supplied &&
        typeof supplied === "object" &&
        !Array.isArray(supplied) &&
        Object.keys(supplied).length >= 1 &&
        Object.keys(supplied).length <= 16,
    );

    keys = parseArtifactEncryptionKeyRing({
      purpose: "postgres_backup",
      currentKeyId: settings.keyRing.currentKeyId,
      serializedKeys: JSON.stringify(supplied),
    });
    const input = { ...settings, keyRing: keys, signal: controller.signal };
    let evidenceOptions, readExpectation, restoreSettings;
    if (cli.operation === "restore") {
      const storage = postgresBackupStorage(settings.storage, "restore", settings.maxDumpBytes);
      readExpectation = snapshotPostgresBackupReadExpectation(
        storage.kind === "azure-blob"
          ? {
              kind: "azure-blob-version",
              containerUrl: storage.options.containerUrl,
              prefix: storage.options.prefix,
            }
          : { kind: "unqualified" },
      );
      evidenceOptions = Object.freeze({
        expectedBackup: Object.freeze({ ...settings.expectedBackup }),
        expectedOwner: settings.expectedOwner,
        maxDumpBytes: settings.maxDumpBytes,
        keyRing: { keys: new Map(keys.keys) },
      });
      restoreSettings = Object.freeze({
        storage: { kind: storage.kind },
        targetDatabase: settings.targetDatabase,
        expectedBackup: evidenceOptions.expectedBackup,
        replayAdmitted: storage.kind === "azure-blob",
      });
      requireValue(
        Object.hasOwn(settings, "erasureReplay") &&
          (storage.kind === "file"
            ? settings.erasureReplay === null
            : settings.erasureReplay !== null),
      );
    }
    for (const inputFile of [held, assemblyHeld])
      if (inputFile) (await inputFile.conserve()).fill(0);
    guard();
    if (cli.operation === "restore") {
      handoff = await claimRestoreHandoff(
        document.restoreHandoffPath,
        [cli.path, document.assembly?.path, document.restoreEvidencePath],
        guard,
        MAX_RECEIPT,
      );
      evidence = await claimRestoreHandoff(
        document.restoreEvidencePath,
        [cli.path, document.assembly?.path, document.restoreHandoffPath],
        guard,
        MAX_EVIDENCE,
      );
    }
    guard();
    requireValue(stop > Date.now() + settings.timeoutMs + RESERVE_MS);
    deadline = stop - RESERVE_MS;
    timer = setTimeout(abort, deadline - Date.now());
    timer.unref();
    const operationModule =
      cli.operation === "backup"
        ? await import("./postgres-backup.mjs")
        : await import("./postgres-restore.mjs");
    const operation =
      cli.operation === "backup"
        ? operationModule.runPostgresBackup
        : operationModule.runPostgresRestore;
    guard();
    if (handoff) await handoff.conserve();
    if (evidence) await evidence.conserve();
    for (const inputFile of [held, assemblyHeld])
      if (inputFile) (await inputFile.conserve()).fill(0);
    guard();
    const outcome = await operation(input);
    guard();
    const restored =
      cli.operation === "restore"
        ? restoreRecord(outcome, restoreSettings, operationModule.snapshotPostgresRestoreReplay)
        : null;
    if (restored) {
      const descriptor = Object.getOwnPropertyDescriptor(outcome, "authenticatedBackup");
      requireValue(descriptor && Object.hasOwn(descriptor, "value"));
      authenticatedBackup = operationModule.snapshotPostgresRestoreAuthenticatedBackup(
        descriptor.value,
        evidenceOptions,
        readExpectation,
      );
      requireValue(
        digest(authenticatedBackup.manifestBytes) === restored.manifestSha256 &&
          digest(authenticatedBackup.sourceEvidence) === restored.sourceEvidenceSha256,
      );
    }
    for (const inputFile of [held, assemblyHeld])
      if (inputFile) (await inputFile.conserve()).fill(0);
    // Keep the raw epoch only in the private handoff; public receipts are projected.
    const fields =
      cli.operation === "backup"
        ? ["kind", "storage", "localOnly", "operationalRecoveryAccepted", "manifestSha256"]
        : [
            "status",
            "sourceStorage",
            "localOnly",
            "operationalRecoveryAccepted",
            "erasureReplayRequired",
            "erasureReplay",
            "applicationTrafficBlocked",
            "targetDatabase",
            "databaseOid",
            "sourceRevision",
            "manifestSha256",
            "sourceEvidenceSha256",
          ];
    result = {
      kind: "nutrition-postgres-operator-receipt-v1",
      operation: cli.operation,
      inputSha256: cli.sha256,
      assemblySha256,
      result: Object.fromEntries(fields.map((key) => [key, (restored ?? outcome)[key]])),
    };
    if (restored) {
      result.result.restoreEpochHash = digest(restored.restoreEpoch);
      const record = {
        schemaVersion: 1,
        kind: "nutrition-postgres-restore-evidence-v1",
        inputSha256: cli.sha256,
        assemblySha256,
        result: Object.fromEntries(
          [
            "targetDatabase",
            "databaseOid",
            "restoreEpochHash",
            "erasureReplay",
            "sourceRevision",
            "manifestSha256",
            "sourceEvidenceSha256",
          ].map((key) => [key, result.result[key]]),
        ),
        authenticatedBackup: {
          manifestBase64: "",
          sourceEvidenceBase64: "",
          metadata: authenticatedBackup.metadata,
          readSource: authenticatedBackup.readSource,
        },
      };
      requireValue(Buffer.byteLength(JSON.stringify(record)) <= MAX_EVIDENCE_ENVELOPE);
      record.authenticatedBackup.manifestBase64 =
        authenticatedBackup.manifestBytes.toString("base64");
      record.authenticatedBackup.sourceEvidenceBase64 =
        authenticatedBackup.sourceEvidence.toString("base64");
      guard();
      await handoff.conserve();
      result.evidence = await evidence.publish(record);
      result.handoff = await handoff.publish({
        schemaVersion: 1,
        kind: "nutrition-postgres-restore-handoff-v1",
        inputSha256: cli.sha256,
        assemblySha256,
        evidence: result.evidence,
        result: restored,
      });
    }
    if (cli.operation === "backup") {
      const manifest = outcome.manifest;
      requireValue(manifest && typeof manifest === "object");
      result.expectedBackup = {
        ...Object.fromEntries(
          ["backupId", "databaseName", "deploymentTarget", "snapshotId", "sourceRevision"].map(
            (key) => [key, manifest[key]],
          ),
        ),
        manifestSha256: outcome.manifestSha256,
      };
      requireValue(
        Object.values(result.expectedBackup).every(
          (value) => typeof value === "string" && value.length > 0 && value.length <= 256,
        ),
      );
    }
    requireValue(Buffer.byteLength(JSON.stringify(result)) <= MAX_RECEIPT);
    if (handoff) await handoff.conserve();
    if (evidence) await evidence.conserve();
    for (const inputFile of [held, assemblyHeld])
      if (inputFile) (await inputFile.conserve()).fill(0);
    guard();
  } catch {
    failed = true;
  } finally {
    clearTimeout(timer);
    clearInterval(interval);
    signal?.removeEventListener("abort", abort);
    for (const inputFile of [assemblyHeld, held]) {
      try {
        if (inputFile) await inputFile.fd.close();
      } catch {
        failed = true;
      } finally {
        inputFile?.raw.fill(0);
      }
    }
    if (keys) for (const key of keys.keys.values()) key.fill(0);
    for (const output of [evidence, handoff]) {
      try {
        if (output) await output.close();
      } catch {
        failed = true;
      }
    }
    authenticatedBackup?.manifestBytes.fill(0);
    authenticatedBackup?.sourceEvidence.fill(0);
  }
  if (failed || failureObserved || controller.signal.aborted) throw failure();
  try {
    guard();
  } catch {
    throw failure();
  }
  return Object.freeze(result);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  const controller = new AbortController();
  const abort = () => controller.abort();
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const name of signals) process.on(name, abort);
  try {
    process.stdout.write(
      JSON.stringify(
        await runPostgresOperator(process.argv.slice(2), { signal: controller.signal }),
      ) + "\n",
    );
  } catch {
    process.stderr.write(failure().message + "\n");
    process.exitCode = 1;
  } finally {
    for (const name of signals) process.off(name, abort);
  }
}
