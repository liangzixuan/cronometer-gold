#!/usr/bin/env bash
set -euo pipefail

readonly deploy_env=/etc/nutrition-tracker/deploy.env
readonly meili_env=/etc/nutrition-tracker/meili.env
readonly api_env=/etc/nutrition-tracker/api.env
readonly worker_env=/etc/nutrition-tracker/worker.env
readonly meili_origin=https://meili.internal:8443
readonly ca_file=/etc/nutrition-tracker/pki/trust/ca.crt

for file in "$deploy_env" "$meili_env" "$api_env" "$worker_env" "$ca_file"; do
  [[ -s "$file" ]] || { echo "Missing Meilisearch bootstrap prerequisite: $file" >&2; exit 1; }
done

master_key=$(sed -n 's/^MEILI_MASTER_KEY=//p' "$meili_env")
[[ ${#master_key} -ge 16 && "$master_key" != REPLACE* ]] || {
  echo "MEILI_MASTER_KEY is missing or still a replacement marker" >&2
  exit 1
}

work_directory=$(mktemp -d /run/nutrition-meili-bootstrap.XXXXXX)
trap 'rm -rf -- "$work_directory"' EXIT
chmod 0700 "$work_directory"

{
  echo 'silent'
  echo 'show-error'
  echo 'fail-with-body'
  echo 'connect-timeout = 5'
  echo 'max-time = 30'
  echo "cacert = \"$ca_file\""
  echo 'resolve = "meili.internal:8443:127.0.0.1"'
  printf 'header = "Authorization: Bearer %s"\n' "$master_key"
} >"$work_directory/curl.conf"
chmod 0600 "$work_directory/curl.conf"
unset master_key

attempt=0
until curl --config "$work_directory/curl.conf" "$meili_origin/health" >/dev/null; do
  attempt=$((attempt + 1))
  [[ "$attempt" -lt 60 ]] || { echo "Meilisearch TLS health timed out" >&2; exit 1; }
  sleep 2
done

create_or_read_key() {
  local uid=$1
  local payload_file=$2
  local response_file=$3

  if curl --config "$work_directory/curl.conf" "$meili_origin/keys/$uid" >"$response_file" 2>/dev/null; then
    return 0
  fi
  curl --config "$work_directory/curl.conf" \
    -H 'Content-Type: application/json' \
    --data-binary "@$payload_file" \
    "$meili_origin/keys" >"$response_file"
}

cat >"$work_directory/search-payload.json" <<'JSON'
{
  "uid": "6b2e828a-7910-4b0c-861a-e5954b06533b",
  "name": "cronometer-gold-api-search",
  "description": "Search-only API key for the controlled beta",
  "actions": ["search"],
  "indexes": ["foods"],
  "expiresAt": null
}
JSON

cat >"$work_directory/admin-payload.json" <<'JSON'
{
  "uid": "2aac5083-d036-4b24-8bb4-2b9ae77a90f1",
  "name": "cronometer-gold-worker-index-admin",
  "description": "Food-index administration key for the controlled-beta worker",
  "actions": ["indexes.*", "documents.*", "settings.*", "tasks.*", "stats.*"],
  "indexes": ["foods*"],
  "expiresAt": null
}
JSON

create_or_read_key \
  6b2e828a-7910-4b0c-861a-e5954b06533b \
  "$work_directory/search-payload.json" \
  "$work_directory/search-response.json"
create_or_read_key \
  2aac5083-d036-4b24-8bb4-2b9ae77a90f1 \
  "$work_directory/admin-payload.json" \
  "$work_directory/admin-response.json"

python3 - \
  "$work_directory/search-payload.json" "$work_directory/search-response.json" "$api_env" MEILI_SEARCH_KEY \
  "$work_directory/admin-payload.json" "$work_directory/admin-response.json" "$worker_env" MEILI_ADMIN_KEY <<'PY'
import json
import os
import pathlib
import sys


def install_key(payload_path: str, response_path: str, environment_path: str, variable: str) -> None:
    payload = json.loads(pathlib.Path(payload_path).read_text(encoding="utf-8"))
    response = json.loads(pathlib.Path(response_path).read_text(encoding="utf-8"))
    for field in ("uid", "expiresAt"):
        if response.get(field) != payload.get(field):
            raise SystemExit(f"Meilisearch key {payload['uid']} has unexpected {field}")
    for field in ("actions", "indexes"):
        if sorted(response.get(field, [])) != sorted(payload.get(field, [])):
            raise SystemExit(f"Meilisearch key {payload['uid']} has unexpected {field}")
    key = response.get("key")
    if not isinstance(key, str) or len(key) < 16 or "\n" in key:
        raise SystemExit(f"Meilisearch key {payload['uid']} has an invalid secret")

    path = pathlib.Path(environment_path)
    stat = path.stat()
    lines = path.read_text(encoding="utf-8").splitlines()
    prefix = f"{variable}="
    matches = [index for index, line in enumerate(lines) if line.startswith(prefix)]
    if len(matches) != 1:
        raise SystemExit(f"{environment_path} must contain exactly one {variable} entry")
    lines[matches[0]] = prefix + key
    temporary = path.with_name(path.name + ".next")
    temporary.write_text("\n".join(lines) + "\n", encoding="utf-8")
    os.chown(temporary, stat.st_uid, stat.st_gid)
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)


arguments = sys.argv[1:]
if len(arguments) != 8:
    raise SystemExit("invalid Meilisearch key bootstrap arguments")
install_key(*arguments[:4])
install_key(*arguments[4:])
PY

echo "Meilisearch search-only and worker-admin key policies verified; role files updated without logging secrets."
