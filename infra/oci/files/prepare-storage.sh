#!/usr/bin/env bash
set -euo pipefail

readonly data_root=/var/lib/nutrition-tracker

[[ "$(findmnt -n -o FSTYPE --target /var/lib)" != "tmpfs" ]] || {
  echo "/var/lib is unexpectedly backed by tmpfs" >&2
  exit 1
}

install -d -o root -g root -m 0755 "$data_root"
install -d -o 70 -g 70 -m 0700 "$data_root/postgres"
for directory in meili export-read-spool export-spool search-spool caddy caddy/data caddy/config; do
  install -d -o 1000 -g 1000 -m 0700 "$data_root/$directory"
done

for specification in \
  'postgres 70:70:700' \
  'meili 1000:1000:700' \
  'export-read-spool 1000:1000:700' \
  'export-spool 1000:1000:700' \
  'search-spool 1000:1000:700' \
  'caddy 1000:1000:700' \
  'caddy/data 1000:1000:700' \
  'caddy/config 1000:1000:700'; do
  read -r directory expected <<<"$specification"
  actual=$(stat -c '%u:%g:%a' "$data_root/$directory")
  [[ "$actual" == "$expected" ]] || {
    echo "Refusing unsafe persistent path $data_root/$directory ($actual, expected $expected)" >&2
    exit 1
  }
done
