#!/usr/bin/env python3
"""Prepare and independently qualify an unadmitted synthetic recovery bundle."""
from contextlib import contextmanager, ExitStack
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import sys

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("assembly_recovery_context", HERE / "storage-recovery-context.py")
C = importlib.util.module_from_spec(spec)
spec.loader.exec_module(C)
A, P, Q, Error, require = C.A, C.P, C.Q, C.A.Error, C.require
MAX_BUNDLE = 65536
RECOVERY_INPUT = "nutrition-storage-recovery-assembly-input-v1"
RECOVERY_CONTRACT = "nutrition-storage-recovery-v1"
RECOVERY_SOURCES = (
    "infra/development/azure/storage-recovery-assembly.py",
    "infra/development/azure/storage-recovery-context.py",
    "infra/development/azure/storage-acquisition.py",
    "scripts/postgres-operator.mjs",
)
# Producer dependencies are in the complete context/acquisition digest. These
# additional bindings cover the selected protected-parser interfaces, not native acceptance.
INTERFACES = (
    "scripts/postgres-operator-input.mjs", "scripts/postgres-backup-storage.mjs",
    "packages/artifact-store/src/artifact-encryption.ts", "packages/artifact-store/src/postgres-backup.ts",
)
REVISION = re.compile(r"[a-f0-9]{40}")

def digest(value, label):
    return C.digest(value)

def matches(value, pattern, label):
    require(isinstance(value, str) and pattern.fullmatch(value) is not None, label + " invalid")
    return value

def source_digest():
    entries = [["recovery-context", C.source_digest()]]
    for name in (*RECOVERY_SOURCES, *INTERFACES):
        path = A.REPO / name
        P.safe_path(path)
        info = path.lstat()
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, "regular assembly source required")
        entries.append([name, A.sha(path.read_bytes()), stat.S_IMODE(info.st_mode)])
    return A.sha(encoded(entries))

def context_qualification(value, now, context_source):
    qualified = C.qualify(value["storage_request"], value["storage_manifest"],
                          value["acquisition"], now, context_source)
    return {"manifest": qualified["manifest"],
            "horizon": A.receipt_utc(qualified["horizon"], "qualified storage horizon"),
            "baseline": qualified["storage_context_sha256"]}

def backup_destination(storage):
    return {"kind": "azure-blob", "containerUrl": storage["backup"]["container_url"],
            "prefix": storage["backup"]["prefix"]}

def ledger_environment(storage):
    return {"ERASURE_REPLAY_LEDGER_STORE": "azure",
            "ERASURE_REPLAY_LEDGER_AZURE_CONTAINER_URL": storage["erasure"]["container_url"],
            "ERASURE_REPLAY_LEDGER_AZURE_PREFIX": storage["erasure"]["prefix"]}

def encoded(value):
    return (json.dumps(value, sort_keys=True, allow_nan=False) + "\n").encode()

def file_identity(value):
    return (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns,
            value.st_ctime_ns, value.st_uid, value.st_mode, value.st_nlink)

@contextmanager
def held_reference(reference, private=True, maximum=None):
    C.exact(reference, {"path", "sha256"}, "recovery reference")
    digest(reference["sha256"], "recovery reference digest")
    require(isinstance(reference["path"], str), "reference path required")
    path = Path(reference["path"])
    require(path.is_absolute() and str(path) == reference["path"], "canonical reference path required")
    P.safe_path(path)
    maximum = maximum or (C.MAX_MANIFEST if private else 1024 * 1024)
    before = (A.H._secure_regular_file(path, "recovery input", ".json", maximum)
              if private else path.lstat())
    require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_size <= maximum,
            "bounded regular recovery input required")
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        identity = file_identity(before)
        def conserve():
            P.safe_path(path)
            require(file_identity(os.fstat(descriptor)) == identity and
                    file_identity(path.lstat()) == identity, "recovery input replaced")
            os.lseek(descriptor, 0, os.SEEK_SET)
            raw = os.read(descriptor, maximum + 1)
            require(len(raw) == before.st_size and A.sha(raw) == reference["sha256"] and
                    file_identity(os.fstat(descriptor)) == identity,
                    "recovery input changed")
            return raw
        raw = conserve()
        yield raw, conserve
        conserve()
    finally:
        os.close(descriptor)

@contextmanager
def recovery_bundle(path, manifest_sha, policy_sha, assembly_sha, now, not_after):
    with ExitStack() as stack:
        guards = []
        def hold(reference, private=True, maximum=None):
            raw, guard = stack.enter_context(held_reference(reference, private, maximum))
            guards.append(guard)
            return raw
        value = A.strict_json(hold({"path": str(path), "sha256": manifest_sha}))
        C.exact(value, {"schema_version", "kind", "target", "classification", "source_revision",
                        "source_files", "acquisition", "storage_request", "storage_manifest", "not_after_utc"},
                "recovery assembly input")
        require(type(value["schema_version"]) is int and value["schema_version"] == 1 and value["kind"] == RECOVERY_INPUT and
                value["target"] == "development" and value["classification"] == "synthetic",
                "development synthetic recovery input required")
        matches(value["source_revision"], REVISION, "recovery source revision")
        digest(assembly_sha, "assembly source")
        require(assembly_sha == source_digest() and policy_sha == C.source_digest(), "recovery source changed")
        C.exact(value["source_files"], set(RECOVERY_SOURCES), "held recovery sources")
        for name in RECOVERY_SOURCES:
            reference = value["source_files"][name]
            require(isinstance(reference, dict) and reference.get("path") == str(A.REPO / name),
                    "executing recovery source required")
            hold(reference, False)
        request = A.strict_json(hold(value["storage_request"]))
        manifest_raw = hold(value["storage_manifest"])
        hold(value["acquisition"], maximum=Q.MAX_BINDING_BYTES)
        manifest_ref = {"raw": manifest_raw.decode("utf-8"), "sha256": value["storage_manifest"]["sha256"]}
        def observe():
            return context_qualification(value, now, policy_sha)
        context = observe()
        limit = A.utc(value["not_after_utc"], "recovery window")
        require(now < limit <= not_after and limit <= context["horizon"], "recovery window expired or exceeds storage scope")
        storage = context["manifest"]["storage"]
        content = encoded({"contract": RECOVERY_CONTRACT, "executable": False, "admitted_components": [],
                           "postgres_backup_destination": backup_destination(storage),
                           "ledger_consumers": {name: ledger_environment(storage) for name in ("worker", "maintenance_worker")}}).decode()
        result = {"schema_version": 1, "kind": "nutrition-storage-recovery-assembly-v1", "contract": RECOVERY_CONTRACT,
                  "target": "development", "classification": "synthetic", "localOnly": True,
                  "operationalAcceptance": False, "executable": False, "admitted_components": [],
                  "source_revision": value["source_revision"], "source_files": value["source_files"],
                  "manifest_sha256": manifest_sha, "policy_sha256": policy_sha, "assembly_sha256": assembly_sha,
                  "acquisition_sha256": value["acquisition"]["sha256"], "storage_context_sha256": context["baseline"],
                  "not_after_utc": limit.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                  "members": {"recovery-references.json": {"mode": "0600", "sha256": A.sha(content.encode()), "content": content}}}
        def conserve():
            for guard in guards:
                guard()
            require(source_digest() == assembly_sha and observe() == context, "recovery context changed")
        conserve()
        yield result, conserve
        conserve()

def recovery_receipt(value, digest, now):
    return {"kind": "nutrition-storage-recovery-assembly-readback-v1", "localOnly": True,
            "operationalAcceptance": False, "executable": False, "admitted_components": [],
            "bundle_sha256": digest, "manifest_sha256": value["manifest_sha256"],
            "assembly_sha256": value["assembly_sha256"], "acquisition_sha256": value["acquisition_sha256"],
            "storage_context_sha256": value["storage_context_sha256"], "component_count": 0,
            "process_role_count": 0, "qualified_at_utc": now.isoformat().replace("+00:00", "Z")}

def prepare_recovery(path, manifest_sha, policy_sha, assembly_sha, now, not_after, output):
    published = False
    try:
        with recovery_bundle(path, manifest_sha, policy_sha, assembly_sha, now, not_after) as (result, conserve):
            raw = encoded(result)
            require(len(raw) <= MAX_BUNDLE, "recovery bundle too large")
            conserve()
            P.safe_path(output.parent)
            A.publish_result(output, result)
            published = True
            require(read_bundle(output)[1] == A.sha(raw), "published recovery assembly differs")
            conserve()
            receipt_value = recovery_receipt(result, A.sha(raw), now)
        return receipt_value
    except (Error, OSError, ValueError, TypeError) as error:
        if published:
            raise A.PublishedResultError("recovery assembly published; final readback unconfirmed") from error
        raise

def qualify_recovery(path, manifest_sha, policy_sha, assembly_sha, now, not_after, bundle_path, bundle_sha):
    digest(bundle_sha, "independent bundle digest")
    with recovery_bundle(path, manifest_sha, policy_sha, assembly_sha, now, not_after) as (expected, conserve):
        with held_reference({"path": str(bundle_path), "sha256": bundle_sha}) as (raw, check_bundle):
            require(raw == encoded(expected), "bundle is not the exact regenerated recovery assembly")
            conserve()
            check_bundle()
            result = recovery_receipt(expected, bundle_sha, now)
    return result

def read_bundle(path):
    return read_private_json(path, MAX_BUNDLE, "runtime bundle")

def read_private_json(path, maximum, label):
    P.safe_path(path)
    expected = A.H._secure_regular_file(path, label, ".json", maximum)
    identity = lambda x: (x.st_dev, x.st_ino, x.st_size, x.st_mtime_ns, x.st_ctime_ns, x.st_uid, x.st_mode, x.st_nlink)
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(descriptor)
        require(identity(before) == identity(expected), "bundle replaced while opening")
        raw = os.read(descriptor, maximum + 1)
        require(identity(os.fstat(descriptor)) == identity(before) and len(raw) == before.st_size,
                "bundle changed during read")
        value = A.strict_json(raw)
        require(isinstance(value, dict), "private JSON object required")
        return value, A.sha(raw)
    except (UnicodeError, json.JSONDecodeError, RecursionError) as error:
        raise Error("invalid private assembly JSON") from error
    finally:
        os.close(descriptor)

def main(argv=None):
    args = sys.argv[1:] if argv is None else argv
    try:
        if args == ["source-digest"]:
            print(source_digest())
            return
        require(len(args) in (8, 9) and args[0] in ("prepare", "qualify"), "explicit recovery assembly action required")
        mode = args[0]
        require(len(args) == (8 if mode == "prepare" else 9), "exact recovery assembly arguments required")
        path, manifest_sha, policy_sha, assembly_sha = Path(args[1]), args[2], args[3], args[4]
        now, not_after = A.utc(args[5], "independent assembly time"), A.utc(args[6], "independent action bound")
        output = Path(args[7])
        result = (prepare_recovery(path, manifest_sha, policy_sha, assembly_sha, now, not_after, output)
                  if mode == "prepare" else
                  qualify_recovery(path, manifest_sha, policy_sha, assembly_sha, now, not_after, output, args[8]))
        print(encoded(result).decode(), end="")
    except A.PublishedResultError:
        print("recovery assembly published; final readback unconfirmed", file=sys.stderr)
        raise SystemExit(3)
    except Exception:
        print("recovery assembly qualification failed", file=sys.stderr)
        raise SystemExit(2)

if __name__ == "__main__":
    main()
