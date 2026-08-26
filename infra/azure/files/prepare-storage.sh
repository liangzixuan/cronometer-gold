#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

readonly data_root=/var/lib/nutrition-tracker
readonly identity_file=/etc/nutrition-tracker/data-disk-identity.env
readonly -a azure_lun0_paths=(
  /dev/disk/azure/data/by-lun/0
  /dev/disk/azure/scsi1/lun0
)

run_bound() {
  timeout --signal=TERM --kill-after=5s 15s "$@"
}

whole_disk_for() {
  local source=$1
  local resolved parent
  resolved=$(run_bound readlink --canonicalize-existing -- "$source") || {
    echo "Could not resolve block device $source" >&2
    return 1
  }
  [[ $resolved =~ ^/dev/[A-Za-z0-9._/+:-]+$ ]] || {
    echo "$source did not resolve to one canonical /dev path" >&2
    return 1
  }
  parent=$(run_bound lsblk -dnro PKNAME -- "$resolved") || {
    echo "Could not resolve the parent disk for $resolved" >&2
    return 1
  }
  [[ $parent != *$'\n'* && ( -z $parent || $parent =~ ^[A-Za-z0-9._+-]+$ ) ]] || {
    echo "$resolved has an ambiguous parent block device" >&2
    return 1
  }
  if [[ -n $parent ]]; then
    resolved=$(run_bound readlink --canonicalize-existing -- "/dev/$parent") || {
      echo "Could not resolve whole-disk device /dev/$parent" >&2
      return 1
    }
  fi
  printf '%s\n' "$resolved"
}

[[ ${EUID} -eq 0 ]] || { echo "Run this storage preparation as root" >&2; exit 1; }
[[ -f $identity_file && ! -L $identity_file ]] || {
  echo "$identity_file must be a regular non-symlink" >&2
  exit 1
}
[[ $(run_bound stat -c '%u:%g:%a' -- "$identity_file") == 0:0:644 ]] || {
  echo "$identity_file must be owned by root:root with mode 0644" >&2
  exit 1
}

declare -A identity=()
while IFS= read -r line || [[ -n $line ]]; do
  [[ -z $line || $line == \#* ]] && continue
  [[ $line =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]] || {
    echo "Invalid entry in $identity_file" >&2
    exit 1
  }
  key=${BASH_REMATCH[1]}
  value=${BASH_REMATCH[2]}
  case "$key" in
    AZURE_DATA_DISK_LUN|AZURE_DATA_DISK_FILESYSTEM_UUID|AZURE_DATA_DISK_SERIAL) ;;
    *) echo "Unexpected key $key in $identity_file" >&2; exit 1 ;;
  esac
  [[ -z ${identity[$key]+present} ]] || {
    echo "Duplicate key $key in $identity_file" >&2
    exit 1
  }
  identity[$key]=$value
done < "$identity_file"
[[ ${#identity[@]} -eq 3 && ${identity[AZURE_DATA_DISK_LUN]} == 0 ]] || {
  echo "$identity_file must contain the exact reviewed LUN-0 identity key set" >&2
  exit 1
}
readonly expected_uuid=${identity[AZURE_DATA_DISK_FILESYSTEM_UUID]}
readonly expected_serial=${identity[AZURE_DATA_DISK_SERIAL]}
[[ $expected_uuid =~ ^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$ ]] || {
  echo "The reviewed data-disk filesystem UUID is invalid" >&2
  exit 1
}
[[ $expected_serial =~ ^[A-Za-z0-9._:+-]{1,128}$ && $expected_serial != REPLACE_* ]] || {
  echo "The reviewed Azure data-disk serial is invalid" >&2
  exit 1
}

run_bound mountpoint -q "$data_root" || {
  echo "$data_root must already be the dedicated preserved data-disk mount" >&2
  exit 1
}

root_source=$(run_bound findmnt -n -o SOURCE --target /)
data_source=$(run_bound findmnt -n -o SOURCE --target "$data_root")
data_type=$(run_bound findmnt -n -o FSTYPE --target "$data_root")
data_uuid=$(run_bound findmnt -n -o UUID --target "$data_root")
data_options=$(run_bound findmnt -n -o OPTIONS --target "$data_root")
[[ -n "$data_source" && "$data_source" != "$root_source" ]] || {
  echo "The data root must not resolve to the OS disk" >&2
  exit 1
}
[[ "$data_type" == ext4 || "$data_type" == xfs ]] || {
  echo "The preserved data disk must use ext4 or xfs" >&2
  exit 1
}
for required_option in rw nodev nosuid; do
  [[ ",$data_options," == *",$required_option,"* ]] || {
    echo "The preserved data disk is missing mount option $required_option" >&2
    exit 1
  }
done

data_backing_device=$(whole_disk_for "$data_source")
declare -a lun0_backing_devices=()
for candidate in "${azure_lun0_paths[@]}"; do
  if [[ -e $candidate || -L $candidate ]]; then
    lun0_backing_devices+=("$(whole_disk_for "$candidate")")
  fi
done
[[ ${#lun0_backing_devices[@]} -gt 0 ]] || {
  echo "No canonical Azure data-disk LUN-0 device link exists" >&2
  exit 1
}
readonly lun0_backing_device=${lun0_backing_devices[0]}
for candidate in "${lun0_backing_devices[@]}"; do
  [[ $candidate == "$lun0_backing_device" ]] || {
    echo "Azure data-disk LUN-0 links resolve to different backing devices" >&2
    exit 1
  }
done
[[ $data_backing_device == "$lun0_backing_device" ]] || {
  echo "$data_root is not backed by the reviewed Azure LUN-0 data disk" >&2
  exit 1
}
data_serial=$(run_bound lsblk -dnro SERIAL -- "$lun0_backing_device")
[[ $data_uuid == "$expected_uuid" && $data_serial == "$expected_serial" ]] || {
  echo "The mounted LUN-0 filesystem UUID or disk serial differs from review" >&2
  exit 1
}

install -d -o root -g root -m 0755 "$data_root"
install -d -o 70 -g 70 -m 0700 "$data_root/postgres"
for directory in \
  meili export-read-spool export-spool search-spool caddy caddy/data caddy/config; do
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
    echo "Unsafe persistent path $data_root/$directory ($actual, expected $expected)" >&2
    exit 1
  }
done

echo "Prepared application directories on the existing preserved data disk; no filesystem was formatted or mounted."
