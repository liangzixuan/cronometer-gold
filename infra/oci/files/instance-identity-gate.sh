#!/usr/bin/env bash
set -euo pipefail

readonly config_root=/etc/nutrition-tracker
readonly identity_file="$config_root/admitted-instance-id"
readonly epoch_file="$config_root/admitted-restore-epoch"
readonly database_env="$config_root/database.env"
readonly metadata_url=http://169.254.169.254/opc/v2/instance/

current_instance_id() {
  local instance_id
  for attempt in $(seq 1 20); do
    if instance_id=$(curl --fail --silent --show-error --noproxy '*' \
      --connect-timeout 2 --max-time 5 \
      -H 'Authorization: Bearer Oracle' "$metadata_url" | \
      python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])'); then
      [[ "$instance_id" =~ ^ocid1\.instance\.oc1\. ]] || {
        echo "OCI metadata returned an invalid instance OCID" >&2
        exit 1
      }
      printf '%s\n' "$instance_id"
      return 0
    fi
    [[ "$attempt" == "20" ]] || sleep 2
  done
  echo "Unable to read the OCI v2 instance identity metadata" >&2
  exit 1
}

read_single_line() {
  local path=$1
  [[ -f "$path" ]] || { echo "Missing instance-admission file: $path" >&2; exit 1; }
  [[ "$(stat -c '%U:%G:%a' "$path")" == "root:root:400" ]] || {
    echo "$path must be root:root mode 0400" >&2
    exit 1
  }
  local -a lines=()
  mapfile -t lines <"$path"
  [[ ${#lines[@]} -eq 1 && -n "${lines[0]}" ]] || {
    echo "$path must contain exactly one non-empty line" >&2
    exit 1
  }
  printf '%s\n' "${lines[0]}"
}

database_restore_epoch() {
  [[ -f "$database_env" ]] || { echo "Missing $database_env" >&2; exit 1; }
  local -a epochs=()
  mapfile -t epochs < <(sed -n 's/^DATABASE_RESTORE_EPOCH=//p' "$database_env")
  [[ ${#epochs[@]} -eq 1 && ${#epochs[0]} -ge 32 && ${#epochs[0]} -le 500 && "${epochs[0]}" == "${epochs[0]# }" && "${epochs[0]}" == "${epochs[0]% }" ]] || {
    echo "database.env must contain exactly one valid DATABASE_RESTORE_EPOCH" >&2
    exit 1
  }
  printf '%s\n' "${epochs[0]}"
}

create_once() {
  local path=$1
  local value=$2
  local staged
  staged=$(mktemp "$config_root/.instance-admission.XXXXXX")
  printf '%s\n' "$value" >"$staged"
  chown root:root "$staged"
  chmod 0400 "$staged"
  if ! ln "$staged" "$path"; then
    rm -f -- "$staged"
    echo "Refusing to overwrite existing instance-admission file: $path" >&2
    exit 1
  fi
  rm -f -- "$staged"
}

replace_atomically() {
  local path=$1
  local value=$2
  local staged
  staged=$(mktemp "$config_root/.instance-admission.XXXXXX")
  printf '%s\n' "$value" >"$staged"
  chown root:root "$staged"
  chmod 0400 "$staged"
  mv -f -- "$staged" "$path"
}

verify_identity() {
  local expected current
  expected=$(read_single_line "$identity_file")
  current=$(current_instance_id)
  [[ "$expected" == "$current" ]] || {
    echo "RESTORE GATE: boot volume is bound to a different OCI instance; application startup denied" >&2
    exit 1
  }
}

command=${1:-}
case "$command" in
  bind-initial)
    install -d -o root -g root -m 0700 "$config_root"
    current=$(current_instance_id)
    if [[ -e "$identity_file" ]]; then
      verify_identity
    else
      create_once "$identity_file" "$current"
      verify_identity
    fi
    ;;
  verify-runtime)
    verify_identity
    current_epoch=$(database_restore_epoch)
    if [[ -e "$epoch_file" ]]; then
      admitted_epoch=$(read_single_line "$epoch_file")
      [[ "$current_epoch" == "$admitted_epoch" ]] || {
        echo "RESTORE GATE: DATABASE_RESTORE_EPOCH differs from the admitted epoch" >&2
        exit 1
      }
    else
      create_once "$epoch_file" "$current_epoch"
    fi
    ;;
  admit-restored)
    current=$(current_instance_id)
    expected_confirmation="ADMIT-RESTORED-INSTANCE:$current"
    [[ ${2:-} == "$expected_confirmation" ]] || {
      echo "Usage: $0 admit-restored '$expected_confirmation'" >&2
      exit 64
    }
    old_instance=$(read_single_line "$identity_file")
    [[ "$old_instance" != "$current" ]] || {
      echo "Current instance is already admitted; refusing an unnecessary rebind" >&2
      exit 1
    }
    old_epoch=$(read_single_line "$epoch_file")
    current_epoch=$(database_restore_epoch)
    [[ "$current_epoch" != "$old_epoch" ]] || {
      echo "Set a fresh DATABASE_RESTORE_EPOCH before admitting a restored instance" >&2
      exit 1
    }
    if systemctl is-active --quiet nutrition-tracker.service; then
      echo "Stop nutrition-tracker.service before restored-instance admission" >&2
      exit 1
    fi
    for service in api web worker; do
      [[ -z "$(docker ps -q \
        --filter label=com.docker.compose.project=cronometer-gold-beta \
        --filter label=com.docker.compose.service="$service")" ]] || {
        echo "Application container $service is running; restored-instance admission denied" >&2
        exit 1
      }
    done
    # Replacing either file first remains fail-closed if the host loses power:
    # identity mismatch or epoch mismatch blocks the next startup.
    replace_atomically "$identity_file" "$current"
    replace_atomically "$epoch_file" "$current_epoch"
    verify_identity
    echo "Restored instance admitted for offline replay; application gates have not yet run."
    ;;
  *)
    echo "Usage: $0 bind-initial | verify-runtime | admit-restored <confirmation>" >&2
    exit 64
    ;;
esac
