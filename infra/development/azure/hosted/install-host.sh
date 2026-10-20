#!/usr/bin/env bash
# First installation on the separately approved empty Azure Arm64 host only.
# This script installs software/storage/configuration. It does not start the app,
# approve images, create credentials, change DNS, or replace release admission.
set -euo pipefail
umask 077
export LC_ALL=C
export PATH=/usr/sbin:/usr/bin:/sbin:/bin

fail() { printf '%s\n' "$1" >&2; exit 1; }
[[ $# == 4 ]] || fail 'Usage: bash install-host.sh TRACKED_SOURCE PRIVATE_BUNDLE EXPECTED_LUN0_SERIAL SOURCE_REVISION'
[[ $EUID == 0 && $(uname -m) == aarch64 ]] || fail 'Use the approved native Arm64 host as root.'
[[ $(systemd-detect-virt) != wsl ]] || fail 'WSL is not an installation target.'
source_root=$(realpath --canonicalize-existing -- "$1")
bundle=$(realpath --canonicalize-existing -- "$2")
serial=$3
revision=$4
[[ $revision =~ ^[0-9a-f]{40}$ && $serial =~ ^[A-Za-z0-9_-]{1,128}$ ]] || fail 'Invalid source or disk identity.'
[[ $(git -C "$source_root" rev-parse HEAD) == "$revision" ]] || fail 'Source revision differs.'
git -C "$source_root" diff --quiet
git -C "$source_root" diff --cached --quiet
git -C "$source_root" cat-file -e "$revision:infra/development/azure/hosted/install-host.sh"
[[ $(realpath --canonicalize-existing -- "$0") == "$source_root/infra/development/azure/hosted/install-host.sh" ]] || fail 'Invoke the tracked installer from the reviewed source.'

[[ $(stat -c '%u:%g:%a' "$bundle") == 0:0:700 ]] || fail 'Bundle must be a root-owned private directory.'
[[ ! -e /opt/nourishing && ! -e /etc/nourishing && ! -e /var/lib/nourishing && ! -e /dev/mapper/nourishing-data ]] || fail 'Preserve the existing installation; first-install paths must be absent.'
[[ ! -e /etc/docker/daemon.json && ! -e /usr/sbin/policy-rc.d && ! -e /etc/systemd/system/docker.service && ! -L /etc/systemd/system/docker.service && ! -e /etc/systemd/system/docker.socket && ! -L /etc/systemd/system/docker.socket && ! -e /etc/systemd/system/docker.service.d/nourishing-storage.conf ]] || fail 'Preserve existing Docker and service policy.'
if systemctl is-active --quiet docker.service; then fail 'An existing Docker daemon is not an empty host.'; fi

# Check all private inputs before any package or disk change. Do not source an env file.
private_file() {
  [[ -f $1 && ! -L $1 && $(stat -c '%u:%g:%a:%h' "$1") == 0:0:600:1 ]] || fail 'A required private bundle file is unsafe.'
}
for name in compose.env packages.env network.nft; do private_file "$bundle/$name"; done
for name in runtime database api worker postgres meili migrate restore scoped-meili canary; do private_file "$bundle/config/$name.env"; done
private_file "$bundle/config/database-bootstrap.sql"
for name in ca.crt postgres.crt postgres.key meili.crt meili.key capture.crt capture.key; do private_file "$bundle/pki/$name"; done
for name in send.htpasswd review.htpasswd; do private_file "$bundle/mail/$name"; done
private_file /run/nourishing-volume.key
[[ $(findmnt -n -o FSTYPE --target /run/nourishing-volume.key) == tmpfs ]] || fail 'The approved volume key must remain on tmpfs.'
[[ $(stat -c '%s' /run/nourishing-volume.key) == 64 ]] || fail 'The volume key must contain exactly 64 random bytes.'

# Compose interpolation is configuration data, not shell code. Reject redirected
# roots/projects and unpinned images before packages, keys or the blank disk change.
python3 - "$bundle/compose.env" "$revision" <<'PY'
import ipaddress, re, sys, uuid
from pathlib import Path
values = {}
for line in Path(sys.argv[1]).read_text(encoding="ascii").splitlines():
    if not line or line.startswith("#"):
        continue
    name, sep, value = line.partition("=")
    assert sep and name not in values and value and value.strip() == value
    values[name] = value
images = {"API": "api", "WORKER": "worker", "MIGRATOR": "migrator", "CADDY": "caddy", "POSTGRES": "postgres", "MEILI": "meilisearch"}
required = {"RUNTIME_ROOT", "RUNTIME_SOURCE", "RUNTIME_PROJECT", "RUNTIME_REVISION", "RUNTIME_OWNER", "ACME_EMAIL", "DEPLOYMENT_READINESS_TOKEN", "ADMIN_IPV4_CIDR", "MAILPIT_IMAGE"} | {name + "_IMAGE" for name in images}
assert set(values) == required
assert values["RUNTIME_ROOT"] == "/var/lib/nourishing/runtime"
assert values["RUNTIME_SOURCE"] == "/opt/nourishing/current"
assert values["RUNTIME_PROJECT"] == "nourishing-hosted-staging"
assert values["RUNTIME_REVISION"] == sys.argv[2]
assert str(uuid.UUID(values["RUNTIME_OWNER"])) == values["RUNTIME_OWNER"]
assert re.fullmatch(r"[0-9a-f]{64}", values["DEPLOYMENT_READINESS_TOKEN"])
assert re.fullmatch(r"[^\s@]+@[^\s@]+", values["ACME_EMAIL"])
network = ipaddress.IPv4Network(values["ADMIN_IPV4_CIDR"], strict=True)
assert network.prefixlen == 32 and network.network_address.is_global
for name, suffix in images.items():
    assert re.fullmatch("ghcr.io/liangzixuan/cronometer-gold-" + suffix + r"@sha256:[0-9a-f]{64}", values[name + "_IMAGE"])
assert re.fullmatch(r"(?:docker.io|ghcr.io)/axllent/mailpit@sha256:[0-9a-f]{64}", values["MAILPIT_IMAGE"])
PY

# Exact distribution versions are selected and reviewed in the operational scope.
# Ubuntu's configured signed repositories remain in use; no new repository is added.
declare -A versions=()
while IFS='=' read -r name value || [[ -n ${name:-} ]]; do
  [[ -z $name || $name == \#* ]] && continue
  case "$name" in DOCKER_IO_VERSION|COMPOSE_VERSION|CRYPTSETUP_VERSION|NFTABLES_VERSION) ;; *) fail 'Unexpected package pin.' ;; esac
  [[ $value =~ ^[0-9][0-9A-Za-z.+:~_-]*$ && ! -v versions[$name] ]] || fail 'Invalid or duplicate package pin.'
  versions[$name]=$value
done < "$bundle/packages.env"
[[ ${#versions[@]} == 4 ]] || fail 'All four exact package pins are required.'

# LUN0 is identified before installation, and checked again immediately before format.
disk=$(readlink --canonicalize-existing /dev/disk/azure/data/by-lun/0)
check_disk() {
  [[ -b $disk && $(lsblk -dnro SERIAL "$disk") == "$serial" && $(blockdev --getsize64 "$disk") == 68719476736 ]] || fail 'The approved 64-GiB LUN0 disk identity differs.'
  [[ $(lsblk -nro TYPE "$disk") == disk && -z $(wipefs --no-act --noheadings --output TYPE "$disk") ]] || fail 'The selected disk is not blank; preserve it.'
  [[ -z $(lsblk -nro MOUNTPOINTS "$disk" | tr -d '[:space:]') ]] || fail 'The selected disk is mounted.'
}
check_disk

# A durable mask also protects a reboot after any partial installation. Package
# service suppression alone cannot prevent an enabled daemon on the next boot.
systemctl mask docker.service docker.socket
inhibit_on_failure() {
  local result=$1
  trap - ERR
  if ! systemctl mask docker.service docker.socket; then
    printf '%s\n' 'Installation failed and Docker inhibition could not be verified; retain the stopped host for recovery.' >&2
  else
    printf '%s\n' 'Installation failed; Docker remains masked. Preserve all partial files and keys.' >&2
  fi
  exit "$result"
}
trap 'inhibit_on_failure "$?"' ERR

# Prevent package post-install scripts from starting Docker on the unencrypted OS disk.
printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d
chmod 0755 /usr/sbin/policy-rc.d
timeout --signal=TERM --kill-after=10s 600s apt-get update
timeout --signal=TERM --kill-after=10s 900s apt-get install --yes --no-install-recommends \
  "docker.io=${versions[DOCKER_IO_VERSION]}" "docker-compose-v2=${versions[COMPOSE_VERSION]}" \
  "cryptsetup=${versions[CRYPTSETUP_VERSION]}" "nftables=${versions[NFTABLES_VERSION]}"

check_disk
timeout --signal=TERM --kill-after=10s 180s cryptsetup luksFormat --type luks2 --batch-mode --key-file /run/nourishing-volume.key "$disk"
timeout --signal=TERM --kill-after=10s 60s cryptsetup open --type luks2 --key-file /run/nourishing-volume.key "$disk" nourishing-data
timeout --signal=TERM --kill-after=10s 180s mkfs.ext4 /dev/mapper/nourishing-data
install -d -m 0700 /var/lib/nourishing
mount -o nodev,nosuid /dev/mapper/nourishing-data /var/lib/nourishing
install -d -m 0700 /var/lib/nourishing/install /var/lib/nourishing/docker /var/lib/nourishing/runtime
# Keep the temporary service policy as an installation artifact rather than deleting it.
mv -- /usr/sbin/policy-rc.d /var/lib/nourishing/install/policy-rc.d

install -d -m 0755 /opt/nourishing "/opt/nourishing/source-$revision"
git -C "$source_root" archive --format=tar "$revision" | tar --extract --no-same-owner --directory "/opt/nourishing/source-$revision"
ln -s "source-$revision" /opt/nourishing/current
install -d -m 0700 /etc/nourishing /var/lib/nourishing/runtime/config /var/lib/nourishing/runtime/pki /var/lib/nourishing/runtime/mail
install -m 0600 "$bundle/compose.env" /etc/nourishing/compose.env
for name in runtime database api worker postgres meili migrate restore scoped-meili canary; do
  install -m 0600 "$bundle/config/$name.env" "/var/lib/nourishing/runtime/config/$name.env"
done
install -o 70 -g 70 -m 0600 "$bundle/config/database-bootstrap.sql" /var/lib/nourishing/runtime/config/database-bootstrap.sql
# The image entrypoints read these bind-mounted files as their documented UIDs.
for name in ca.crt postgres.crt meili.crt capture.crt; do install -m 0644 "$bundle/pki/$name" "/var/lib/nourishing/runtime/pki/$name"; done
install -o 70 -g 70 -m 0600 "$bundle/pki/postgres.key" /var/lib/nourishing/runtime/pki/postgres.key
for name in meili.key capture.key; do install -o 1000 -g 1000 -m 0600 "$bundle/pki/$name" "/var/lib/nourishing/runtime/pki/$name"; done
for name in send.htpasswd review.htpasswd; do install -o 1000 -g 1000 -m 0600 "$bundle/mail/$name" "/var/lib/nourishing/runtime/mail/$name"; done
install -d -m 0700 /var/lib/nourishing/runtime/data
install -d -o 70 -g 70 -m 0700 /var/lib/nourishing/runtime/data/postgres
for name in meili capture export-read-spool export-spool search-spool erasure-replay-spool caddy; do
  install -d -o 1000 -g 1000 -m 0700 "/var/lib/nourishing/runtime/data/$name"
done

# Resolve the actual merged configuration without contacting Docker or printing
# environment values. Appwrite staging cannot accidentally reuse localhost mail,
# a finite client deadline, a different database or filesystem storage.
docker compose --env-file /etc/nourishing/compose.env \
  -f /opt/nourishing/current/infra/development/azure/runtime/compose.yaml \
  -f /opt/nourishing/current/infra/development/azure/hosted/compose.yaml \
  --profile dependencies --profile maintenance --profile application --profile hosted \
  config --format json | python3 -c '
import json, sys
from urllib.parse import urlsplit
try:
    services = json.load(sys.stdin)["services"]
    api = services["api"]["environment"]
    worker = services["worker"]["environment"]
    restore = services["restore-admission"]["environment"]
    assert api["NODE_ENV"] == "development" and worker["NODE_ENV"] == "production"
    assert api["NOURISHING_API_PROFILE"] == "hosted-development"
    assert api["EMAIL_DELIVERY_TRANSPORT"] == "https-capture"
    assert api["EMAIL_VERIFICATION_PUBLIC_ORIGIN"] == api["PASSWORD_RECOVERY_PUBLIC_ORIGIN"] == "https://staging.nourishing.app"
    assert api["DATABASE_SSL_MODE"] == worker["DATABASE_SSL_MODE"] == restore["DATABASE_SSL_MODE"] == "verify-full"
    assert api["DATABASE_RESTORE_EPOCH"] == worker["DATABASE_RESTORE_EPOCH"] == restore["DATABASE_RESTORE_EPOCH"]
    assert 32 <= len(api["DATABASE_RESTORE_EPOCH"]) <= 500
    urls = [urlsplit(env["DATABASE_URL"]) for env in [api, worker, restore]]
    assert all(u.scheme == "postgresql" and u.hostname == "postgres" and u.port == 5432 and u.path == urls[0].path and not u.query and not u.fragment for u in urls)
    assert len({u.username for u in urls}) == 3
    for env in [api, worker]:
        assert env["RETENTION_FEATURES_ENABLED"] == "true" and env["EXPORT_ARTIFACT_STORE"] == "azure"
        assert "NOURISHING_RUNTIME_NOT_AFTER_UTC" not in env and "NOURISHING_RUNTIME_DEADLINE_NS" not in env
    assert worker["ERASURE_REPLAY_LEDGER_STORE"] == restore["ERASURE_REPLAY_LEDGER_STORE"] == "azure"
except Exception:
    raise SystemExit("Installed staging configuration rejected; preserve private inputs.")
'

install -d -m 0755 /etc/docker /etc/systemd/system/docker.service.d
printf '%s\n' '{"data-root":"/var/lib/nourishing/docker","live-restore":false,"log-driver":"journald"}' > /etc/docker/daemon.json
install -m 0644 /opt/nourishing/current/infra/development/azure/hosted/var-lib-nourishing.mount /etc/systemd/system/var-lib-nourishing.mount
install -m 0644 /opt/nourishing/current/infra/development/azure/hosted/docker-storage.conf /etc/systemd/system/docker.service.d/nourishing-storage.conf
install -m 0644 /opt/nourishing/current/infra/development/azure/hosted/nourishing-hosted.service /etc/systemd/system/nourishing-hosted.service
install -m 0644 /opt/nourishing/current/infra/development/azure/hosted/nourishing-host-policy.service /etc/systemd/system/nourishing-host-policy.service
# This is the separately reviewed native host policy, including Docker forwarding,
# fixed Azure storage destinations, administrator SSH and public application HTTPS.
# It is not inferred from the finite controller's one-IP client policy.
nft --check --file "$bundle/network.nft"
install -m 0600 "$bundle/network.nft" /etc/nourishing/network.nft
# Configuration and required units now exist. Any verification failure remasks both
# units through the error trap; success removes only this installer's inhibition.
systemctl unmask docker.service docker.socket
systemctl daemon-reload
systemd-analyze verify /etc/systemd/system/nourishing-hosted.service /etc/systemd/system/var-lib-nourishing.mount /etc/systemd/system/nourishing-host-policy.service
trap - ERR
printf '%s\n' 'Host files installed. Application remains stopped. Keep the bundle, volume key and all partial artifacts.'
printf '%s\n' 'Apply the reviewed native policy, qualify images and configuration, and complete release admission before enabling or starting the service.'
