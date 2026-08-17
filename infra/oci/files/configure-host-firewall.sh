#!/usr/bin/env bash
set -euo pipefail

command -v firewall-cmd >/dev/null || {
  echo "Oracle Linux firewalld is required but firewall-cmd is unavailable" >&2
  exit 1
}

systemctl enable --now firewalld
default_interface=$(ip -4 route show default | awk 'NR == 1 { print $5 }')
[[ -n "$default_interface" ]] || { echo "Cannot determine the default network interface" >&2; exit 1; }
zone=$(firewall-cmd --get-zone-of-interface "$default_interface")
if [[ -z "$zone" || "$zone" == "no zone" ]]; then
  zone=$(firewall-cmd --get-default-zone)
fi
[[ -n "$zone" ]] || { echo "Cannot determine the firewalld zone" >&2; exit 1; }

# Add only the two edge services. Existing SSH and OCI platform rules remain
# intact; the firewall is never disabled or flushed.
for service in http https; do
  firewall-cmd --permanent --zone "$zone" --add-service "$service" >/dev/null
done
firewall-cmd --reload >/dev/null

for service in http https; do
  firewall-cmd --zone "$zone" --query-service "$service" >/dev/null || {
    echo "firewalld failed to admit $service on zone $zone" >&2
    exit 1
  }
done
printf '%s\n' "$default_interface $zone" >/etc/nutrition-tracker/firewall-interface-zone
chown root:root /etc/nutrition-tracker/firewall-interface-zone
chmod 0644 /etc/nutrition-tracker/firewall-interface-zone
