#!/usr/bin/env python3
"""Fail-closed admission for the manually started ARM64 synthetic beta."""

from __future__ import annotations

import base64
import binascii
import datetime
import hashlib
import ipaddress
import json
import os
import pathlib
import re
import signal
import stat
import subprocess
import sys
import time
from contextlib import contextmanager
from typing import Any, Iterator


CONFIG_ROOT = pathlib.Path("/etc/nutrition-tracker")
DATA_ROOT = pathlib.Path("/var/lib/nutrition-tracker")
COMPOSE_FILE = pathlib.Path("/opt/nutrition-tracker/compose.yaml")
PUBLIC_CADDYFILE = pathlib.Path("/opt/nutrition-tracker/Caddyfile")
INTERNAL_CADDYFILE = pathlib.Path("/opt/nutrition-tracker/Caddyfile.internal")
IMAGE_ADMISSION = pathlib.Path("/opt/nutrition-tracker/image-admission.py")
OBJECT_COORDINATES = CONFIG_ROOT / "object-storage-coordinates.json"
OBJECT_HOSTS = pathlib.Path("/run/nutrition-tracker/object-storage-hosts.env")
PUBLIC_RANGE_LOCK = pathlib.Path("/opt/nutrition-tracker/object-storage-public-ranges.lock.json")
REVIEWER_CIDR_FILE = CONFIG_ROOT / "expected-reviewer-cidr"
DATA_DISK_IDENTITY = CONFIG_ROOT / "data-disk-identity.env"
RESTORE_PRIVATE_KEY = CONFIG_ROOT / "oci/restore-private-key.pem"
AZURE_LUN0_PATHS = (
    pathlib.Path("/dev/disk/azure/data/by-lun/0"),
    pathlib.Path("/dev/disk/azure/scsi1/lun0"),
)
COMMAND_TIMEOUT_SECONDS = 60
PROCESS_GROUP_TERM_SECONDS = 5
PROCESS_GROUP_KILL_SECONDS = 5
VALIDATOR_RECONCILIATION_SECONDS = 20
VALIDATOR_LABEL_KEY = "com.nutrition-tracker.azure-preflight-validator"
VALIDATOR_NAME_PREFIX = "nutrition-azure-caddy-validator"
ACKNOWLEDGEMENT = "I_ACCEPT_SYNTHETIC_ONLY_SINGLE_SERVER_NON_HA_BETA"
ENVIRONMENTS = ("deploy", "runtime", "database", "api", "worker", "meili", "restore")
ENVIRONMENT_KEY_SCHEMAS = {
    "deploy": frozenset(
        {
            "ACME_EMAIL",
            "API_FQDN",
            "API_IMAGE",
            "AZURE_OCI_CREDENTIAL_INSTALL_ADMISSION",
            "AZURE_OCI_EGRESS_ADMISSION",
            "AZURE_OCI_USAGE_ADMISSION",
            "AZURE_OFF_HOST_BACKUP_ADMISSION",
            "BETA_ALLOWED_CIDRS",
            "CADDY_IMAGE",
            "MEILI_IMAGE",
            "MIGRATOR_IMAGE",
            "POSTGRES_IMAGE",
            "SYNTHETIC_ONLY_ACKNOWLEDGEMENT",
            "WEB_FQDN",
            "WEB_IMAGE",
            "WORKER_IMAGE",
        }
    ),
    "runtime": frozenset(
        {
            "BETA_DATA_CLASSIFICATION",
            "DATABASE_APPLICATION_NAME",
            "DATABASE_CONNECTION_TIMEOUT_MS",
            "DATABASE_POOL_MAX",
            "DATABASE_SSL_MODE",
            "DATABASE_STATEMENT_TIMEOUT_MS",
            "ERASURE_REPLAY_LEDGER_BUCKET",
            "ERASURE_REPLAY_LEDGER_CURRENT_KEY_ID",
            "ERASURE_REPLAY_LEDGER_ENDPOINT",
            "ERASURE_REPLAY_LEDGER_LOCATOR_CURRENT_KEY_ID",
            "ERASURE_REPLAY_LEDGER_REGION",
            "ERASURE_REPLAY_LEDGER_STORE",
            "EXPORT_ARTIFACT_BUCKET",
            "EXPORT_ARTIFACT_CURRENT_KEY_ID",
            "EXPORT_ARTIFACT_DELETE_VERSION_POLICY",
            "EXPORT_ARTIFACT_ENDPOINT",
            "EXPORT_ARTIFACT_READ_MAX_ARTIFACT_BYTES",
            "EXPORT_ARTIFACT_READ_MAX_BYTES_PER_WINDOW",
            "EXPORT_ARTIFACT_READ_MAX_CONCURRENCY",
            "EXPORT_ARTIFACT_READ_MAX_RESERVED_BYTES",
            "EXPORT_ARTIFACT_READ_SPOOL_DIR",
            "EXPORT_ARTIFACT_READ_SPOOL_PROTECTION",
            "EXPORT_ARTIFACT_REGION",
            "EXPORT_ARTIFACT_STORE",
            "LOG_LEVEL",
            "MEILI_URL",
            "NODE_ENV",
            "RETENTION_EXPORT_SPOOL_DIR",
            "RETENTION_EXPORT_SPOOL_MAX_BYTES",
            "RETENTION_EXPORT_SPOOL_PROTECTION",
            "RETENTION_FEATURES_ENABLED",
            "RETENTION_WORKER_ID",
            "SEARCH_REBUILD_SPOOL_DIR",
            "SEARCH_REBUILD_SPOOL_MAX_BYTES",
            "SEARCH_REBUILD_WORKER_ID",
            "SERVICE_VERSION",
        }
    ),
    "database": frozenset(
        {
            "DATABASE_RESTORE_EPOCH",
            "DATABASE_URL",
            "POSTGRES_DB",
            "POSTGRES_PASSWORD",
            "POSTGRES_USER",
        }
    ),
    "api": frozenset(
        {
            "DEVICE_CHALLENGE_HMAC_KEY",
            "ERASURE_REPLAY_LEDGER_LOCATOR_HMAC_KEYS",
            "ERASURE_STATUS_CAPABILITY_HMAC_KEY",
            "EXPORT_ARTIFACT_ENCRYPTION_KEYS",
            "EXPORT_ARTIFACT_READ_ACCESS_KEY_ID",
            "EXPORT_ARTIFACT_READ_SECRET_ACCESS_KEY",
            "MEILI_SEARCH_KEY",
            "SEARCH_CURSOR_SECRET",
        }
    ),
    "worker": frozenset(
        {
            "ERASURE_REPLAY_LEDGER_ENCRYPTION_KEYS",
            "ERASURE_REPLAY_LEDGER_LOCATOR_HMAC_KEYS",
            "ERASURE_REPLAY_LEDGER_WRITE_ACCESS_KEY_ID",
            "ERASURE_REPLAY_LEDGER_WRITE_SECRET_ACCESS_KEY",
            "EXPORT_ARTIFACT_ENCRYPTION_KEYS",
            "EXPORT_ARTIFACT_WRITE_ACCESS_KEY_ID",
            "EXPORT_ARTIFACT_WRITE_SECRET_ACCESS_KEY",
            "MEILI_ADMIN_KEY",
            "MEILI_TASK_OBSERVER_KEY",
        }
    ),
    "meili": frozenset({"MEILI_MASTER_KEY"}),
    "restore": frozenset(
        {
            "ERASURE_REPLAY_LEDGER_ENCRYPTION_KEYS",
            "ERASURE_REPLAY_LEDGER_LOCATOR_HMAC_KEYS",
            "ERASURE_REPLAY_LEDGER_RESTORE_ACCESS_KEY_ID",
            "ERASURE_REPLAY_LEDGER_RESTORE_MAX_CONCURRENCY",
            "ERASURE_REPLAY_LEDGER_RESTORE_OCI_KEY_FINGERPRINT",
            "ERASURE_REPLAY_LEDGER_RESTORE_OCI_NAMESPACE",
            "ERASURE_REPLAY_LEDGER_RESTORE_OCI_PRIVATE_KEY_FILE",
            "ERASURE_REPLAY_LEDGER_RESTORE_OCI_TENANCY_OCID",
            "ERASURE_REPLAY_LEDGER_RESTORE_OCI_USER_OCID",
            "ERASURE_REPLAY_LEDGER_RESTORE_REQUEST_TIMEOUT_MS",
            "ERASURE_REPLAY_LEDGER_RESTORE_SECRET_ACCESS_KEY",
            "ERASURE_REPLAY_LEDGER_RESTORE_SPOOL_DIR",
            "ERASURE_REPLAY_LEDGER_RESTORE_SPOOL_PROTECTION",
            "ERASURE_REPLAY_LEDGER_RESTORE_VERSION_LIST_PROVIDER",
        }
    ),
}
IMAGE_REPOSITORIES = {
    "MEILI_IMAGE": "ghcr.io/liangzixuan/cronometer-gold-meilisearch",
    "CADDY_IMAGE": "ghcr.io/liangzixuan/cronometer-gold-caddy",
    "POSTGRES_IMAGE": "ghcr.io/liangzixuan/cronometer-gold-postgres",
    "API_IMAGE": "ghcr.io/liangzixuan/cronometer-gold-api",
    "WEB_IMAGE": "ghcr.io/liangzixuan/cronometer-gold-web",
    "WORKER_IMAGE": "ghcr.io/liangzixuan/cronometer-gold-worker",
    "MIGRATOR_IMAGE": "ghcr.io/liangzixuan/cronometer-gold-migrator",
}
IMAGE_ADMISSION_SHA256 = "c3a7be9218b791010322c36f20bef7593779e4ade01c1233a611543be0b7b017"
PUBLIC_RANGE_LOCK_SHA256 = "44124af92774cb3766b001a706425b4582cfefa660b815efafcd35c2b1ed81ed"
IMAGE_REFERENCE = re.compile(r"[^@\s]+@sha256:[0-9a-f]{64}")
FQDN = re.compile(r"(?=.{1,253}\Z)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}")


def fail(message: str) -> None:
    raise SystemExit(message)


class PreflightCancellation(BaseException):
    """A catchable TERM/HUP cancellation used to reconcile Docker validators."""

    def __init__(self, signum: int):
        super().__init__(f"cancelled by signal {signum}")
        self.signum = signum


class TerminationSignalScope:
    """Translate TERM/HUP into cancellation and support scoped cleanup masking."""

    def __init__(self) -> None:
        self._previous_handlers: dict[int, Any] = {}

    def __enter__(self) -> "TerminationSignalScope":
        def cancel(signum: int, _frame: object) -> None:
            raise PreflightCancellation(signum)

        for signum in (signal.SIGTERM, signal.SIGHUP):
            self._previous_handlers[signum] = signal.signal(signum, cancel)
        return self

    @contextmanager
    def cleanup_masked(self) -> Iterator[None]:
        active_handlers = {
            signum: signal.getsignal(signum) for signum in self._previous_handlers
        }
        for signum in active_handlers:
            signal.signal(signum, signal.SIG_IGN)
        try:
            yield
        finally:
            for signum, handler in active_handlers.items():
                signal.signal(signum, handler)

    def __exit__(self, _type: object, _value: object, _traceback: object) -> None:
        for signum, handler in self._previous_handlers.items():
            signal.signal(signum, handler)


@contextmanager
def termination_signals_masked() -> Iterator[None]:
    active_handlers = {
        signum: signal.getsignal(signum) for signum in (signal.SIGTERM, signal.SIGHUP)
    }
    for signum in active_handlers:
        signal.signal(signum, signal.SIG_IGN)
    try:
        yield
    finally:
        for signum, handler in active_handlers.items():
            signal.signal(signum, handler)


def process_group_exists(process_group_id: int) -> bool:
    try:
        os.killpg(process_group_id, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def wait_for_process_group_exit(
    process: subprocess.Popen[str], process_group_id: int, timeout_seconds: int
) -> bool:
    deadline = time.monotonic() + timeout_seconds
    while True:
        process.poll()
        if not process_group_exists(process_group_id):
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(0.1)


def stop_process_group(process: subprocess.Popen[str], description: str) -> None:
    process_group_id = process.pid
    try:
        os.killpg(process_group_id, signal.SIGTERM)
    except ProcessLookupError:
        pass
    if not wait_for_process_group_exit(
        process, process_group_id, PROCESS_GROUP_TERM_SECONDS
    ):
        try:
            os.killpg(process_group_id, signal.SIGKILL)
        except ProcessLookupError:
            pass
        wait_for_process_group_exit(
            process, process_group_id, PROCESS_GROUP_KILL_SECONDS
        )
    if process.poll() is None:
        try:
            process.wait(timeout=1)
        except subprocess.TimeoutExpired:
            pass
    if process_group_exists(process_group_id) or process.poll() is None:
        fail(f"Could not stop the complete {description} process group")


def command(
    arguments: list[str],
    description: str,
    *,
    timeout_seconds: int = COMMAND_TIMEOUT_SECONDS,
) -> str:
    try:
        process = subprocess.Popen(
            arguments,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            start_new_session=True,
        )
    except OSError as error:
        fail(f"Could not start {description}: {error}")
    try:
        output, _ = process.communicate(timeout=timeout_seconds)
    except subprocess.TimeoutExpired as error:
        with termination_signals_masked():
            stop_process_group(process, description)
        fail(f"{description} timed out after {timeout_seconds} seconds: {error}")
    except BaseException:
        with termination_signals_masked():
            stop_process_group(process, description)
        raise
    if process.returncode != 0:
        detail = output.strip()
        fail(
            f"Could not inspect {description}"
            f"{f': {detail[:1_500]}' if detail else ''}"
        )
    return output.strip()


def require_regular_file(path: pathlib.Path, mode: int, uid: int = 0, gid: int = 0) -> None:
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        fail(f"Missing {path}")
    if (
        not stat.S_ISREG(metadata.st_mode)
        or stat.S_ISLNK(metadata.st_mode)
        or (metadata.st_uid, metadata.st_gid, stat.S_IMODE(metadata.st_mode)) != (uid, gid, mode)
    ):
        fail(f"{path} must be a regular non-symlink owned by {uid}:{gid} with mode {mode:04o}")


def read_environment(path: pathlib.Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for line_number, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        key, separator, value = raw.partition("=")
        if not separator or not re.fullmatch(r"[A-Z][A-Z0-9_]*", key) or key in values:
            fail(f"Invalid or duplicate environment entry at {path}:{line_number}")
        values[key] = value
    return values


def assert_environment_schemas(environments: dict[str, dict[str, str]]) -> None:
    if set(environments) != set(ENVIRONMENT_KEY_SCHEMAS):
        fail("Deployment environment file set differs from the reviewed role schema")
    for name, expected in ENVIRONMENT_KEY_SCHEMAS.items():
        actual = set(environments[name])
        if actual != expected:
            missing = ",".join(sorted(expected - actual)) or "none"
            unexpected = ",".join(sorted(actual - expected)) or "none"
            fail(
                f"{name}.env key schema differs from the reviewed role projection; "
                f"missing={missing}; unexpected={unexpected}"
            )


def required(environment: dict[str, str], key: str) -> str:
    value = environment.get(key)
    if value is None or not value:
        fail(f"Missing {key}")
    return value


def assert_host() -> None:
    if os.geteuid() != 0:
        fail("Run the deployment preflight as root")
    if command(["uname", "-m"], "host architecture") != "aarch64":
        fail("The reviewed runtime requires an ARM64 host")
    if (os.cpu_count() or 0) < 2:
        fail("The reviewed runtime requires at least two visible CPUs")
    meminfo = pathlib.Path("/proc/meminfo").read_text(encoding="ascii")
    match = re.search(r"^MemTotal:\s+(\d+)\s+kB$", meminfo, re.MULTILINE)
    if match is None or int(match.group(1)) < 14 * 1024 * 1024:
        fail("The reviewed E2ps_v5 runtime requires at least 14 GiB of visible memory")


def assert_markers(mode: str, paths: dict[str, pathlib.Path]) -> None:
    allowed = {
        "api": {"MEILI_SEARCH_KEY=REPLACE_SCOPED_MEILI_SEARCH_KEY"},
        "worker": {
            "MEILI_ADMIN_KEY=REPLACE_SCOPED_MEILI_ADMIN_KEY",
            "MEILI_TASK_OBSERVER_KEY=REPLACE_SCOPED_MEILI_TASK_OBSERVER_KEY",
        },
    }
    marker = re.compile(r"REPLACE_[A-Z0-9_]+")
    for name, path in paths.items():
        found = {line for line in path.read_text(encoding="utf-8").splitlines() if marker.search(line)}
        expected = allowed.get(name, set()) if mode == "early" else set()
        if found != expected:
            fail(f"{path} has an unexpected replacement-marker set for {mode} preflight")


def assert_deployment(deploy: dict[str, str]) -> None:
    if required(deploy, "SYNTHETIC_ONLY_ACKNOWLEDGEMENT") != ACKNOWLEDGEMENT:
        fail("The exact synthetic-only, single-server, non-HA acknowledgement is required")
    reviewer = required(deploy, "BETA_ALLOWED_CIDRS")
    try:
        network = ipaddress.ip_network(reviewer, strict=True)
    except ValueError as error:
        fail(f"BETA_ALLOWED_CIDRS must be one canonical public IPv4 /32: {error}")
    if network.version != 4 or network.prefixlen != 32 or not network.is_global or str(network) != reviewer:
        fail("BETA_ALLOWED_CIDRS must be one canonical globally routable IPv4 /32")
    require_regular_file(REVIEWER_CIDR_FILE, 0o644)
    if REVIEWER_CIDR_FILE.read_text(encoding="ascii").strip() != reviewer:
        fail("BETA_ALLOWED_CIDRS differs from the reviewed SSH/NSG source /32")
    api_fqdn = required(deploy, "API_FQDN")
    web_fqdn = required(deploy, "WEB_FQDN")
    if (
        not FQDN.fullmatch(api_fqdn)
        or not FQDN.fullmatch(web_fqdn)
        or (api_fqdn, web_fqdn) != ("api.nourishing.app", "app.nourishing.app")
    ):
        fail("The beta FQDNs must remain api.nourishing.app and app.nourishing.app")
    if not re.fullmatch(r"[^@\s]+@[^@\s]+", required(deploy, "ACME_EMAIL")):
        fail("ACME_EMAIL is invalid")
    for variable, repository in IMAGE_REPOSITORIES.items():
        reference = required(deploy, variable)
        if not IMAGE_REFERENCE.fullmatch(reference) or not reference.startswith(repository + "@"):
            fail(f"{variable} must use the exact reviewed repository at an immutable digest")


def assert_runtime(environments: dict[str, dict[str, str]]) -> None:
    runtime = environments["runtime"]
    expected = {
        "NODE_ENV": "production",
        "BETA_DATA_CLASSIFICATION": "synthetic-only",
        "DATABASE_SSL_MODE": "verify-full",
        "MEILI_URL": "https://meili.internal:8443",
        "EXPORT_ARTIFACT_STORE": "s3",
        "EXPORT_ARTIFACT_DELETE_VERSION_POLICY": "latest",
        "ERASURE_REPLAY_LEDGER_STORE": "s3",
        "EXPORT_ARTIFACT_REGION": "us-ashburn-1",
        "ERASURE_REPLAY_LEDGER_REGION": "us-ashburn-1",
        "RETENTION_FEATURES_ENABLED": "true",
        "EXPORT_ARTIFACT_READ_SPOOL_PROTECTION": "encrypted_volume",
        "EXPORT_ARTIFACT_READ_MAX_ARTIFACT_BYTES": "268435456",
        "EXPORT_ARTIFACT_READ_MAX_CONCURRENCY": "1",
        "EXPORT_ARTIFACT_READ_MAX_RESERVED_BYTES": "268435456",
        "EXPORT_ARTIFACT_READ_MAX_BYTES_PER_WINDOW": "536870912",
        "RETENTION_EXPORT_SPOOL_MAX_BYTES": "268435456",
        "SEARCH_REBUILD_SPOOL_MAX_BYTES": "536870912",
        "RETENTION_EXPORT_SPOOL_PROTECTION": "encrypted_volume",
    }
    for key, value in expected.items():
        if runtime.get(key) != value:
            fail(f"runtime.env {key} must equal {value}")
    if not re.fullmatch(r"[0-9a-f]{40}", required(runtime, "SERVICE_VERSION")):
        fail("SERVICE_VERSION must be a full lowercase Git commit SHA")
    if environments["restore"].get("ERASURE_REPLAY_LEDGER_RESTORE_VERSION_LIST_PROVIDER") != "oci_native":
        fail("The compute-only pivot must retain the reviewed oci_native restore inventory")
    if environments["restore"].get("ERASURE_REPLAY_LEDGER_RESTORE_OCI_PRIVATE_KEY_FILE") != "/run/oci/restore-private-key.pem":
        fail("The restore API key must remain an offline-only fixed-path mount")


def parse_keyring(environment: dict[str, str], key: str) -> dict[str, str]:
    try:
        parsed = json.loads(required(environment, key))
    except json.JSONDecodeError as error:
        fail(f"{key} is not valid JSON: {error}")
    if not isinstance(parsed, dict) or not 1 <= len(parsed) <= 32:
        fail(f"{key} must be a non-empty JSON object")
    for key_id, encoded in parsed.items():
        if not isinstance(key_id, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", key_id):
            fail(f"{key} has an invalid key identifier")
        try:
            decoded = base64.b64decode(encoded, validate=True)
        except (binascii.Error, ValueError, TypeError) as error:
            fail(f"{key} has invalid Base64: {error}")
        if len(decoded) != 32 or base64.b64encode(decoded).decode("ascii") != encoded:
            fail(f"{key} must contain canonical Base64 32-byte keys")
    return parsed


def assert_secrets(environments: dict[str, dict[str, str]]) -> None:
    credential_fields = (
        ("api", "EXPORT_ARTIFACT_READ_ACCESS_KEY_ID", "EXPORT_ARTIFACT_READ_SECRET_ACCESS_KEY"),
        ("worker", "EXPORT_ARTIFACT_WRITE_ACCESS_KEY_ID", "EXPORT_ARTIFACT_WRITE_SECRET_ACCESS_KEY"),
        ("worker", "ERASURE_REPLAY_LEDGER_WRITE_ACCESS_KEY_ID", "ERASURE_REPLAY_LEDGER_WRITE_SECRET_ACCESS_KEY"),
        ("restore", "ERASURE_REPLAY_LEDGER_RESTORE_ACCESS_KEY_ID", "ERASURE_REPLAY_LEDGER_RESTORE_SECRET_ACCESS_KEY"),
    )
    access_ids = [required(environments[name], access) for name, access, _ in credential_fields]
    secrets = [required(environments[name], secret) for name, _, secret in credential_fields]
    if any(len(value) < 16 or len(value) > 256 or any(char.isspace() for char in value) for value in access_ids):
        fail("Every Object Storage access identifier must contain 16 to 256 non-whitespace characters")
    if any(len(value) < 32 or len(value) > 256 or any(char.isspace() for char in value) for value in secrets):
        fail("Every Object Storage secret must contain 32 to 256 non-whitespace characters")
    if len(set(access_ids)) != len(access_ids) or len(set(secrets)) != len(secrets):
        fail("All four least-privilege Object Storage roles must use distinct credential pairs")
    meili_credentials = [
        required(environments["meili"], "MEILI_MASTER_KEY"),
        required(environments["api"], "MEILI_SEARCH_KEY"),
        required(environments["worker"], "MEILI_ADMIN_KEY"),
        required(environments["worker"], "MEILI_TASK_OBSERVER_KEY"),
    ]
    if any(
        len(value) < 16
        or len(value) > 512
        or value.strip() != value
        or any(character.isspace() for character in value)
        for value in meili_credentials
    ):
        fail("Every Meilisearch credential must contain 16 to 512 non-whitespace characters")
    if len(set(meili_credentials)) != len(meili_credentials):
        fail("Meilisearch master, search, mutation, and task-observer credentials must be distinct")
    export_api = parse_keyring(environments["api"], "EXPORT_ARTIFACT_ENCRYPTION_KEYS")
    export_worker = parse_keyring(environments["worker"], "EXPORT_ARTIFACT_ENCRYPTION_KEYS")
    ledger_worker = parse_keyring(environments["worker"], "ERASURE_REPLAY_LEDGER_ENCRYPTION_KEYS")
    ledger_restore = parse_keyring(environments["restore"], "ERASURE_REPLAY_LEDGER_ENCRYPTION_KEYS")
    locator_api = parse_keyring(environments["api"], "ERASURE_REPLAY_LEDGER_LOCATOR_HMAC_KEYS")
    locator_worker = parse_keyring(environments["worker"], "ERASURE_REPLAY_LEDGER_LOCATOR_HMAC_KEYS")
    locator_restore = parse_keyring(environments["restore"], "ERASURE_REPLAY_LEDGER_LOCATOR_HMAC_KEYS")
    if export_api != export_worker or ledger_worker != ledger_restore or not (locator_api == locator_worker == locator_restore):
        fail("Application and offline-role encryption/HMAC key rings must match exactly")
    for key, ring in (
        ("EXPORT_ARTIFACT_CURRENT_KEY_ID", export_api),
        ("ERASURE_REPLAY_LEDGER_CURRENT_KEY_ID", ledger_worker),
        ("ERASURE_REPLAY_LEDGER_LOCATOR_CURRENT_KEY_ID", locator_api),
    ):
        if required(environments["runtime"], key) not in ring:
            fail(f"runtime.env {key} is absent from its role key ring")


def canonical_backing_device(source: str, description: str) -> str:
    resolved = command(
        ["readlink", "--canonicalize-existing", "--", source],
        f"{description} canonical device",
    )
    if not re.fullmatch(r"/dev/[A-Za-z0-9._/+:-]+", resolved):
        fail(f"{description} did not resolve to one canonical /dev path")
    parent = command(
        ["lsblk", "-dnro", "PKNAME", "--", resolved],
        f"{description} parent device",
    )
    if "\n" in parent or (parent and not re.fullmatch(r"[A-Za-z0-9._+-]+", parent)):
        fail(f"{description} has an ambiguous parent block device")
    if parent:
        resolved = command(
            ["readlink", "--canonicalize-existing", "--", f"/dev/{parent}"],
            f"{description} whole-disk device",
        )
    return resolved


def azure_lun0_backing_device() -> str:
    candidates = [
        canonical_backing_device(str(path), f"Azure LUN-0 link {path}")
        for path in AZURE_LUN0_PATHS
        if path.exists() or path.is_symlink()
    ]
    if not candidates:
        fail("No canonical Azure data-disk LUN-0 device link exists")
    if len(set(candidates)) != 1:
        fail("Azure data-disk LUN-0 links resolve to different backing devices")
    return candidates[0]


def reviewed_data_disk_identity() -> tuple[str, str]:
    require_regular_file(DATA_DISK_IDENTITY, 0o644)
    identity = read_environment(DATA_DISK_IDENTITY)
    if set(identity) != {
        "AZURE_DATA_DISK_LUN",
        "AZURE_DATA_DISK_FILESYSTEM_UUID",
        "AZURE_DATA_DISK_SERIAL",
    }:
        fail("The reviewed data-disk identity file has an unexpected key set")
    if identity["AZURE_DATA_DISK_LUN"] != "0":
        fail("The reviewed Azure data disk must remain attached at LUN 0")
    filesystem_uuid = identity["AZURE_DATA_DISK_FILESYSTEM_UUID"]
    serial = identity["AZURE_DATA_DISK_SERIAL"]
    if not re.fullmatch(
        r"[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-"
        r"[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}",
        filesystem_uuid,
    ):
        fail("The reviewed data-disk filesystem UUID is invalid")
    if not re.fullmatch(r"[A-Za-z0-9._:+-]{1,128}", serial):
        fail("The reviewed Azure data-disk serial is invalid")
    return filesystem_uuid, serial


def assert_storage() -> None:
    expected_uuid, expected_serial = reviewed_data_disk_identity()
    target = command(["findmnt", "-n", "-o", "TARGET", "--target", str(DATA_ROOT)], "data mount target")
    source = command(["findmnt", "-n", "-o", "SOURCE", "--target", str(DATA_ROOT)], "data mount source")
    root_source = command(["findmnt", "-n", "-o", "SOURCE", "--target", "/"], "OS mount source")
    fs_type = command(["findmnt", "-n", "-o", "FSTYPE", "--target", str(DATA_ROOT)], "data filesystem")
    filesystem_uuid = command(["findmnt", "-n", "-o", "UUID", "--target", str(DATA_ROOT)], "data filesystem UUID")
    options = set(command(["findmnt", "-n", "-o", "OPTIONS", "--target", str(DATA_ROOT)], "data mount options").split(","))
    if target != str(DATA_ROOT) or source == root_source or fs_type not in {"ext4", "xfs"}:
        fail("The persistent root must be the dedicated ext4/xfs data-disk mount")
    data_backing_device = canonical_backing_device(source, "mounted data filesystem")
    lun0_backing_device = azure_lun0_backing_device()
    if data_backing_device != lun0_backing_device:
        fail("The persistent root is not backed by the reviewed Azure LUN-0 data disk")
    serial = command(
        ["lsblk", "-dnro", "SERIAL", "--", lun0_backing_device],
        "Azure LUN-0 data-disk serial",
    )
    if filesystem_uuid != expected_uuid or serial != expected_serial:
        fail("The mounted LUN-0 filesystem UUID or disk serial differs from review")
    if not {"rw", "nodev", "nosuid"} <= options:
        fail("The data-disk mount must be rw,nodev,nosuid")
    specifications = {
        "postgres": (70, 70, 0o700),
        "meili": (1000, 1000, 0o700),
        "export-read-spool": (1000, 1000, 0o700),
        "export-spool": (1000, 1000, 0o700),
        "search-spool": (1000, 1000, 0o700),
        "caddy": (1000, 1000, 0o700),
        "caddy/data": (1000, 1000, 0o700),
        "caddy/config": (1000, 1000, 0o700),
    }
    for relative, expected in specifications.items():
        metadata = (DATA_ROOT / relative).lstat()
        if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode) or (
            metadata.st_uid,
            metadata.st_gid,
            stat.S_IMODE(metadata.st_mode),
        ) != expected:
            fail(f"Unsafe persistent directory: {DATA_ROOT / relative}")
    stats = os.statvfs(DATA_ROOT)
    if stats.f_bavail * stats.f_frsize < 40 * 1024 * 1024 * 1024:
        fail("At least 40 GiB must remain available on the preserved data disk")


def assert_pki() -> None:
    pki = CONFIG_ROOT / "pki"
    require_regular_file(pki / "ca/ca.key", 0o600)
    require_regular_file(pki / "ca/ca.crt", 0o644)
    require_regular_file(pki / "trust/ca.crt", 0o644)
    if (pki / "ca/ca.crt").read_bytes() != (pki / "trust/ca.crt").read_bytes():
        fail("The internal CA and application trust copy differ")
    leaves = (
        ("postgres", "postgres", "server.crt", "server.key", 70, 70),
        ("meili", "meili.internal", "server.crt", "server.key", 1000, 1000),
    )
    for service, dns_name, cert_name, key_name, uid, gid in leaves:
        certificate = pki / service / cert_name
        private_key = pki / service / key_name
        require_regular_file(certificate, 0o644, uid, gid)
        require_regular_file(private_key, 0o600, uid, gid)
        command(["openssl", "verify", "-CAfile", str(pki / "ca/ca.crt"), str(certificate)], f"{service} certificate chain")
        command(["openssl", "x509", "-checkend", str(14 * 86400), "-noout", "-in", str(certificate)], f"{service} certificate lifetime")
        san = command(["openssl", "x509", "-noout", "-ext", "subjectAltName", "-in", str(certificate)], f"{service} SAN")
        if f"DNS:{dns_name}" not in san:
            fail(f"{service} certificate does not contain DNS:{dns_name}")
        key_public = command(["openssl", "pkey", "-in", str(private_key), "-pubout"], f"{service} key")
        cert_public = command(["openssl", "x509", "-in", str(certificate), "-pubkey", "-noout"], f"{service} certificate key")
        if key_public != cert_public:
            fail(f"{service} certificate and private key do not match")


def assert_object_storage(environments: dict[str, dict[str, str]]) -> None:
    require_regular_file(OBJECT_COORDINATES, 0o644)
    require_regular_file(OBJECT_HOSTS, 0o600)
    require_regular_file(PUBLIC_RANGE_LOCK, 0o644)
    require_regular_file(RESTORE_PRIVATE_KEY, 0o400, 1000, 1000)
    if RESTORE_PRIVATE_KEY.stat().st_size > 16_384:
        fail("The offline restore API key exceeds 16 KiB")
    command(["openssl", "pkey", "-check", "-noout", "-in", str(RESTORE_PRIVATE_KEY)], "offline restore API key")

    if hashlib.sha256(PUBLIC_RANGE_LOCK.read_bytes()).hexdigest() != PUBLIC_RANGE_LOCK_SHA256:
        fail("Installed Object Storage public-range lock differs from the reviewed source")
    try:
        public_range_lock = json.loads(PUBLIC_RANGE_LOCK.read_text(encoding="utf-8"))
        reviewed_at = datetime.datetime.fromisoformat(
            public_range_lock["review"]["reviewedAt"].replace("Z", "+00:00")
        )
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
        fail(f"Object Storage public-range lock is invalid: {error}")
    now = datetime.datetime.now(datetime.timezone.utc)
    if reviewed_at.tzinfo is None or reviewed_at > now or now - reviewed_at > datetime.timedelta(hours=168):
        fail("Object Storage public-range review is future-dated or older than 168 hours")

    try:
        coordinates = json.loads(OBJECT_COORDINATES.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        fail(f"Object Storage coordinates are not valid JSON: {error}")
    expected_keys = {
        "schemaVersion", "endpoint", "compatHost", "nativeHost", "region", "namespace",
        "exportBucket", "ledgerBucket", "restoreUserOcid", "tenancyOcid", "bridgeCidr",
        "objectStoragePublicCidrs",
    }
    if set(coordinates) != expected_keys or coordinates.get("schemaVersion") != 3:
        fail("Object Storage coordinates have an unexpected schema")
    if coordinates.get("region") != "us-ashburn-1" or coordinates.get("bridgeCidr") != "172.31.255.0/28":
        fail("Object Storage coordinates differ from the reviewed region or bridge")
    namespace = coordinates.get("namespace")
    if not isinstance(namespace, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", namespace):
        fail("Object Storage namespace is invalid")
    compat_host = f"{namespace}.compat.objectstorage.us-ashburn-1.oci.customer-oci.com"
    native_host = "objectstorage.us-ashburn-1.oraclecloud.com"
    if coordinates.get("compatHost") != compat_host or coordinates.get("endpoint") != f"https://{compat_host}":
        fail("S3 compatibility coordinates are invalid")
    if coordinates.get("nativeHost") != native_host:
        fail("Native Object Storage coordinates are invalid")
    if not re.fullmatch(r"ocid1\.user\.oc1\..+", str(coordinates.get("restoreUserOcid", ""))):
        fail("Restore user identifier is invalid")
    if not re.fullmatch(r"ocid1\.tenancy\.oc1\..+", str(coordinates.get("tenancyOcid", ""))):
        fail("Tenancy identifier is invalid")
    for key in ("exportBucket", "ledgerBucket"):
        if not re.fullmatch(r"[A-Za-z0-9_.-]{1,256}", str(coordinates.get(key, ""))):
            fail(f"Object Storage {key} is invalid")
    if coordinates["exportBucket"] == coordinates["ledgerBucket"]:
        fail("Export and ledger buckets must remain distinct")

    cidr_values = coordinates.get("objectStoragePublicCidrs")
    if (
        not isinstance(cidr_values, list)
        or len(cidr_values) != 2
        or any(not isinstance(item, str) for item in cidr_values)
        or cidr_values != sorted(cidr_values)
        or len(cidr_values) != len(set(cidr_values))
    ):
        fail("Object Storage public ranges must be the reviewed sorted unique pair")
    try:
        cidrs = [ipaddress.ip_network(item, strict=True) for item in cidr_values]
    except ValueError as error:
        fail(f"Object Storage public ranges are invalid: {error}")
    if any(network.version != 4 or not network.is_global for network in cidrs):
        fail("Object Storage public ranges must be globally routable IPv4 networks")
    if any(left.overlaps(right) for index, left in enumerate(cidrs) for right in cidrs[index + 1 :]):
        fail("Object Storage public ranges may not overlap")
    if public_range_lock.get("objectStoragePublicCidrs") != cidr_values:
        fail("Object Storage coordinates differ from the current reviewed public-range lock")

    hosts: dict[str, str] = {}
    for number, raw in enumerate(OBJECT_HOSTS.read_text(encoding="ascii").splitlines(), 1):
        key, separator, value = raw.partition("=")
        if not separator or key in hosts or not value:
            fail(f"Invalid Object Storage host-map entry at line {number}")
        hosts[key] = value
    if set(hosts) != {"OCI_COMPAT_HOST", "OCI_COMPAT_IPV4", "OCI_NATIVE_HOST", "OCI_NATIVE_IPV4"}:
        fail("Object Storage host map has an unexpected schema")
    if hosts["OCI_COMPAT_HOST"] != compat_host or hosts["OCI_NATIVE_HOST"] != native_host:
        fail("Object Storage host map differs from reviewed coordinates")
    for key in ("OCI_COMPAT_IPV4", "OCI_NATIVE_IPV4"):
        try:
            address = ipaddress.ip_address(hosts[key])
        except ValueError as error:
            fail(f"{key} is invalid: {error}")
        if address.version != 4 or not any(address in network for network in cidrs):
            fail(f"{key} is outside the reviewed Object Storage ranges")

    runtime = environments["runtime"]
    mirrors = (
        ("EXPORT_ARTIFACT_ENDPOINT", "endpoint"),
        ("EXPORT_ARTIFACT_BUCKET", "exportBucket"),
        ("ERASURE_REPLAY_LEDGER_ENDPOINT", "endpoint"),
        ("ERASURE_REPLAY_LEDGER_BUCKET", "ledgerBucket"),
    )
    for environment_key, coordinate_key in mirrors:
        if required(runtime, environment_key) != coordinates.get(coordinate_key):
            fail(f"runtime.env {environment_key} differs from reviewed Object Storage coordinates")
    restore = environments["restore"]
    if restore.get("ERASURE_REPLAY_LEDGER_RESTORE_OCI_NAMESPACE") != namespace:
        fail("restore.env namespace differs from reviewed Object Storage coordinates")
    if restore.get("ERASURE_REPLAY_LEDGER_RESTORE_OCI_USER_OCID") != coordinates.get("restoreUserOcid"):
        fail("restore.env user differs from reviewed Object Storage coordinates")
    if restore.get("ERASURE_REPLAY_LEDGER_RESTORE_OCI_TENANCY_OCID") != coordinates.get("tenancyOcid"):
        fail("restore.env tenancy differs from reviewed Object Storage coordinates")
    if not re.fullmatch(
        r"(?:[0-9a-f]{2}:){15}[0-9a-f]{2}",
        required(restore, "ERASURE_REPLAY_LEDGER_RESTORE_OCI_KEY_FINGERPRINT"),
    ):
        fail("The restore API-key fingerprint is invalid")
    os.environ.update(hosts)


def assert_image_admission(deploy_path: pathlib.Path, runtime_path: pathlib.Path) -> None:
    require_regular_file(IMAGE_ADMISSION, 0o750)
    if hashlib.sha256(IMAGE_ADMISSION.read_bytes()).hexdigest() != IMAGE_ADMISSION_SHA256:
        fail("Installed provider-neutral image admission helper differs from reviewed source")
    command(["python3", str(IMAGE_ADMISSION), "validate", str(deploy_path)], "image reference admission")
    command(
        ["python3", str(IMAGE_ADMISSION), "inspect", str(deploy_path), str(runtime_path)],
        "linux/arm64 image provenance and runtime contracts",
    )


def validator_container_ids(name: str) -> tuple[str, ...]:
    output = command(
        [
            "docker",
            "container",
            "ls",
            "--all",
            "--quiet",
            "--no-trunc",
            "--filter",
            f"name=^/{name}$",
        ],
        f"{name} validator container lookup",
        timeout_seconds=15,
    )
    candidates = tuple(line.strip() for line in output.splitlines() if line.strip())
    if len(candidates) > 1 or any(
        re.fullmatch(r"[0-9a-f]{64}", candidate) is None for candidate in candidates
    ):
        fail(f"Docker returned an ambiguous exact validator container for {name}")
    return candidates


def reconcile_validator_container(name: str, label_value: str) -> None:
    candidates = validator_container_ids(name)
    if not candidates:
        return
    reference = candidates[0]
    label = command(
        [
            "docker",
            "inspect",
            "--format",
            f'{{{{ index .Config.Labels "{VALIDATOR_LABEL_KEY}" }}}}',
            reference,
        ],
        f"{name} validator label",
        timeout_seconds=15,
    )
    if label != label_value:
        fail(f"Refusing to remove {name}: its exact validator label changed")
    command(
        ["docker", "rm", "--force", reference],
        f"{name} validator removal",
        timeout_seconds=20,
    )
    if validator_container_ids(name):
        fail(f"Could not prove exact validator container absence for {name}")


def reconcile_validator_absence(
    name: str, label_value: str, *, ambiguous_launch: bool
) -> None:
    reconcile_until = time.monotonic() + (
        VALIDATOR_RECONCILIATION_SECONDS if ambiguous_launch else 0
    )
    while True:
        reconcile_validator_container(name, label_value)
        if not ambiguous_launch or time.monotonic() >= reconcile_until:
            return
        time.sleep(0.5)


def run_caddy_validator(
    arguments: list[str],
    *,
    name: str,
    label_value: str,
    description: str,
    cancellation_scope: TerminationSignalScope,
) -> None:
    completed = False
    try:
        with cancellation_scope.cleanup_masked():
            reconcile_validator_absence(name, label_value, ambiguous_launch=False)
        command(arguments, description, timeout_seconds=30)
        completed = True
    finally:
        with cancellation_scope.cleanup_masked():
            reconcile_validator_absence(
                name, label_value, ambiguous_launch=not completed
            )


def assert_caddy_configs(
    deploy: dict[str, str], cancellation_scope: TerminationSignalScope
) -> None:
    for path in (PUBLIC_CADDYFILE, INTERNAL_CADDYFILE):
        require_regular_file(path, 0o644)

    base = [
        "docker",
        "run",
        "--rm",
        "--pull=never",
        "--network=none",
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges:true",
        "--user=1000:1000",
        "--tmpfs=/data:rw,noexec,nosuid,size=32m,uid=1000,gid=1000,mode=0700",
        "--tmpfs=/config:rw,noexec,nosuid,size=16m,uid=1000,gid=1000,mode=0700",
    ]
    image = required(deploy, "CADDY_IMAGE")
    validator_suffix = str(os.getpid())
    public_name = f"{VALIDATOR_NAME_PREFIX}-public-{validator_suffix}"
    internal_name = f"{VALIDATOR_NAME_PREFIX}-internal-{validator_suffix}"
    public_environment = [
        "--env",
        f"ACME_EMAIL={required(deploy, 'ACME_EMAIL')}",
        "--env",
        f"API_FQDN={required(deploy, 'API_FQDN')}",
        "--env",
        f"WEB_FQDN={required(deploy, 'WEB_FQDN')}",
        "--env",
        f"BETA_ALLOWED_CIDRS={required(deploy, 'BETA_ALLOWED_CIDRS')}",
    ]
    public_mount = f"type=bind,src={PUBLIC_CADDYFILE},dst=/etc/caddy/Caddyfile,readonly"
    run_caddy_validator(
        base
        + [
            "--name",
            public_name,
            "--label",
            f"{VALIDATOR_LABEL_KEY}=public",
        ]
        + public_environment
        + ["--mount", public_mount, image, "validate", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"],
        name=public_name,
        label_value="public",
        description="public Caddy configuration without network access",
        cancellation_scope=cancellation_scope,
    )

    internal_mount = f"type=bind,src={INTERNAL_CADDYFILE},dst=/etc/caddy/Caddyfile,readonly"
    pki_mount = "type=bind,src=/etc/nutrition-tracker/pki/meili,dst=/run/internal-pki/meili,readonly"
    run_caddy_validator(
        base
        + [
            "--name",
            internal_name,
            "--label",
            f"{VALIDATOR_LABEL_KEY}=internal",
            "--mount",
            internal_mount,
            "--mount",
            pki_mount,
            image,
            "validate",
            "--config",
            "/etc/caddy/Caddyfile",
            "--adapter",
            "caddyfile",
        ],
        name=internal_name,
        label_value="internal",
        description="internal Caddy configuration without network access",
        cancellation_scope=cancellation_scope,
    )


def reject_unimplemented_integrations(deploy: dict[str, str]) -> None:
    for key in (
        "AZURE_OCI_EGRESS_ADMISSION",
        "AZURE_OCI_CREDENTIAL_INSTALL_ADMISSION",
        "AZURE_OCI_USAGE_ADMISSION",
        "AZURE_OFF_HOST_BACKUP_ADMISSION",
    ):
        if deploy.get(key) != "BLOCKED_NOT_IMPLEMENTED":
            fail(f"{key} may not be operator-overridden before its reviewed implementation exists")
    fail(
        "BLOCKED: endpoint-only Object Storage egress, Azure-host OCI credential install/rotation, "
        "live OCI usage/headroom admission, and off-host backup/restore-drill admission are not implemented; "
        "no Compose service is admitted to start"
    )


def run_preflight(mode: str, cancellation_scope: TerminationSignalScope) -> None:
    assert_host()
    paths = {name: CONFIG_ROOT / f"{name}.env" for name in ENVIRONMENTS}
    for path in paths.values():
        require_regular_file(path, 0o600)
    require_regular_file(COMPOSE_FILE, 0o644)
    environments = {name: read_environment(path) for name, path in paths.items()}
    assert_environment_schemas(environments)
    assert_markers(mode, paths)
    assert_deployment(environments["deploy"])
    assert_runtime(environments)
    assert_secrets(environments)
    assert_storage()
    assert_pki()
    assert_object_storage(environments)
    assert_image_admission(paths["deploy"], paths["runtime"])
    assert_caddy_configs(environments["deploy"], cancellation_scope)
    command(
        [
            "docker",
            "compose",
            "--env-file",
            str(paths["deploy"]),
            "-f",
            str(COMPOSE_FILE),
            "--profile",
            "core",
            "--profile",
            "application",
            "--profile",
            "operations",
            "--profile",
            "edge",
            "config",
            "--quiet",
        ],
        "rendered Compose contract",
        timeout_seconds=30,
    )
    reject_unimplemented_integrations(environments["deploy"])


def main() -> None:
    mode = sys.argv[1] if len(sys.argv) == 2 else ""
    if mode not in {"early", "full"}:
        fail(f"Usage: {sys.argv[0]} early|full")
    with TerminationSignalScope() as cancellation_scope:
        run_preflight(mode, cancellation_scope)


if __name__ == "__main__":
    try:
        main()
    except PreflightCancellation as error:
        print(
            f"CANCELLED: deployment preflight received signal {error.signum}",
            file=sys.stderr,
        )
        raise SystemExit(128 + error.signum) from None
