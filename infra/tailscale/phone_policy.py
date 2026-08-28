"""Render a reviewed, host-neutral Tailscale policy for physical-phone testing.

This module is deliberately pure and non-collecting. It securely reads one
reviewer-supplied input on the WSL Linux filesystem, validates structured
listener evidence, and writes a canonical policy proposal. It never invokes a
process, opens a network connection, authenticates a node, or applies policy.
"""

from __future__ import annotations

import argparse
import ctypes
import ipaddress
import json
import os
import stat
import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, NoReturn


INPUT_SCHEMA = "nutrition-tracker-tailscale-phone-policy-input-v2"
TAILSCALE_NETWORK = ipaddress.ip_network("100.64.0.0/10")
PHONE_ALIASES = ("nutrition-tracker-phone-1", "nutrition-tracker-phone-2")
RELAY_HOST_ALIAS = "nutrition-tracker-relay-host"
HTTPS_PORT = 443
MAX_JSON_BYTES = 262_144
MAX_LISTENERS = 2_048
MAX_PATH_BYTES = 4_096

# Linux-native filesystems whose ownership, mode, and no-follow semantics are
# suitable for protected WSL inputs. DrvFS/9p, NTFS, CIFS, and FUSE are omitted.
NATIVE_LINUX_FILESYSTEMS = frozenset(
    {
        0xEF53,  # ext2/3/4
        0x9123683E,  # btrfs
        0x58465342,  # XFS
        0x2FC12FC1,  # ZFS
        0xF2F52010,  # f2fs
    }
)

# These remain denied even when stopped. Current listeners are added
# dynamically so probes must cover the complete reviewed inventory.
BASELINE_DENIED_TCP_PORTS = frozenset(
    {22, 80, 1025, 2181, 4000, 4566, 5432, 7700, 8025, 8080, 8081, 9000, 9001, 9092}
)
REQUIRED_LOOPBACK_PORTS = frozenset({1025, 4000, 4566, 5432, 7700, 8025, 9000, 9001})
REPOSITORY_ROOT = Path(__file__).resolve().parents[2]


class PhonePolicyError(RuntimeError):
    """A fail-closed physical-phone policy precondition was not satisfied."""


class ProtectedArgumentParser(argparse.ArgumentParser):
    """Reject malformed CLI input without echoing protected argument values."""

    def error(self, _message: str) -> NoReturn:
        self.print_usage(sys.stderr)
        self.exit(2, "Phone-policy arguments rejected; supply only one protected --input-file path.\n")


@dataclass(frozen=True)
class Listener:
    host: str
    port: int


@dataclass(frozen=True)
class PhonePolicyInput:
    phone_tailscale_ipv4: Mapping[str, str]
    relay_host_tailscale_ipv4: str
    listeners: tuple[Listener, ...]


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
    raise PhonePolicyError(message)


def _exact_keys(value: Any, expected: Sequence[str], name: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != set(expected):
        _fail(f"{name} must contain exactly: {', '.join(sorted(expected))}.")
    return value


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            _fail("Protected JSON contains duplicate keys.")
        result[key] = value
    return result


def _reject_non_integer_number(_value: str) -> NoReturn:
    _fail("Protected JSON may contain only integer numbers.")


def _canonical(value: Any) -> bytes:
    return (
        json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"), sort_keys=True)
        + "\n"
    ).encode("utf-8")


def _json(raw: bytes, name: str) -> dict[str, Any]:
    try:
        value = json.loads(
            raw,
            object_pairs_hook=_reject_duplicate_keys,
            parse_float=_reject_non_integer_number,
            parse_constant=_reject_non_integer_number,
        )
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise PhonePolicyError(f"{name} must be exact UTF-8 JSON.") from error
    if not isinstance(value, dict) or _canonical(value) != raw:
        _fail(f"{name} must use canonical JSON encoding and field order.")
    return value


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
        raise PhonePolicyError("Unable to prove native Linux filesystem semantics.") from error


def _normalized_absolute_path(path_value: Any, name: str) -> Path:
    if (
        not isinstance(path_value, str)
        or not path_value
        or "\x00" in path_value
        or len(os.fsencode(path_value)) > MAX_PATH_BYTES
    ):
        _fail(f"{name} must be a bounded path string.")
    path = Path(path_value)
    if not path.is_absolute():
        _fail(f"{name} must be absolute.")
    if path != Path(os.path.normpath(path_value)):
        _fail(f"{name} must be lexically normalized.")
    parts = tuple(part.casefold() for part in path.parts)
    if len(parts) >= 2 and parts[1] == "mnt":
        _fail("Protected inputs must not use /mnt/* or DrvFS.")
    if any("onedrive" in part for part in parts):
        _fail("Protected inputs must remain outside OneDrive.")
    try:
        resolved = path.resolve(strict=True)
    except OSError as error:
        raise PhonePolicyError(f"{name} cannot be resolved safely.") from error
    if path != resolved:
        _fail(f"{name} must be normalized and contain no symlink traversal.")
    return resolved


def _review_directory(path: Path) -> tuple[Path, os.stat_result]:
    directory = path.parent
    for ancestor in (directory, *directory.parents):
        try:
            os.lstat(ancestor / ".git")
        except FileNotFoundError:
            continue
        except OSError as error:
            raise PhonePolicyError("Unable to prove that protected inputs are outside Git.") from error
        else:
            _fail("Protected inputs must remain outside every Git worktree.")
    try:
        directory_stat = os.lstat(directory)
    except OSError as error:
        raise PhonePolicyError("Unable to inspect the protected review directory.") from error
    if (
        not stat.S_ISDIR(directory_stat.st_mode)
        or directory_stat.st_uid != os.getuid()
        or stat.S_IMODE(directory_stat.st_mode) != 0o700
    ):
        _fail("Protected review directory must be current-user-owned mode 0700.")
    return directory, directory_stat


def _stable_file_signature(value: os.stat_result) -> tuple[int, ...]:
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


def read_phone_policy_input(path_value: str) -> PhonePolicyInput:
    path = _normalized_absolute_path(path_value, "input file")
    directory, directory_before = _review_directory(path)
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NONBLOCK", 0)
    no_follow = getattr(os, "O_NOFOLLOW", None)
    directory_only = getattr(os, "O_DIRECTORY", None)
    if no_follow is None or directory_only is None:
        _fail("Secure no-follow file opens are unavailable.")
    directory_descriptor = -1
    file_descriptor = -1
    try:
        directory_descriptor = os.open(directory, flags | no_follow | directory_only)
        opened_directory_before = os.fstat(directory_descriptor)
        if _stable_file_signature(directory_before) != _stable_file_signature(opened_directory_before):
            _fail("Protected review directory changed before it was opened.")
        directory_magic = _filesystem_magic(directory_descriptor)
        if directory_magic not in NATIVE_LINUX_FILESYSTEMS:
            _fail("Protected review directory is not on an approved persistent Linux filesystem.")
        file_descriptor = os.open(path.name, flags | no_follow, dir_fd=directory_descriptor)
        entry_before = os.stat(path.name, dir_fd=directory_descriptor, follow_symlinks=False)
        before = os.fstat(file_descriptor)
        if (
            _stable_file_signature(entry_before) != _stable_file_signature(before)
            or not stat.S_ISREG(before.st_mode)
            or before.st_uid != os.getuid()
            or stat.S_IMODE(before.st_mode) != 0o600
            or before.st_nlink != 1
            or before.st_dev != opened_directory_before.st_dev
            or before.st_size < 2
            or before.st_size > MAX_JSON_BYTES
        ):
            _fail("Protected input must be a bounded current-user-owned mode-0600 single-link file.")
        if _filesystem_magic(file_descriptor) != directory_magic:
            _fail("Protected input must share the review directory's native Linux filesystem.")
        chunks: list[bytes] = []
        remaining = before.st_size
        while remaining:
            chunk = os.read(file_descriptor, min(65_536, remaining))
            if not chunk:
                _fail("Protected input ended before its inspected size.")
            chunks.append(chunk)
            remaining -= len(chunk)
        if os.read(file_descriptor, 1):
            _fail("Protected input grew while it was read.")
        after = os.fstat(file_descriptor)
        entry_after = os.stat(path.name, dir_fd=directory_descriptor, follow_symlinks=False)
        opened_directory_after = os.fstat(directory_descriptor)
        directory_path_after = os.lstat(directory)
        if (
            _stable_file_signature(before) != _stable_file_signature(after)
            or _stable_file_signature(before) != _stable_file_signature(entry_after)
            or _stable_file_signature(opened_directory_before)
            != _stable_file_signature(opened_directory_after)
            or _stable_file_signature(opened_directory_before)
            != _stable_file_signature(directory_path_after)
        ):
            _fail("Protected input or review directory changed while it was read.")
    except OSError as error:
        raise PhonePolicyError("Unable to securely read the protected input.") from error
    finally:
        if file_descriptor >= 0:
            os.close(file_descriptor)
        if directory_descriptor >= 0:
            os.close(directory_descriptor)
    return parse_phone_policy_input(_json(b"".join(chunks), "input file"))


def _parse_tailscale_ipv4(value: Any, name: str) -> str:
    if not isinstance(value, str):
        _fail(f"{name} must be an exact Tailscale IPv4 address.")
    try:
        address = ipaddress.ip_address(value)
    except ValueError as error:
        raise PhonePolicyError(f"{name} must be an exact Tailscale IPv4 address.") from error
    if address.version != 4 or address not in TAILSCALE_NETWORK or str(address) != value:
        _fail(f"{name} must be canonical and inside Tailscale 100.64.0.0/10.")
    return value


def _parse_listener_host(value: Any, name: str) -> str:
    if value == "*":
        return value
    if not isinstance(value, str) or not value or value.strip() != value:
        _fail(f"{name} must be a canonical IP address or exact wildcard.")
    try:
        address = ipaddress.ip_address(value)
    except ValueError as error:
        raise PhonePolicyError(f"{name} must be a canonical IP address or exact wildcard.") from error
    if str(address) != value:
        _fail(f"{name} must use canonical IP notation.")
    return value


def _validated_listeners(value: Sequence[Listener]) -> tuple[Listener, ...]:
    if isinstance(value, (str, bytes)):
        _fail("listeners must be a bounded sequence of Listener records.")
    listeners = tuple(value)
    if not 1 <= len(listeners) <= MAX_LISTENERS:
        _fail("listeners must be a bounded non-empty sequence.")
    seen: set[tuple[str, int]] = set()
    for index, listener in enumerate(listeners):
        if not isinstance(listener, Listener):
            _fail(f"listeners[{index}] must be a Listener record.")
        host = _parse_listener_host(listener.host, f"listeners[{index}].host")
        port = listener.port
        if not isinstance(port, int) or isinstance(port, bool) or not 1 <= port <= 65_535:
            _fail(f"listeners[{index}].port must be an integer TCP port in range.")
        if (host, port) in seen:
            _fail("listeners must not contain duplicate endpoints.")
        seen.add((host, port))
    return listeners


def parse_listener_capture(value: object) -> tuple[Listener, ...]:
    if not isinstance(value, list) or not 1 <= len(value) <= MAX_LISTENERS:
        _fail("listeners must be a bounded non-empty array.")
    listeners: list[Listener] = []
    seen: set[tuple[str, int]] = set()
    for index, candidate in enumerate(value):
        record = _exact_keys(candidate, ("host", "port"), f"listeners[{index}]")
        host = _parse_listener_host(record["host"], f"listeners[{index}].host")
        port = record["port"]
        if not isinstance(port, int) or isinstance(port, bool) or not 1 <= port <= 65_535:
            _fail(f"listeners[{index}].port must be an integer TCP port in range.")
        key = (host, port)
        if key in seen:
            _fail("listeners must not contain duplicate endpoints.")
        seen.add(key)
        listeners.append(Listener(host, port))
    return tuple(listeners)


def parse_phone_policy_input(value: object) -> PhonePolicyInput:
    record = _exact_keys(
        value,
        ("schemaVersion", "phoneTailscaleIpv4", "relayHostTailscaleIpv4", "listeners"),
        "phone policy input",
    )
    if record["schemaVersion"] != INPUT_SCHEMA:
        _fail("Phone-policy input schema is not supported.")
    phones = _exact_keys(record["phoneTailscaleIpv4"], PHONE_ALIASES, "phoneTailscaleIpv4")
    canonical_phones = {
        alias: _parse_tailscale_ipv4(phones[alias], alias) for alias in PHONE_ALIASES
    }
    relay = _parse_tailscale_ipv4(record["relayHostTailscaleIpv4"], RELAY_HOST_ALIAS)
    listeners = parse_listener_capture(record["listeners"])
    if len({relay, *canonical_phones.values()}) != 3:
        _fail("Both phones and the relay host must have distinct Tailscale IPv4 addresses.")
    _assert_required_loopback_services(listeners)
    return PhonePolicyInput(canonical_phones, relay, listeners)


def _assert_required_loopback_services(listeners: Sequence[Listener]) -> None:
    unexpected = next((listener for listener in listeners if listener.host != "127.0.0.1"), None)
    if unexpected is not None:
        _fail(
            f"TCP/{unexpected.port} must bind exact IPv4 loopback 127.0.0.1; wildcard and IPv6 bindings are forbidden."
        )
    for port in sorted(REQUIRED_LOOPBACK_PORTS):
        hosts = {listener.host for listener in listeners if listener.port == port}
        if hosts != {"127.0.0.1"}:
            _fail(f"TCP/{port} must bind only exact IPv4 loopback 127.0.0.1 before phone access.")
    if any(listener.port == HTTPS_PORT for listener in listeners):
        _fail("TCP/443 must be unused before the reviewed attended relay setup.")


def build_phone_policy(
    phone_tailscale_ipv4: Mapping[str, str],
    relay_host_tailscale_ipv4: str,
    listeners: Sequence[Listener],
) -> dict[str, object]:
    phones = _exact_keys(dict(phone_tailscale_ipv4), PHONE_ALIASES, "phone Tailscale addresses")
    canonical_phones = {
        alias: _parse_tailscale_ipv4(phones[alias], alias) for alias in PHONE_ALIASES
    }
    relay = _parse_tailscale_ipv4(relay_host_tailscale_ipv4, RELAY_HOST_ALIAS)
    if len({relay, *canonical_phones.values()}) != 3:
        _fail("Both phones and the relay host must have distinct Tailscale IPv4 addresses.")
    validated_listeners = _validated_listeners(listeners)
    _assert_required_loopback_services(validated_listeners)
    denied_ports = sorted(
        BASELINE_DENIED_TCP_PORTS
        | {listener.port for listener in validated_listeners if listener.port != HTTPS_PORT}
    )
    denied_destinations = [f"{RELAY_HOST_ALIAS}:{port}" for port in denied_ports]
    return {
        "acls": [],
        "grants": [
            {
                "dst": [RELAY_HOST_ALIAS],
                "ip": ["tcp:443"],
                "src": list(PHONE_ALIASES),
            }
        ],
        "hosts": {
            RELAY_HOST_ALIAS: relay,
            **canonical_phones,
        },
        "nodeAttrs": [],
        "ssh": [],
        "tests": [
            test
            for alias in PHONE_ALIASES
            for test in (
                {
                    "accept": [f"{RELAY_HOST_ALIAS}:443"],
                    "deny": denied_destinations,
                    "proto": "tcp",
                    "src": alias,
                },
                {
                    "deny": [f"{RELAY_HOST_ALIAS}:443", *denied_destinations],
                    "proto": "udp",
                    "src": alias,
                },
            )
        ],
    }


def render_phone_policy(policy_input: PhonePolicyInput) -> str:
    policy = build_phone_policy(
        policy_input.phone_tailscale_ipv4,
        policy_input.relay_host_tailscale_ipv4,
        policy_input.listeners,
    )
    return _canonical(policy).decode("utf-8")


def _parser() -> argparse.ArgumentParser:
    parser = ProtectedArgumentParser(
        description=(
            "Render, but never apply, a host-neutral two-phone Tailscale policy from one "
            "protected native-WSL input file."
        )
    )
    parser.add_argument(
        "--input-file",
        required=True,
        help="Absolute mode-0600 input path inside a mode-0700 native-WSL review directory",
    )
    return parser


def main(arguments: Sequence[str] | None = None) -> int:
    try:
        parsed = _parser().parse_args(arguments)
        sys.stdout.write(render_phone_policy(read_phone_policy_input(parsed.input_file)))
        sys.stderr.write(
            "Rendered a protected proposal only; review the complete existing tailnet policy and apply nothing automatically.\n"
        )
        return 0
    except PhonePolicyError as error:
        sys.stderr.write(f"Phone policy rejected: {error}\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
