#!/usr/bin/python3
"""Resolve and pin the two reviewed OCI Object Storage hosts for Compose."""

import ipaddress
import json
import os
import pathlib
import socket
import stat
import subprocess
import tempfile
import urllib.parse


COORDINATES = pathlib.Path("/etc/nutrition-tracker/object-storage-coordinates.json")
OUTPUT_DIRECTORY = pathlib.Path("/run/nutrition-tracker")
OUTPUT = OUTPUT_DIRECTORY / "object-storage-hosts.env"
EXPECTED_KEYS = {
    "schemaVersion",
    "endpoint",
    "compatHost",
    "nativeHost",
    "region",
    "namespace",
    "exportBucket",
    "ledgerBucket",
    "restoreUserOcid",
    "tenancyOcid",
    "bridgeCidr",
    "objectStoragePublicCidrs",
}


def fail(message: str) -> None:
    raise SystemExit(message)


def read_coordinates() -> dict:
    metadata = COORDINATES.lstat()
    if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        fail("Object Storage coordinates must be a regular non-symlink file")
    if (metadata.st_uid, metadata.st_gid, stat.S_IMODE(metadata.st_mode)) != (0, 0, 0o644):
        fail("Object Storage coordinates must be root:root mode 0644")
    data = json.loads(COORDINATES.read_text(encoding="utf-8"))
    if set(data) != EXPECTED_KEYS or data["schemaVersion"] != 3:
        fail("Object Storage coordinates have an unexpected schema")
    endpoint = urllib.parse.urlsplit(data["endpoint"])
    if endpoint.scheme != "https" or endpoint.hostname != data["compatHost"] or endpoint.port is not None or endpoint.path not in ("", "/"):
        fail("S3 compatibility endpoint differs from its pinned hostname")
    expected_native = f'objectstorage.{data["region"]}.oraclecloud.com'
    if data["nativeHost"] != expected_native:
        fail("Native OCI Object Storage hostname differs from the region")
    return data


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


def reject_bridge_overlap(bridge: ipaddress.IPv4Network) -> None:
    routes = json.loads(subprocess.check_output(["ip", "-j", "-4", "route", "show", "table", "all"], text=True))
    for route in routes:
        destination = route.get("dst")
        if not destination or destination == "default":
            continue
        try:
            network = ipaddress.ip_network(destination, strict=False)
        except ValueError:
            continue
        expected_bridge_route = str(route.get("dev", "")).startswith("br-") and network.subnet_of(bridge)
        if network.overlaps(bridge) and not expected_bridge_route:
            fail(f"Object-egress bridge {bridge} overlaps host route {destination}")

    identifiers = subprocess.check_output(["docker", "network", "ls", "-q"], text=True).split()
    if not identifiers:
        return
    inventory = json.loads(subprocess.check_output(["docker", "network", "inspect", *identifiers], text=True))
    for network in inventory:
        for config in (network.get("IPAM", {}).get("Config") or []):
            subnet = config.get("Subnet")
            if not subnet:
                continue
            candidate = ipaddress.ip_network(subnet, strict=False)
            if candidate.version == bridge.version and candidate.overlaps(bridge) and not (
                network.get("Name") == "cronometer-gold-beta-object-egress" and candidate == bridge
            ):
                fail(f"Object-egress bridge {bridge} overlaps Docker network {network.get('Name')}")


def resolve(host: str, allowed_networks: tuple[ipaddress.IPv4Network, ...]) -> str:
    try:
        answers = sorted(
            {
                result[4][0]
                for result in socket.getaddrinfo(host, 443, socket.AF_INET, socket.SOCK_STREAM)
            },
            key=ipaddress.ip_address,
        )
    except socket.gaierror as error:
        fail(f"Could not resolve {host}: {error}")
    if not answers:
        fail(f"No IPv4 address resolved for {host}")
    outside = [
        address
        for address in answers
        if not any(ipaddress.ip_address(address) in network for network in allowed_networks)
    ]
    if outside:
        fail(f"{host} resolved outside the Terraform-frozen Object Storage public CIDRs: {outside}")
    return answers[0]


def write_environment(values: dict[str, str]) -> None:
    OUTPUT_DIRECTORY.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chown(OUTPUT_DIRECTORY, 0, 0)
    os.chmod(OUTPUT_DIRECTORY, 0o700)
    descriptor, temporary_name = tempfile.mkstemp(prefix=".object-storage-hosts.", dir=OUTPUT_DIRECTORY)
    temporary = pathlib.Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="ascii") as stream:
            for key, value in values.items():
                stream.write(f"{key}={value}\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.chown(temporary, 0, 0)
        os.chmod(temporary, 0o600)
        os.replace(temporary, OUTPUT)
        directory = os.open(OUTPUT_DIRECTORY, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)


def main() -> None:
    if os.geteuid() != 0:
        fail("Run this gate as root")
    data = read_coordinates()
    bridge = ipaddress.ip_network(data["bridgeCidr"], strict=True)
    networks = public_networks(data["objectStoragePublicCidrs"])
    if str(bridge) != "172.31.255.0/28" or bridge.version != 4:
        fail("Object-egress bridge CIDR differs from the reviewed fixed subnet")
    reject_bridge_overlap(bridge)
    write_environment(
        {
            "OCI_COMPAT_HOST": data["compatHost"],
            "OCI_COMPAT_IPV4": resolve(data["compatHost"], networks),
            "OCI_NATIVE_HOST": data["nativeHost"],
            "OCI_NATIVE_IPV4": resolve(data["nativeHost"], networks),
        }
    )


if __name__ == "__main__":
    main()
