#!/usr/bin/env python3
"""Pure preparation and validation for the native collector. Never starts a child."""
from __future__ import annotations
from datetime import datetime, timedelta, timezone
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import sys

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("evidence_auth", ROOT / "auth-preflight.py")
P = importlib.util.module_from_spec(spec); spec.loader.exec_module(P)
A = P.A
require = A.require
FIELDS = {"schema_version", "source_sha256", "identity_file", "profile_directory", "operation_name",
          "not_after_utc", "shutdown_deadline_utc"}
AUTH_LABELS = ("version", "extensions", "account", "subscription")
MAX_RESPONSE = 131072
MAX_AGGREGATE = 4 * 1024 * 1024
OUTPUTS = {"session.json": 16384, "phases.json": 65536, "index.json": 16384,
           **{"auth-" + n + ".json": MAX_RESPONSE for n in AUTH_LABELS},
           **{"read-" + row[1] + ".json": MAX_RESPONSE for row in A.NATIVE_READS},
           **{kind + ".json": 1024 * 1024 for kind in A.EVIDENCE_KINDS}}

def write_json(path, value):
    raw = (json.dumps(value, sort_keys=True) + "\n").encode()
    require(len(raw) <= OUTPUTS.get(path.name, MAX_RESPONSE), "private JSON exceeds bound")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as output:
        output.write(raw); output.flush(); os.fsync(output.fileno())

def load_request(path, now):
    P.safe_path(path)
    request, digest = A.private_json(path)
    require(isinstance(request, dict) and set(request) == FIELDS and type(request["schema_version"]) is int and request["schema_version"] == 1,
            "exact evidence request required")
    require(isinstance(request["operation_name"], str) and re.fullmatch(r"nourishing-evidence-[0-9a-f]{12}", request["operation_name"]),
            "new evidence operation name required")
    require(request["source_sha256"] == A.native_source_digest(), "reviewed collector source changed")
    horizon = A.utc(request["not_after_utc"], "operation deadline")
    require(now < horizon <= now + timedelta(minutes=15), "operation deadline outside finite bound")
    deadline = A.utc(request["shutdown_deadline_utc"], "shutdown deadline")
    require(deadline.second == 0 and deadline.microsecond == 0 and deadline.date() == now.date()
            and timedelta(hours=1) <= deadline - now <= timedelta(hours=4), "shutdown outside same-day session bound")
    expected, identity_hash = P.identity(Path(request["identity_file"]))
    profile = P.profile_digest(Path(request["profile_directory"]))
    tool = P.tool_digest(Path("/usr/bin/az"))
    require(P.CLI_SHA256 == A.NATIVE_CLI_SHA256 and P.CLI_VERSION == "2.90.0", "native authentication policy differs")
    snapshot = {"source": request["source_sha256"], "request": digest, "identity": identity_hash,
                "profile": profile, "azure": tool[0]}
    return request, expected, snapshot

def tree(directory):
    total = 0; result = {}
    entries = list(directory.iterdir())
    require(len(entries) <= len(OUTPUTS) + 3, "operation file count exceeds bound")
    for path in entries:
        info = path.lstat()
        require(info.st_uid == os.getuid(), "operation ownership differs")
        if path.name in ("home", "tmp", "work"):
            require(stat.S_ISDIR(info.st_mode) and stat.S_IMODE(info.st_mode) == 0o700 and not list(path.iterdir()),
                    "unexpected child scratch files")
            result[path.name] = {"directory": True}; continue
        require(path.name in OUTPUTS and stat.S_ISREG(info.st_mode) and info.st_nlink == 1
                and stat.S_IMODE(info.st_mode) == 0o600 and info.st_size <= OUTPUTS[path.name],
                "unexpected or oversized operation file")
        total += info.st_size
        require(total <= MAX_AGGREGATE, "post-command aggregate bound exceeded")
        _, digest = A.private_json(path)
        result[path.name] = {"bytes": info.st_size, "sha256": digest}
    return result

def prepare(path, now):
    request, expected, snapshot = load_request(path, now)
    directory = path.parent / request["operation_name"]
    directory.mkdir(mode=0o700)
    for name in ("home", "tmp", "work"): (directory / name).mkdir(mode=0o700)
    info = directory.stat()
    state = {"snapshot": snapshot, "request": str(path), "createdAt": now.isoformat().replace("+00:00", "Z"),
             "directory_identity": [info.st_dev, info.st_ino]}
    write_json(directory / "session.json", state)
    require(load_request(path, now)[2] == snapshot, "inputs changed during preparation")
    return {"directory": str(directory), "state_sha256": A.sha((directory / "session.json").read_bytes()),
            "azure": {"path": "/usr/bin/az", "sha256": P.CLI_SHA256}, "auth_commands": P.commands(expected),
            "profile_directory": request["profile_directory"]}

def verify(path, directory, state_hash, now):
    P.safe_path(directory); A.H._require_private_directory(directory, "evidence operation")
    state, actual = A.private_json(directory / "session.json")
    require(actual == state_hash, "session binding differs")
    request, expected, snapshot = load_request(path, now)
    info = directory.stat()
    require(directory == path.parent / request["operation_name"] and state["request"] == str(path)
            and state["directory_identity"] == [info.st_dev, info.st_ino] and snapshot == state["snapshot"],
            "operation or inputs changed")
    tree(directory)
    return state, request, expected

def authenticate(path, directory, state_hash, now):
    _, _, expected = verify(path, directory, state_hash, now)
    hashes = {}
    for label, _ in P.commands(expected):
        value, digest = A.private_json(directory / ("auth-" + label + ".json"))
        P.validate_response(label, value, expected); hashes[label] = digest
    return hashes

def requests(path, directory, state_hash, now, *, remaining=False):
    _, _, expected = verify(path, directory, state_hash, now)
    authenticate(path, directory, state_hash, now)
    profile = None
    if remaining:
        sub, _ = A.private_json(directory / "read-after-subscription-policy.json")
        require(sub.get("subscriptionId") == expected["subscriptionId"] and sub.get("state") == "Enabled"
                and sub.get("subscriptionPolicies", {}).get("quotaId") == "AzureForStudents_2018-01-01"
                and sub.get("subscriptionPolicies", {}).get("spendingLimit") == "On", "subscription protection changed")
        billing, _ = A.private_json(directory / "read-after-billing-property.json")
        require(billing.get("billingProfileSpendingLimit") == "On" and billing.get("billingProfileStatus") == "Active"
                and billing.get("subscriptionBillingStatus") == "Active" and billing.get("subscriptionBillingType") == "Free",
                "billing protection changed")
        profile = A.native_profile(billing.get("billingProfileId"))
    rows = A.NATIVE_READS[2:] if remaining else A.NATIVE_READS[:2]
    return [{"kind": kind, "label": label, "arguments": A.native_arguments(label, expected["subscriptionId"], profile)}
            for kind, label, *_ in rows]

def finish(path, directory, state_hash, now):
    state, request, expected = verify(path, directory, state_hash, now)
    authentication = authenticate(path, directory, state_hash, now)
    descriptors = requests(path, directory, state_hash, now) + requests(path, directory, state_hash, now, remaining=True)
    phases, phases_hash = A.private_json(directory / "phases.json")
    auth = [{"label": "auth-" + label, "arguments": args + ["--only-show-errors", "--output", "json"]}
            for label, args in P.commands(expected)]
    reads = [{**entry, "label": "read-" + entry["label"]} for entry in descriptors]
    require(isinstance(phases, list) and len(phases) == 14, "four authentication and ten read phases required")
    previous = A.receipt_utc(state["createdAt"], "operation start")
    values = {}
    for phase, command in zip(phases, auth + reads):
        require(set(phase) == {"label", "arguments", "executableSha256", "startedAt", "endedAt", "completed", "exitCode",
                               "stdoutBytes", "stdoutSha256", "stderrBytes", "stderrSha256"}
                and phase["label"] == command["label"] and phase["arguments"] == command["arguments"]
                and phase["executableSha256"] == P.CLI_SHA256 and phase["completed"] is True
                and type(phase["exitCode"]) is int and phase["exitCode"] == 0, "operator phase differs")
        start, end = A.receipt_utc(phase["startedAt"], "phase start"), A.receipt_utc(phase["endedAt"], "phase end")
        require(previous <= start <= end <= now and end - start <= timedelta(seconds=60), "phase timing differs")
        previous = end
        selected, digest = A.private_json(directory / (phase["label"] + ".json"))
        raw = (directory / (phase["label"] + ".json")).read_bytes()
        require(digest == A.sha(raw) == phase["stdoutSha256"] and len(raw) == phase["stdoutBytes"], "observed stdout changed")
        item = {key: phase[key] for key in ("label", "arguments", "startedAt", "endedAt", "completed", "exitCode",
                                          "stdoutBytes", "stdoutSha256", "stderrBytes", "stderrSha256")}
        item.update(format=A.NATIVE_FORMAT, timedOut=False, stdout=raw.decode("utf-8"), selected=selected)
        A.native_record(item, now)
        require(isinstance(item["stderrSha256"], str) and re.fullmatch(r"[0-9a-f]{64}", item["stderrSha256"]), "diagnostic hash missing")
        values[phase["label"]] = item
    documents = {}
    provenance = A.native_provenance()
    for kind in sorted(A.EVIDENCE_KINDS):
        commands = []
        for entry in descriptors:
            if entry["kind"] != kind: continue
            item = {**values["read-" + entry["label"]], "label": entry["label"]}; commands.append(item)
        documents[kind] = {"format": A.NATIVE_FORMAT, "schemaVersion": 2, "readOnly": True,
                           "mutationAttempted": False, "provenance": provenance, "commands": commands}
    # Validate all policy before publishing any family or complete index.
    pending_hashes = {kind: A.sha((json.dumps(doc, sort_keys=True) + "\n").encode()) for kind, doc in documents.items()}
    facts = A.evidence_values(documents, pending_hashes, expected["subscriptionId"],
                              A.utc(request["shutdown_deadline_utc"], "shutdown deadline"), now)
    for kind, doc in documents.items(): write_json(directory / (kind + ".json"), doc)
    verify(path, directory, state_hash, now)
    hashes = {kind: A.private_json(directory / (kind + ".json"))[1] for kind in documents}
    require(hashes == pending_hashes, "family publication differs")
    result = {"completed": True, "scope": "Unsigned native read-only evidence; no plan, allocation or runtime acceptance.",
              "source_sha256": state["snapshot"]["source"], "input_sha256": state["snapshot"],
              "authentication_response_sha256": authentication, "phases_sha256": phases_hash,
              "evidence_sha256": hashes, "facts": facts}
    A.publish_result(directory / "index.json", result)
    return {"completed": True, "index_sha256": A.private_json(directory / "index.json")[1]}

def main(argv=None):
    os.umask(0o077)
    args = sys.argv[1:] if argv is None else argv
    try:
        require(len(args) in (2, 4), "fixed helper arguments required")
        mode, name = args[:2]; path = Path(name); now = datetime.now(timezone.utc)
        if mode == "prepare":
            require(len(args) == 2, "fixed prepare arguments required"); value = prepare(path, now)
        else:
            require(len(args) == 4, "fixed operation arguments required")
            params = (path, Path(args[2]), args[3], now)
            if mode == "verify": verify(*params); value = {"verified": True}
            elif mode == "authenticate": value = authenticate(*params)
            elif mode == "requests": value = requests(*params)
            elif mode == "remaining": value = requests(*params, remaining=True)
            elif mode == "finish": value = finish(*params)
            else: raise A.Error("unrecognized pure collector stage")
        print(json.dumps(value, separators=(",", ":"))); return 0
    except Exception:
        print("Evidence stage rejected; private partial or published files may remain. No acceptance established.", file=sys.stderr)
        return 1

if __name__ == "__main__": raise SystemExit(main())
