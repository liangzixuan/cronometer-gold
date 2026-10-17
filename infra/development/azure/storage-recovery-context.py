#!/usr/bin/env python3
"""Read-only qualification of an unadmitted retained storage recovery context."""
from contextlib import contextmanager, ExitStack
from datetime import datetime, timedelta
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import sys

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("retained_recovery_acquisition", HERE / "storage-acquisition.py")
Q = importlib.util.module_from_spec(spec)
spec.loader.exec_module(Q)
A, P, S = Q.A, Q.P, Q.S
require, encoded = A.require, Q.encoded
NAMES = Q.NAMES
STORAGE_REQUEST_KIND = "nutrition-azure-storage-observation-request-v1"
STORAGE_MANIFEST_KIND = "nutrition-azure-storage-observation-manifest-v1"
MAX_MANIFEST = 65536

def exact(value, fields, label="storage context"):
    require(isinstance(value, dict) and set(value) == set(fields), label + " has omitted or unreviewed fields")
    return value

def digest(value):
    require(type(value) is str and re.fullmatch(r"[a-f0-9]{64}", value) is not None,
            "explicit independent digest required")
    return value

def source_digest():
    source = Path(__file__).resolve()
    P.safe_path(source)
    info = source.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, "regular context source required")
    # The retained producer digest binds its actual 23-entry helper/source closure.
    # This consumer adds its own bytes and mode as a distinct, incompatible scope.
    return A.sha(encoded([["retained-acquisition", Q.source_digest()],
                          [str(source.relative_to(A.REPO)), A.sha(source.read_bytes()), stat.S_IMODE(info.st_mode)]]))

def acquisition_helpers():
    return Q

def integer(value, low, high, label):
    require(type(value) is int and low <= value <= high, label + " outside bound")
    return value

def validate_lease(lease, now, not_after):
    require(isinstance(now, datetime) and now.utcoffset() == timedelta(0)
            and isinstance(not_after, datetime) and not_after.utcoffset() == timedelta(0),
            "independent UTC clock and action bound required")
    exact(lease, {"started_at_utc", "shutdown_at_utc", "cleanup_seconds"}, "lease")
    start = A.utc(lease["started_at_utc"], "lease start")
    shutdown = A.utc(lease["shutdown_at_utc"], "shutdown deadline")
    require(start.second == 0 and start.microsecond == 0 and shutdown.second == 0 and shutdown.microsecond == 0,
            "whole UTC minute lifecycle required")
    require(start <= now < shutdown <= not_after and start.date() == shutdown.date() == now.date()
            and timedelta(hours=1) <= shutdown-start <= timedelta(hours=4), "finite authorized same-day lease required")
    cleanup = integer(lease["cleanup_seconds"], 900, 3600, "cleanup reserve")
    require(now + timedelta(seconds=cleanup) < shutdown, "cleanup no longer fits the lease")
    return shutdown, cleanup

def storage_context(request, manifest_reference, acquisition_reference, now):
    exact(request, {"kind", "schema_version", "source_sha256", "acquisition",
                   "identity_file", "identity_sha256", "profile_directory", "profile_sha256",
                   "manifest_sha256", "not_after_utc", "lifecycle_not_after_utc"})
    require(request["kind"] == STORAGE_REQUEST_KIND and type(request["schema_version"]) is int
            and request["schema_version"] == 1 and request["source_sha256"] == source_digest(),
            "reviewed storage observation request required")
    require(request["acquisition"] == acquisition_reference, "original storage acquisition differs")
    exact(manifest_reference, {"raw", "sha256"})
    require(type(manifest_reference["raw"]) is str and len(manifest_reference["raw"].encode()) <= 65536
            and manifest_reference["sha256"] == request["manifest_sha256"]
            == A.sha(manifest_reference["raw"].encode()), "original storage manifest changed")
    manifest = A.strict_json(manifest_reference["raw"].encode())
    exact(manifest, {"kind", "schema_version", "storage", "lease"})
    require(manifest["kind"] == STORAGE_MANIFEST_KIND and type(manifest["schema_version"]) is int
            and manifest["schema_version"] == 1, "fixed storage observation manifest required")
    lifecycle = A.utc(request["lifecycle_not_after_utc"], "authorized storage lifecycle bound")
    shutdown, cleanup = validate_lease(manifest["lease"], now, lifecycle)
    horizon = A.utc(request["not_after_utc"], "storage observation deadline")
    require(now < horizon and horizon + timedelta(seconds=cleanup) < shutdown,
            "storage observation and cleanup must fit original lease")
    Q = acquisition_helpers()
    binding = Q.qualify(acquisition_reference, now)
    result = Q.ref(acquisition_reference)
    session = S.reference(Path(acquisition_reference["path"]).parent / "session.json", result["session_sha256"])
    plan_reference = session["original"]["request_reference"]
    plan_result = Q.ref(result["original_plan"])
    recorded = A.receipt_utc(plan_result["completed_at_utc"], "original storage plan completion")
    plan, expected, values, snapshot, _ = Q.load_request("plan", Path(plan_reference["path"]), recorded)
    identity, identity_hash = P.identity(Path(request["identity_file"]))
    profile = P.profile_digest(Path(request["profile_directory"]))
    require(request["identity_file"] == plan["identity_file"] and identity == expected
            and identity_hash == request["identity_sha256"] == snapshot["identity"]
            and request["profile_directory"] == plan["profile_directory"]
            and profile == request["profile_sha256"] == snapshot["profile"],
            "original storage identity or profile differs")
    tool = P.tool_digest(Path("/usr/bin/az"))
    exact(manifest["storage"], NAMES)
    for name in NAMES:
        destination = manifest["storage"][name]
        exact(destination, {"provider", "container_url", "prefix", "ownership_sha256"})
        require(destination == {"provider":"azure-blob", **Q.destination(values, name),
                "prefix":"development/" + name + "/", "ownership_sha256":binding["ownership"][name]["sha256"]},
                "storage destination differs from acquired graph")
    baseline = {"source":request["source_sha256"], "request":A.sha(encoded(request)),
                "manifest":manifest_reference["sha256"], "acquisition":binding,
                "identity":identity_hash, "profile":profile, "azure":tool[0]}
    return {"baseline":A.sha(encoded(baseline)), "expected":expected, "manifest":manifest,
            "horizon":horizon, "shutdown":shutdown}

def file_identity(value):
    return (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns,
            value.st_ctime_ns, value.st_uid, value.st_mode, value.st_nlink)

@contextmanager
def held_reference(reference, maximum):
    exact(reference, {"path", "sha256"}, "recovery reference")
    digest(reference["sha256"])
    require(type(reference["path"]) is str, "reference path required")
    path = Path(reference["path"])
    require(path.is_absolute() and str(path) == reference["path"], "canonical reference path required")
    P.safe_path(path)
    before = A.H._secure_regular_file(path, "recovery input", ".json", maximum)
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
                    file_identity(os.fstat(descriptor)) == identity, "recovery input changed")
            return raw
        raw = conserve()
        yield raw, conserve
        conserve()
    finally:
        os.close(descriptor)

def qualify(request_reference, manifest_reference, acquisition_reference, now, expected_source):
    digest(expected_source)
    require(source_digest() == expected_source, "independently selected context source changed")
    with ExitStack() as stack:
        request_raw, request_guard = stack.enter_context(held_reference(request_reference, MAX_MANIFEST))
        manifest_raw, manifest_guard = stack.enter_context(held_reference(manifest_reference, MAX_MANIFEST))
        _, acquisition_guard = stack.enter_context(held_reference(acquisition_reference, Q.MAX_BINDING_BYTES))
        request = A.strict_json(request_raw)
        manifest = {"raw": manifest_raw.decode("utf-8"), "sha256": manifest_reference["sha256"]}
        context = storage_context(request, manifest, acquisition_reference, now)
        request_guard(); manifest_guard(); acquisition_guard()
        require(source_digest() == expected_source, "context source changed during qualification")
        require(storage_context(request, manifest, acquisition_reference, now) == context,
                "storage recovery context changed")
        require(source_digest() == expected_source, "context source changed after regeneration")
        result = {
            "kind": "nutrition-azure-storage-recovery-context-v1", "localOnly": True,
            "operationalAcceptance": False, "source_sha256": expected_source,
            "request_sha256": request_reference["sha256"], "manifest_sha256": manifest_reference["sha256"],
            "acquisition_sha256": acquisition_reference["sha256"], "storage_context_sha256": context["baseline"],
            "expected": context["expected"], "manifest": context["manifest"],
            "horizon": context["horizon"].isoformat(), "shutdown": context["shutdown"].isoformat(),
        }
    return A.strict_json(encoded(result))

def main(argv=None):
    args = sys.argv[1:] if argv is None else argv
    try:
        if args == ["source-digest"]:
            print(source_digest())
            return
        require(len(args) == 9 and args[0] == "qualify", "explicit context qualification required")
        references = [{"path": args[i], "sha256": args[i+1]} for i in (1, 3, 5)]
        result = qualify(*references, A.utc(args[8], "independent qualification time"), args[7])
        print(encoded(result).decode(), end="")
    except Exception:
        print("Azure storage recovery context qualification failed", file=sys.stderr)
        raise SystemExit(2)

if __name__ == "__main__":
    main()
