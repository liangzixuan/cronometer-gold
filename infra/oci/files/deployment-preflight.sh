#!/usr/bin/env bash
set -euo pipefail

deploy_env=/etc/nutrition-tracker/deploy.env
runtime_env=/etc/nutrition-tracker/runtime.env
compose_file=/opt/nutrition-tracker/compose.yaml
dependency_lock=/opt/nutrition-tracker/external-images.lock.json
object_hosts_env=/run/nutrition-tracker/object-storage-hosts.env
mode=${1:-full}
[[ "$mode" == "early" || "$mode" == "full" ]] || {
  echo "Usage: $0 early|full" >&2
  exit 64
}

[[ "$(docker version --format '{{.Server.Version}}')" == "29.7.2" ]] || {
  echo "Docker Engine must be the reviewed 29.7.2 release" >&2
  exit 1
}
[[ "$(docker compose version --short)" == "5.4.0" ]] || {
  echo "Docker Compose must be the reviewed 5.4.0 release" >&2
  exit 1
}

systemctl is-active --quiet firewalld || { echo "firewalld must be active" >&2; exit 1; }
systemctl is-active --quiet nutrition-object-egress-firewall.service || {
  echo "The object-egress firewall service must be active" >&2
  exit 1
}
read -r firewall_interface firewall_zone </etc/nutrition-tracker/firewall-interface-zone
[[ -n "$firewall_interface" && -n "$firewall_zone" ]] || {
  echo "Missing reviewed firewalld interface/zone evidence" >&2
  exit 1
}
[[ "$(ip -4 route show default | awk 'NR == 1 { print $5 }')" == "$firewall_interface" ]] || {
  echo "The default interface changed after firewalld configuration" >&2
  exit 1
}
current_firewall_zone=$(firewall-cmd --get-zone-of-interface "$firewall_interface")
if [[ -z "$current_firewall_zone" || "$current_firewall_zone" == "no zone" ]]; then
  current_firewall_zone=$(firewall-cmd --get-default-zone)
fi
[[ "$current_firewall_zone" == "$firewall_zone" ]] || {
  echo "The default interface is no longer assigned to the reviewed firewalld zone" >&2
  exit 1
}
for service in http https; do
  firewall-cmd --zone "$firewall_zone" --query-service "$service" >/dev/null || {
    echo "firewalld does not admit $service on $firewall_zone" >&2
    exit 1
  }
done

/usr/local/sbin/nutrition-assert-object-egress-firewall

[[ -f "$dependency_lock" ]] || { echo "Missing external dependency lock" >&2; exit 1; }
[[ "$(stat -c '%U:%G:%a' "$dependency_lock")" == "root:root:644" ]] || {
  echo "External dependency lock must be root:root mode 0644" >&2
  exit 1
}

helper_manifest=/etc/nutrition-tracker/operator-helper-digests.json
[[ "$(stat -c '%U:%G:%a' "$helper_manifest")" == "root:root:644" ]] || {
  echo "Operator helper manifest must be root:root mode 0644" >&2
  exit 1
}
python3 - "$helper_manifest" <<'PY'
import hashlib, json, pathlib, re, stat, sys

manifest = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="ascii"))
expected = {
    "bootstrap-meili-keys.sh",
    "deployment-preflight.sh",
    "image-admission.py",
    "install-object-storage-credentials.py",
}
if set(manifest) != expected or any(not re.fullmatch(r"[0-9a-f]{64}", value) for value in manifest.values()):
    raise SystemExit("Operator helper manifest is invalid")
for source, target in {
    "bootstrap-meili-keys.sh": "/usr/local/sbin/nutrition-bootstrap-meili-keys",
    "deployment-preflight.sh": "/usr/local/sbin/nutrition-deployment-preflight",
    "image-admission.py": "/usr/local/sbin/nutrition-image-admission",
}.items():
    path = pathlib.Path(target)
    metadata = path.lstat()
    if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode) or (metadata.st_uid, metadata.st_gid, metadata.st_mode & 0o777) != (0, 0, 0o750):
        raise SystemExit(f"Unsafe operator-installed helper owner/mode: {target}")
    if hashlib.sha256(path.read_bytes()).hexdigest() != manifest[source]:
        raise SystemExit(f"Operator-installed helper differs from Terraform-applied bytes: {target}")
PY

for file in "$deploy_env" "$runtime_env" /etc/nutrition-tracker/database.env /etc/nutrition-tracker/api.env /etc/nutrition-tracker/worker.env /etc/nutrition-tracker/meili.env /etc/nutrition-tracker/restore.env; do
  [[ -f "$file" ]] || { echo "Missing $file" >&2; exit 1; }
  [[ "$(stat -c '%U:%G' "$file")" == "root:root" ]] || { echo "$file must be owned by root:root" >&2; exit 1; }
  [[ "$(stat -c '%a' "$file")" == "600" ]] || { echo "$file must have mode 0600" >&2; exit 1; }
done

python3 - "$mode" "$deploy_env" "$runtime_env" /etc/nutrition-tracker/database.env /etc/nutrition-tracker/api.env /etc/nutrition-tracker/worker.env /etc/nutrition-tracker/meili.env /etc/nutrition-tracker/restore.env <<'PY'
import pathlib
import re
import sys

mode = sys.argv[1]
allowed_early = {
    "/etc/nutrition-tracker/api.env": {"MEILI_SEARCH_KEY=REPLACE_SCOPED_MEILI_SEARCH_KEY"},
    "/etc/nutrition-tracker/worker.env": {"MEILI_ADMIN_KEY=REPLACE_SCOPED_MEILI_ADMIN_KEY"},
}
marker = re.compile(r"REPLACE|CHANGE_ME|example\.com")
for filename in sys.argv[2:]:
    lines = pathlib.Path(filename).read_text(encoding="utf-8").splitlines()
    found = {line for line in lines if marker.search(line)}
    allowed = allowed_early.get(filename, set()) if mode == "early" else set()
    if found != allowed:
        raise SystemExit(f"{filename} has an unexpected replacement-marker set for {mode} preflight")
PY

python3 - "$deploy_env" <<'PY'
import ipaddress
import pathlib
import sys

lines = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8").splitlines()
values = [line.partition("=")[2].strip() for line in lines if line.startswith("BETA_ALLOWED_CIDRS=")]
if len(values) != 1:
    raise SystemExit("deploy.env must contain exactly one BETA_ALLOWED_CIDRS entry")
cidrs = values[0].split()
if not cidrs:
    raise SystemExit("BETA_ALLOWED_CIDRS may not be empty")
if len(cidrs) > 32:
    raise SystemExit("BETA_ALLOWED_CIDRS is limited to 32 reviewed networks")
if len(cidrs) != len(set(cidrs)):
    raise SystemExit("BETA_ALLOWED_CIDRS contains a duplicate network")
for value in cidrs:
    if value in {"0.0.0.0/0", "::/0"}:
        raise SystemExit("BETA_ALLOWED_CIDRS may not allow the whole Internet")
    try:
        network = ipaddress.ip_network(value, strict=True)
    except ValueError as error:
        raise SystemExit(f"Invalid BETA_ALLOWED_CIDRS network {value!r}: {error}") from error
    minimum_prefix = 24 if network.version == 4 else 64
    if network.prefixlen < minimum_prefix:
        raise SystemExit(
            f"BETA_ALLOWED_CIDRS network {value!r} is too broad; "
            f"use IPv4 /{minimum_prefix} or narrower, or IPv6 /{minimum_prefix} or narrower"
        )
    if not network.is_global:
        raise SystemExit(f"BETA_ALLOWED_CIDRS network {value!r} is not a public reviewer egress network")
PY

python3 - \
  "$runtime_env" \
  /etc/nutrition-tracker/api.env \
  /etc/nutrition-tracker/worker.env \
  /etc/nutrition-tracker/restore.env \
  /etc/nutrition-tracker/object-storage-coordinates.json <<'PY'
import base64
import binascii
import ipaddress
import json
import pathlib
import re
import sys

names = ("runtime", "api", "worker", "restore")


def read_env(name, filename):
    values = {}
    for line_number, raw_line in enumerate(
        pathlib.Path(filename).read_text(encoding="utf-8").splitlines(), start=1
    ):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        key, separator, value = raw_line.partition("=")
        if not separator or not re.fullmatch(r"[A-Z][A-Z0-9_]*", key):
            raise SystemExit(f"Invalid {name} environment entry at line {line_number}")
        if key in values:
            raise SystemExit(f"Duplicate {key} in {name} environment")
        values[key] = value
    return values


env = {name: read_env(name, filename) for name, filename in zip(names, sys.argv[1:5])}


def value(name, key):
    result = env[name].get(key)
    if result is None or result == "":
        raise SystemExit(f"Missing {key} in {name} environment")
    return result


credential_fields = (
    ("api", "EXPORT_ARTIFACT_READ_ACCESS_KEY_ID", "EXPORT_ARTIFACT_READ_SECRET_ACCESS_KEY"),
    ("worker", "EXPORT_ARTIFACT_WRITE_ACCESS_KEY_ID", "EXPORT_ARTIFACT_WRITE_SECRET_ACCESS_KEY"),
    ("worker", "ERASURE_REPLAY_LEDGER_WRITE_ACCESS_KEY_ID", "ERASURE_REPLAY_LEDGER_WRITE_SECRET_ACCESS_KEY"),
    ("restore", "ERASURE_REPLAY_LEDGER_RESTORE_ACCESS_KEY_ID", "ERASURE_REPLAY_LEDGER_RESTORE_SECRET_ACCESS_KEY"),
)
access_ids = [value(name, access) for name, access, _secret in credential_fields]
secrets = [value(name, secret) for name, _access, secret in credential_fields]
if any(len(item) < 16 or len(item) > 256 or any(character.isspace() for character in item) for item in access_ids + secrets):
    raise SystemExit("OCI Customer Secret Key fields have an invalid length or whitespace")
if len(set(access_ids)) != 4 or len(set(secrets)) != 4:
    raise SystemExit("Every OCI Object Storage principal must use a distinct credential pair")

coordinates = json.loads(pathlib.Path(sys.argv[5]).read_text(encoding="utf-8"))
expected_coordinate_keys = {
    "schemaVersion", "endpoint", "compatHost", "nativeHost", "region", "namespace",
    "exportBucket", "ledgerBucket", "restoreUserOcid", "tenancyOcid", "bridgeCidr",
    "serviceCidr",
}
if set(coordinates) != expected_coordinate_keys or coordinates["schemaVersion"] != 2:
    raise SystemExit("Object Storage coordinates have an unexpected schema")
if coordinates["region"] != "us-ashburn-1":
    raise SystemExit("OCI Object Storage region must remain us-ashburn-1")
if not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", coordinates["namespace"]):
    raise SystemExit("OCI Object Storage namespace is invalid")
if not re.fullmatch(r"ocid1\.user\.oc1\..+", coordinates["restoreUserOcid"]):
    raise SystemExit("OCI restore IAM user OCID is invalid")
expected_compat = f'{coordinates["namespace"]}.compat.objectstorage.{coordinates["region"]}.oci.customer-oci.com'
expected_native = f'objectstorage.{coordinates["region"]}.oraclecloud.com'
if coordinates["compatHost"] != expected_compat or coordinates["endpoint"] != f"https://{expected_compat}":
    raise SystemExit("OCI S3 compatibility host or endpoint is invalid")
if coordinates["nativeHost"] != expected_native:
    raise SystemExit("OCI native Object Storage host is invalid")
if coordinates["bridgeCidr"] != "172.31.255.0/28":
    raise SystemExit("Object-egress bridge CIDR is invalid")
try:
    service_cidr = ipaddress.ip_network(coordinates["serviceCidr"], strict=True)
except ValueError as error:
    raise SystemExit("Object Storage service CIDR is invalid") from error
if service_cidr.version != 4 or not service_cidr.is_global:
    raise SystemExit("Object Storage service CIDR must be a public IPv4 network")

coordinate_mirrors = (
    ("EXPORT_ARTIFACT_ENDPOINT", "endpoint"),
    ("EXPORT_ARTIFACT_REGION", "region"),
    ("EXPORT_ARTIFACT_BUCKET", "exportBucket"),
    ("ERASURE_REPLAY_LEDGER_ENDPOINT", "endpoint"),
    ("ERASURE_REPLAY_LEDGER_REGION", "region"),
    ("ERASURE_REPLAY_LEDGER_BUCKET", "ledgerBucket"),
)
for runtime_key, coordinate_key in coordinate_mirrors:
    if value("runtime", runtime_key) != coordinates[coordinate_key]:
        raise SystemExit(f"runtime.env {runtime_key} differs from Terraform-installed OCI coordinates")
restore_mirrors = (
    ("ERASURE_REPLAY_LEDGER_RESTORE_OCI_NAMESPACE", "namespace"),
    ("ERASURE_REPLAY_LEDGER_RESTORE_OCI_USER_OCID", "restoreUserOcid"),
)
for restore_key, coordinate_key in restore_mirrors:
    if value("restore", restore_key) != coordinates[coordinate_key]:
        raise SystemExit(f"restore.env {restore_key} differs from Terraform-installed OCI coordinates")
if value("restore", "ERASURE_REPLAY_LEDGER_RESTORE_VERSION_LIST_PROVIDER") != "oci_native":
    raise SystemExit("OCI controlled-beta restore version inventory must use oci_native")
if value("restore", "ERASURE_REPLAY_LEDGER_RESTORE_OCI_PRIVATE_KEY_FILE") != "/run/oci/restore-private-key.pem":
    raise SystemExit("Restore API private-key path differs from the offline-only mount")
if value("restore", "ERASURE_REPLAY_LEDGER_RESTORE_OCI_TENANCY_OCID") != coordinates["tenancyOcid"]:
    raise SystemExit("Restore tenancy OCID differs from Terraform-installed OCI coordinates")
if not re.fullmatch(r"(?:[0-9a-f]{2}:){15}[0-9a-f]{2}", value("restore", "ERASURE_REPLAY_LEDGER_RESTORE_OCI_KEY_FINGERPRINT")):
    raise SystemExit("Restore API-key fingerprint is invalid")


def parse_ring(name, key):
    try:
        parsed = json.loads(value(name, key))
    except json.JSONDecodeError as error:
        raise SystemExit(f"{key} in {name}.env is not valid JSON") from error
    if not isinstance(parsed, dict) or not 1 <= len(parsed) <= 32:
        raise SystemExit(f"{key} in {name}.env must be a non-empty JSON object")
    for key_id, encoded in parsed.items():
        if not isinstance(key_id, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", key_id):
            raise SystemExit(f"{key} in {name}.env has an invalid key ID")
        if not isinstance(encoded, str):
            raise SystemExit(f"{key} in {name}.env has a non-string key")
        try:
            decoded = base64.b64decode(encoded, validate=True)
        except (binascii.Error, ValueError) as error:
            raise SystemExit(f"{key} in {name}.env has invalid Base64") from error
        if len(decoded) != 32 or base64.b64encode(decoded).decode("ascii") != encoded:
            raise SystemExit(f"{key} in {name}.env must contain canonical Base64 32-byte keys")
    return parsed


export_api = parse_ring("api", "EXPORT_ARTIFACT_ENCRYPTION_KEYS")
export_worker = parse_ring("worker", "EXPORT_ARTIFACT_ENCRYPTION_KEYS")
ledger_worker = parse_ring("worker", "ERASURE_REPLAY_LEDGER_ENCRYPTION_KEYS")
ledger_restore = parse_ring("restore", "ERASURE_REPLAY_LEDGER_ENCRYPTION_KEYS")
locator_api = parse_ring("api", "ERASURE_REPLAY_LEDGER_LOCATOR_HMAC_KEYS")
locator_worker = parse_ring("worker", "ERASURE_REPLAY_LEDGER_LOCATOR_HMAC_KEYS")
locator_restore = parse_ring("restore", "ERASURE_REPLAY_LEDGER_LOCATOR_HMAC_KEYS")
if export_api != export_worker:
    raise SystemExit("Export encryption key rings differ between api.env and worker.env")
if ledger_worker != ledger_restore:
    raise SystemExit("Erasure-ledger encryption key rings differ between worker.env and restore.env")
if not (locator_api == locator_worker == locator_restore):
    raise SystemExit("Erasure locator HMAC key rings differ across api.env, worker.env, and restore.env")

ring_ids = (
    ("EXPORT_ARTIFACT_CURRENT_KEY_ID", export_api),
    ("ERASURE_REPLAY_LEDGER_CURRENT_KEY_ID", ledger_worker),
    ("ERASURE_REPLAY_LEDGER_LOCATOR_CURRENT_KEY_ID", locator_api),
)
for key, ring in ring_ids:
    if value("runtime", key) not in ring:
        raise SystemExit(f"runtime.env {key} does not exist in its role key ring")

expected_capacity_caps = {
    "OCI_PILOT_DATA_CLASSIFICATION": "synthetic-reviewer-only",
    "EXPORT_ARTIFACT_DELETE_VERSION_POLICY": "latest",
    "EXPORT_ARTIFACT_READ_MAX_ARTIFACT_BYTES": "10737418240",
    "EXPORT_ARTIFACT_READ_MAX_CONCURRENCY": "2",
    "EXPORT_ARTIFACT_READ_MAX_RESERVED_BYTES": "21474836480",
    "EXPORT_ARTIFACT_READ_MAX_BYTES_PER_WINDOW": "21474836480",
    "RETENTION_EXPORT_SPOOL_MAX_BYTES": "10737418240",
    "SEARCH_REBUILD_SPOOL_MAX_BYTES": "2147483648",
}
for key, expected in expected_capacity_caps.items():
    if value("runtime", key) != expected:
        raise SystemExit(f"runtime.env {key} must equal the reviewed single-node capacity cap")
PY

[[ -f "$object_hosts_env" && ! -L "$object_hosts_env" ]] || {
  echo "Missing root-generated Object Storage host map" >&2
  exit 1
}
[[ "$(stat -c '%U:%G:%a' "$object_hosts_env")" == "root:root:600" ]] || {
  echo "Object Storage host map must be root:root mode 0600" >&2
  exit 1
}
python3 - "$object_hosts_env" /etc/nutrition-tracker/object-storage-coordinates.json <<'PY'
import ipaddress, json, pathlib, re, sys

entries = {}
for line in pathlib.Path(sys.argv[1]).read_text(encoding="ascii").splitlines():
    key, separator, value = line.partition("=")
    if not separator or key in entries:
        raise SystemExit("Invalid or duplicate Object Storage host-map entry")
    entries[key] = value
if set(entries) != {"OCI_COMPAT_HOST", "OCI_COMPAT_IPV4", "OCI_NATIVE_HOST", "OCI_NATIVE_IPV4"}:
    raise SystemExit("Object Storage host map has an unexpected schema")
coordinates = json.loads(pathlib.Path(sys.argv[2]).read_text(encoding="utf-8"))
if entries["OCI_COMPAT_HOST"] != coordinates["compatHost"] or entries["OCI_NATIVE_HOST"] != coordinates["nativeHost"]:
    raise SystemExit("Object Storage host map differs from Terraform coordinates")
service = ipaddress.ip_network(coordinates["serviceCidr"], strict=True)
for key in ("OCI_COMPAT_IPV4", "OCI_NATIVE_IPV4"):
    try:
        address = ipaddress.ip_address(entries[key])
    except ValueError as error:
        raise SystemExit(f"{key} is not a canonical IP address") from error
    if address.version != 4 or address not in service:
        raise SystemExit(f"{key} is outside the Terraform-frozen Object Storage service CIDR")
PY

while IFS='=' read -r host_key host_value; do
  case "$host_key" in
    OCI_COMPAT_HOST|OCI_COMPAT_IPV4|OCI_NATIVE_HOST|OCI_NATIVE_IPV4)
      export "$host_key=$host_value"
      ;;
  esac
done <"$object_hosts_env"

for directory_specification in \
  'postgres 70:70:700' \
  'meili 1000:1000:700' \
  'export-read-spool 1000:1000:700' \
  'export-spool 1000:1000:700' \
  'search-spool 1000:1000:700' \
  'caddy 1000:1000:700' \
  'caddy/data 1000:1000:700' \
  'caddy/config 1000:1000:700'; do
  read -r directory expected <<<"$directory_specification"
  actual=$(stat -c '%u:%g:%a' "/var/lib/nutrition-tracker/$directory")
  [[ "$actual" == "$expected" ]] || { echo "Unsafe owner/mode on persistent path: $directory" >&2; exit 1; }
done

[[ "$(findmnt -n -o FSTYPE --target /var/lib/nutrition-tracker)" != "tmpfs" ]] || {
  echo "Persistent data root may not be tmpfs" >&2
  exit 1
}
[[ "$(findmnt -n -o SOURCE --target /var/lib/nutrition-tracker)" == "$(findmnt -n -o SOURCE --target /)" ]] || {
  echo "Persistent data root must remain on the reviewed encrypted boot volume" >&2
  exit 1
}
python3 - /var/lib/nutrition-tracker <<'PY'
import os
import sys

minimum_available_bytes = 48 * 1024 * 1024 * 1024
stats = os.statvfs(sys.argv[1])
available_bytes = stats.f_bavail * stats.f_frsize
if available_bytes < minimum_available_bytes:
    raise SystemExit(
        "At least 48 GiB must be available on the boot volume before application startup"
    )
PY

backup_evidence=/etc/nutrition-tracker/backup-restore-evidence.json
[[ -f "$backup_evidence" ]] || { echo "Missing reviewed backup/restore evidence" >&2; exit 1; }
[[ "$(stat -c '%U:%G:%a' "$backup_evidence")" == "root:root:600" ]] || {
  echo "Backup/restore evidence must be root:root mode 0600" >&2
  exit 1
}
python3 - "$backup_evidence" /etc/nutrition-tracker/expected-backup-policy-id "$runtime_env" <<'PY'
import datetime
import json
import pathlib
import re
import sys

evidence = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
expected_policy = pathlib.Path(sys.argv[2]).read_text(encoding="utf-8").strip()
expected_keys = {"backupId", "backupPolicyId", "restoreDrillAt", "restoreDrillResult", "sourceCommit"}
if set(evidence) != expected_keys:
    raise SystemExit("Backup/restore evidence has unexpected fields")
if evidence["backupPolicyId"] != expected_policy:
    raise SystemExit("Backup/restore evidence names the wrong OCI policy")
if not re.fullmatch(r"ocid1\.bootvolumebackup\.oc1\..+", evidence["backupId"]):
    raise SystemExit("Backup/restore evidence has an invalid boot-volume-backup OCID")
if evidence["restoreDrillResult"] != "passed":
    raise SystemExit("Backup restore drill did not pass")
if not re.fullmatch(r"[0-9a-f]{40}", evidence["sourceCommit"]):
    raise SystemExit("Backup/restore evidence sourceCommit must be a full Git SHA")
service_versions = [
    line.partition("=")[2]
    for line in pathlib.Path(sys.argv[3]).read_text(encoding="utf-8").splitlines()
    if line.startswith("SERVICE_VERSION=")
]
if len(service_versions) != 1 or not re.fullmatch(r"[0-9a-f]{40}", service_versions[0]):
    raise SystemExit("runtime.env must contain exactly one full-Git-SHA SERVICE_VERSION")
if evidence["sourceCommit"] != service_versions[0]:
    raise SystemExit("Backup/restore evidence sourceCommit does not match runtime.env SERVICE_VERSION")
try:
    drill_time = datetime.datetime.fromisoformat(evidence["restoreDrillAt"].replace("Z", "+00:00"))
except (AttributeError, ValueError):
    raise SystemExit("Backup/restore evidence restoreDrillAt must be RFC 3339")
now = datetime.datetime.now(datetime.timezone.utc)
if drill_time.tzinfo is None or drill_time > now or now - drill_time > datetime.timedelta(days=30):
    raise SystemExit("Backup restore drill must be timezone-aware, not future, and no older than 30 days")
PY


for cert in trust/ca.crt postgres/server.crt postgres/server.key meili/server.crt meili/server.key; do
  [[ -s "/etc/nutrition-tracker/pki/$cert" ]] || { echo "Missing internal PKI file: $cert" >&2; exit 1; }
done

restore_private_key=/etc/nutrition-tracker/oci/restore-private-key.pem
[[ -f "$restore_private_key" && ! -L "$restore_private_key" ]] || {
  echo "Offline restore API key must be a regular non-symlink file" >&2
  exit 1
}
[[ "$(stat -c '%u:%g:%a' "$restore_private_key")" == "1000:1000:400" ]] || {
  echo "Offline restore API key must be owned by UID/GID 1000 with mode 0400" >&2
  exit 1
}
[[ "$(stat -c '%s' "$restore_private_key")" -le 16384 ]] || {
  echo "Offline restore API key exceeds 16 KiB" >&2
  exit 1
}
openssl pkey -check -noout -in "$restore_private_key" >/dev/null 2>&1 || {
  echo "Offline restore API key is not a valid private key" >&2
  exit 1
}

/usr/local/sbin/nutrition-image-admission validate "$deploy_env" "$dependency_lock"

# No image is pulled or executed until the exact dependency lock is approved.
for image_variable in CADDY_IMAGE POSTGRES_IMAGE MEILI_IMAGE API_IMAGE WEB_IMAGE WORKER_IMAGE MIGRATOR_IMAGE; do
  image_reference=$(sed -n "s/^${image_variable}=//p" "$deploy_env")
  docker pull --platform linux/arm64 "$image_reference" >/dev/null
done

/usr/local/sbin/nutrition-image-admission inspect "$deploy_env" "$runtime_env" "$dependency_lock"

/usr/bin/docker compose \
  --env-file "$deploy_env" \
  -f "$compose_file" \
  config --quiet
