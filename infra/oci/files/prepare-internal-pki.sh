#!/usr/bin/env bash
set -euo pipefail

readonly pki_root=/etc/nutrition-tracker/pki
readonly ca_dir="$pki_root/ca"
readonly trust_dir="$pki_root/trust"
readonly release_lock=/run/nutrition-release-orchestrator.lock
readonly deploy_env=/etc/nutrition-tracker/deploy.env
readonly compose_file=/opt/nutrition-tracker/compose.yaml
readonly project_name=cronometer-gold-beta
readonly compose=(/usr/bin/docker compose --env-file "$deploy_env" -f "$compose_file")
readonly operation_services=(migrate object-egress-negative-canary object-storage-live-canary erasure-restore-attestation database-readiness)
readonly runtime_services=(api web worker caddy postgres meilisearch)
readonly containment_services=(api web worker caddy postgres meilisearch "${operation_services[@]}")
rotation_staging_root=
stack_requires_reload=0
release_lock_held=0
pki_reload_attempted=0
pki_reload_committed=0

cleanup_rotation_staging() {
  [[ -n "$rotation_staging_root" ]] || return 0
  [[ "$rotation_staging_root" == "$pki_root"/.leaf-rotation.* ]] || {
    echo "Refusing to clean an unexpected PKI staging path" >&2
    return 1
  }
  rm -rf -- "$rotation_staging_root"
  rotation_staging_root=
}

usage() {
  echo "Usage: $0 init | verify [minimum-days] | rotate-if-needed [renewal-days]" >&2
  exit 64
}

certificate_specifications() {
  printf '%s\n' 'postgres postgres 70 70' 'meili meili.internal 1000 1000'
}

verify_leaf() {
  local service=$1
  local dns_name=$2
  local expected_uid=$3
  local expected_gid=$4
  local minimum_days=$5
  local directory="$pki_root/$service"
  local minimum_seconds=$((minimum_days * 86400))
  local key_digest
  local cert_digest

  [[ -s "$directory/server.key" && -s "$directory/server.crt" ]] || return 1
  openssl verify -CAfile "$ca_dir/ca.crt" "$directory/server.crt" >/dev/null || return 1
  openssl x509 -checkend "$minimum_seconds" -noout -in "$directory/server.crt" >/dev/null || return 1
  openssl x509 -noout -ext subjectAltName -in "$directory/server.crt" | grep -Fq "DNS:$dns_name" || return 1

  key_digest=$(openssl pkey -in "$directory/server.key" -pubout -outform DER | sha256sum | cut -d' ' -f1) || return 1
  cert_digest=$(openssl x509 -in "$directory/server.crt" -pubkey -noout | openssl pkey -pubin -outform DER | sha256sum | cut -d' ' -f1) || return 1
  [[ "$key_digest" == "$cert_digest" ]] || return 1
  [[ "$(stat -c '%u:%g:%a' "$directory/server.key")" == "$expected_uid:$expected_gid:600" ]] || return 1
  [[ "$(stat -c '%a' "$directory/server.crt")" == "644" ]] || return 1
  return 0
}

verify_all() {
  local minimum_days=$1
  [[ -s "$ca_dir/ca.crt" && -s "$ca_dir/ca.key" && -s "$trust_dir/ca.crt" ]] || return 1
  [[ "$(stat -c '%U:%G:%a' "$ca_dir/ca.key")" == "root:root:600" ]] || return 1
  cmp -s "$ca_dir/ca.crt" "$trust_dir/ca.crt" || return 1
  openssl x509 -checkend $((minimum_days * 86400)) -noout -in "$ca_dir/ca.crt" >/dev/null || return 1
  while read -r service dns_name uid gid; do
    verify_leaf "$service" "$dns_name" "$uid" "$gid" "$minimum_days" || return 1
  done < <(certificate_specifications)
  return 0
}

acquire_release_lock_and_inspect_stack() {
  local unit_state service running
  [[ $release_lock_held -eq 0 ]] || return 0
  umask 077
  exec 8>"$release_lock"
  flock -n 8 || { echo "Release orchestration is active; retry PKI rotation later" >&2; exit 75; }
  release_lock_held=1
  unit_state=$(systemctl is-active nutrition-tracker.service 2>/dev/null || true)
  case "$unit_state" in
    activating|deactivating|reloading)
      echo "nutrition-tracker.service is $unit_state; retry PKI rotation later" >&2
      exit 75
      ;;
  esac
  for service in "${operation_services[@]}"; do
    running=$(/usr/bin/docker ps -q \
      --filter "label=com.docker.compose.project=$project_name" \
      --filter "label=com.docker.compose.service=$service")
    [[ -z "$running" ]] || {
      echo "Offline operation $service is still running; retry PKI rotation after guarded cleanup" >&2
      exit 75
    }
  done
  [[ "$unit_state" != active ]] || stack_requires_reload=1
  for service in "${runtime_services[@]}"; do
    running=$(/usr/bin/docker ps -q \
      --filter "label=com.docker.compose.project=$project_name" \
      --filter "label=com.docker.compose.service=$service")
    [[ -z "$running" ]] || stack_requires_reload=1
  done
  if [[ $stack_requires_reload -eq 1 ]]; then
    [[ -f "$deploy_env" && -f "$compose_file" ]] || {
      echo "A core container is live but its reviewed Compose configuration is missing" >&2
      exit 1
    }
  fi
}

contain_failed_pki_reload() {
  local service containers container failed=0
  for service in "${containment_services[@]}"; do
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
  for service in "${containment_services[@]}"; do
    containers=$(/usr/bin/docker ps -q \
      --filter "label=com.docker.compose.project=$project_name" \
      --filter "label=com.docker.compose.service=$service") || failed=1
    [[ -z "$containers" ]] || failed=1
  done
  systemctl --no-block stop nutrition-tracker.service || failed=1
  if [[ $failed -ne 0 ]]; then
    echo "PKI reload failed and complete application/core containment could not be proven" >&2
  else
    echo "PKI reload failed; application/core containers were stopped and the release unit was invalidated" >&2
  fi
  [[ $failed -eq 0 ]]
}

pki_exit_cleanup() {
  local status=$? containment_status=0 cleanup_status=0
  trap - EXIT HUP INT TERM
  if [[ $pki_reload_attempted -eq 1 && $pki_reload_committed -eq 0 ]]; then
    contain_failed_pki_reload || containment_status=$?
    [[ $status -ne 0 ]] || status=1
  fi
  cleanup_rotation_staging || cleanup_status=$?
  if [[ $containment_status -ne 0 || $cleanup_status -ne 0 ]]; then
    status=1
  fi
  exit "$status"
}
trap pki_exit_cleanup EXIT
trap 'exit 143' HUP INT TERM

served_leaves_match_disk() {
  local postgres_id caddy_id postgres_ip expected served
  postgres_id=$("${compose[@]}" ps -q postgres)
  caddy_id=$("${compose[@]}" ps -q caddy)
  [[ "$postgres_id" =~ ^[0-9a-f]{12,64}$ && "$caddy_id" =~ ^[0-9a-f]{12,64}$ ]] || return 1
  postgres_ip=$(/usr/bin/docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$postgres_id")
  [[ "$postgres_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1

  expected=$(openssl x509 -in "$pki_root/postgres/server.crt" -noout -fingerprint -sha256) || return 1
  served=$(timeout 15 openssl s_client -starttls postgres -connect "$postgres_ip:5432" \
    -servername postgres -verify_hostname postgres -verify_return_error \
    -CAfile "$trust_dir/ca.crt" </dev/null 2>/dev/null | \
    openssl x509 -noout -fingerprint -sha256) || return 1
  [[ "$served" == "$expected" ]] || return 1

  expected=$(openssl x509 -in "$pki_root/meili/server.crt" -noout -fingerprint -sha256) || return 1
  served=$(timeout 15 openssl s_client -connect 127.0.0.1:8443 \
    -servername meili.internal -verify_hostname meili.internal -verify_return_error \
    -CAfile "$trust_dir/ca.crt" </dev/null 2>/dev/null | \
    openssl x509 -noout -fingerprint -sha256) || return 1
  [[ "$served" == "$expected" ]]
}

reload_and_verify_served_leaves() {
  [[ $stack_requires_reload -eq 1 ]] || return 0
  pki_reload_attempted=1
  if ! "${compose[@]}" up -d --no-build --pull never --force-recreate \
    --wait --wait-timeout 300 caddy postgres meilisearch; then
    echo "Core container recreation failed after internal TLS leaf publication" >&2
    return 1
  fi
  if ! served_leaves_match_disk; then
    echo "Core containers do not serve the newly installed internal TLS leaves" >&2
    return 1
  fi
  pki_reload_committed=1
}

issue_leaf_to_staging() {
  local staging_root=$1
  local service=$2
  local dns_name=$3
  local directory="$staging_root/$service"
  local config="$directory/openssl.cnf"

  install -d -m 0700 "$directory"
  {
    echo '[req]'
    echo 'distinguished_name = dn'
    echo 'prompt = no'
    echo 'req_extensions = extensions'
    echo '[dn]'
    echo "CN = $dns_name"
    echo '[extensions]'
    echo "subjectAltName = DNS:$dns_name"
    echo 'keyUsage = critical,digitalSignature,keyEncipherment'
    echo 'extendedKeyUsage = serverAuth'
  } >"$config"

  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$directory/server.key"
  openssl req -new -key "$directory/server.key" -config "$config" -out "$directory/server.csr"
  openssl x509 -req -in "$directory/server.csr" -CA "$ca_dir/ca.crt" \
    -CAkey "$ca_dir/ca.key" -CAcreateserial -days 90 -sha256 \
    -extfile "$config" -extensions extensions -out "$directory/server.crt"
  openssl verify -CAfile "$ca_dir/ca.crt" "$directory/server.crt" >/dev/null
  openssl x509 -noout -ext subjectAltName -in "$directory/server.crt" | grep -Fq "DNS:$dns_name"
}

rotate_leaves() {
  acquire_release_lock_and_inspect_stack
  rotation_staging_root=$(mktemp -d "$pki_root/.leaf-rotation.XXXXXX")

  pki_reload_attempted=$stack_requires_reload
  while read -r service dns_name uid gid; do
    issue_leaf_to_staging "$rotation_staging_root" "$service" "$dns_name"
  done < <(certificate_specifications)

  while read -r service dns_name uid gid; do
    install -d -o "$uid" -g "$gid" -m 0750 "$pki_root/$service"
    install -o "$uid" -g "$gid" -m 0600 "$rotation_staging_root/$service/server.key" "$pki_root/$service/server.key.next"
    install -o "$uid" -g "$gid" -m 0644 "$rotation_staging_root/$service/server.crt" "$pki_root/$service/server.crt.next"
  done < <(certificate_specifications)

  while read -r service dns_name uid gid; do
    mv -f "$pki_root/$service/server.key.next" "$pki_root/$service/server.key"
    mv -f "$pki_root/$service/server.crt.next" "$pki_root/$service/server.crt"
  done < <(certificate_specifications)

  verify_all 14
  reload_and_verify_served_leaves
  cleanup_rotation_staging
}

command=${1:-}
case "$command" in
  init)
    acquire_release_lock_and_inspect_stack
    if [[ -e "$ca_dir/ca.key" || -e "$ca_dir/ca.crt" ]]; then
      echo "Refusing to overwrite an existing internal CA; use rotate-if-needed for leaf renewal" >&2
      exit 1
    fi
    install -d -m 0711 "$pki_root"
    install -d -m 0700 "$ca_dir"
    install -d -m 0755 "$trust_dir"
    openssl genpkey -algorithm ED25519 -out "$ca_dir/ca.key"
    openssl req -x509 -new -key "$ca_dir/ca.key" -days 1825 \
      -subj "/CN=nutrition-tracker-internal-ca" -out "$ca_dir/ca.crt"
    chown root:root "$ca_dir/ca.key" "$ca_dir/ca.crt"
    chmod 0600 "$ca_dir/ca.key"
    chmod 0644 "$ca_dir/ca.crt"
    install -o root -g root -m 0644 "$ca_dir/ca.crt" "$trust_dir/ca.crt"
    install -d -o 1000 -g 1000 -m 0700 /var/lib/nutrition-tracker/caddy/data /var/lib/nutrition-tracker/caddy/config
    rotate_leaves
    echo "Internal CA and renewable 90-day leaf certificates created. Securely back up the CA."
    ;;
  verify)
    minimum_days=${2:-14}
    [[ "$minimum_days" =~ ^[0-9]+$ ]] || usage
    verify_all "$minimum_days" || {
      echo "Internal PKI verification failed or a certificate expires within $minimum_days days" >&2
      exit 1
    }
    ;;
  rotate-if-needed)
    renewal_days=${2:-30}
    [[ "$renewal_days" =~ ^[0-9]+$ ]] || usage
    if [[ ! -e "$ca_dir/ca.key" ]]; then
      echo "Internal PKI is not initialized; run '$0 init' before deployment" >&2
      exit 1
    fi
    if verify_all "$renewal_days"; then
      acquire_release_lock_and_inspect_stack
      if [[ $stack_requires_reload -eq 1 ]] && ! served_leaves_match_disk; then
        reload_and_verify_served_leaves
      fi
      exit 0
    fi
    rotate_leaves
    echo "Internal leaf certificates rotated and dependent containers restarted."
    ;;
  *)
    usage
    ;;
esac
