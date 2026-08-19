#!/usr/bin/env bash
set -euo pipefail

readonly coordinates_file=/etc/nutrition-tracker/object-storage-coordinates.json
readonly chain=NUTRITION-OCI-EGRESS

[[ "$(stat -c '%U:%G:%a' "$coordinates_file")" == "root:root:644" ]] || {
  echo "Object Storage coordinates must be root:root mode 0644" >&2
  exit 1
}
coordinates=$(python3 - "$coordinates_file" <<'PY'
import ipaddress, json, pathlib, sys

data = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
expected_keys = {
    "schemaVersion", "endpoint", "compatHost", "nativeHost", "region", "namespace",
    "exportBucket", "ledgerBucket", "restoreUserOcid", "tenancyOcid", "bridgeCidr",
    "objectStoragePublicCidrs",
}
if set(data) != expected_keys or data["schemaVersion"] != 3:
    raise SystemExit("Object Storage coordinates have an unexpected schema")
bridge = ipaddress.ip_network(data.get("bridgeCidr", ""), strict=True)
if str(bridge) != "172.31.255.0/28" or bridge.version != 4:
    raise SystemExit("Unexpected object-egress bridge CIDR")
values = data["objectStoragePublicCidrs"]
if not isinstance(values, list) or len(values) != 2 or any(not isinstance(value, str) for value in values):
    raise SystemExit("Object Storage public CIDRs must contain exactly two strings")
if values != sorted(values) or len(values) != len(set(values)):
    raise SystemExit("Object Storage public CIDRs must be sorted and unique")
try:
    networks = [ipaddress.ip_network(value, strict=True) for value in values]
except ValueError as error:
    raise SystemExit(f"Object Storage public CIDRs are invalid: {error}") from error
if any(network.version != 4 or not network.is_global or str(network) != value for value, network in zip(values, networks)):
    raise SystemExit("Object Storage public CIDRs must be canonical public IPv4 networks")
if any(left.overlaps(right) for index, left in enumerate(networks) for right in networks[index + 1:]):
    raise SystemExit("Object Storage public CIDRs may not overlap")
print(bridge, *networks)
PY
)
read -r -a firewall_coordinates <<<"$coordinates"
[[ "${#firewall_coordinates[@]}" -eq 3 ]] || {
  echo "Missing reviewed object-egress firewall coordinates" >&2
  exit 1
}
readonly bridge_cidr=${firewall_coordinates[0]}
readonly -a object_storage_public_cidrs=("${firewall_coordinates[@]:1}")

command -v iptables >/dev/null || {
  echo "The controlled-beta FORWARD egress gate requires iptables" >&2
  exit 1
}
iptables -nL FORWARD >/dev/null 2>&1 || {
  echo "The FORWARD chain is unavailable for the object-egress gate" >&2
  exit 1
}
if ! iptables -nL "$chain" >/dev/null 2>&1; then
  iptables -N "$chain"
fi
iptables -F "$chain"
for object_storage_public_cidr in "${object_storage_public_cidrs[@]}"; do
  iptables -A "$chain" -d "$object_storage_public_cidr" -p tcp --dport 443 -m conntrack --ctstate ESTABLISHED -j ACCEPT
  iptables -A "$chain" -d "$object_storage_public_cidr" -p tcp --dport 443 -m conntrack --ctstate NEW -j ACCEPT
done
iptables -A "$chain" -j REJECT --reject-with icmp-port-unreachable
# Normalize only module-owned rules. A watchdog drift response may have placed
# one or more first-position quarantine rejects before it acquired the release
# lock. No reviewed application container is live while these are removed.
while iptables -C FORWARD -s "$bridge_cidr" -j "$chain" >/dev/null 2>&1; do
  iptables -D FORWARD -s "$bridge_cidr" -j "$chain"
done
while iptables -C FORWARD -s "$bridge_cidr" -j REJECT --reject-with icmp-port-unreachable >/dev/null 2>&1; do
  iptables -D FORWARD -s "$bridge_cidr" -j REJECT --reject-with icmp-port-unreachable
done
iptables -I FORWARD 1 -s "$bridge_cidr" -j "$chain"

iptables -C FORWARD -s "$bridge_cidr" -j "$chain" >/dev/null
/usr/local/sbin/nutrition-assert-object-egress-firewall
