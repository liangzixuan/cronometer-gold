#!/usr/bin/env bash
set -euo pipefail

readonly bridge_cidr=172.31.255.0/28
readonly release_lock=/run/nutrition-release-orchestrator.lock

# shellcheck disable=SC2317 # Invoked indirectly by the EXIT trap below.
invalidate_on_true_failure() {
  local status=$?
  trap - EXIT
  if [[ $status -ne 0 && $status -ne 3 ]]; then
    systemctl --no-block stop nutrition-tracker.service || \
      echo "Could not invalidate the controlled-beta release after watchdog failure" >&2
  fi
  exit "$status"
}
trap invalidate_on_true_failure EXIT

if /usr/local/sbin/nutrition-assert-object-egress-firewall; then
  exit 0
fi

systemctl --no-block stop nutrition-tracker.service || {
  echo "Could not immediately invalidate the active controlled-beta release" >&2
  exit 1
}

# Quarantine is deliberately installed before waiting for the release lock.
# It blocks both new and established traffic sourced by the object bridge even
# when a migration/canary/start currently owns the orchestration lock.
iptables -nL FORWARD >/dev/null 2>&1 || {
  echo "Cannot quarantine object egress because FORWARD is unavailable" >&2
  exit 1
}
iptables -I FORWARD 1 -s "$bridge_cidr" -j REJECT --reject-with icmp-port-unreachable
first_rule=$(iptables -S FORWARD | sed -n '1p') || {
  echo "Could not inspect the immediate object-egress quarantine" >&2
  exit 1
}
[[ "$first_rule" == "-A FORWARD -s $bridge_cidr -j REJECT --reject-with icmp-port-unreachable" ]] || {
  echo "Immediate object-egress quarantine is not the first FORWARD rule" >&2
  exit 1
}
exec 9>"$release_lock"
flock -w 120 9 || {
  echo "Object egress remains quarantined after containment lock timeout" >&2
  exit 1
}
/usr/local/sbin/nutrition-contain-failed-release --lock-held || {
  echo "Refusing firewall repair because stack containment was not proven" >&2
  exit 1
}
/usr/local/sbin/nutrition-configure-object-egress-firewall
/usr/local/sbin/nutrition-assert-object-egress-firewall || {
  echo "Object-egress firewall repair did not restore the exact reviewed rules" >&2
  exit 1
}
echo "Object-egress firewall was repaired only after fail-closed stack containment" >&2
exit 3
