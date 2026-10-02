#!/usr/bin/env python3
"""Check native Azure CLI authentication and subscription protection with one fixed GET."""
from __future__ import annotations
import argparse
import configparser
from contextlib import contextmanager
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import stat
import tempfile

ROOT = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("development_auth_auditor", ROOT / "audit-plan.py")
assert _spec and _spec.loader
A = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(A)
require = A.require
Error = A.Error
CLI_VERSION = "2.90.0"
CLI_SHA256 = "732d82c05ee1b264d3f30221fd51bb234cb7a95d863c0b69526b0c95b60df021"
API_VERSION = "2022-12-01"
SETTINGS = {
    "core": {"collect_telemetry": "no", "no_color": "yes", "login_experience_v2": "off"},
    "extension": {"use_dynamic_install": "no"},
    "logging": {"enable_log_file": "no"},
    "cloud": {"name": "AzureCloud"},
}
ACCOUNT_QUERY = "{id:id,tenantId:tenantId,state:state,environmentName:environmentName}"
SUBSCRIPTION_QUERY = "{subscriptionId:subscriptionId,tenantId:tenantId,state:state,subscriptionPolicies:subscriptionPolicies}"
SCOPE = "Read-only authentication and subscription identity/protection; no budget, plan, allocation or runtime acceptance."

def source_digest():
    path = Path(__file__).resolve()
    require(path.is_file() and not path.is_symlink(), "regular authentication source required")
    return A.sha(json.dumps([A.source_digest(), A.sha(path.read_bytes()),
                            stat.S_IMODE(path.stat().st_mode)], separators=(",", ":")).encode())

def safe_path(path):
    require(path.is_absolute() and path.resolve(strict=True) == path, "canonical absolute path required")
    for entry in [path, *path.parents[:-1]]:
        info = entry.lstat()
        require(info.st_uid in (0, os.getuid()) and not info.st_mode & 0o022,
                "unsafe path ownership or mode")
        require(not stat.S_ISLNK(info.st_mode), "symlink path rejected")

def tool_digest(path):
    safe_path(path)
    digest, size = A.H.secure_executable_digest(path)
    require(digest == CLI_SHA256 and os.access(path, os.X_OK), "qualified native CLI launcher required")
    return digest, size

def identity(path):
    safe_path(path)
    value, digest = A.private_json(path)
    require(isinstance(value, dict) and set(value) == {"subscriptionId", "tenantId"}, "exact expected identity required")
    for item in value.values():
        require(isinstance(item, str) and re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", item),
                "canonical identity UUID required")
    return value, digest

def private_ini(path, modes):
    expected = path.lstat()
    require(stat.S_ISREG(expected.st_mode) and expected.st_uid == os.getuid()
            and stat.S_IMODE(expected.st_mode) in modes and expected.st_nlink == 1
            and 0 < expected.st_size <= 16384, "unsafe CLI configuration file")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        before = os.fstat(fd)
        fields = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
        require(fields(before) == fields(expected), "configuration changed while opening")
        raw = os.read(fd, 16385)
        require(fields(os.fstat(fd)) == fields(before) and len(raw) == before.st_size, "configuration changed during read")
    finally:
        os.close(fd)
    parser = configparser.ConfigParser(interpolation=None, strict=True)
    parser.read_string(raw.decode("utf-8"))
    require(not parser.defaults(), "configuration defaults are not supported")
    return {section: dict(parser[section]) for section in parser.sections()}, A.sha(raw)

def profile_digest(profile):
    safe_path(profile)
    A.H._require_private_directory(profile, "Azure CLI profile")
    settings, config_sha = private_ini(profile / "config", {0o600})
    require(settings == SETTINGS, "unreviewed configuration or authentication override")
    # The CLI overlays this file on built-ins; permit only its account-selection field.
    clouds, cloud_sha = private_ini(profile / "clouds.config", {0o600, 0o644})
    default = clouds.get("AzureCloud", {}).get("subscription")
    require(set(clouds) == {"AzureCloud"} and set(clouds["AzureCloud"]) == {"subscription"}
            and isinstance(default, str) and re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", default),
            "custom cloud or malformed subscription default")
    return {"config": config_sha, "clouds.config": cloud_sha}

@contextmanager
def signal_scope():
    """Let the bounded runner settle its group before restoring caller handlers."""
    signals = (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)
    previous = {number: signal.getsignal(number) for number in signals}
    def interrupt(number, frame):
        for item in signals:
            signal.signal(item, signal.SIG_IGN)
        raise InterruptedError("authentication preflight interrupted")
    try:
        for number in signals:
            signal.signal(number, interrupt)
        yield
    finally:
        for number, handler in previous.items():
            signal.signal(number, handler)

def preflight(cli, profile, expected_identity, expected_source, *, runner=A.run_json):
    require(source_digest() == expected_source, "reviewed source changed")
    tool = tool_digest(cli)
    expected, input_sha = identity(expected_identity)
    config_sha = profile_digest(profile)
    started = datetime.now(timezone.utc).isoformat()
    responses = {}
    def conserve():
        require(source_digest() == expected_source and tool_digest(cli) == tool
                and identity(expected_identity) == (expected, input_sha) and profile_digest(profile) == config_sha,
                "source, launcher, identity or configuration changed")
    with tempfile.TemporaryDirectory(prefix="nourishing-auth-home-") as home:
        env = {"HOME": home, "TMPDIR": home, "PATH": "/usr/bin:/bin", "LANG": "C.UTF-8",
               "AZURE_CONFIG_DIR": str(profile), "AZURE_CORE_COLLECT_TELEMETRY": "no",
               "AZURE_EXTENSION_USE_DYNAMIC_INSTALL": "no", "AZURE_LOGGING_ENABLE_LOG_FILE": "no"}
        def read(label, args):
            conserve()
            value = runner([str(cli), *args, "--only-show-errors", "--output", "json"], Path(home), env, timeout=60)
            conserve()
            # These bind parsed projected JSON, not raw CLI response bytes or a signature.
            responses[label] = A.sha(json.dumps(value, sort_keys=True, separators=(",", ":")).encode())
            return value
        version = read("version", ["version"])
        require(isinstance(version, dict) and set(version) == {"azure-cli", "azure-cli-core", "azure-cli-telemetry", "extensions"}
                and version["azure-cli"] == version["azure-cli-core"] == CLI_VERSION
                and version["extensions"] == {}, "CLI version or extension mismatch")
        require(read("extensions", ["extension", "list"]) == [], "CLI extensions are not permitted")
        account = read("account", ["account", "show", "--subscription", expected["subscriptionId"], "--query", ACCOUNT_QUERY])
        require(account == {"id": expected["subscriptionId"], "tenantId": expected["tenantId"],
                            "state": "Enabled", "environmentName": "AzureCloud"}, "account identity or state mismatch")
        url = "https://management.azure.com/subscriptions/" + expected["subscriptionId"] + "?api-version=" + API_VERSION
        subscription = read("subscription", ["rest", "--method", "get", "--url", url,
                            "--subscription", expected["subscriptionId"], "--query", SUBSCRIPTION_QUERY])
        require(isinstance(subscription, dict) and set(subscription) == {"subscriptionId", "tenantId", "state", "subscriptionPolicies"}
                and subscription["subscriptionId"] == expected["subscriptionId"]
                and subscription["tenantId"] == expected["tenantId"] and subscription["state"] == "Enabled",
                "live subscription identity or state mismatch")
        policies = subscription["subscriptionPolicies"]
        require(isinstance(policies, dict) and policies.get("quotaId") == "AzureForStudents_2018-01-01"
                and policies.get("spendingLimit") == "On", "Students subscription protection required")
    conserve()
    return {"schema_version": 1, "scope": SCOPE, "started_at_utc": started,
            "completed_at_utc": datetime.now(timezone.utc).isoformat(), "source_sha256": expected_source,
            "cli_launcher_sha256": tool[0], "identity_input_sha256": input_sha, "profile_config_sha256": config_sha,
            "parsed_response_sha256": responses, "authentication": "passed", "subscription_protection": "passed"}

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-digest", action="store_true", help="print current digest for review; not acceptance")
    parser.add_argument("--cli", type=Path)
    parser.add_argument("--profile", type=Path)
    parser.add_argument("--expected-identity", type=Path)
    parser.add_argument("--source-sha256")
    parser.add_argument("--result", type=Path)
    args = parser.parse_args(argv)
    try:
        if args.source_digest:
            print(source_digest()); return 0
        require(all((args.cli, args.profile, args.expected_identity, args.source_sha256, args.result)), "explicit reviewed inputs required")
        require(args.result.is_absolute(), "absolute result path required")
        safe_path(args.result.parent)
        A.H._require_private_directory(args.result.parent, "authentication result")
        require(not os.path.lexists(args.result), "result must be new")
        with signal_scope():
            result = preflight(args.cli, args.profile, args.expected_identity, args.source_sha256)
            A.publish_result(args.result, result)
    except A.PublishedResultError:
        print("Complete authentication result was published; durability or temporary cleanup is unconfirmed.")
        return 2
    except (Error, OSError, ValueError, KeyError, TypeError, configparser.Error, A.subprocess.SubprocessError):
        print("Authentication preflight did not complete; inspect the requested result path before reuse.")
        return 1
    print("Read-only authentication and subscription protection passed; no budget or allocation acceptance.")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
