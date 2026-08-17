#!/usr/bin/python3
"""Assert the exact fail-closed Docker egress chain without mutating it."""

import ipaddress
import json
import pathlib
import shlex
import stat
import subprocess


COORDINATES = pathlib.Path("/etc/nutrition-tracker/object-storage-coordinates.json")
CHAIN = "NUTRITION-OCI-EGRESS"


def fail(message: str) -> None:
    raise SystemExit(message)


def rules(chain: str) -> list[list[str]]:
    try:
        output = subprocess.check_output(["iptables", "-S", chain], text=True)
    except (OSError, subprocess.CalledProcessError) as error:
        fail(f"Could not inspect iptables chain {chain}: {error}")
    return [shlex.split(line) for line in output.splitlines() if line.startswith("-A ")]


def verify(forward_rules: list[list[str]], egress_rules: list[list[str]], bridge: str, service: str) -> None:
    expected_jump = ["-A", "FORWARD", "-s", bridge, "-j", CHAIN]
    if not forward_rules or forward_rules[0] != expected_jump or forward_rules.count(expected_jump) != 1:
        fail("The object-egress jump is not the unique first FORWARD rule")
    established = [
        "-A", CHAIN, "-d", service, "-p", "tcp", "-m", "tcp", "--dport", "443",
        "-m", "conntrack", "--ctstate", "ESTABLISHED", "-j", "ACCEPT",
    ]
    new_https = [
        "-A", CHAIN, "-d", service, "-p", "tcp", "-m", "tcp", "--dport", "443",
        "-m", "conntrack", "--ctstate", "NEW", "-j", "ACCEPT",
    ]
    reject = [
        "-A", CHAIN, "-j", "REJECT", "--reject-with", "icmp-port-unreachable"
    ]
    if egress_rules != [established, new_https, reject]:
        fail("The object-egress chain differs from the exact three reviewed rules")


def main() -> None:
    metadata = COORDINATES.lstat()
    if (
        not stat.S_ISREG(metadata.st_mode)
        or COORDINATES.is_symlink()
        or (metadata.st_uid, metadata.st_gid, metadata.st_mode & 0o777) != (0, 0, 0o644)
    ):
        fail("Object Storage coordinates must be a regular root:root mode 0644 file")
    coordinates = json.loads(COORDINATES.read_text(encoding="utf-8"))
    bridge_network = ipaddress.ip_network(coordinates.get("bridgeCidr", ""), strict=True)
    service_network = ipaddress.ip_network(coordinates.get("serviceCidr", ""), strict=True)
    if (
        str(bridge_network) != "172.31.255.0/28"
        or bridge_network.version != 4
        or service_network.version != 4
        or not service_network.is_global
    ):
        fail("Unexpected object-egress firewall coordinates")
    verify(
        rules("FORWARD"),
        rules(CHAIN),
        str(bridge_network),
        str(service_network),
    )


if __name__ == "__main__":
    main()
