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
printf '%s' "$master_key" >"$work_directory/master-key"
chmod 0600 "$work_directory/master-key"
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
  "uid": "91bdc613-7bf6-42b2-9244-cb3bffc64e23",
  "name": "cronometer-gold-worker-index-mutation-v2",
  "description": "Food-index mutation key for the controlled-beta worker",
  "actions": ["indexes.create", "indexes.get", "indexes.delete", "indexes.swap", "documents.add", "settings.update", "stats.get"],
  "indexes": ["foods*"],
  "expiresAt": null
}
JSON

cat >"$work_directory/task-observer-payload.json" <<'JSON'
{
  "uid": "d0ee657d-9a00-4187-a18b-3ea5f17f81b0",
  "name": "cronometer-gold-worker-task-observer",
  "description": "Task-observer key for the controlled-beta worker",
  "actions": ["tasks.get"],
  "indexes": ["*"],
  "expiresAt": null
}
JSON

create_or_read_key \
  6b2e828a-7910-4b0c-861a-e5954b06533b \
  "$work_directory/search-payload.json" \
  "$work_directory/search-response.json"
create_or_read_key \
  91bdc613-7bf6-42b2-9244-cb3bffc64e23 \
  "$work_directory/admin-payload.json" \
  "$work_directory/admin-response.json"
create_or_read_key \
  d0ee657d-9a00-4187-a18b-3ea5f17f81b0 \
  "$work_directory/task-observer-payload.json" \
  "$work_directory/task-observer-response.json"

python3 - \
  "$work_directory/master-key" \
  "$work_directory/search-payload.json" "$work_directory/search-response.json" "$api_env" MEILI_SEARCH_KEY \
  "$work_directory/admin-payload.json" "$work_directory/admin-response.json" "$worker_env" MEILI_ADMIN_KEY \
  "$work_directory/task-observer-payload.json" "$work_directory/task-observer-response.json" "$worker_env" MEILI_TASK_OBSERVER_KEY <<'PY'
import json
import os
import pathlib
import re
import sys


def validated_key(payload_path: str, response_path: str) -> str:
    payload = json.loads(pathlib.Path(payload_path).read_text(encoding="utf-8"))
    response = json.loads(pathlib.Path(response_path).read_text(encoding="utf-8"))
    for field in ("uid", "name", "description", "expiresAt"):
        if response.get(field) != payload.get(field):
            raise SystemExit(f"Meilisearch key {payload['uid']} has unexpected {field}")
    for field in ("actions", "indexes"):
        if sorted(response.get(field, [])) != sorted(payload.get(field, [])):
            raise SystemExit(f"Meilisearch key {payload['uid']} has unexpected {field}")
    key = response.get("key")
    if not isinstance(key, str) or not re.fullmatch(r"[a-f0-9]{64}", key):
        raise SystemExit(f"Meilisearch key {payload['uid']} has an invalid secret")
    return key


def install_keys(environment_path: str, assignments: list[tuple[str, str]]) -> None:
    path = pathlib.Path(environment_path)
    stat = path.stat()
    lines = path.read_text(encoding="utf-8").splitlines()
    if len({variable for variable, _key in assignments}) != len(assignments):
        raise SystemExit(f"{environment_path} received a duplicate Meilisearch key assignment")
    for variable, key in assignments:
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
if len(arguments) != 13:
    raise SystemExit("invalid Meilisearch key bootstrap arguments")
master_key = pathlib.Path(arguments[0]).read_text(encoding="utf-8")
specifications = [arguments[index : index + 4] for index in range(1, len(arguments), 4)]
validated = [
    (environment_path, variable, validated_key(payload_path, response_path))
    for payload_path, response_path, environment_path, variable in specifications
]
keys = [key for _environment_path, _variable, key in validated]
if any(key == master_key for key in keys) or len(set(keys)) != len(keys):
    raise SystemExit("Meilisearch master and scoped role credentials must remain distinct")
assignments_by_environment: dict[str, list[tuple[str, str]]] = {}
for environment_path, variable, key in validated:
    assignments_by_environment.setdefault(environment_path, []).append((variable, key))
for environment_path, assignments in assignments_by_environment.items():
    install_keys(environment_path, assignments)
PY

echo "Meilisearch search, mutation, and task-observer policies verified; role files updated without logging secrets."
