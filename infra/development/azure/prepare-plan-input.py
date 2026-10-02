#!/usr/bin/env python3
"""Pure protected-input, private-session and plan-policy stages. Never starts a child."""
from __future__ import annotations
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import stat
import sys
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("plan_auth", ROOT / "auth-preflight.py")
P = importlib.util.module_from_spec(spec); spec.loader.exec_module(P)
A = P.A
require = A.require
SOURCE_FILES = ["infra/development/azure/" + name for name in (
    ".terraform.lock.hcl", "versions.tf", "variables.tf", "main.tf", "outputs.tf",
    "audit-plan.py", "auth-preflight.py", "prepare-plan-input.py")]
SOURCE_FILES += ["infra/azure/tests/audit_saved_plan.py", "scripts/azure-development-plan.mjs",
                 "scripts/postgres-operator-process.mjs"]
TF_FILES = ("versions.tf", "variables.tf", "main.tf", "outputs.tf", ".terraform.lock.hcl")
MAX_FILE = 512 * 1024 * 1024
MAX_OUTPUT = 20 * 1024 * 1024
MAX_AGGREGATE = MAX_FILE + MAX_OUTPUT + 600 * 1024 * 1024
OUTPUTS = {"plan.tfplan": MAX_FILE, "rendered.json": MAX_OUTPUT, "version.json": 65536,
           "phases.json": 32768, **{"auth-" + n + ".json": 65536 for n in
           ("version", "extensions", "account", "subscription")}}
FIELDS = {"schema_version", "source_sha256", "identity_file", "profile_directory", "terraform",
          "provider_directory", "operation_name", "admin_ipv4_cidr", "ssh_public_key",
          "shutdown_deadline_utc", "not_after_utc", "evidence_paths"}

def source_digest():
    A.source_digest()
    # No implicit state, variables, override or working directory is admitted.
    for path in ROOT.iterdir():
        require(not (path.name == ".terraform" or "tfstate" in path.name or
                     path.name.endswith((".tfvars", ".tfvars.json")) or
                     path.name in ("override.tf", "override.tf.json") or
                     path.name.endswith(("_override.tf", "_override.tf.json"))), "source root has implicit inputs")
    entries = []
    for name in SOURCE_FILES:
        path = A.REPO / name; P.safe_path(path)
        require(path.is_file(), "regular source required")
        entries.append([name, A.sha(path.read_bytes()), stat.S_IMODE(path.stat().st_mode)])
    return A.sha(json.dumps(entries, separators=(",", ":")).encode())

def write_json(path, value):
    raw = (json.dumps(value, sort_keys=True) + "\n").encode()
    require(len(raw) <= MAX_OUTPUT, "generated JSON exceeds bound")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as output:
        output.write(raw); output.flush(); os.fsync(output.fileno())

def load_request(path, now):
    P.safe_path(path)
    request, digest = A.private_json(path)
    require(isinstance(request, dict) and set(request) == FIELDS and request["schema_version"] == 1,
            "exact plan request required")
    require(re.fullmatch(r"nourishing-dev-[0-9a-f]{12}", request["operation_name"]) is not None,
            "new operation name required")
    require(request["source_sha256"] == source_digest(), "reviewed plan source changed")
    require(now < A.utc(request["not_after_utc"], "operation deadline"), "operation deadline expired")
    expected, identity_hash = P.identity(Path(request["identity_file"]))
    profile = P.profile_digest(Path(request["profile_directory"]))
    require(set(request["evidence_paths"]) == A.EVIDENCE_KINDS, "six original evidence families required")
    documents, hashes = {}, {}
    for kind, name in request["evidence_paths"].items():
        P.safe_path(Path(name)); documents[kind], hashes[kind] = A.private_json(Path(name))
    values = {"subscription_id": expected["subscriptionId"], "name_prefix": request["operation_name"],
              "admin_ipv4_cidr": request["admin_ipv4_cidr"], "ssh_public_key": request["ssh_public_key"],
              "shutdown_deadline_utc": request["shutdown_deadline_utc"]}
    values["live_preflight"] = A.evidence_values(documents, hashes, expected["subscriptionId"],
                                                A.utc(request["shutdown_deadline_utc"], "shutdown deadline"), now)
    A.inputs({"timestamp": now.isoformat().replace("+00:00", "Z"),
              "variables": {key: {"value": value} for key, value in values.items()}}, documents, hashes, now)
    terraform = Path(request["terraform"]); P.safe_path(terraform)
    require(A.H.secure_executable_digest(terraform)[0] == A.TF_SHA256 and os.access(terraform, os.X_OK),
            "qualified Terraform required")
    provider = A.provider_digest(Path(request["provider_directory"]))
    P.tool_digest(Path("/usr/bin/az"))
    snapshot = {"source": request["source_sha256"], "request": digest, "identity": identity_hash,
                "profile": profile, "evidence": hashes, "provider": provider, "terraform": A.TF_SHA256,
                "azure": P.CLI_SHA256}
    return request, expected, documents, hashes, values, snapshot

def tree(directory):
    """Finite post-command inventory, never follows a directory symlink."""
    entries = {}; pending = [directory]; total = 0
    while pending:
        current = pending.pop()
        for path in current.iterdir():
            require(len(entries) < 96, "session entry count exceeds bound")
            info = path.lstat(); name = str(path.relative_to(directory))
            require(info.st_uid == os.getuid(), "session ownership changed")
            if stat.S_ISDIR(info.st_mode):
                require(stat.S_IMODE(info.st_mode) == 0o700, "private session directory required")
                entries[name] = {"type": "directory"}; pending.append(path)
            elif stat.S_ISLNK(info.st_mode):
                entries[name] = {"type": "link", "target": os.readlink(path)}
            else:
                require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= MAX_FILE,
                        "unsafe or oversized session file")
                total += info.st_size
                require(total <= MAX_AGGREGATE, "aggregate session size exceeds bound")
                import hashlib
                digest = hashlib.sha256()
                with path.open("rb") as source:
                    for block in iter(lambda: source.read(1024 * 1024), b""): digest.update(block)
                entries[name] = {"type": "file", "mode": stat.S_IMODE(info.st_mode),
                                 "size": info.st_size, "sha256": digest.hexdigest()}
    return entries

def prepare(path, now):
    request, expected, _, _, values, snapshot = load_request(path, now)
    directory = path.parent / request["operation_name"]
    directory.mkdir(mode=0o700)  # exclusive; never reuses a prior operation
    for name in ("work", "home", "tmp", "data"):
        (directory / name).mkdir(mode=0o700)
    mirror, _ = A.prepare_provider(directory, Path(request["provider_directory"]))
    for parent in [mirror, *mirror.parents]:
        if parent == directory: break
        parent.chmod(0o700)
    for name in TF_FILES:
        raw = (ROOT / name).read_bytes()
        fd = os.open(directory / "work" / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as output: output.write(raw)
        require(A.sha(raw) == A.sha((ROOT / name).read_bytes()), "source changed during copy")
    write_json(directory / "work/inputs.tfvars.json", values)
    config = "provider_installation {\n filesystem_mirror {\n  path = " + json.dumps(str(directory / "terraform/providers")) + "\n  include = [\"registry.terraform.io/hashicorp/azurerm\"]\n }\n}\n"
    fd = os.open(directory / "terraform.rc", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as output: output.write(config)
    baseline = tree(directory)
    info = directory.stat()
    state = {"snapshot": snapshot, "baseline": baseline, "directory_identity": [info.st_dev, info.st_ino],
             "mirror": str(mirror), "request": str(path)}
    write_json(directory / "session.json", state)
    require(load_request(path, now)[-1] == snapshot, "inputs changed during preparation")
    return {"directory": str(directory), "state_sha256": A.sha((directory / "session.json").read_bytes()),
            "terraform": {"path": request["terraform"], "sha256": A.TF_SHA256},
            "azure": {"path": "/usr/bin/az", "sha256": P.CLI_SHA256},
            "auth_commands": P.commands(expected), "not_after_utc": request["not_after_utc"],
            "profile_directory": request["profile_directory"], "subscription_id": expected["subscriptionId"],
            "tenant_id": expected["tenantId"]}

def verify(path, directory, state_hash, now):
    P.safe_path(directory); A.H._require_private_directory(directory, "plan operation")
    state, actual_hash = A.private_json(directory / "session.json")
    require(actual_hash == state_hash, "session input binding changed")
    request, expected, documents, hashes, _, snapshot = load_request(path, now)
    info = directory.stat()
    require(directory == path.parent / request["operation_name"] and state["request"] == str(path)
            and state["directory_identity"] == [info.st_dev, info.st_ino] and state["snapshot"] == snapshot,
            "operation or inputs changed")
    current = tree(directory)
    for name, value in state["baseline"].items():
        require(current.get(name) == value, "fixed session input changed")
    provider_link = "data/providers/registry.terraform.io/hashicorp/azurerm/4.79.0/linux_amd64"
    parents = {str(p) for p in Path(provider_link).parents if str(p) != "."}
    for name in set(current) - set(state["baseline"]) - {"session.json"}:
        entry = current[name]
        if name == provider_link:
            require(entry == {"type": "link", "target": state["mirror"]}, "provider mirror link changed")
        elif name in parents:
            require(entry == {"type": "directory"}, "provider directory changed")
        else:
            require(name in OUTPUTS and entry["type"] == "file" and entry["mode"] == 0o600
                    and entry["size"] <= OUTPUTS[name], "unexpected session output")
    return state, expected, documents, hashes

def authenticate(path, directory, state_hash, now):
    _, expected, _, _ = verify(path, directory, state_hash, now)
    result = {}
    for label, _ in P.commands(expected):
        value, digest = A.private_json(directory / ("auth-" + label + ".json"))
        P.validate_response(label, value, expected); result[label] = digest
    return result

def finish(path, directory, state_hash, now):
    state, _, documents, hashes = verify(path, directory, state_hash, now)
    authentication = authenticate(path, directory, state_hash, now)
    version, _ = A.private_json(directory / "version.json")
    require(version.get("terraform_version") == "1.5.7" and version.get("platform") == "linux_amd64",
            "Terraform runtime version differs")
    document, rendered_hash = A.private_json(directory / "rendered.json")
    values, _ = A.private_json(directory / "work/inputs.tfvars.json")
    require(A.inputs(document, documents, hashes, now) == values, "rendered plan inputs differ from request")
    summary = A.audit_plan(document, documents, hashes, now)
    plan_hash, plan_size = A.H.secure_plan_digest(directory / "plan.tfplan")
    phases, phases_hash = A.private_json(directory / "phases.json")
    require(isinstance(phases, list) and [v.get("phase") for v in phases] ==
            ["prepare", "auth-version", "auth-extensions", "auth-account", "auth-subscription", "authenticate",
             "version", "init", "plan", "show"], "exact completed operator phases required")
    require(all(v.get("completed") is True and v.get("exitCode") == 0 for v in phases), "incomplete operator phase")
    require(phases[-1].get("binaryPlanSha256") == plan_hash, "binary plan differs from rendered descriptor")
    result = {"completed": True, "scope": "Local binary development plan and empty-host policy; no apply or runtime acceptance.",
              "source_sha256": state["snapshot"]["source"], "input_sha256": state["snapshot"],
              "binary_plan_sha256": plan_hash, "binary_plan_bytes": plan_size, "rendered_sha256": rendered_hash,
              "authentication_response_sha256": authentication, "phases_sha256": phases_hash,
              "phases": phases, **summary}
    # Remove only this exclusive operation's verified scratch trees. Publication is last.
    def owned_directory():
        info = directory.lstat()
        require(stat.S_ISDIR(info.st_mode) and [info.st_dev, info.st_ino] == state["directory_identity"]
                and info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o700, "operation replaced during cleanup")
    for name in ("work", "home", "tmp", "data", "terraform"):
        owned_directory(); shutil.rmtree(directory / name)
    for name in ("terraform.rc", "rendered.json", "version.json", "session.json", *["auth-" + n + ".json" for n in authentication]):
        owned_directory(); (directory / name).unlink()
    require({p.name for p in directory.iterdir()} == {"plan.tfplan", "phases.json"}, "scratch cleanup incomplete")
    require(load_request(path, now)[-1] == state["snapshot"], "inputs changed before publication")
    owned_directory(); A.publish_result(directory / "result.json", result)
    return {"completed": True, "result_sha256": A.sha((directory / "result.json").read_bytes())}

def main(argv=None):
    os.umask(0o077)
    args = sys.argv[1:] if argv is None else argv
    try:
        require(len(args) in (2, 4), "fixed helper arguments required")
        mode, name = args[:2]; path = Path(name); now = datetime.now(timezone.utc)
        if mode == "prepare":
            require(len(args) == 2, "fixed prepare arguments required"); value = prepare(path, now)
        else:
            require(len(args) == 4, "fixed session arguments required")
            directory, digest = Path(args[2]), args[3]
            if mode == "verify": verify(path, directory, digest, now); value = {"verified": True}
            elif mode == "authenticate": value = authenticate(path, directory, digest, now)
            elif mode == "finish": value = finish(path, directory, digest, now)
            else: raise A.Error("unknown pure helper stage")
        print(json.dumps(value, separators=(",", ":"))); return 0
    except Exception:
        print("Plan stage rejected; inspect the private operation directory for partial or published output.", file=sys.stderr)
        return 1

if __name__ == "__main__": raise SystemExit(main())
