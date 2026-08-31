#!/usr/bin/env bash
set -euo pipefail

readonly deploy_env=/etc/nutrition-tracker/deploy.env
readonly compose_file=/opt/nutrition-tracker/compose.yaml
readonly lock_file=/run/nutrition-release-orchestrator.lock
readonly credential_lock_file=/run/nutrition-object-credential-rotation.lock
readonly credential_token_file=/run/nutrition-object-credential-rotation.token
readonly credential_admission_file=/run/nutrition-object-credential-start-admission
readonly object_hosts_env=/run/nutrition-tracker/object-storage-hosts.env
readonly project_name=cronometer-gold-beta
readonly compose=(/usr/bin/docker compose --env-file "$deploy_env" -f "$compose_file")
umask 077
application_start_attempted=0
readiness_committed=0

admit_rotation_start() {
  local status token admission
  exec 8>"$credential_lock_file"
  set +e
  flock -n -E 75 8
  status=$?
  set -e
  case "$status" in
    0)
      rm -f -- "$credential_token_file" "$credential_admission_file"
      return 0
      ;;
    75)
      exec 8>&-
      for file in "$credential_token_file" "$credential_admission_file"; do
        [[ ! -L "$file" && -f "$file" && "$(stat -c '%U:%G:%a' "$file")" == root:root:400 ]] || {
          echo "Credential rotation has not admitted this release start" >&2
          return 1
        }
      done
      IFS= read -r token <"$credential_token_file"
      IFS= read -r admission <"$credential_admission_file"
      [[ "$token" =~ ^[0-9a-f]{64}$ && "$admission" == "$token" ]] || {
        echo "Credential rotation start admission does not match the active lock" >&2
        return 1
      }
      rm -f -- "$credential_admission_file"
      ;;
    *)
      exec 8>&-
      echo "Could not inspect the credential-rotation lock" >&2
      return 1
      ;;
  esac
}

load_object_storage_hosts() {
  local key value
  while IFS='=' read -r key value; do
    case "$key" in
      OCI_COMPAT_HOST|OCI_COMPAT_IPV4|OCI_NATIVE_HOST|OCI_NATIVE_IPV4)
        [[ -n "$value" ]] || { echo "Empty $key in $object_hosts_env" >&2; return 1; }
        export "$key=$value"
        ;;
      *)
        echo "Unexpected key in $object_hosts_env: $key" >&2
        return 1
        ;;
    esac
  done <"$object_hosts_env"
  for key in OCI_COMPAT_HOST OCI_COMPAT_IPV4 OCI_NATIVE_HOST OCI_NATIVE_IPV4; do
    [[ -n "${!key:-}" ]] || { echo "Missing $key in $object_hosts_env" >&2; return 1; }
  done
}

stop_stale_operations() {
  local service container
  for service in migrate object-egress-negative-canary object-storage-live-canary erasure-restore-attestation database-readiness; do
    while read -r container; do
      [[ -z "$container" ]] && continue
      [[ "$container" =~ ^[0-9a-f]{12,64}$ ]] || {
        echo "Docker returned an invalid container ID for $service" >&2
        return 1
      }
      /usr/bin/docker stop --time 60 "$container" >/dev/null
      /usr/bin/docker rm "$container" >/dev/null
    done < <(/usr/bin/docker ps -aq \
      --filter "label=com.docker.compose.project=$project_name" \
      --filter "label=com.docker.compose.service=$service")
  done
}

assert_release_services_stopped() {
  local service running
  for service in api web worker migrate object-egress-negative-canary object-storage-live-canary erasure-restore-attestation database-readiness; do
    running=$(/usr/bin/docker ps -q \
      --filter "label=com.docker.compose.project=$project_name" \
      --filter "label=com.docker.compose.service=$service") || {
      echo "Could not inspect release service $service" >&2
      return 1
    }
    [[ -z "$running" ]] || {
      echo "Release service $service is still running; offline gates will not execute" >&2
      return 1
    }
  done
}

stop_release_containers() {
  local service containers container failed=0
  for service in api web worker migrate object-egress-negative-canary object-storage-live-canary erasure-restore-attestation database-readiness; do
    containers=$(/usr/bin/docker ps -q \
      --filter "label=com.docker.compose.project=$project_name" \
      --filter "label=com.docker.compose.service=$service") || {
      echo "Could not inspect $service during release containment" >&2
      failed=1
      continue
    }
    for container in $containers; do
      [[ "$container" =~ ^[0-9a-f]{12,64}$ ]] || {
        echo "Docker returned an invalid container ID for $service" >&2
        failed=1
        continue
      }
      /usr/bin/docker stop --time 60 "$container" >/dev/null || failed=1
    done
  done
  [[ $failed -eq 0 ]]
}

contain_uncommitted_application_start() {
  local status=$? containment_failed=0
  trap - EXIT
  if [[ $application_start_attempted -eq 1 && $readiness_committed -eq 0 ]]; then
    stop_release_containers || containment_failed=1
    assert_release_services_stopped || containment_failed=1
    if [[ $containment_failed -ne 0 ]]; then
      echo "Release failed and application containment also failed; immediate operator intervention is required" >&2
    else
      echo "Release was not committed; API, web, and worker were stopped" >&2
    fi
    [[ $status -ne 0 ]] || status=1
  fi
  exit "$status"
}
trap contain_uncommitted_application_start EXIT

exec 9>"$lock_file"
flock -n 9 || { echo "Another release orchestration is active" >&2; exit 1; }

command=${1:-}
case "$command" in
  start)
    admit_rotation_start
    application_start_attempted=1
    # Fail closed on a previously running application while migration and
    # restore-attestation gates are re-established for this exact database.
    "${compose[@]}" --profile application stop api web worker
    stop_stale_operations
    assert_release_services_stopped
    /usr/local/sbin/nutrition-instance-identity verify-runtime
    /usr/local/sbin/nutrition-prepare-object-storage-egress
    load_object_storage_hosts
    /usr/local/sbin/nutrition-deployment-preflight early

    "${compose[@]}" up -d --wait --wait-timeout 300 caddy postgres meilisearch
    /usr/local/sbin/nutrition-bootstrap-meili-keys
    /usr/local/sbin/nutrition-deployment-preflight full

    "${compose[@]}" --profile operations run --rm object-egress-negative-canary
    "${compose[@]}" --profile operations run --rm object-storage-live-canary
    # Run the migration twice: the second execution is an idempotency/replay
    # proof for the exact image and database before restore attestation.
    "${compose[@]}" --profile operations run --rm migrate
    "${compose[@]}" --profile operations run --rm migrate
    "${compose[@]}" --profile operations run --rm erasure-restore-attestation
    "${compose[@]}" --profile operations run --rm database-readiness

    /usr/local/sbin/nutrition-assert-object-egress-firewall
    if ! "${compose[@]}" --profile application up -d --wait --wait-timeout 300 api web worker; then
      echo "Application Compose startup or health validation failed" >&2
      exit 1
    fi

    api_fqdn=$(sed -n 's/^API_FQDN=//p' "$deploy_env")
    [[ "$api_fqdn" =~ ^[a-z0-9.-]+$ ]] || { echo "Invalid API_FQDN" >&2; exit 1; }
    for attempt in $(seq 1 60); do
      if curl --fail --silent --show-error \
        --connect-timeout 5 --max-time 10 \
        --resolve "$api_fqdn:443:127.0.0.1" \
        "https://$api_fqdn/ready" >/dev/null; then
        readiness_committed=1
        echo "Release gates passed and public-certificate HTTPS readiness is healthy."
        exit 0
      fi
      [[ "$attempt" != "60" ]] || break
      sleep 5
    done

    echo "HTTPS readiness failed" >&2
    exit 1
    ;;
  stop)
    application_start_attempted=1
    "${compose[@]}" --profile application down --timeout 610
    stop_stale_operations
    assert_release_services_stopped
    readiness_committed=1
    ;;
  *)
    echo "Usage: $0 start|stop" >&2
    exit 64
    ;;
esac
