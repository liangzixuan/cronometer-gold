#!/usr/bin/env bash
set -euo pipefail

case $- in
  *x*) echo "Refusing to provision credentials while shell tracing is enabled" >&2; exit 1 ;;
esac
umask 077

if [[ $# -ne 4 ]]; then
  echo "Usage: $0 <OCI-security-token-profile> <opc@host> <iam-user-ids.json> <object-storage.json>" >&2
  exit 64
fi

readonly profile=$1
readonly ssh_target=$2
readonly iam_users_json=$3
readonly object_storage_json=$4
[[ "$ssh_target" =~ ^opc@(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\])$ ]] || {
  echo "SSH target must be opc@ followed by a hostname, IPv4 address, or bracketed IPv6 address" >&2
  exit 64
}
script_directory=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
readonly script_directory
temporary_directory=$(mktemp -d "/tmp/nutrition-oci-credentials.XXXXXX")
readonly temporary_directory
[[ -n "$temporary_directory" && -d "$temporary_directory" && "$temporary_directory" == /tmp/nutrition-oci-credentials.* ]] || {
  echo "Could not create a safe credential staging directory" >&2
  exit 1
}
readonly oci_cli=(oci --profile "$profile" --auth security_token)
installed=0
remote_runner=
rotation_lock_pid=
rotation_lock_fd_open=0
readonly rotation_token_file="$temporary_directory/rotation-token"

for command in oci openssl python3 scp sha256sum ssh; do
  command -v "$command" >/dev/null || { echo "Missing required operator command: $command" >&2; exit 1; }
done
[[ -f "$iam_users_json" && -f "$object_storage_json" ]] || {
  echo "Both Terraform output JSON files must exist" >&2
  exit 1
}

json_field() {
  python3 - "$1" "$2" <<'PY'
import json
import pathlib
import sys
value = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
for component in sys.argv[2].split("."):
    value = value[component]
if not isinstance(value, str) or not value:
    raise SystemExit("Expected a non-empty string in Terraform output JSON")
print(value)
PY
}

export_reader_user=$(json_field "$iam_users_json" export_reader)
readonly export_reader_user
export_writer_user=$(json_field "$iam_users_json" export_writer)
readonly export_writer_user
ledger_writer_user=$(json_field "$iam_users_json" ledger_writer)
readonly ledger_writer_user
ledger_restore_user=$(json_field "$iam_users_json" ledger_restore)
readonly ledger_restore_user
endpoint=$(json_field "$object_storage_json" s3_endpoint)
readonly endpoint
namespace=$(json_field "$object_storage_json" namespace)
readonly namespace
export_bucket=$(json_field "$object_storage_json" export_bucket_name)
readonly export_bucket
ledger_bucket=$(json_field "$object_storage_json" ledger_bucket_name)
readonly ledger_bucket
readonly region=us-ashburn-1
tenancy_ocid=$("${oci_cli[@]}" iam user get --user-id "$ledger_restore_user" --query 'data."compartment-id"' --raw-output)
readonly tenancy_ocid

declare -a role_names=(export-reader export-writer ledger-writer ledger-restore)
declare -a user_ids=("$export_reader_user" "$export_writer_user" "$ledger_writer_user" "$ledger_restore_user")
declare -a response_files=(
  "$temporary_directory/export-reader.json"
  "$temporary_directory/export-writer.json"
  "$temporary_directory/ledger-writer.json"
  "$temporary_directory/ledger-restore.json"
)

active_customer_key_count() {
  "${oci_cli[@]}" iam customer-secret-key list --user-id "$1" --all >"$2"
  python3 - "$2" <<'PY'
import json, pathlib, sys
data = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))["data"]
print(sum(item.get("lifecycle-state") in {"ACTIVE", "CREATING"} for item in data))
PY
}

new_access_id() {
  python3 - "$1" <<'PY'
import json, pathlib, sys
print(json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))["data"]["id"])
PY
}

uploaded_fingerprint() {
  python3 - "$1" <<'PY'
import json, pathlib, sys
print(json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))["data"]["fingerprint"])
PY
}

verify_plan_bound_helpers() {
  local manifest="$temporary_directory/operator-helper-digests.json"
  ssh "$ssh_target" \
    'test "$(sudo stat -c "%U:%G:%a" /etc/nutrition-tracker/operator-helper-digests.json)" = "root:root:644" && sudo cat /etc/nutrition-tracker/operator-helper-digests.json' \
    >"$manifest"
  python3 - "$manifest" "$script_directory" "$temporary_directory/pinned-helpers" <<'PY'
import hashlib, json, os, pathlib, re, stat, sys

manifest = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="ascii"))
expected = {
    "bootstrap-meili-keys.sh",
    "deployment-preflight.sh",
    "image-admission.py",
    "install-object-storage-credentials.py",
}
if set(manifest) != expected or any(not re.fullmatch(r"[0-9a-f]{64}", value) for value in manifest.values()):
    raise SystemExit("Terraform-installed operator helper manifest is invalid")
for name, digest in manifest.items():
    source = pathlib.Path(sys.argv[2], name)
    metadata = source.lstat()
    if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        raise SystemExit(f"Local operator helper is not a regular file: {name}")
    content = source.read_bytes()
    if hashlib.sha256(content).hexdigest() != digest:
        raise SystemExit(f"Local operator helper differs from Terraform-applied bytes: {name}")
    snapshot_directory = pathlib.Path(sys.argv[3])
    snapshot_directory.mkdir(mode=0o700, exist_ok=True)
    snapshot = snapshot_directory / name
    descriptor = os.open(snapshot, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(content)
        stream.flush()
        os.fsync(stream.fileno())
PY
}

install_reviewed_host_script() {
  local source=$1 target=$2 label=$3 digest staged
  [[ -f "$source" && "$label" =~ ^[a-z-]+$ ]] || {
    echo "Missing or invalid checked-in host helper: $source" >&2
    return 1
  }
  case "$target" in
    /run/nutrition-install-object-storage-credentials|/usr/local/sbin/nutrition-bootstrap-meili-keys|/usr/local/sbin/nutrition-deployment-preflight|/usr/local/sbin/nutrition-image-admission) ;;
    *) echo "Unapproved host-helper target: $target" >&2; return 1 ;;
  esac
  digest=$(sha256sum "$source" | awk '{print $1}')
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || { echo "Could not hash $source" >&2; return 1; }
  staged="/tmp/nutrition-$label-$display_suffix"
  scp -q "$source" "$ssh_target:$staged"
  # Client-side expansion is intentional for validated paths and digest.
  # shellcheck disable=SC2029
  ssh "$ssh_target" "set -eu; actual=\$(sha256sum '$staged' | awk '{print \$1}'); test \"\$actual\" = '$digest'; sudo install -o root -g root -m 0750 '$staged' '$target.new'; sudo mv -f '$target.new' '$target'; rm -f '$staged'"
}

wait_customer_key_active() {
  local user_id=$1
  local response_file=$2
  local access_id inventory state
  access_id=$(new_access_id "$response_file")
  for _ in $(seq 1 30); do
    inventory="$temporary_directory/activation.json"
    "${oci_cli[@]}" iam customer-secret-key list --user-id "$user_id" --all >"$inventory"
    state=$(python3 - "$inventory" "$access_id" <<'PY'
import json, pathlib, sys
matches = [item for item in json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))["data"] if item.get("id") == sys.argv[2]]
print(matches[0].get("lifecycle-state", "") if len(matches) == 1 else "")
PY
)
    [[ "$state" == "ACTIVE" ]] && return 0
    [[ "$state" == "CREATING" ]] || return 1
    sleep 2
  done
  return 1
}

acquire_remote_rotation_lock() {
  local fifo="$temporary_directory/rotation-lock.fifo"
  local status_file="$temporary_directory/rotation-lock.status"
  local error_file="$temporary_directory/rotation-lock.error"
  local token
  token=$(openssl rand -hex 32)
  [[ "$token" =~ ^[0-9a-f]{64}$ ]] || { echo "Could not generate rotation token" >&2; return 1; }
  printf '%s\n' "$token" >"$rotation_token_file"
  chmod 0600 "$rotation_token_file"
  mkfifo "$fifo"
  chmod 0600 "$fifo"
  ssh "$ssh_target" 'sudo /usr/local/sbin/nutrition-credential-rotation-lock' \
    <"$fifo" >"$status_file" 2>"$error_file" &
  rotation_lock_pid=$!
  exec 8>"$fifo"
  rotation_lock_fd_open=1
  printf '%s\n' "$token" >&8
  unset token
  for _ in $(seq 1 40); do
    if [[ -s "$status_file" ]] && grep -qx LOCKED "$status_file"; then
      return 0
    fi
    kill -0 "$rotation_lock_pid" 2>/dev/null || {
      echo "Could not acquire the exclusive remote credential-rotation lock" >&2
      return 1
    }
    sleep 0.25
  done
  echo "Timed out acquiring the exclusive remote credential-rotation lock" >&2
  return 1
}

assert_remote_rotation_lock() {
  if [[ -z "$rotation_lock_pid" ]] || ! kill -0 "$rotation_lock_pid" 2>/dev/null; then
    echo "The remote credential-rotation lock was lost" >&2
    return 1
  fi
}

release_remote_rotation_lock() {
  local _
  if [[ $rotation_lock_fd_open -eq 1 ]]; then
    exec 8>&-
    rotation_lock_fd_open=0
  fi
  if [[ -n "$rotation_lock_pid" ]]; then
    for _ in $(seq 1 40); do
      kill -0 "$rotation_lock_pid" 2>/dev/null || break
      sleep 0.25
    done
    if kill -0 "$rotation_lock_pid" 2>/dev/null; then
      kill "$rotation_lock_pid" 2>/dev/null || true
    fi
    wait "$rotation_lock_pid" 2>/dev/null || true
    rotation_lock_pid=
  fi
}

cleanup() {
  status=$?
  if [[ $status -ne 0 && $installed -eq 0 ]]; then
    for index in 0 1 2 3; do
      if [[ -s "${response_files[$index]}" ]]; then
        access_id=$(new_access_id "${response_files[$index]}" 2>/dev/null || true)
        if [[ -n "$access_id" ]]; then
          "${oci_cli[@]}" iam customer-secret-key delete \
            --user-id "${user_ids[$index]}" --customer-secret-key-id "$access_id" --force \
            >/dev/null 2>&1 || true
        fi
      fi
    done
    if [[ -s "$temporary_directory/restore-api-upload.json" ]]; then
      fingerprint=$(uploaded_fingerprint "$temporary_directory/restore-api-upload.json" 2>/dev/null || true)
      if [[ -n "$fingerprint" ]]; then
        "${oci_cli[@]}" iam user api-key delete \
          --user-id "$ledger_restore_user" --fingerprint "$fingerprint" --force \
          >/dev/null 2>&1 || true
      fi
    fi
    echo "Provisioning failed before host installation; newly created OCI credentials were revoked where possible and the application remains stopped." >&2
  fi
  if [[ -n "$remote_runner" ]]; then
    # Client-side expansion is intentional; both values are validated above.
    # shellcheck disable=SC2029
    ssh "$ssh_target" "rm -f '$remote_runner'; sudo rm -f /run/nutrition-install-object-storage-credentials" \
      >/dev/null 2>&1 || true
  fi
  release_remote_rotation_lock
  [[ "$temporary_directory" == /tmp/nutrition-oci-credentials.* ]] && rm -rf -- "$temporary_directory"
  exit "$status"
}
trap cleanup EXIT

# Serialize slot checks, stop, cloud-key creation, host installation, and the
# guarded start across every operator invocation.
acquire_remote_rotation_lock
assert_remote_rotation_lock

# Every OCI IAM user can hold only two Customer Secret Keys. A rotation needs
# one free slot so the old key remains valid until the new deployment passes.
for index in 0 1 2 3; do
  count=$(active_customer_key_count "${user_ids[$index]}" "$temporary_directory/key-list-$index.json")
  [[ "$count" -le 1 ]] || {
    echo "${role_names[$index]} has no free Customer Secret Key rotation slot; revoke a retired key after evidence review" >&2
    exit 1
  }
done
"${oci_cli[@]}" iam user api-key list --user-id "$ledger_restore_user" --all >"$temporary_directory/api-key-list.json"
api_key_count=$(python3 - "$temporary_directory/api-key-list.json" <<'PY'
import json, pathlib, sys
print(len(json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))["data"]))
PY
)
[[ "$api_key_count" -le 2 ]] || {
  echo "ledger-restore has no free API signing-key rotation slot; revoke a retired key after evidence review" >&2
  exit 1
}

# Credential creation and rotation are deliberately offline: application
# containers stop before any new cloud credential exists and remain down on
# every error path.
ssh "$ssh_target" 'sudo systemctl stop nutrition-tracker.service && sudo /usr/local/sbin/nutrition-release-orchestrator stop'
assert_remote_rotation_lock
verify_plan_bound_helpers

display_suffix=$(date -u +%Y%m%dT%H%M%SZ)
readonly display_suffix
install_reviewed_host_script \
  "$temporary_directory/pinned-helpers/image-admission.py" \
  /usr/local/sbin/nutrition-image-admission image-admission
install_reviewed_host_script \
  "$temporary_directory/pinned-helpers/bootstrap-meili-keys.sh" \
  /usr/local/sbin/nutrition-bootstrap-meili-keys meili-bootstrap
install_reviewed_host_script \
  "$temporary_directory/pinned-helpers/deployment-preflight.sh" \
  /usr/local/sbin/nutrition-deployment-preflight deployment-preflight
install_reviewed_host_script \
  "$temporary_directory/pinned-helpers/install-object-storage-credentials.py" \
  /run/nutrition-install-object-storage-credentials credential-installer
remote_runner=/run/nutrition-install-object-storage-credentials

for index in 0 1 2 3; do
  assert_remote_rotation_lock
  "${oci_cli[@]}" iam customer-secret-key create \
    --user-id "${user_ids[$index]}" \
    --display-name "nutrition-beta-${role_names[$index]}-$display_suffix" \
    >"${response_files[$index]}"
  wait_customer_key_active "${user_ids[$index]}" "${response_files[$index]}" || {
    echo "New ${role_names[$index]} Customer Secret Key did not become ACTIVE" >&2
    exit 1
  }
done

readonly restore_private_key="$temporary_directory/restore-private-key.pem"
readonly restore_public_key="$temporary_directory/restore-public-key.pem"
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$restore_private_key" >/dev/null 2>&1
openssl pkey -in "$restore_private_key" -pubout -out "$restore_public_key" >/dev/null 2>&1
chmod 0600 "$restore_private_key" "$restore_public_key"
assert_remote_rotation_lock
"${oci_cli[@]}" iam user api-key upload \
  --user-id "$ledger_restore_user" --key-file "$restore_public_key" \
  >"$temporary_directory/restore-api-upload.json"

assert_remote_rotation_lock
python3 "$script_directory/object-storage-credential-canary.py" \
  "$endpoint" "$region" "$namespace" "$export_bucket" "$ledger_bucket" \
  "${response_files[0]}" "${response_files[1]}" "${response_files[2]}" "${response_files[3]}" \
  "$tenancy_ocid" "$ledger_restore_user" "$temporary_directory/restore-api-upload.json"
assert_remote_rotation_lock

python3 - \
  "${response_files[0]}" "${response_files[1]}" "${response_files[2]}" "${response_files[3]}" \
  "$temporary_directory/restore-api-upload.json" "$restore_private_key" \
  "$temporary_directory/credential-bundle.json" "$rotation_token_file" <<'PY'
import json
import pathlib
import sys

def customer(path):
    data = json.loads(pathlib.Path(path).read_text(encoding="utf-8"))["data"]
    return {"accessKeyId": data["id"], "secretAccessKey": data["key"]}

api = json.loads(pathlib.Path(sys.argv[5]).read_text(encoding="utf-8"))["data"]
bundle = {
    "schemaVersion": 1,
    "exportReader": customer(sys.argv[1]),
    "exportWriter": customer(sys.argv[2]),
    "ledgerWriter": customer(sys.argv[3]),
    "ledgerRestore": customer(sys.argv[4]),
    "rotationLockToken": pathlib.Path(sys.argv[8]).read_text(encoding="ascii").strip(),
    "restoreApi": {
        "fingerprint": api["fingerprint"].lower(),
        "privateKeyPem": pathlib.Path(sys.argv[6]).read_text(encoding="ascii"),
    },
}
target = pathlib.Path(sys.argv[7])
target.write_text(json.dumps(bundle, separators=(",", ":")), encoding="utf-8")
target.chmod(0o600)
PY

assert_remote_rotation_lock
ssh "$ssh_target" 'sudo /run/nutrition-install-object-storage-credentials' \
  <"$temporary_directory/credential-bundle.json"
installed=1
ssh "$ssh_target" 'sudo rm -f /run/nutrition-install-object-storage-credentials'

assert_remote_rotation_lock
ssh "$ssh_target" 'sudo systemctl start nutrition-tracker.service'
assert_remote_rotation_lock
echo "OCI Object Storage credential rotation installed and the guarded release service started."
echo "After recording successful readiness, list each IAM user's keys and explicitly delete only retired Customer Secret Keys/API keys; this script never revokes the prior working set."
