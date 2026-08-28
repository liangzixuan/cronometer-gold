"""Normalize a protected Windows/WSL2 relay review package into an unsigned v3 candidate.

The module is deliberately non-collecting.  It reads reviewer-supplied files,
validates structural and continuity contracts, and emits redacted canonical
JSON.  It never invokes Tailscale, PowerShell, WSL, Docker, a browser, a probe,
or an administrative command.  The production adapter registry is empty until
an exact Windows Tailscale version and raw output corpus are independently
reviewed.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import ctypes
import hashlib
import json
import os
import re
import stat
import sys
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from types import MappingProxyType
from typing import Any, NoReturn

try:
    from infra.tailscale.phone_policy import build_phone_policy, parse_phone_policy_input
except ModuleNotFoundError:  # Direct ``python infra/tailscale/relay_evidence.py`` invocation.
    from phone_policy import build_phone_policy, parse_phone_policy_input  # type: ignore[no-redef]


REPORT_SCHEMA = "nutrition-tracker-physical-device-relay-report-v3"
REVIEW_PACKAGE_SCHEMA = "nutrition-tracker-tailscale-relay-review-package-v2"
SOURCE_CAPTURE_BUNDLE_SCHEMA = "nutrition-tracker-tailscale-relay-source-capture-bundle-v2"
UNSIGNED_TRUST_BOUNDARY = (
    "unsigned-structural-candidate-requires-independent-ed25519-manifest-review"
)
ORIGIN_COMMITMENT_DOMAIN = "nutrition-tracker-physical-device-api-origin-v1"
ORIGIN_COMMITMENT_VECTOR_ORIGIN = "https://relay.example.ts.net"
ORIGIN_COMMITMENT_VECTOR_SHA256 = (
    "324c46636c4c63c6dd63502c753892fcc8cdbce343fd0d760fa29417397ee19e"
)
READY_BODY = b'{"status":"ok"}'
READY_BODY_SHA256 = hashlib.sha256(READY_BODY).hexdigest()

MAX_INDEX_BYTES = 131_072
MAX_CAPTURE_BYTES = 4 * 1_048_576
MAX_RAW_SOURCE_BYTES = 3 * 1_048_576
MAX_SESSION_SECONDS = 24 * 60 * 60
MAX_MOUNTINFO_BYTES = 1_048_576
PHONE_ALIASES = ("nutrition-tracker-phone-1", "nutrition-tracker-phone-2")
RELAY_HOST_ALIAS = "nutrition-tracker-relay-host"
BASELINE_DENIED_TCP_PORTS = frozenset(
    {22, 80, 1025, 2181, 4000, 4566, 5432, 7700, 8025, 8080, 8081, 9000, 9001, 9092}
)

SHA256_HEX = re.compile(r"^[0-9a-f]{64}$")
GIT_COMMIT = re.compile(r"^[0-9a-f]{40}$")
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
ISO_INSTANT = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
SAFE_VERSION = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+()-]{0,63}$")
SAFE_ADAPTER_ID = re.compile(r"^[a-z0-9][a-z0-9._-]{2,63}$")
PRIVATE_ORIGIN = re.compile(
    r"^https://[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\."
    r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ts\.net$"
)
STANDARD_BASE64 = re.compile(r"^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$")
LINUX_NATIVE_FILESYSTEMS = frozenset({"btrfs", "ext2", "ext3", "ext4", "xfs"})
LINUX_NATIVE_FILESYSTEM_MAGIC = frozenset(
    {
        0xEF53,  # ext2/3/4
        0x9123683E,  # btrfs
        0x58465342,  # XFS
        0x2FC12FC1,  # ZFS
        0xF2F52010,  # f2fs
    }
)


# This matrix is the only source for the required role set and digest order.
# There is deliberately no independent capture-count constant.
PHASE_MATRIX = (
    ("session", "versions-and-boundary", ("sessionEnvironment", "hostBoundary")),
    ("preflight", "incoming-and-identity", ("preflightIncoming", "preflightIdentities")),
    ("preflight", "serve-and-funnel", ("preflightServe", "preflightFunnel")),
    (
        "preflight",
        "host-and-runtime",
        (
            "preflightWindowsListeners",
            "preflightWindowsFirewall",
            "preflightHyperVFirewall",
            "preflightForwarding",
            "preflightWslListeners",
            "preflightDockerPorts",
        ),
    ),
    (
        "policy",
        "proposal-and-application",
        ("policyProposal", "policy", "policyTests", "configurationEvent", "policyGate"),
    ),
    ("active", "current-policy", ("activePolicyState",)),
    ("active", "incoming-and-identity", ("activeIncoming", "activeIdentities")),
    ("active", "serve-and-funnel", ("activeServe", "activeFunnel")),
    (
        "active",
        "host-and-runtime",
        (
            "activeEnvironment",
            "activeWindowsListeners",
            "activeWindowsFirewall",
            "activeHyperVFirewall",
            "activeForwarding",
            "activeWslListeners",
            "activeDockerPorts",
        ),
    ),
    (
        "active",
        "reachability",
        ("iosProbe", "androidProbe", "unapprovedTailnetProbe", "lanProbe"),
    ),
    (
        "restart",
        "pre-shutdown-safety",
        (
            "restartPreShutdownIncoming",
            "restartPreShutdownServe",
            "restartPreShutdownFunnel",
            "coldRestartEvent",
        ),
    ),
    (
        "restart",
        "post-restart-pre-exposure",
        (
            "restartPreExposureIncoming",
            "restartPreExposureServe",
            "restartPreExposureFunnel",
            "restartPreExposureIdentities",
        ),
    ),
    (
        "restart",
        "host-and-runtime",
        (
            "restartEnvironment",
            "restartWindowsListeners",
            "restartWindowsFirewall",
            "restartHyperVFirewall",
            "restartForwarding",
            "restartWslListeners",
            "restartDockerPorts",
        ),
    ),
    ("restart", "local-readiness", ("restartWslReadyProbe", "restartWindowsReadyProbe")),
    (
        "restart",
        "re-enabled-relay",
        (
            "restartPolicyState",
            "restartActiveIncoming",
            "restartActiveServe",
            "restartActiveFunnel",
            "restartActiveIdentities",
        ),
    ),
    (
        "restart",
        "reachability",
        (
            "restartIosProbe",
            "restartAndroidProbe",
            "restartUnapprovedTailnetProbe",
            "restartLanProbe",
        ),
    ),
    (
        "teardown",
        "tailscale",
        ("teardownIncoming", "teardownServe", "teardownFunnel"),
    ),
    (
        "teardown",
        "restoration",
        (
            "teardownEnvironment",
            "teardownWindowsListeners",
            "teardownWindowsFirewall",
            "teardownHyperVFirewall",
            "teardownForwarding",
            "teardownWslListeners",
            "teardownDockerPorts",
        ),
    ),
    ("teardown", "current-policy", ("teardownPolicyState",)),
    ("teardown", "disconnect", ("teardownDisconnect",)),
    ("completion", "immutable-binding", ("sessionLedger",)),
)
CAPTURE_NAMES = tuple(role for _phase, _boundary, roles in PHASE_MATRIX for role in roles)
if len(CAPTURE_NAMES) != len(set(CAPTURE_NAMES)) or CAPTURE_NAMES[-1] != "sessionLedger":
    raise RuntimeError("The relay phase matrix must contain unique roles with sessionLedger last.")

ENVIRONMENT_ROLES = frozenset(
    {"sessionEnvironment", "activeEnvironment", "restartEnvironment", "teardownEnvironment"}
)
INCOMING_STATES = {
    "preflightIncoming": "disabled",
    "activeIncoming": "enabled",
    "restartPreShutdownIncoming": "disabled",
    "restartPreExposureIncoming": "disabled",
    "restartActiveIncoming": "enabled",
    "teardownIncoming": "disabled",
}
SERVE_STATES = {
    "preflightServe": "disabled",
    "activeServe": "attended-foreground",
    "restartPreShutdownServe": "disabled",
    "restartPreExposureServe": "disabled",
    "restartActiveServe": "attended-foreground",
    "teardownServe": "disabled",
}
FUNNEL_ROLES = frozenset(
    {
        "preflightFunnel",
        "activeFunnel",
        "restartPreShutdownFunnel",
        "restartPreExposureFunnel",
        "restartActiveFunnel",
        "teardownFunnel",
    }
)
POLICY_STATE_ROLES = (
    "activePolicyState", "restartPolicyState", "teardownPolicyState",
)
IDENTITY_ROLES = frozenset(
    {"preflightIdentities", "activeIdentities", "restartPreExposureIdentities", "restartActiveIdentities", "teardownDisconnect"}
)
LISTENER_BOUNDARY_ROLES = frozenset(
    role
    for role in CAPTURE_NAMES
    if role.endswith(("WindowsListeners", "WslListeners", "DockerPorts"))
)
STATE_BOUNDARY_ROLES = frozenset(
    role
    for role in CAPTURE_NAMES
    if role.endswith(("WindowsFirewall", "HyperVFirewall", "Forwarding"))
)
APPROVED_PROBE_ROLES = {
    "iosProbe": ("ios", PHONE_ALIASES[0]),
    "androidProbe": ("android", PHONE_ALIASES[1]),
    "restartIosProbe": ("ios", PHONE_ALIASES[0]),
    "restartAndroidProbe": ("android", PHONE_ALIASES[1]),
}
UNAPPROVED_PROBE_ROLES = frozenset({"unapprovedTailnetProbe", "restartUnapprovedTailnetProbe"})
LAN_PROBE_ROLES = frozenset({"lanProbe", "restartLanProbe"})
READINESS_ROLES = frozenset({"restartWslReadyProbe", "restartWindowsReadyProbe"})
ADAPTER_ROLES = frozenset(
    ENVIRONMENT_ROLES | set(INCOMING_STATES) | set(SERVE_STATES) | FUNNEL_ROLES
    | set(POLICY_STATE_ROLES) | IDENTITY_ROLES
)
BOUNDARY_SUFFIXES = (
    "WindowsListeners",
    "WindowsFirewall",
    "HyperVFirewall",
    "Forwarding",
    "WslListeners",
    "DockerPorts",
)
COLD_POST_RESTART_ROLES = (
    "restartPreExposureIncoming",
    "restartPreExposureServe",
    "restartPreExposureFunnel",
    "restartPreExposureIdentities",
    "restartEnvironment",
    "restartWindowsListeners",
    "restartWindowsFirewall",
    "restartHyperVFirewall",
    "restartForwarding",
    "restartWslListeners",
    "restartDockerPorts",
    "restartWslReadyProbe",
    "restartWindowsReadyProbe",
    "restartActiveIncoming",
    "restartPolicyState",
    "restartActiveServe",
    "restartActiveFunnel",
    "restartActiveIdentities",
    "restartIosProbe",
    "restartAndroidProbe",
    "restartUnapprovedTailnetProbe",
    "restartLanProbe",
)

ENVIRONMENT_FIELDS = (
    "adapterId",
    "windowsVersion",
    "wslVersion",
    "ubuntuVersion",
    "dockerDesktopVersion",
    "dockerEngineVersion",
    "tailscaleClientVersion",
    "tailscaleDaemonVersion",
    "clientHelpSha256",
    "daemonHelpSha256",
    "rawStatusSha256",
    "linuxContainers",
    "dockerDesktopWslIntegration",
    "dockerUnixSocket",
    "tailscaleInWsl",
    "secondDockerEngineInWsl",
    "sourceHead",
    "sourceTreeClean",
    "apiProcessSha256",
    "apiCwdSha256",
    "hostBoundarySha256",
)
HOST_BOUNDARY_FIELDS = (
    "relayNode",
    "applicationNode",
    "containerProvider",
    "tailscalePlacement",
    "apiBind",
    "serveUpstream",
    "wslNetworkingMode",
)
IDENTITY_FIELDS = (
    "adapterId",
    "relayHostIdentitySha256",
    "iosIdentitySha256",
    "androidIdentitySha256",
    "relayHostConnected",
    "phonesConnected",
    "hostBoundarySha256",
)
APPROVED_PROBE_FIELDS = (
    "platform",
    "testedEasBuildId",
    "phoneAlias",
    "observedAt",
    "apiOrigin",
    "publicCaAndHostname",
    "readyHttpStatus",
    "readyBodySha256",
    "openTcpPorts",
    "blockedTcpPorts",
    "directWindowsWslDockerTargets",
    "tailscaleDisabledHttps",
    "policyGateSha256",
    "relayHostIdentitySha256",
    "phoneIdentitySha256",
    "hostBoundarySha256",
)


class RelayEvidenceError(RuntimeError):
    """A protected capture or continuity check failed closed."""


class _StatFs(ctypes.Structure):
    _fields_ = [
        ("f_type", ctypes.c_long),
        ("f_bsize", ctypes.c_long),
        ("f_blocks", ctypes.c_ulong),
        ("f_bfree", ctypes.c_ulong),
        ("f_bavail", ctypes.c_ulong),
        ("f_files", ctypes.c_ulong),
        ("f_ffree", ctypes.c_ulong),
        ("f_fsid", ctypes.c_int * 2),
        ("f_namelen", ctypes.c_long),
        ("f_frsize", ctypes.c_long),
        ("f_flags", ctypes.c_long),
        ("f_spare", ctypes.c_long * 4),
    ]


def _fail(message: str) -> NoReturn:
    raise RelayEvidenceError(message)


def _exact_keys(value: Any, expected: Sequence[str], name: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != set(expected):
        _fail(f"{name} does not have the exact reviewed fields.")
    return value


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            _fail("A JSON input contains a duplicate key.")
        result[key] = value
    return result


def _reject_non_integer_number(_value: str) -> NoReturn:
    _fail("JSON input numbers must be strict finite integers.")


def _json(raw: bytes, name: str) -> dict[str, Any]:
    try:
        value = json.loads(
            raw.decode("utf-8", errors="strict"),
            object_pairs_hook=_reject_duplicate_keys,
            parse_float=_reject_non_integer_number,
            parse_constant=_reject_non_integer_number,
        )
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RelayEvidenceError(f"{name} is not strict UTF-8 JSON.") from error
    if not isinstance(value, dict):
        _fail(f"{name} must be a JSON object.")
    return value


def _canonical(value: Any) -> bytes:
    return (
        json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"), sort_keys=True)
        + "\n"
    ).encode("utf-8")


def _canonical_json(raw: bytes, name: str) -> dict[str, Any]:
    value = _json(raw, name)
    if raw != _canonical(value):
        _fail(f"{name} must use exact canonical JSON with one final newline.")
    return value


def _sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _assert_sha(value: Any, name: str) -> str:
    if not isinstance(value, str) or not SHA256_HEX.fullmatch(value):
        _fail(f"{name} must be one lowercase SHA-256 digest.")
    return value


def _instant(value: Any, name: str) -> datetime:
    if not isinstance(value, str) or not ISO_INSTANT.fullmatch(value):
        _fail(f"{name} must be a canonical UTC instant with milliseconds.")
    try:
        parsed = datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc)
    except ValueError as error:
        raise RelayEvidenceError(f"{name} is not a real instant.") from error
    if parsed.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z" != value:
        _fail(f"{name} is not canonical.")
    return parsed


def api_origin_commitment_sha256(origin: str) -> str:
    if not isinstance(origin, str) or not PRIVATE_ORIGIN.fullmatch(origin):
        _fail("apiOrigin is not the exact canonical private .ts.net HTTPS origin.")
    if any(token in origin for token in ("localstack", "meilisearch", "postgres", "postgresql")):
        _fail("apiOrigin identifies a forbidden dependency rather than the API relay.")
    return _sha(f"{ORIGIN_COMMITMENT_DOMAIN}\n{origin}\n".encode("utf-8"))


if api_origin_commitment_sha256(ORIGIN_COMMITMENT_VECTOR_ORIGIN) != ORIGIN_COMMITMENT_VECTOR_SHA256:
    raise RuntimeError("The physical-device API origin commitment vector changed.")


def _role_schema(role: str) -> str:
    kebab = re.sub(r"(?<!^)(?=[A-Z])", "-", role).lower()
    return f"nutrition-tracker-tailscale-{kebab}-capture-v2"


@dataclass(frozen=True)
class CaptureRecord:
    role: str
    raw: bytes
    identity: tuple[int, int]
    captured_at: datetime
    source: bytes
    observation: dict[str, Any]
    schema_version: str

    @property
    def sha256(self) -> str:
        return _sha(self.raw)


@dataclass(frozen=True)
class VersionAdapter:
    adapter_id: str
    tailscale_client_version: str
    tailscale_daemon_version: str
    validated_roles: frozenset[str]
    validate: Callable[[str, bytes, Mapping[str, Any]], None]


# Deliberately empty. Tests inject a synthetic adapter through the function API;
# command-line normalization cannot select it.
PRODUCTION_VERSION_ADAPTERS: Mapping[str, VersionAdapter] = MappingProxyType({})


def _decode_mount_field(value: str) -> str:
    return re.sub(
        r"\\([0-7]{3})",
        lambda match: chr(int(match.group(1), 8)),
        value,
    )


def _native_linux_filesystem(path: Path) -> None:
    if sys.platform != "linux":
        _fail("Protected relay review packages require a native Linux filesystem.")
    try:
        device = path.stat().st_dev
        with open("/proc/self/mountinfo", "rb", buffering=0) as mount_file:
            raw = mount_file.read(MAX_MOUNTINFO_BYTES + 1)
    except OSError as error:
        raise RelayEvidenceError("The review filesystem type cannot be established.") from error
    if not raw or len(raw) > MAX_MOUNTINFO_BYTES:
        _fail("The bounded Linux mount inventory is unavailable.")
    try:
        text = raw.decode("utf-8", errors="strict")
    except UnicodeDecodeError as error:
        raise RelayEvidenceError("The Linux mount inventory is not UTF-8.") from error
    expected_device = f"{os.major(device)}:{os.minor(device)}"
    candidates: list[tuple[int, str]] = []
    for line in text.splitlines():
        if " - " not in line:
            _fail("The Linux mount inventory has an unsupported shape.")
        left, right = line.split(" - ", 1)
        left_fields = left.split()
        right_fields = right.split()
        if len(left_fields) < 6 or len(right_fields) < 3:
            _fail("The Linux mount inventory has an unsupported shape.")
        if left_fields[2] != expected_device:
            continue
        mount_point = Path(_decode_mount_field(left_fields[4]))
        try:
            path.relative_to(mount_point)
        except ValueError:
            continue
        candidates.append((len(mount_point.parts), right_fields[0]))
    if not candidates:
        _fail("The review filesystem mount cannot be identified.")
    filesystem = max(candidates)[1]
    if filesystem not in LINUX_NATIVE_FILESYSTEMS:
        _fail("The review directory is not on an approved native Linux filesystem.")


def _filesystem_magic(descriptor: int) -> int:
    try:
        libc = ctypes.CDLL(None, use_errno=True)
        fstatfs = libc.fstatfs
        fstatfs.argtypes = (ctypes.c_int, ctypes.POINTER(_StatFs))
        fstatfs.restype = ctypes.c_int
        result = _StatFs()
        if fstatfs(descriptor, ctypes.byref(result)) != 0:
            raise OSError(ctypes.get_errno(), "fstatfs failed")
        return int(result.f_type) & 0xFFFFFFFF
    except (AttributeError, OSError, TypeError, ValueError) as error:
        raise RelayEvidenceError(
            "The opened review filesystem type cannot be established safely."
        ) from error


def _contains_git_metadata(path: Path) -> bool:
    for ancestor in (path, *path.parents):
        try:
            (ancestor / ".git").lstat()
            return True
        except FileNotFoundError:
            pass
        except OSError:
            return True
    return False


def _checked_review_directory(index_path_value: str) -> tuple[Path, str, os.stat_result]:
    if not isinstance(index_path_value, str):
        _fail("The capture index path is absent.")
    try:
        encoded = os.fsencode(index_path_value)
    except UnicodeEncodeError as error:
        raise RelayEvidenceError("The capture index path encoding is invalid.") from error
    if not encoded or b"\x00" in encoded or len(encoded) > 4096:
        _fail("The capture index path violates the bounded path contract.")
    index_path = Path(index_path_value)
    if not index_path.is_absolute() or os.path.normpath(index_path_value) != index_path_value:
        _fail("The capture index path must be absolute and normalized.")
    review_directory = index_path.parent
    if review_directory == Path("/mnt") or Path("/mnt") in review_directory.parents:
        _fail("The review directory must not be below /mnt or a Windows-mounted tree.")
    if any("onedrive" in part.casefold() for part in review_directory.parts):
        _fail("The review directory must be outside OneDrive and synced paths.")
    try:
        directory_lstat = review_directory.lstat()
        if review_directory.resolve(strict=True) != review_directory:
            _fail("The review directory and its ancestors must not use symbolic links.")
    except (OSError, ValueError) as error:
        raise RelayEvidenceError("The review directory cannot be inspected safely.") from error
    if (
        stat.S_ISLNK(directory_lstat.st_mode)
        or not stat.S_ISDIR(directory_lstat.st_mode)
        or stat.S_IMODE(directory_lstat.st_mode) != 0o700
        or directory_lstat.st_uid != os.getuid()
    ):
        _fail("The review directory must be current-user-owned mode 0700.")
    if _contains_git_metadata(review_directory):
        _fail("The review directory must be outside every Git worktree.")
    _native_linux_filesystem(review_directory)
    return review_directory, index_path.name, directory_lstat


def _directory_identity(value: os.stat_result) -> tuple[int, int, int, int, int, int, int, int]:
    return (
        value.st_dev,
        value.st_ino,
        value.st_mode,
        value.st_uid,
        value.st_nlink,
        value.st_size,
        value.st_mtime_ns,
        value.st_ctime_ns,
    )


def _open_review_directory(
    path: Path,
    expected: os.stat_result,
) -> tuple[int, tuple[int, int, int, int, int, int, int, int], int]:
    no_follow = getattr(os, "O_NOFOLLOW", None)
    directory_flag = getattr(os, "O_DIRECTORY", None)
    if not isinstance(no_follow, int) or not isinstance(directory_flag, int):
        _fail("This platform cannot enforce no-follow review-directory reads.")
    try:
        descriptor = os.open(
            path,
            os.O_RDONLY | no_follow | directory_flag | getattr(os, "O_CLOEXEC", 0),
        )
        inspected = os.fstat(descriptor)
        path_after = os.lstat(path)
    except OSError as error:
        raise RelayEvidenceError("The protected review directory cannot be opened safely.") from error
    if (
        not stat.S_ISDIR(inspected.st_mode)
        or stat.S_IMODE(inspected.st_mode) != 0o700
        or inspected.st_uid != os.getuid()
        or _directory_identity(inspected) != _directory_identity(expected)
        or _directory_identity(path_after) != _directory_identity(expected)
    ):
        os.close(descriptor)
        _fail("The opened review directory changed or violated its owner/mode boundary.")
    filesystem_magic = _filesystem_magic(descriptor)
    if filesystem_magic not in LINUX_NATIVE_FILESYSTEM_MAGIC:
        os.close(descriptor)
        _fail("The opened review directory is not on an approved persistent Linux filesystem.")
    return descriptor, _directory_identity(inspected), filesystem_magic


def _file_state(value: os.stat_result) -> tuple[int, int, int, int, int, int, int, int]:
    return (
        value.st_dev,
        value.st_ino,
        value.st_mode,
        value.st_uid,
        value.st_nlink,
        value.st_size,
        value.st_mtime_ns,
        value.st_ctime_ns,
    )


def _secure_read_at(
    directory_descriptor: int,
    directory_device: int,
    filesystem_magic: int,
    name: str,
    label: str,
    maximum: int,
) -> tuple[bytes, tuple[int, int], tuple[int, int, int, int, int, int, int, int]]:
    if (
        not isinstance(name, str)
        or not name
        or name in {".", ".."}
        or "/" in name
        or "\x00" in name
        or len(os.fsencode(name)) > 255
    ):
        _fail(f"{label} must be a direct bounded child of the review directory.")
    no_follow = getattr(os, "O_NOFOLLOW", None)
    if not isinstance(no_follow, int):
        _fail("This platform cannot enforce no-follow capture reads.")
    try:
        before = os.stat(name, dir_fd=directory_descriptor, follow_symlinks=False)
        descriptor = os.open(
            name,
            os.O_RDONLY
            | no_follow
            | getattr(os, "O_CLOEXEC", 0)
            | getattr(os, "O_NONBLOCK", 0),
            dir_fd=directory_descriptor,
        )
        try:
            opened = os.fstat(descriptor)
            if (
                not stat.S_ISREG(opened.st_mode)
                or stat.S_IMODE(opened.st_mode) != 0o600
                or opened.st_uid != os.getuid()
                or opened.st_nlink != 1
                or opened.st_size < 1
                or opened.st_size > maximum
                or opened.st_dev != directory_device
                or (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino)
                or _file_state(opened) != _file_state(before)
            ):
                _fail(f"{label} must be one stable current-user mode-0600 regular file with nlink 1.")
            if _filesystem_magic(descriptor) != filesystem_magic:
                _fail(f"{label} must share the review directory's persistent Linux filesystem.")
            chunks: list[bytes] = []
            remaining = opened.st_size
            while remaining:
                chunk = os.read(descriptor, min(65_536, remaining))
                if not chunk:
                    _fail(f"{label} ended unexpectedly while being read.")
                chunks.append(chunk)
                remaining -= len(chunk)
            if os.read(descriptor, 1):
                _fail(f"{label} grew while being read.")
            after = os.fstat(descriptor)
            entry_after = os.stat(name, dir_fd=directory_descriptor, follow_symlinks=False)
            if (
                _file_state(opened) != _file_state(after)
                or _file_state(opened) != _file_state(entry_after)
            ):
                _fail(f"{label} changed while being read.")
            return b"".join(chunks), (opened.st_dev, opened.st_ino), _file_state(opened)
        finally:
            os.close(descriptor)
    except RelayEvidenceError:
        raise
    except (OSError, ValueError) as error:
        raise RelayEvidenceError(f"{label} could not be read safely.") from error



def _assert_stable_entry_at(
    directory_descriptor: int,
    name: str,
    expected_state: tuple[int, int, int, int, int, int, int, int],
    label: str,
) -> None:
    try:
        current = os.stat(name, dir_fd=directory_descriptor, follow_symlinks=False)
    except (OSError, ValueError) as error:
        raise RelayEvidenceError(f"{label} cannot be re-inspected safely.") from error
    if _file_state(current) != expected_state:
        _fail(f"{label} changed after its protected read.")

def _capture_filename(path_value: Any, review_directory: Path, role: str) -> str:
    if not isinstance(path_value, str):
        _fail(f"{role} capture path is absent.")
    try:
        path = Path(path_value)
        if (
            not path.is_absolute()
            or os.path.normpath(path_value) != path_value
            or path.parent != review_directory
            or path.name in {"", ".", ".."}
        ):
            _fail(f"{role} capture must be a normalized absolute direct child of the review directory.")
    except (OSError, ValueError) as error:
        raise RelayEvidenceError(f"{role} capture path is invalid.") from error
    return path.name


def _decode_raw_source(value: dict[str, Any], role: str) -> bytes:
    encoded = value["rawSourceBase64"]
    if (
        not isinstance(encoded, str)
        or not encoded
        or len(encoded) > ((MAX_RAW_SOURCE_BYTES + 2) // 3) * 4
        or not STANDARD_BASE64.fullmatch(encoded)
    ):
        _fail(f"{role}.rawSourceBase64 must be bounded canonical padded base64.")
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as error:
        raise RelayEvidenceError(f"{role}.rawSourceBase64 is invalid.") from error
    if not raw or len(raw) > MAX_RAW_SOURCE_BYTES or base64.b64encode(raw).decode("ascii") != encoded:
        _fail(f"{role}.rawSourceBase64 is empty, noncanonical, or oversized.")
    if _sha(raw) != _assert_sha(value["rawSourceSha256"], f"{role}.rawSourceSha256"):
        _fail(f"{role}.rawSourceSha256 does not bind the exact source bytes.")
    return raw


def _observation_fields(role: str) -> tuple[str, ...]:
    if role in ENVIRONMENT_ROLES:
        return ENVIRONMENT_FIELDS
    if role == "hostBoundary":
        return HOST_BOUNDARY_FIELDS
    if role in INCOMING_STATES:
        return ("adapterId", "state", "hostBoundarySha256")
    if role in IDENTITY_ROLES:
        return IDENTITY_FIELDS
    if role in SERVE_STATES:
        return (
            "adapterId", "state", "mode", "httpsPort", "handlerPath", "upstream",
            "persistentConfiguration", "hostBoundarySha256",
        )
    if role in FUNNEL_ROLES:
        return (
            "adapterId", "state", "allowFunnel", "publicHandlers", "services",
            "persistentConfiguration", "hostBoundarySha256",
        )
    if role in POLICY_STATE_ROLES:
        return (
            "adapterId", "policyRevisionSha256", "policy", "appliedCaptureSha256",
            "configurationEventCaptureSha256", "hostBoundarySha256",
        )
    if role in LISTENER_BOUNDARY_ROLES:
        return (
            "canonicalStateSha256", "safe", "bindings", "inventoriedNon443TcpPorts",
            "hostBoundarySha256",
        )
    if role in STATE_BOUNDARY_ROLES:
        return ("canonicalStateSha256", "safe", "hostBoundarySha256")
    if role == "policyProposal":
        return ("policyInput", "policy", "hostBoundarySha256")
    if role == "policy":
        return ("policy", "proposalCaptureSha256", "hostBoundarySha256")
    if role == "policyTests":
        return (
            "result", "positiveTestsPassed", "negativeTestsPassed", "unapprovedTailnetBlocked",
            "proposalCaptureSha256", "appliedCaptureSha256", "hostBoundarySha256",
        )
    if role == "configurationEvent":
        return (
            "eventType", "outcome", "eventIdSha256", "policyRevisionSha256",
            "appliedCaptureSha256", "hostBoundarySha256",
        )
    if role == "policyGate":
        return (
            "result", "proposalCaptureSha256", "appliedCaptureSha256", "testsCaptureSha256",
            "configurationEventCaptureSha256", "currentPolicyCaptureSha256",
            "identitiesCaptureSha256", "hostBoundarySha256",
        )
    if role in APPROVED_PROBE_ROLES:
        return APPROVED_PROBE_FIELDS
    if role in UNAPPROVED_PROBE_ROLES:
        return (
            "observedAt", "peerClassSha256", "httpsPort", "blockedTcpPorts",
            "policyGateSha256", "hostBoundarySha256",
        )
    if role in LAN_PROBE_ROLES:
        return (
            "observedAt", "peerClassSha256", "httpsPort", "blockedTcpPorts",
            "windowsWslDockerTargets", "ipv4AndIpv6Paths", "policyGateSha256",
            "hostBoundarySha256",
        )
    if role in READINESS_ROLES:
        return (
            "observedAt", "httpStatus", "bodySha256", "sourceHead", "apiProcessSha256",
            "apiCwdSha256", "hostBoundarySha256",
        )
    if role == "coldRestartEvent":
        return (
            "preShutdown", "postRestart", "shutdownOrder", "restartOrder",
            "dockerBoundaryRestored", "migrationsCurrent", "sourceHead", "sourceTreeClean",
            "apiProcessSha256", "apiCwdSha256", "result", "hostBoundarySha256",
        )
    if role == "sessionLedger":
        return ("entries",)
    raise RuntimeError(f"No observation schema was declared for {role}.")


def _parse_capture(role: str, raw: bytes, identity: tuple[int, int], session_id: str) -> CaptureRecord:
    envelope = _exact_keys(
        _canonical_json(raw, f"{role} capture"),
        ("schemaVersion", "sessionId", "capturedAt", "rawSourceSha256", "rawSourceBase64", "observation"),
        f"{role} capture",
    )
    expected_schema = _role_schema(role)
    if envelope["schemaVersion"] != expected_schema:
        _fail(f"{role} capture schema is not the exact v2 role schema.")
    if envelope["sessionId"] != session_id:
        _fail(f"{role} capture belongs to a different session.")
    captured_at = _instant(envelope["capturedAt"], f"{role}.capturedAt")
    observation = _exact_keys(envelope["observation"], _observation_fields(role), f"{role}.observation")
    return CaptureRecord(
        role=role,
        raw=raw,
        identity=identity,
        captured_at=captured_at,
        source=_decode_raw_source(envelope, role),
        observation=observation,
        schema_version=expected_schema,
    )


def _assert_versions_and_environment(
    records: Mapping[str, CaptureRecord],
    host_boundary_sha256: str,
    adapters: Mapping[str, VersionAdapter],
) -> VersionAdapter:
    session = records["sessionEnvironment"].observation
    adapter_id = session["adapterId"]
    if not isinstance(adapter_id, str) or not SAFE_ADAPTER_ID.fullmatch(adapter_id):
        _fail("sessionEnvironment.adapterId is not a bounded adapter identifier.")
    for field in (
        "windowsVersion",
        "wslVersion",
        "ubuntuVersion",
        "dockerDesktopVersion",
        "dockerEngineVersion",
        "tailscaleClientVersion",
        "tailscaleDaemonVersion",
    ):
        if not isinstance(session[field], str) or not SAFE_VERSION.fullmatch(session[field]):
            _fail(f"sessionEnvironment.{field} is not an exact bounded version.")
    for field in (
        "clientHelpSha256",
        "daemonHelpSha256",
        "rawStatusSha256",
        "apiProcessSha256",
        "apiCwdSha256",
    ):
        _assert_sha(session[field], f"sessionEnvironment.{field}")
    if not isinstance(session["sourceHead"], str) or not GIT_COMMIT.fullmatch(session["sourceHead"]):
        _fail("sessionEnvironment.sourceHead must be a full clean Git commit.")
    required = {
        "linuxContainers": True,
        "dockerDesktopWslIntegration": True,
        "dockerUnixSocket": "local",
        "tailscaleInWsl": False,
        "secondDockerEngineInWsl": False,
        "sourceTreeClean": True,
        "hostBoundarySha256": host_boundary_sha256,
    }
    for field, expected in required.items():
        if session[field] != expected:
            _fail(f"sessionEnvironment.{field} does not prove the required Windows/WSL boundary.")

    adapter = adapters.get(adapter_id)
    if adapter is None:
        _fail("The exact Windows Tailscale version/output adapter is not supported.")
    if (
        adapter.adapter_id != adapter_id
        or adapter.tailscale_client_version != session["tailscaleClientVersion"]
        or adapter.tailscale_daemon_version != session["tailscaleDaemonVersion"]
    ):
        _fail("The selected Tailscale adapter does not bind the captured client and daemon versions.")
    if adapter.validated_roles != frozenset(CAPTURE_NAMES):
        _fail(
            "The selected review-package adapter does not explicitly cover every protected role."
        )

    stable_fields = (
        "adapterId",
        "windowsVersion",
        "wslVersion",
        "ubuntuVersion",
        "dockerDesktopVersion",
        "dockerEngineVersion",
        "tailscaleClientVersion",
        "tailscaleDaemonVersion",
        "clientHelpSha256",
        "daemonHelpSha256",
        "linuxContainers",
        "dockerDesktopWslIntegration",
        "dockerUnixSocket",
        "tailscaleInWsl",
        "secondDockerEngineInWsl",
        "sourceHead",
        "sourceTreeClean",
        "apiProcessSha256",
        "apiCwdSha256",
        "hostBoundarySha256",
    )
    for role in ENVIRONMENT_ROLES:
        observation = records[role].observation
        for field in stable_fields:
            if observation[field] != session[field]:
                _fail(f"{role}.{field} drifted from the continuous Windows/WSL session.")
        _assert_sha(observation["rawStatusSha256"], f"{role}.rawStatusSha256")
    return adapter


def _assert_host_boundary(record: CaptureRecord) -> dict[str, Any]:
    boundary = record.observation
    required = {
        "relayNode": "windows-host",
        "applicationNode": "wsl2-ubuntu",
        "containerProvider": "docker-desktop-wsl-integration",
        "tailscalePlacement": "windows-host-only",
        "apiBind": "127.0.0.1:4000",
        "serveUpstream": "http://127.0.0.1:4000",
    }
    for field, expected in required.items():
        if boundary[field] != expected:
            _fail(f"hostBoundary.{field} does not match the sole reviewed topology.")
    if boundary["wslNetworkingMode"] not in {"nat", "mirrored"}:
        _fail("hostBoundary.wslNetworkingMode must be the reviewed nat or mirrored mode.")
    return boundary


def _assert_adapter_observations(
    records: Mapping[str, CaptureRecord], adapter: VersionAdapter, host_boundary_sha256: str
) -> None:
    for role in CAPTURE_NAMES:
        record = records[role]
        if role in ADAPTER_ROLES:
            if record.observation["adapterId"] != adapter.adapter_id:
                _fail(f"{role} selected a different Tailscale adapter.")
            if record.observation["hostBoundarySha256"] != host_boundary_sha256:
                _fail(f"{role} does not bind the sole hostBoundary capture.")
        adapter_failed = False
        try:
            adapter.validate(role, record.source, record.observation)
        except Exception:
            adapter_failed = True
        if adapter_failed:
            _fail(f"{role} raw output failed its exact version adapter.")

    for role, expected_state in INCOMING_STATES.items():
        if records[role].observation["state"] != expected_state:
            _fail(f"{role} does not prove the required incoming-access state.")
    for role, expected_state in SERVE_STATES.items():
        observation = records[role].observation
        expected = (
            {
                "state": "attended-foreground",
                "mode": "attended-foreground",
                "httpsPort": 443,
                "handlerPath": "/",
                "upstream": "http://127.0.0.1:4000",
                "persistentConfiguration": "empty",
            }
            if expected_state == "attended-foreground"
            else {
                "state": "disabled",
                "mode": "none",
                "httpsPort": None,
                "handlerPath": None,
                "upstream": None,
                "persistentConfiguration": "empty",
            }
        )
        for field, expected in expected.items():
            if observation[field] != expected:
                _fail(f"{role}.{field} does not prove the reviewed attended Serve state.")
    for role in FUNNEL_ROLES:
        observation = records[role].observation
        if (
            observation["state"] != "disabled"
            or observation["allowFunnel"] is not False
            or observation["publicHandlers"] != []
            or observation["services"] != []
            or observation["persistentConfiguration"] != "empty"
        ):
            _fail(f"{role} does not prove semantically disabled Funnel state.")

    baseline = records["preflightIdentities"].observation
    for field in ("relayHostIdentitySha256", "iosIdentitySha256", "androidIdentitySha256"):
        _assert_sha(baseline[field], f"preflightIdentities.{field}")
    if len(
        {
            baseline["relayHostIdentitySha256"],
            baseline["iosIdentitySha256"],
            baseline["androidIdentitySha256"],
        }
    ) != 3:
        _fail("The relay host and two approved phones must have distinct reviewed identities.")
    if baseline["relayHostConnected"] is not True or baseline["phonesConnected"] is not True:
        _fail("Preflight identities do not prove the connected reviewed devices.")
    for role in ("activeIdentities", "restartPreExposureIdentities", "restartActiveIdentities"):
        observation = records[role].observation
        for field in ("relayHostIdentitySha256", "iosIdentitySha256", "androidIdentitySha256"):
            if observation[field] != baseline[field]:
                _fail(f"{role}.{field} drifted from the continuous session.")
        if observation["relayHostConnected"] is not True or observation["phonesConnected"] is not True:
            _fail(f"{role} does not prove connected reviewed identities.")
    teardown = records["teardownDisconnect"].observation
    for field in ("relayHostIdentitySha256", "iosIdentitySha256", "androidIdentitySha256"):
        if teardown[field] != baseline[field]:
            _fail("Teardown identity continuity changed before disconnect.")
    if teardown["relayHostConnected"] is not False or teardown["phonesConnected"] is not True:
        _fail("Teardown does not prove the Windows relay host disconnected last.")


def _sorted_ports(value: Any, name: str, *, require_baseline: bool) -> list[int]:
    if not isinstance(value, list) or len(value) > 1_024:
        _fail(f"{name} must be a bounded sorted TCP-port array.")
    previous = 0
    for port in value:
        if isinstance(port, bool) or not isinstance(port, int) or port <= previous or port > 65_535 or port == 443:
            _fail(f"{name} must contain unique ascending non-443 TCP ports.")
        previous = port
    if require_baseline and not BASELINE_DENIED_TCP_PORTS.issubset(value):
        _fail(f"{name} omits a required denied TCP port.")
    return value


def _assert_boundaries(
    records: Mapping[str, CaptureRecord], host_boundary_sha256: str
) -> list[int]:
    for role in LISTENER_BOUNDARY_ROLES | STATE_BOUNDARY_ROLES:
        observation = records[role].observation
        _assert_sha(observation["canonicalStateSha256"], f"{role}.canonicalStateSha256")
        if observation["safe"] != "passed" or observation["hostBoundarySha256"] != host_boundary_sha256:
            _fail(f"{role} does not prove the reviewed safe host boundary.")
        if role in LISTENER_BOUNDARY_ROLES:
            bindings = observation["bindings"]
            if not isinstance(bindings, list) or not bindings or len(bindings) > 1_024:
                _fail(f"{role}.bindings must be a bounded nonempty listener array.")
            endpoints: list[tuple[str, int]] = []
            for binding in bindings:
                exact = _exact_keys(binding, ("host", "port"), f"{role}.binding")
                host, port = exact["host"], exact["port"]
                if (
                    host != "127.0.0.1"
                    or isinstance(port, bool)
                    or not isinstance(port, int)
                    or port < 1
                    or port > 65_535
                    or port == 443
                ):
                    _fail(f"{role} contains a wildcard, IPv6, non-loopback, or unexpected TCP binding.")
                endpoints.append((host, port))
            if endpoints != sorted(set(endpoints), key=lambda item: (item[1], item[0])):
                _fail(f"{role}.bindings must be unique and sorted by TCP port.")
            observed_ports = sorted({port for _host, port in endpoints})
            if observation["inventoriedNon443TcpPorts"] != observed_ports:
                _fail(f"{role}.inventoriedNon443TcpPorts does not equal its exact binding inventory.")
            _sorted_ports(observed_ports, f"{role}.inventoriedNon443TcpPorts", require_baseline=False)

    inventories: list[list[int]] = []
    for prefix in ("preflight", "active", "restart", "teardown"):
        union = set(BASELINE_DENIED_TCP_PORTS)
        for suffix in ("WindowsListeners", "WslListeners", "DockerPorts"):
            union.update(records[f"{prefix}{suffix}"].observation["inventoriedNon443TcpPorts"])
        inventories.append(sorted(union))
    if any(inventory != inventories[0] for inventory in inventories[1:]):
        _fail("The complete non-443 listener inventory drifted across the reviewed phases.")

    for suffix in BOUNDARY_SUFFIXES:
        preflight = records[f"preflight{suffix}"].observation["canonicalStateSha256"]
        teardown = records[f"teardown{suffix}"].observation["canonicalStateSha256"]
        if preflight != teardown:
            _fail(f"Teardown did not restore the preflight {suffix} state exactly.")
    return _sorted_ports(inventories[0], "complete denied-port inventory", require_baseline=True)


def _assert_policy(
    records: Mapping[str, CaptureRecord],
    host_boundary_sha256: str,
    boundary_ports: list[int],
) -> None:
    proposal = records["policyProposal"]
    proposal_observation = proposal.observation
    if proposal_observation["hostBoundarySha256"] != host_boundary_sha256:
        _fail("policyProposal does not bind hostBoundary.")
    if proposal.source != _canonical(proposal_observation["policyInput"]):
        _fail("policyProposal raw source must be the exact canonical protected policy input.")
    try:
        parsed = parse_phone_policy_input(proposal_observation["policyInput"])
        expected_policy = build_phone_policy(
            parsed.phone_tailscale_ipv4,
            parsed.relay_host_tailscale_ipv4,
            parsed.listeners,
        )
    except Exception as error:
        raise RelayEvidenceError("policyProposal cannot form the exact host-neutral phone policy.") from error
    if proposal_observation["policy"] != expected_policy:
        _fail("policyProposal does not equal the pure host-neutral renderer output.")

    expected_denies = [f"{RELAY_HOST_ALIAS}:{port}" for port in boundary_ports]
    tcp_tests = {
        test["src"]: test
        for test in expected_policy["tests"]
        if test["proto"] == "tcp"
    }
    if set(tcp_tests) != set(PHONE_ALIASES) or any(
        tcp_tests[alias]["deny"] != expected_denies for alias in PHONE_ALIASES
    ):
        _fail(
            "The rendered per-phone TCP deny tests do not equal the complete boundary inventory."
        )

    applied = records["policy"]
    if (
        applied.observation["policy"] != expected_policy
        or applied.source != _canonical(expected_policy)
        or applied.observation["proposalCaptureSha256"] != proposal.sha256
        or applied.observation["hostBoundarySha256"] != host_boundary_sha256
    ):
        _fail("The applied policy does not byte-bind the exact reviewed proposal.")

    tests = records["policyTests"]
    tests_observation = tests.observation
    if (
        tests_observation["result"] != "passed"
        or tests_observation["positiveTestsPassed"] is not True
        or tests_observation["negativeTestsPassed"] is not True
        or tests_observation["unapprovedTailnetBlocked"] is not True
        or tests_observation["proposalCaptureSha256"] != proposal.sha256
        or tests_observation["appliedCaptureSha256"] != applied.sha256
        or tests_observation["hostBoundarySha256"] != host_boundary_sha256
    ):
        _fail("policyTests do not prove exact positive and negative policy behavior.")

    event = records["configurationEvent"]
    event_observation = event.observation
    if (
        event_observation["eventType"] != "policy-update"
        or event_observation["outcome"] != "applied"
        or event_observation["appliedCaptureSha256"] != applied.sha256
        or event_observation["hostBoundarySha256"] != host_boundary_sha256
    ):
        _fail("configurationEvent does not bind the exact applied policy.")
    _assert_sha(event_observation["eventIdSha256"], "configurationEvent.eventIdSha256")
    policy_revision_sha256 = _assert_sha(
        event_observation["policyRevisionSha256"],
        "configurationEvent.policyRevisionSha256",
    )

    for role in POLICY_STATE_ROLES:
        observation = records[role].observation
        _assert_sha(observation["policyRevisionSha256"], f"{role}.policyRevisionSha256")
        _assert_sha(observation["appliedCaptureSha256"], f"{role}.appliedCaptureSha256")
        _assert_sha(
            observation["configurationEventCaptureSha256"],
            f"{role}.configurationEventCaptureSha256",
        )
        if (
            observation["policy"] != expected_policy
            or observation["policyRevisionSha256"] != policy_revision_sha256
            or observation["appliedCaptureSha256"] != applied.sha256
            or observation["configurationEventCaptureSha256"] != event.sha256
            or observation["hostBoundarySha256"] != host_boundary_sha256
        ):
            _fail(
                f"{role} does not prove the exact applied current-policy revision without drift."
            )

    gate = records["policyGate"]
    gate_observation = gate.observation
    expected_links = {
        "proposalCaptureSha256": proposal.sha256,
        "appliedCaptureSha256": applied.sha256,
        "testsCaptureSha256": tests.sha256,
        "configurationEventCaptureSha256": event.sha256,
        "currentPolicyCaptureSha256": records["activePolicyState"].sha256,
        "identitiesCaptureSha256": records["activeIdentities"].sha256,
        "hostBoundarySha256": host_boundary_sha256,
    }
    if gate_observation["result"] != "passed" or any(
        gate_observation[field] != expected for field, expected in expected_links.items()
    ):
        _fail("policyGate does not hash-link the reviewed proposal, policy, tests, event, and identities.")


def _roles_for_phase(phase: str) -> tuple[str, ...]:
    return tuple(
        role
        for declared_phase, _boundary, roles in PHASE_MATRIX
        if declared_phase == phase
        for role in roles
    )


def _creation_chronology() -> tuple[str, ...]:
    policy_before_gate = tuple(
        role for role in _roles_for_phase("policy") if role != "policyGate"
    )
    active_after_gate = tuple(
        role for role in _roles_for_phase("active")
        if role not in {"activeIdentities", "activePolicyState"}
    )
    teardown_before_disconnect = tuple(
        role for role in _roles_for_phase("teardown") if role != "teardownDisconnect"
    )
    roles = (
        *_roles_for_phase("session"),
        *_roles_for_phase("preflight"),
        *policy_before_gate,
        "activeIdentities",
        "activePolicyState",
        "policyGate",
        *active_after_gate,
        "restartPreShutdownIncoming",
        "restartPreShutdownServe",
        "restartPreShutdownFunnel",
        "restartPreExposureIncoming",
        "restartPreExposureServe",
        "restartPreExposureFunnel",
        "restartPreExposureIdentities",
        "restartEnvironment",
        "restartWindowsListeners",
        "restartWindowsFirewall",
        "restartHyperVFirewall",
        "restartForwarding",
        "restartWslListeners",
        "restartDockerPorts",
        "restartWslReadyProbe",
        "restartWindowsReadyProbe",
        "restartActiveIdentities",
        "restartPolicyState",
        "restartActiveServe",
        "restartActiveFunnel",
        "restartActiveIncoming",
        "restartIosProbe",
        "restartAndroidProbe",
        "restartUnapprovedTailnetProbe",
        "restartLanProbe",
        "coldRestartEvent",
        *teardown_before_disconnect,
        "teardownDisconnect",
        "sessionLedger",
    )
    if len(roles) != len(set(roles)) or set(roles) != set(CAPTURE_NAMES):
        raise RuntimeError("Creation chronology must contain every matrix role exactly once.")
    return roles


def _assert_timing(
    records: Mapping[str, CaptureRecord],
    started: datetime,
    executed: datetime,
    completed: datetime,
) -> None:
    if not (started <= executed <= completed) or (completed - started).total_seconds() > MAX_SESSION_SECONDS:
        _fail("Review-package timing must describe one continuous session of at most 24 hours.")
    for role, record in records.items():
        if not (started <= record.captured_at <= completed):
            _fail(f"{role} falls outside the continuous session.")

    # Digest order remains PHASE_MATRIX order. Creation chronology is deliberately
    # different where a later capture hash-binds earlier matrix roles: active
    # identity precedes policyGate/incoming, coldRestartEvent follows restart
    # probes, and teardownDisconnect follows restoration.
    creation_chronology = _creation_chronology()
    times = [records[role].captured_at for role in creation_chronology]
    if any(later <= earlier for earlier, later in zip(times, times[1:])):
        _fail("Protected captures must use strict canonical creation chronology.")
    if records["coldRestartEvent"].captured_at != executed:
        _fail("coldRestartEvent must be finalized after all restart probes at executedAt.")
    if records["sessionLedger"].captured_at != completed:
        _fail("sessionLedger must be created strictly last at completedAt.")


def _assert_approved_probe(
    role: str,
    record: CaptureRecord,
    build_ids: Mapping[str, str],
    origin: str,
    ports: list[int],
    gate_sha256: str,
    relay_identity_sha256: str,
    phone_identity_sha256: str,
    host_boundary_sha256: str,
) -> None:
    observation = record.observation
    platform, alias = APPROVED_PROBE_ROLES[role]
    expected = {
        "platform": platform,
        "testedEasBuildId": build_ids[platform],
        "phoneAlias": alias,
        "observedAt": record.captured_at.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z",
        "apiOrigin": origin,
        "publicCaAndHostname": "passed",
        "readyHttpStatus": 200,
        "readyBodySha256": READY_BODY_SHA256,
        "openTcpPorts": [443],
        "blockedTcpPorts": ports,
        "directWindowsWslDockerTargets": "blocked",
        "tailscaleDisabledHttps": "blocked",
        "policyGateSha256": gate_sha256,
        "relayHostIdentitySha256": relay_identity_sha256,
        "phoneIdentitySha256": phone_identity_sha256,
        "hostBoundarySha256": host_boundary_sha256,
    }
    for field, expected_value in expected.items():
        if observation[field] != expected_value:
            _fail(f"{role}.{field} does not bind the reviewed build, origin, policy, identity, and reachability result.")


def _assert_reachability(
    records: Mapping[str, CaptureRecord],
    build_ids: Mapping[str, str],
    origin: str,
    ports: list[int],
    host_boundary_sha256: str,
) -> None:
    gate_sha256 = records["policyGate"].sha256
    active_identities = records["activeIdentities"].observation
    restart_identities = records["restartActiveIdentities"].observation
    for role in ("iosProbe", "androidProbe"):
        platform = APPROVED_PROBE_ROLES[role][0]
        _assert_approved_probe(
            role,
            records[role],
            build_ids,
            origin,
            ports,
            gate_sha256,
            active_identities["relayHostIdentitySha256"],
            active_identities[f"{platform}IdentitySha256"],
            host_boundary_sha256,
        )
    for role in ("restartIosProbe", "restartAndroidProbe"):
        platform = APPROVED_PROBE_ROLES[role][0]
        _assert_approved_probe(
            role,
            records[role],
            build_ids,
            origin,
            ports,
            gate_sha256,
            restart_identities["relayHostIdentitySha256"],
            restart_identities[f"{platform}IdentitySha256"],
            host_boundary_sha256,
        )
    for role in UNAPPROVED_PROBE_ROLES:
        record = records[role]
        expected = {
            "observedAt": record.captured_at.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z",
            "httpsPort": "blocked",
            "blockedTcpPorts": ports,
            "policyGateSha256": gate_sha256,
            "hostBoundarySha256": host_boundary_sha256,
        }
        _assert_sha(record.observation["peerClassSha256"], f"{role}.peerClassSha256")
        if any(record.observation[field] != value for field, value in expected.items()):
            _fail(f"{role} does not prove the distinct unapproved-tailnet denial.")
    for role in LAN_PROBE_ROLES:
        record = records[role]
        expected = {
            "observedAt": record.captured_at.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z",
            "httpsPort": "blocked",
            "blockedTcpPorts": ports,
            "windowsWslDockerTargets": "blocked",
            "ipv4AndIpv6Paths": "blocked",
            "policyGateSha256": gate_sha256,
            "hostBoundarySha256": host_boundary_sha256,
        }
        _assert_sha(record.observation["peerClassSha256"], f"{role}.peerClassSha256")
        if any(record.observation[field] != value for field, value in expected.items()):
            _fail(f"{role} does not prove the distinct LAN IPv4/IPv6 denial.")
    unapproved_peer = records["unapprovedTailnetProbe"].observation["peerClassSha256"]
    lan_peer = records["lanProbe"].observation["peerClassSha256"]
    if (
        records["restartUnapprovedTailnetProbe"].observation["peerClassSha256"]
        != unapproved_peer
        or records["restartLanProbe"].observation["peerClassSha256"] != lan_peer
    ):
        _fail("Denied peer classes drifted across the continuous restart session.")
    reviewed_identities = {
        active_identities["relayHostIdentitySha256"],
        active_identities["iosIdentitySha256"],
        active_identities["androidIdentitySha256"],
        unapproved_peer,
        lan_peer,
    }
    if len(reviewed_identities) != 5:
        _fail("Approved identities and denied peer classes must all remain distinct.")


def _assert_restart(
    records: Mapping[str, CaptureRecord], host_boundary_sha256: str
) -> None:
    restart_environment = records["restartEnvironment"].observation
    for role in READINESS_ROLES:
        record = records[role]
        expected = {
            "observedAt": record.captured_at.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z",
            "httpStatus": 200,
            "bodySha256": READY_BODY_SHA256,
            "sourceHead": restart_environment["sourceHead"],
            "apiProcessSha256": restart_environment["apiProcessSha256"],
            "apiCwdSha256": restart_environment["apiCwdSha256"],
            "hostBoundarySha256": host_boundary_sha256,
        }
        if any(record.observation[field] != value for field, value in expected.items()):
            _fail(f"{role} does not prove exact post-restart local API readiness.")

    event = records["coldRestartEvent"]
    observation = event.observation
    expected_pre = {
        role: records[role].sha256
        for role in (
            "restartPreShutdownIncoming",
            "restartPreShutdownServe",
            "restartPreShutdownFunnel",
        )
    }
    expected_post = {role: records[role].sha256 for role in COLD_POST_RESTART_ROLES}
    if _exact_keys(observation["preShutdown"], tuple(expected_pre), "coldRestartEvent.preShutdown") != expected_pre:
        _fail("coldRestartEvent does not bind the exact pre-shutdown capture hashes.")
    if _exact_keys(observation["postRestart"], COLD_POST_RESTART_ROLES, "coldRestartEvent.postRestart") != expected_post:
        _fail("coldRestartEvent does not bind every exact post-restart capture hash.")
    shutdown_order = observation["shutdownOrder"]
    restart_order = observation["restartOrder"]
    if (
        not isinstance(shutdown_order, list)
        or shutdown_order[:2] != ["incoming-disabled", "serve-stopped"]
        or set(shutdown_order[2:]) != {"wsl-shutdown", "docker-desktop-stopped"}
        or len(shutdown_order) != 4
        or not isinstance(restart_order, list)
        or set(restart_order) != {"wsl-started", "docker-desktop-started"}
        or len(restart_order) != 2
    ):
        _fail("coldRestartEvent does not preserve the reviewed safe shutdown and restart ordering.")
    expected_results = {
        "dockerBoundaryRestored": "passed",
        "migrationsCurrent": "passed",
        "sourceHead": restart_environment["sourceHead"],
        "sourceTreeClean": True,
        "apiProcessSha256": restart_environment["apiProcessSha256"],
        "apiCwdSha256": restart_environment["apiCwdSha256"],
        "result": "passed",
        "hostBoundarySha256": host_boundary_sha256,
    }
    if any(observation[field] != value for field, value in expected_results.items()):
        _fail("coldRestartEvent does not prove clean source/process, migrations, and Docker continuity.")
    if event.source != _canonical(observation):
        _fail("coldRestartEvent raw source must be its exact canonical ordered event record.")


def _assert_session_ledger(records: Mapping[str, CaptureRecord]) -> None:
    ledger = records["sessionLedger"]
    entries = ledger.observation["entries"]
    preceding_roles = CAPTURE_NAMES[:-1]
    if not isinstance(entries, list) or len(entries) != len(preceding_roles):
        _fail("sessionLedger must contain one entry for every preceding matrix role.")
    for entry, role in zip(entries, preceding_roles, strict=True):
        exact = _exact_keys(entry, ("role", "schemaVersion", "capturedAt", "sha256"), "sessionLedger entry")
        expected = {
            "role": role,
            "schemaVersion": records[role].schema_version,
            "capturedAt": records[role].captured_at.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z",
            "sha256": records[role].sha256,
        }
        if exact != expected:
            _fail("sessionLedger is missing, reordered, cross-session, or hash-inconsistent.")
    if ledger.source != _canonical({"entries": entries}):
        _fail("sessionLedger raw source must be the exact canonical preceding-entry ledger.")


def _source_capture_bundle_sha256(records: Mapping[str, CaptureRecord]) -> str:
    digest = hashlib.sha256()
    digest.update(f"{SOURCE_CAPTURE_BUNDLE_SCHEMA}\n".encode("ascii"))
    for role in CAPTURE_NAMES:
        digest.update(f"{role}\n{records[role].sha256}\n".encode("ascii"))
    return digest.hexdigest()


def _capture_hashes(records: Mapping[str, CaptureRecord], roles: Sequence[str]) -> dict[str, str]:
    return {role: records[role].sha256 for role in roles}


def _boundary_phase(
    records: Mapping[str, CaptureRecord], prefix: str, environment_role: str
) -> dict[str, str]:
    return {
        "environmentSha256": records[environment_role].sha256,
        "windowsListenersSha256": records[f"{prefix}WindowsListeners"].sha256,
        "windowsFirewallSha256": records[f"{prefix}WindowsFirewall"].sha256,
        "hyperVFirewallSha256": records[f"{prefix}HyperVFirewall"].sha256,
        "forwardingSha256": records[f"{prefix}Forwarding"].sha256,
        "wslListenersSha256": records[f"{prefix}WslListeners"].sha256,
        "dockerPortsSha256": records[f"{prefix}DockerPorts"].sha256,
    }


def _approved_probe_report(record: CaptureRecord) -> dict[str, Any]:
    observation = record.observation
    return {
        "testedEasBuildId": observation["testedEasBuildId"],
        "phoneAlias": observation["phoneAlias"],
        "observedAt": observation["observedAt"],
        "captureSha256": record.sha256,
        "publicCaAndHostname": "passed",
        "readyHttpStatus": 200,
        "readyBodySha256": READY_BODY_SHA256,
        "openTcpPorts": [443],
        "blockedTcpPorts": observation["blockedTcpPorts"],
        "directWindowsWslDockerTargets": "blocked",
        "tailscaleDisabledHttps": "blocked",
    }


def _unapproved_probe_report(record: CaptureRecord) -> dict[str, Any]:
    return {
        "observedAt": record.observation["observedAt"],
        "captureSha256": record.sha256,
        "httpsPort": "blocked",
        "blockedTcpPorts": record.observation["blockedTcpPorts"],
    }


def _lan_probe_report(record: CaptureRecord) -> dict[str, Any]:
    return {
        **_unapproved_probe_report(record),
        "windowsWslDockerTargets": "blocked",
        "ipv4AndIpv6Paths": "blocked",
    }


def _probe_set(records: Mapping[str, CaptureRecord], *, restart: bool) -> dict[str, Any]:
    prefix = "restart" if restart else ""
    return {
        "ios": _approved_probe_report(records[f"{prefix}IosProbe" if restart else "iosProbe"]),
        "android": _approved_probe_report(
            records[f"{prefix}AndroidProbe" if restart else "androidProbe"]
        ),
        "unapprovedTailnet": _unapproved_probe_report(
            records[f"{prefix}UnapprovedTailnetProbe" if restart else "unapprovedTailnetProbe"]
        ),
        "lan": _lan_probe_report(records[f"{prefix}LanProbe" if restart else "lanProbe"]),
    }


def _readiness_report(record: CaptureRecord) -> dict[str, Any]:
    return {
        "observedAt": record.observation["observedAt"],
        "captureSha256": record.sha256,
        "httpStatus": 200,
        "bodySha256": READY_BODY_SHA256,
    }


def _report_candidate(
    index: Mapping[str, Any],
    records: Mapping[str, CaptureRecord],
    host_boundary: Mapping[str, Any],
    ports: list[int],
) -> dict[str, Any]:
    environment = records["sessionEnvironment"].observation
    return {
        "schemaVersion": REPORT_SCHEMA,
        "trustBoundary": UNSIGNED_TRUST_BOUNDARY,
        "sourceCaptureBundleSha256": _source_capture_bundle_sha256(records),
        "apiOriginCommitmentSha256": api_origin_commitment_sha256(index["apiOrigin"]),
        "startedAt": index["startedAt"],
        "executedAt": index["executedAt"],
        "completedAt": index["completedAt"],
        "sourceCommit": environment["sourceHead"],
        "buildIds": dict(index["buildIds"]),
        "hostTopology": {
            **dict(host_boundary),
            "hostBoundarySha256": records["hostBoundary"].sha256,
        },
        "versionAdapter": {
            "adapterId": environment["adapterId"],
            "windowsVersion": environment["windowsVersion"],
            "wslVersion": environment["wslVersion"],
            "ubuntuVersion": environment["ubuntuVersion"],
            "dockerDesktopVersion": environment["dockerDesktopVersion"],
            "dockerEngineVersion": environment["dockerEngineVersion"],
            "tailscaleClientVersion": environment["tailscaleClientVersion"],
            "tailscaleDaemonVersion": environment["tailscaleDaemonVersion"],
            "clientHelpSha256": environment["clientHelpSha256"],
            "daemonHelpSha256": environment["daemonHelpSha256"],
            "rawStatusSha256": environment["rawStatusSha256"],
            "sessionEnvironmentSha256": records["sessionEnvironment"].sha256,
            "activeEnvironmentSha256": records["activeEnvironment"].sha256,
            "restartEnvironmentSha256": records["restartEnvironment"].sha256,
            "teardownEnvironmentSha256": records["teardownEnvironment"].sha256,
        },
        "policy": {
            "approvedPhoneAliases": list(PHONE_ALIASES),
            "incomingAccessHeldUntilPolicyTests": "passed",
            "relayHostIdentityRevalidated": "passed",
            "testedPhonesToRelayHostTcp443Only": "passed",
            "noOverlappingAclOrGrant": "passed",
            "policyTests": "passed",
            "proposalCaptureSha256": records["policyProposal"].sha256,
            "appliedCaptureSha256": records["policy"].sha256,
            "testsCaptureSha256": records["policyTests"].sha256,
            "configurationEventCaptureSha256": records["configurationEvent"].sha256,
            "gateCaptureSha256": records["policyGate"].sha256,
        },
        "boundaryEvidence": {
            "preflight": _boundary_phase(records, "preflight", "sessionEnvironment"),
            "active": _boundary_phase(records, "active", "activeEnvironment"),
            "restart": _boundary_phase(records, "restart", "restartEnvironment"),
            "teardown": _boundary_phase(records, "teardown", "teardownEnvironment"),
        },
        "active": {
            "incoming": "enabled",
            "serve": "attended-foreground",
            "funnel": "disabled",
            "httpsPort": 443,
            "handlerPath": "/",
            "upstream": "http://127.0.0.1:4000",
            "inventoriedNon443TcpPorts": ports,
            "incomingCaptureSha256": records["activeIncoming"].sha256,
            "serveCaptureSha256": records["activeServe"].sha256,
            "funnelCaptureSha256": records["activeFunnel"].sha256,
            "identitiesCaptureSha256": records["activeIdentities"].sha256,
            "deviceProbes": _probe_set(records, restart=False),
        },
        "restart": {
            "preShutdown": {
                "incoming": "disabled",
                "serve": "disabled",
                "funnel": "disabled",
                "incomingCaptureSha256": records["restartPreShutdownIncoming"].sha256,
                "serveCaptureSha256": records["restartPreShutdownServe"].sha256,
                "funnelCaptureSha256": records["restartPreShutdownFunnel"].sha256,
            },
            "preExposure": {
                "incoming": "disabled",
                "serve": "disabled",
                "funnel": "disabled",
                "relayHostIdentityRevalidated": "passed",
                "incomingCaptureSha256": records["restartPreExposureIncoming"].sha256,
                "serveCaptureSha256": records["restartPreExposureServe"].sha256,
                "funnelCaptureSha256": records["restartPreExposureFunnel"].sha256,
                "identitiesCaptureSha256": records["restartPreExposureIdentities"].sha256,
            },
            "localReadiness": {
                "wsl": _readiness_report(records["restartWslReadyProbe"]),
                "windows": _readiness_report(records["restartWindowsReadyProbe"]),
                "migrationsCurrent": "passed",
            },
            "reenabledRelay": {
                "incoming": "enabled",
                "serve": "attended-foreground",
                "funnel": "disabled",
                "relayHostIdentityRevalidated": "passed",
                "incomingCaptureSha256": records["restartActiveIncoming"].sha256,
                "serveCaptureSha256": records["restartActiveServe"].sha256,
                "funnelCaptureSha256": records["restartActiveFunnel"].sha256,
                "identitiesCaptureSha256": records["restartActiveIdentities"].sha256,
            },
            "deviceProbes": _probe_set(records, restart=True),
            "coldRestartEventSha256": records["coldRestartEvent"].sha256,
            "sourceProcessContinuity": "passed",
            "routeRecovered": "passed",
        },
        "teardown": {
            "incoming": "disabled",
            "serve": "disabled",
            "funnel": "disabled",
            "relayHostDisconnected": "passed",
            "boundaryRestored": "passed",
            "incomingCaptureSha256": records["teardownIncoming"].sha256,
            "serveCaptureSha256": records["teardownServe"].sha256,
            "funnelCaptureSha256": records["teardownFunnel"].sha256,
            "disconnectCaptureSha256": records["teardownDisconnect"].sha256,
        },
        "sessionLedgerSha256": records["sessionLedger"].sha256,
    }


def normalize_relay_report_candidate(
    index_path: str,
    *,
    adapters: Mapping[str, VersionAdapter] | None = None,
) -> bytes:
    review_directory, index_name, checked_directory_state = _checked_review_directory(index_path)
    directory_descriptor, initial_directory_state, filesystem_magic = _open_review_directory(
        review_directory, checked_directory_state
    )
    directory_device = initial_directory_state[0]
    try:
        index_raw, index_identity, index_state = _secure_read_at(
            directory_descriptor,
            directory_device,
            filesystem_magic,
            index_name,
            "review-package index",
            MAX_INDEX_BYTES,
        )
        index = _exact_keys(
            _canonical_json(index_raw, "review-package index"),
            (
                "schemaVersion", "trustBoundary", "sessionId", "apiOrigin", "startedAt",
                "executedAt", "completedAt", "buildIds", "captures",
            ),
            "review-package index",
        )
        if index["schemaVersion"] != REVIEW_PACKAGE_SCHEMA:
            _fail("Review-package schema is not the exact Windows v2 schema.")
        if index["trustBoundary"] != UNSIGNED_TRUST_BOUNDARY:
            _fail("Review package does not acknowledge the unsigned structural trust boundary.")
        if not isinstance(index["sessionId"], str) or not UUID.fullmatch(index["sessionId"]):
            _fail("Review package sessionId must be one canonical lowercase UUID.")
        api_origin_commitment_sha256(index["apiOrigin"])
        started = _instant(index["startedAt"], "startedAt")
        executed = _instant(index["executedAt"], "executedAt")
        completed = _instant(index["completedAt"], "completedAt")
        build_ids = _exact_keys(index["buildIds"], ("ios", "android"), "buildIds")
        if any(not isinstance(value, str) or not UUID.fullmatch(value) for value in build_ids.values()) or len(
            set(build_ids.values())
        ) != 2:
            _fail("buildIds must bind two distinct canonical lowercase EAS build IDs.")
        paths = _exact_keys(index["captures"], CAPTURE_NAMES, "captures")

        raw_records: dict[
            str,
            tuple[bytes, tuple[int, int], tuple[int, int, int, int, int, int, int, int]],
        ] = {}
        for role in CAPTURE_NAMES:
            filename = _capture_filename(paths[role], review_directory, role)
            raw_records[role] = _secure_read_at(
                directory_descriptor,
                directory_device,
                filesystem_magic,
                filename,
                f"{role} capture",
                MAX_CAPTURE_BYTES,
            )
        identities = [
            index_identity,
            *(identity for _raw, identity, _state in raw_records.values()),
        ]
        if len(identities) != len(set(identities)):
            _fail("The index and every matrix role must use distinct files and inodes.")
        records = {
            role: _parse_capture(role, raw, identity, index["sessionId"])
            for role, (raw, identity, _state) in raw_records.items()
        }
        if len({record.sha256 for record in records.values()}) != len(records):
            _fail("Every matrix role must use distinct complete capture bytes.")
        _assert_stable_entry_at(
            directory_descriptor, index_name, index_state, "review-package index"
        )
        for role in CAPTURE_NAMES:
            filename = _capture_filename(paths[role], review_directory, role)
            _assert_stable_entry_at(
                directory_descriptor,
                filename,
                raw_records[role][2],
                f"{role} capture",
            )
        if (
            _directory_identity(os.fstat(directory_descriptor)) != initial_directory_state
            or _directory_identity(os.lstat(review_directory)) != initial_directory_state
            or _filesystem_magic(directory_descriptor) != filesystem_magic
        ):
            _fail("The protected review directory changed while captures were read.")
    finally:
        os.close(directory_descriptor)

    host_boundary = _assert_host_boundary(records["hostBoundary"])
    host_boundary_sha256 = records["hostBoundary"].sha256
    for role, record in records.items():
        if role not in {"hostBoundary", "sessionLedger"} and record.observation.get(
            "hostBoundarySha256"
        ) != host_boundary_sha256:
            _fail(f"{role} does not hash-link the sole authoritative hostBoundary capture.")
    selected_adapters = PRODUCTION_VERSION_ADAPTERS if adapters is None else adapters
    adapter = _assert_versions_and_environment(records, host_boundary_sha256, selected_adapters)
    _assert_adapter_observations(records, adapter, host_boundary_sha256)
    ports = _assert_boundaries(records, host_boundary_sha256)
    _assert_policy(records, host_boundary_sha256, ports)
    _assert_timing(records, started, executed, completed)
    _assert_reachability(records, build_ids, index["apiOrigin"], ports, host_boundary_sha256)
    _assert_restart(records, host_boundary_sha256)
    _assert_session_ledger(records)
    return _canonical(_report_candidate(index, records, host_boundary, ports))


class _QuietArgumentParser(argparse.ArgumentParser):
    def error(self, _message: str) -> NoReturn:
        _fail("Command arguments do not match the protected normalizer contract.")


def _parser() -> argparse.ArgumentParser:
    parser = _QuietArgumentParser(
        allow_abbrev=False,
        description=(
            "Structurally normalize a protected Windows relay review package into an unsigned "
            "canonical candidate; this does not collect or authenticate evidence."
        ),
    )
    parser.add_argument(
        "--capture-index",
        required=True,
        help="Absolute generic path to the mode-0600 index in a native-Linux mode-0700 review directory",
    )
    parser.add_argument(
        "--acknowledge-unsigned-candidate",
        action="store_true",
        required=True,
        help="Acknowledge that independent Ed25519 manifest review remains required",
    )
    return parser


def main(arguments: Sequence[str] | None = None) -> int:
    try:
        parsed = _parser().parse_args(arguments)
        candidate = normalize_relay_report_candidate(parsed.capture_index)
        sys.stdout.buffer.write(candidate)
        sys.stderr.write(
            "Unsigned structural candidate only; independent trusted Ed25519 manifest review remains required.\n"
        )
        return 0
    except RelayEvidenceError as error:
        sys.stderr.write(f"Relay evidence rejected: {error}\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
