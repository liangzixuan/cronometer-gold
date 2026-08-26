"""Render a reviewed, device-scoped Tailscale policy for physical-phone testing.

This module never installs Tailscale, authenticates a node, reads credentials, or
applies a tailnet policy. It inventories the local TCP listeners needed to build
policy regression tests and writes the proposed policy to stdout for human review.
"""

from __future__ import annotations

import argparse
import ipaddress
import json
import re
import subprocess
import sys
from collections.abc import Callable, Sequence
from dataclasses import dataclass


LSOF = "/usr/sbin/lsof"
MAX_LSOF_BYTES = 1_048_576
TAILSCALE_NETWORK = ipaddress.ip_network("100.64.0.0/10")
PHONE_ALIAS = "nutrition-tracker-phone"
MAC_ALIAS = "nutrition-tracker-mac"
HTTPS_PORT = 443

# These ports remain denied even when the corresponding service is stopped while
# the policy is rendered. Current listeners are added to this set dynamically.
BASELINE_DENIED_TCP_PORTS = frozenset(
    {
        22,  # SSH
        80,  # unencrypted HTTP
        1025,  # Mailpit SMTP
        2181,  # ZooKeeper
        4000,  # direct API listener
        4566,  # LocalStack
        5432,  # PostgreSQL
        7700,  # Meilisearch
        8025,  # Mailpit UI
        8080,  # ZooKeeper/admin and common Java listeners
        8081,  # Metro
        9000,  # MinIO API
        9001,  # MinIO console
        9092,  # Kafka
    }
)
REQUIRED_LOOPBACK_PORTS = frozenset({4000, 4566, 5432, 7700, 9000, 9001})
PORT_SUFFIX = re.compile(r":(?P<port>[0-9]{1,5})$")


class PhonePolicyError(RuntimeError):
    """A fail-closed physical-phone policy precondition was not satisfied."""


@dataclass(frozen=True)
class Listener:
    host: str
    port: int


def _parse_tailscale_ipv4(value: str, name: str) -> str:
    try:
        address = ipaddress.ip_address(value)
    except ValueError as error:
        raise PhonePolicyError(f"{name} must be an exact Tailscale IPv4 address.") from error
    if address.version != 4 or address not in TAILSCALE_NETWORK:
        raise PhonePolicyError(f"{name} must be inside the Tailscale 100.64.0.0/10 range.")
    if str(address) != value:
        raise PhonePolicyError(f"{name} must use canonical IPv4 notation.")
    return value


def parse_lsof_snapshot(raw: bytes) -> tuple[Listener, ...]:
    if not isinstance(raw, bytes) or not raw or len(raw) > MAX_LSOF_BYTES:
        raise PhonePolicyError("The bounded lsof listener snapshot was absent or oversized.")
    if b"\x00" in raw:
        raise PhonePolicyError("The lsof listener snapshot used an unexpected NUL encoding.")
    try:
        text = raw.decode("utf-8", errors="strict")
    except UnicodeDecodeError as error:
        raise PhonePolicyError("The lsof listener snapshot was not UTF-8.") from error

    listeners: list[Listener] = []
    saw_process = False
    for line in text.splitlines():
        if not line:
            continue
        field = line[0]
        value = line[1:]
        if field == "p":
            if not value.isdecimal():
                raise PhonePolicyError("The lsof process record was malformed.")
            saw_process = True
            continue
        if field == "f":
            if not saw_process or not value.isdecimal():
                raise PhonePolicyError("The lsof file-descriptor record was malformed.")
            continue
        if field != "n" or not saw_process:
            raise PhonePolicyError("The lsof listener snapshot contained an unexpected record.")
        match = PORT_SUFFIX.search(value)
        if match is None:
            raise PhonePolicyError("The lsof listener endpoint was malformed.")
        port = int(match.group("port"))
        if port < 1 or port > 65_535:
            raise PhonePolicyError("The lsof listener port was outside the TCP range.")
        host = value[: match.start()]
        if not host or any(character.isspace() for character in host):
            raise PhonePolicyError("The lsof listener host was malformed.")
        listeners.append(Listener(host=host, port=port))

    if not listeners:
        raise PhonePolicyError("No TCP listeners were present in the lsof snapshot.")
    return tuple(listeners)


def _assert_required_loopback_services(listeners: Sequence[Listener]) -> None:
    for port in sorted(REQUIRED_LOOPBACK_PORTS):
        hosts = {listener.host for listener in listeners if listener.port == port}
        if hosts != {"127.0.0.1"}:
            raise PhonePolicyError(
                f"TCP/{port} must have exactly one loopback binding at 127.0.0.1 before phone access."
            )
    if any(listener.port == HTTPS_PORT for listener in listeners):
        raise PhonePolicyError("TCP/443 must be unused before the reviewed Tailscale Serve setup.")


def discover_listeners(
    run: Callable[..., subprocess.CompletedProcess[bytes]] = subprocess.run,
) -> tuple[Listener, ...]:
    environment = {
        "LANG": "C",
        "LC_ALL": "C",
        "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
    }
    try:
        result = run(
            [LSOF, "-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-Fpn"],
            capture_output=True,
            check=False,
            cwd="/",
            env=environment,
            input=None,
            shell=False,
            timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise PhonePolicyError("Unable to collect the bounded local TCP listener snapshot.") from error
    if result.returncode != 0 or result.stderr:
        raise PhonePolicyError("lsof did not return a clean TCP listener snapshot.")
    listeners = parse_lsof_snapshot(result.stdout)
    _assert_required_loopback_services(listeners)
    return listeners


def build_phone_policy(
    phone_ip: str,
    mac_ip: str,
    listeners: Sequence[Listener],
) -> dict[str, object]:
    canonical_phone_ip = _parse_tailscale_ipv4(phone_ip, "phone IP")
    canonical_mac_ip = _parse_tailscale_ipv4(mac_ip, "Mac IP")
    if canonical_phone_ip == canonical_mac_ip:
        raise PhonePolicyError("The phone and Mac must have distinct Tailscale IPv4 addresses.")
    _assert_required_loopback_services(listeners)

    denied_ports = sorted(
        BASELINE_DENIED_TCP_PORTS
        | {listener.port for listener in listeners if listener.port != HTTPS_PORT}
    )
    denied_destinations = [f"{MAC_ALIAS}:{port}" for port in denied_ports]
    return {
        "acls": [],
        "hosts": {
            MAC_ALIAS: canonical_mac_ip,
            PHONE_ALIAS: canonical_phone_ip,
        },
        "grants": [
            {
                "src": [PHONE_ALIAS],
                "dst": [MAC_ALIAS],
                "ip": ["tcp:443"],
            }
        ],
        "nodeAttrs": [],
        "ssh": [],
        "tests": [
            {
                "src": PHONE_ALIAS,
                "proto": "tcp",
                "accept": [f"{MAC_ALIAS}:443"],
                "deny": denied_destinations,
            },
            {
                "src": PHONE_ALIAS,
                "proto": "udp",
                "deny": [f"{MAC_ALIAS}:443", *denied_destinations],
            },
        ],
    }


def render_phone_policy(phone_ip: str, mac_ip: str) -> str:
    policy = build_phone_policy(phone_ip, mac_ip, discover_listeners())
    return f"{json.dumps(policy, indent=2, sort_keys=True)}\n"


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Render, but never apply, a deny-by-default Tailscale policy for the exact phone and Mac."
        )
    )
    parser.add_argument("--phone-ip", required=True, help="Exact physical-phone Tailscale IPv4")
    parser.add_argument("--mac-ip", required=True, help="Exact Mac Tailscale IPv4")
    return parser


def main(arguments: Sequence[str] | None = None) -> int:
    try:
        parsed = _parser().parse_args(arguments)
        sys.stdout.write(render_phone_policy(parsed.phone_ip, parsed.mac_ip))
        sys.stderr.write(
            "Rendered a local proposal only; review the complete existing tailnet policy and apply nothing automatically.\n"
        )
        return 0
    except PhonePolicyError as error:
        sys.stderr.write(f"{error}\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
