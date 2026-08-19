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


def public_networks(values: object) -> tuple[ipaddress.IPv4Network, ...]:
    if not isinstance(values, list) or len(values) != 2 or any(not isinstance(value, str) for value in values):
        fail("Object Storage public CIDRs must contain exactly two strings")
    if values != sorted(values) or len(values) != len(set(values)):
        fail("Object Storage public CIDRs must be sorted and unique")
    try:
        networks = tuple(ipaddress.ip_network(value, strict=True) for value in values)
    except ValueError as error:
        fail(f"Object Storage public CIDRs are invalid: {error}")
    if any(network.version != 4 or not network.is_global or str(network) != value for value, network in zip(values, networks)):
        fail("Object Storage public CIDRs must be canonical public IPv4 networks")
    if any(left.overlaps(right) for index, left in enumerate(networks) for right in networks[index + 1 :]):
        fail("Object Storage public CIDRs may not overlap")
    return networks


def verify(
    forward_rules: list[list[str]],
    egress_rules: list[list[str]],
    bridge: str,
    public_cidrs: tuple[str, ...],
) -> None:
    expected_jump = ["-A", "FORWARD", "-s", bridge, "-j", CHAIN]
    if not forward_rules or forward_rules[0] != expected_jump or forward_rules.count(expected_jump) != 1:
        fail("The object-egress jump is not the unique first FORWARD rule")
    expected_egress_rules = []
    for public_cidr in public_cidrs:
        expected_egress_rules.extend(
            [
                [
                    "-A", CHAIN, "-d", public_cidr, "-p", "tcp", "-m", "tcp", "--dport", "443",
                    "-m", "conntrack", "--ctstate", "ESTABLISHED", "-j", "ACCEPT",
                ],
                [
                    "-A", CHAIN, "-d", public_cidr, "-p", "tcp", "-m", "tcp", "--dport", "443",
                    "-m", "conntrack", "--ctstate", "NEW", "-j", "ACCEPT",
                ],
            ]
        )
    reject = [
        "-A", CHAIN, "-j", "REJECT", "--reject-with", "icmp-port-unreachable"
    ]
    expected_egress_rules.append(reject)
    if egress_rules != expected_egress_rules:
        fail("The object-egress chain differs from the exact reviewed rules")


def main() -> None:
    metadata = COORDINATES.lstat()
    if (
        not stat.S_ISREG(metadata.st_mode)
        or COORDINATES.is_symlink()
        or (metadata.st_uid, metadata.st_gid, metadata.st_mode & 0o777) != (0, 0, 0o644)
    ):
        fail("Object Storage coordinates must be a regular root:root mode 0644 file")
    coordinates = json.loads(COORDINATES.read_text(encoding="utf-8"))
    expected_keys = {
        "schemaVersion", "endpoint", "compatHost", "nativeHost", "region", "namespace",
        "exportBucket", "ledgerBucket", "restoreUserOcid", "tenancyOcid", "bridgeCidr",
        "objectStoragePublicCidrs",
    }
    if set(coordinates) != expected_keys or coordinates["schemaVersion"] != 3:
        fail("Object Storage coordinates have an unexpected schema")
    bridge_network = ipaddress.ip_network(coordinates.get("bridgeCidr", ""), strict=True)
    networks = public_networks(coordinates["objectStoragePublicCidrs"])
    if str(bridge_network) != "172.31.255.0/28" or bridge_network.version != 4:
        fail("Unexpected object-egress firewall coordinates")
    verify(
        rules("FORWARD"),
        rules(CHAIN),
        str(bridge_network),
        tuple(str(network) for network in networks),
    )


if __name__ == "__main__":
    main()
