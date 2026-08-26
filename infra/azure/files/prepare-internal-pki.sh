#!/usr/bin/env bash
set -euo pipefail

readonly pki_root=/etc/nutrition-tracker/pki
readonly ca_dir="$pki_root/ca"
readonly trust_dir="$pki_root/trust"

[[ ${EUID} -eq 0 ]] || { echo "Run this PKI helper as root" >&2; exit 1; }

usage() {
  echo "Usage: $0 init | verify [minimum-days]" >&2
  exit 64
}

certificate_specifications() {
  printf '%s\n' \
    'postgres postgres 70 70 server.crt server.key' \
    'meili meili.internal 1000 1000 server.crt server.key'
}

verify_leaf() {
  local service=$1 dns_name=$2 expected_uid=$3 expected_gid=$4 cert_name=$5 key_name=$6 minimum_days=$7
  local directory="$pki_root/$service" key_digest cert_digest
  [[ -f "$directory/$key_name" && ! -L "$directory/$key_name" ]] || return 1
  [[ -f "$directory/$cert_name" && ! -L "$directory/$cert_name" ]] || return 1
  openssl verify -CAfile "$ca_dir/ca.crt" "$directory/$cert_name" >/dev/null || return 1
  openssl x509 -checkend $((minimum_days * 86400)) -noout -in "$directory/$cert_name" >/dev/null || return 1
  openssl x509 -noout -ext subjectAltName -in "$directory/$cert_name" | grep -Fq "DNS:$dns_name" || return 1
  key_digest=$(openssl pkey -in "$directory/$key_name" -pubout -outform DER | sha256sum | cut -d' ' -f1) || return 1
  cert_digest=$(openssl x509 -in "$directory/$cert_name" -pubkey -noout | openssl pkey -pubin -outform DER | sha256sum | cut -d' ' -f1) || return 1
  [[ "$key_digest" == "$cert_digest" ]] || return 1
  [[ "$(stat -c '%u:%g:%a' "$directory/$key_name")" == "$expected_uid:$expected_gid:600" ]] || return 1
  [[ "$(stat -c '%u:%g:%a' "$directory/$cert_name")" == "$expected_uid:$expected_gid:644" ]] || return 1
}

verify_all() {
  local minimum_days=$1
  [[ -f "$ca_dir/ca.key" && ! -L "$ca_dir/ca.key" ]] || return 1
  [[ -f "$ca_dir/ca.crt" && ! -L "$ca_dir/ca.crt" ]] || return 1
  [[ -f "$trust_dir/ca.crt" && ! -L "$trust_dir/ca.crt" ]] || return 1
  [[ "$(stat -c '%u:%g:%a' "$ca_dir/ca.key")" == "0:0:600" ]] || return 1
  [[ "$(stat -c '%u:%g:%a' "$ca_dir/ca.crt")" == "0:0:644" ]] || return 1
  [[ "$(stat -c '%u:%g:%a' "$trust_dir/ca.crt")" == "0:0:644" ]] || return 1
  cmp -s "$ca_dir/ca.crt" "$trust_dir/ca.crt" || return 1
  openssl x509 -checkend $((minimum_days * 86400)) -noout -in "$ca_dir/ca.crt" >/dev/null || return 1
  while read -r service dns_name uid gid cert_name key_name; do
    verify_leaf "$service" "$dns_name" "$uid" "$gid" "$cert_name" "$key_name" "$minimum_days" || return 1
  done < <(certificate_specifications)
}

issue_leaf() {
  local staging=$1 service=$2 dns_name=$3
  local directory="$staging/$service" config="$staging/$service/openssl.cnf"
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
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$directory/leaf.key"
  openssl req -new -key "$directory/leaf.key" -config "$config" -out "$directory/leaf.csr"
  openssl x509 -req -in "$directory/leaf.csr" -CA "$ca_dir/ca.crt" \
    -CAkey "$ca_dir/ca.key" -CAcreateserial -days 90 -sha256 \
    -extfile "$config" -extensions extensions -out "$directory/leaf.crt"
}

case ${1:-} in
  init)
    [[ $# -eq 1 ]] || usage
    [[ ! -e "$ca_dir/ca.key" && ! -e "$ca_dir/ca.crt" ]] || {
      echo "Refusing to overwrite an existing internal CA" >&2
      exit 1
    }
    umask 077
    install -d -o root -g root -m 0700 "$pki_root" "$ca_dir"
    install -d -o root -g root -m 0755 "$trust_dir"
    staging=$(mktemp -d "$pki_root/.initial.XXXXXX")
    trap '[[ -z "${staging:-}" ]] || rm -rf -- "$staging"' EXIT HUP INT TERM
    openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 -out "$staging/ca.key"
    openssl req -x509 -new -sha256 -days 3650 -key "$staging/ca.key" \
      -subj '/CN=nutrition-ledger-internal-ca' -out "$staging/ca.crt"
    install -o root -g root -m 0600 "$staging/ca.key" "$ca_dir/ca.key"
    install -o root -g root -m 0644 "$staging/ca.crt" "$ca_dir/ca.crt"
    install -o root -g root -m 0644 "$staging/ca.crt" "$trust_dir/ca.crt"
    while read -r service dns_name uid gid cert_name key_name; do
      issue_leaf "$staging" "$service" "$dns_name"
      install -d -o "$uid" -g "$gid" -m 0750 "$pki_root/$service"
      install -o "$uid" -g "$gid" -m 0600 "$staging/$service/leaf.key" "$pki_root/$service/$key_name"
      install -o "$uid" -g "$gid" -m 0644 "$staging/$service/leaf.crt" "$pki_root/$service/$cert_name"
    done < <(certificate_specifications)
    verify_all 30 || { echo "Generated internal PKI did not verify" >&2; exit 1; }
    echo "Created a private CA plus Postgres and Meilisearch TLS leaves; no service was started."
    ;;
  verify)
    [[ $# -le 2 ]] || usage
    minimum_days=${2:-14}
    [[ "$minimum_days" =~ ^[1-9][0-9]*$ && "$minimum_days" -le 365 ]] || usage
    verify_all "$minimum_days" || { echo "Internal PKI verification failed" >&2; exit 1; }
    echo "Internal PKI is valid for at least $minimum_days more days."
    ;;
  *)
    usage
    ;;
esac
