#!/usr/bin/env bash
set -euo pipefail

readonly release_lock=/run/nutrition-release-orchestrator.lock
readonly project_name=cronometer-gold-beta
readonly services=(api web worker migrate object-egress-negative-canary object-storage-live-canary erasure-restore-attestation database-readiness caddy postgres meilisearch)
failed=0

umask 077
case ${1:-} in
  "")
    exec 9>"$release_lock"
    flock -w 120 9 || { echo "Timed out waiting to contain a failed release" >&2; exit 1; }
    ;;
  --lock-held)
    inherited_lock=$(readlink "/proc/$$/fd/9") || {
      echo "Containment did not inherit release-lock descriptor 9" >&2
      exit 1
    }
    [[ "$inherited_lock" == "$release_lock" ]] || {
      echo "Containment inherited an unexpected release-lock descriptor" >&2
      exit 1
    }
    flock -n 9 || {
      echo "Containment caller does not hold the inherited release lock" >&2
      exit 1
    }
    ;;
  *)
    echo "Usage: $0 [--lock-held]" >&2
    exit 64
    ;;
esac

for service in "${services[@]}"; do
  containers=$(/usr/bin/docker ps -q \
    --filter "label=com.docker.compose.project=$project_name" \
    --filter "label=com.docker.compose.service=$service") || {
    failed=1
    continue
  }
  for container in $containers; do
    if [[ ! "$container" =~ ^[0-9a-f]{12,64}$ ]] || \
      ! /usr/bin/docker stop --time 60 "$container" >/dev/null; then
      failed=1
    fi
  done
done

for service in "${services[@]}"; do
  containers=$(/usr/bin/docker ps -q \
    --filter "label=com.docker.compose.project=$project_name" \
    --filter "label=com.docker.compose.service=$service") || failed=1
  [[ -z "$containers" ]] || failed=1
done

# When PKI rotation fails, invalidate a previously active RemainAfterExit unit
# so the next operator start cannot be a no-op. The queued ExecStop is safe even
# if it observes this containment lock: every container is already stopped.
systemctl --no-block stop nutrition-tracker.service || failed=1
[[ $failed -eq 0 ]] || {
  echo "Failed-release containment could not prove every project service stopped" >&2
  exit 1
}
echo "Failed-release containment stopped and verified the application, operations, and core services."
