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
bridge = ipaddress.ip_network(data.get("bridgeCidr", ""), strict=True)
service = ipaddress.ip_network(data.get("serviceCidr", ""), strict=True)
if str(bridge) != "172.31.255.0/28" or bridge.version != 4:
    raise SystemExit("Unexpected object-egress bridge CIDR")
if service.version != 4 or not service.is_global:
    raise SystemExit("Object Storage service CIDR must be a canonical public IPv4 network")
print(bridge, service)
PY
)
read -r bridge_cidr service_cidr <<<"$coordinates"
[[ -n "$bridge_cidr" && -n "$service_cidr" ]] || {
  echo "Missing reviewed object-egress firewall coordinates" >&2
  exit 1
}

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
iptables -A "$chain" -d "$service_cidr" -p tcp --dport 443 -m conntrack --ctstate ESTABLISHED -j ACCEPT
iptables -A "$chain" -d "$service_cidr" -p tcp --dport 443 -m conntrack --ctstate NEW -j ACCEPT
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
