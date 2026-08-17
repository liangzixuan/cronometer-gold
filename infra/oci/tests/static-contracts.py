#!/usr/bin/env python3
"""Regression checks for ordering and fail-closed OCI runtime contracts."""

import base64
import copy
import hashlib
import json
import lzma
import os
import pathlib
import re
import stat
import subprocess
import sys
import tempfile
import types


ROOT = pathlib.Path(__file__).resolve().parents[1]
compose = (ROOT / "files/compose.yaml").read_text(encoding="utf-8")
orchestrator = (ROOT / "files/release-orchestrator.sh").read_text(encoding="utf-8")
caddyfile = (ROOT / "files/Caddyfile").read_text(encoding="utf-8")
preflight = (ROOT / "files/deployment-preflight.sh").read_text(encoding="utf-8")
image_admission = (ROOT / "files/image-admission.py").read_text(encoding="utf-8")
initial_secrets = (ROOT / "files/install-initial-secrets.py").read_text(encoding="utf-8")
object_credential_installer = (ROOT / "files/install-object-storage-credentials.py").read_text(encoding="utf-8")
object_credential_provisioner = (ROOT / "files/provision-object-storage-credentials.sh").read_text(encoding="utf-8")
object_credential_canary = (ROOT / "files/object-storage-credential-canary.py").read_text(encoding="utf-8")
credential_rotation_lock = (ROOT / "files/credential-rotation-lock.sh").read_text(encoding="utf-8")
object_egress_firewall = (ROOT / "files/configure-object-egress-firewall.sh").read_text(encoding="utf-8")
object_egress_assertion = (ROOT / "files/assert-object-egress-firewall.py").read_text(encoding="utf-8")
object_egress_watchdog = (ROOT / "files/object-egress-firewall-watchdog.sh").read_text(encoding="utf-8")
object_egress_preparer = (ROOT / "files/prepare-object-storage-egress.py").read_text(encoding="utf-8")
object_egress_systemd = (ROOT / "files/object-egress-firewall.service").read_text(encoding="utf-8")
object_egress_watchdog_systemd = (ROOT / "files/object-egress-firewall-watchdog.service").read_text(encoding="utf-8")
object_egress_watchdog_timer = (ROOT / "files/object-egress-firewall-watchdog.timer").read_text(encoding="utf-8")
systemd = (ROOT / "files/nutrition-tracker.service").read_text(encoding="utf-8")
internal_pki = (ROOT / "files/prepare-internal-pki.sh").read_text(encoding="utf-8")
internal_pki_systemd = (ROOT / "files/internal-pki-rotation.service").read_text(encoding="utf-8")
container_runtime_systemd = (ROOT / "files/container-runtime-bootstrap.service").read_text(encoding="utf-8")
failure_containment = (ROOT / "files/release-failure-containment.sh").read_text(encoding="utf-8")
failure_containment_systemd = (ROOT / "files/release-failure-containment.service").read_text(encoding="utf-8")
cloud_init = (ROOT / "templates/cloud-init.yaml.tftpl").read_text(encoding="utf-8")
locals_tf = (ROOT / "locals.tf").read_text(encoding="utf-8")
compute_tf = (ROOT / "compute.tf").read_text(encoding="utf-8")
network_tf = (ROOT / "network.tf").read_text(encoding="utf-8")
object_storage_tf = (ROOT / "object-storage.tf").read_text(encoding="utf-8")
variables_tf = (ROOT / "variables.tf").read_text(encoding="utf-8")
deploy_example = (ROOT / "templates/deploy.env.example.tftpl").read_text(encoding="utf-8")
runtime_example = (ROOT / "templates/runtime.env.example.tftpl").read_text(encoding="utf-8")
restore_example = (ROOT / "templates/restore.env.example.tftpl").read_text(encoding="utf-8")
external_lock = json.loads((ROOT / "external-images.lock.json").read_text(encoding="utf-8"))
assert set(external_lock) == {"schemaVersion", "reviewedAt", "policy", "images"}


def service(name: str) -> str:
    match = re.search(
        rf"(?ms)^  {re.escape(name)}:\n(.*?)(?=^  [a-z0-9-]+:\n|^networks:\n|\Z)", compose
    )
    if match is None:
        raise AssertionError(f"missing Compose service {name}")
    return match.group(1)


assert "minio" not in compose.lower()
assert "minio" not in orchestrator.lower()

application_anchor = compose[: compose.index("services:")]
assert 'restart: "no"' in application_anchor
assert "restart: unless-stopped" not in application_anchor

for egress_service in (
    "api",
    "worker",
    "object-storage-live-canary",
    "erasure-restore-attestation",
):
    assert "object_egress:" in service(egress_service)
    assert "gw_priority: 1" in service(egress_service)
for isolated_service in ("migrate", "database-readiness"):
    assert "object_egress" not in service(isolated_service)
restore_key_mount = "/etc/nutrition-tracker/oci/restore-private-key.pem:/run/oci/restore-private-key.pem:ro,z"
assert compose.count(restore_key_mount) == 2
assert restore_key_mount in service("object-storage-live-canary")
assert restore_key_mount in service("erasure-restore-attestation")
for online_service in ("api", "web", "worker", "migrate", "database-readiness"):
    assert restore_key_mount not in service(online_service)
assert "internal: true" in compose and "object_egress:" in compose
assert "internal: false" in compose.split("  object_egress:\n", 1)[1]
assert "name: cronometer-gold-beta-object-egress" in compose
assert "subnet: 172.31.255.0/28" in compose
assert "dns: [127.0.0.1]" in service("api")
assert "dns:" not in service("web")
assert "network_mode: service:api" in service("web")
assert "dns: [127.0.0.1]" in service("worker")
assert "dns: [127.0.0.1]" in service("object-storage-live-canary")
assert "dns: [127.0.0.1]" in service("erasure-restore-attestation")
assert 'user: "1000:1000"' in service("caddy")
assert "cap_drop: [ALL]" in service("caddy")
assert "cap_add: [NET_BIND_SERVICE]" in service("caddy")
assert 'user: "70:70"' in service("postgres")
assert "/var/lib/nutrition-tracker/postgres:/var/lib/postgresql/data:Z" in service("postgres")
assert "/run/postgresql:rw,noexec,nosuid,size=64m,uid=70,gid=70,mode=3775" in service("postgres")
assert "/tmp:rw,noexec,nosuid,size=64m,uid=70,gid=70,mode=1770" in service("postgres")

live_canary = service("object-storage-live-canary")
assert 'command: ["node", "dist/object-storage-credential-canary.js"]' in live_canary
for env_file in ("runtime.env", "api.env", "worker.env", "restore.env"):
    assert f"/etc/nutrition-tracker/{env_file}" in live_canary
assert "depends_on:" not in live_canary
assert "backend" not in live_canary

negative_canary = service("object-egress-negative-canary")
assert "host:'1.1.1.1',port:443" in negative_canary
assert "object_egress:" in negative_canary
assert "env_file:" not in negative_canary and "volumes:" not in negative_canary

ordered = (
    '\n    admit_rotation_start\n',
    'stop api web worker',
    '\n    stop_stale_operations\n',
    '\n    assert_release_services_stopped\n',
    'nutrition-instance-identity verify-runtime',
    'nutrition-prepare-object-storage-egress',
    '\n    load_object_storage_hosts\n',
    'nutrition-deployment-preflight early',
    'up -d --wait --wait-timeout 300 caddy postgres meilisearch',
    'nutrition-bootstrap-meili-keys',
    'nutrition-deployment-preflight full',
    'run --rm object-egress-negative-canary',
    'run --rm object-storage-live-canary',
    'run --rm migrate',
    'run --rm erasure-restore-attestation',
    'run --rm database-readiness',
    'up -d --wait --wait-timeout 300 api web worker',
)
positions = [orchestrator.index(fragment) for fragment in ordered]
assert positions == sorted(positions), "release gate ordering changed"
assert "stop_stale_operations" in orchestrator
assert "object-storage-live-canary erasure-restore-attestation database-readiness" in orchestrator
assert orchestrator.count('run --rm migrate') == 2
assert "object-storage-hosts.env" in orchestrator
assert "flock -n -E 75 8" in orchestrator
assert orchestrator.index("admit_rotation_start") < orchestrator.index("stop api web worker")
application_attempt = orchestrator.index("application_start_attempted=1")
application_up = orchestrator.index("up -d --wait --wait-timeout 300 api web worker")
readiness_commit = orchestrator.index("readiness_committed=1")
assert application_attempt < application_up < readiness_commit
assert "trap contain_uncommitted_application_start EXIT" in orchestrator
assert "stop_release_containers || containment_failed=1" in orchestrator
assert "Release was not committed; API, web, and worker were stopped" in orchestrator
assert "Could not inspect release service $service" in orchestrator
assert re.search(r"running=\$\(/usr/bin/docker ps -q.*?\) \|\| \{", orchestrator, re.DOTALL)
start_body = orchestrator.split("  start)\n", 1)[1].split("    ;;", 1)[0]
assert start_body.index("application_start_attempted=1") < start_body.index('stop api web worker')
stop_body = orchestrator.split("  stop)\n", 1)[1].split("    ;;", 1)[0]
assert stop_body.index("application_start_attempted=1") < stop_body.index("stop_stale_operations") < stop_body.index("readiness_committed=1")

assert '@betaAllowed remote_ip {$BETA_ALLOWED_CIDRS}' in caddyfile
assert "remote_ip private_ranges" in caddyfile
assert "method GET" in caddyfile and "path /ready" in caddyfile
assert 'respond "Not Found" 404' in caddyfile
assert "0.0.0.0/0" in preflight and "::/0" in preflight
assert "ExecStartPre=/usr/local/sbin/nutrition-instance-identity verify-runtime" in systemd
assert "nutrition-instance-identity, bind-initial" in cloud_init

expected_bootstrap_modes = {
    "/etc/docker/daemon.json": "0644",
    "/etc/nutrition-tracker/api.env.example": "0600",
    "/etc/nutrition-tracker/backup-restore-evidence.json.example": "0600",
    "/etc/nutrition-tracker/database.env.example": "0600",
    "/etc/nutrition-tracker/deploy.env.example": "0600",
    "/etc/nutrition-tracker/expected-backup-policy-id": "0644",
    "/etc/nutrition-tracker/meili.env.example": "0600",
    "/etc/nutrition-tracker/object-storage-coordinates.json": "0644",
    "/etc/nutrition-tracker/operator-helper-digests.json": "0644",
    "/etc/nutrition-tracker/restore.env.example": "0600",
    "/etc/nutrition-tracker/runtime.env.example": "0600",
    "/etc/nutrition-tracker/worker.env.example": "0600",
    "/etc/ssh/sshd_config.d/60-nutrition-tracker.conf": "0644",
    "/etc/systemd/system/nutrition-container-runtime-bootstrap.service": "0644",
    "/etc/systemd/system/nutrition-internal-pki-rotation.service": "0644",
    "/etc/systemd/system/nutrition-internal-pki-rotation.timer": "0644",
    "/etc/systemd/system/nutrition-object-egress-firewall.service": "0644",
    "/etc/systemd/system/nutrition-object-egress-firewall-watchdog.service": "0644",
    "/etc/systemd/system/nutrition-object-egress-firewall-watchdog.timer": "0644",
    "/etc/systemd/system/nutrition-release-failure-containment.service": "0644",
    "/etc/systemd/system/nutrition-tracker.service": "0644",
    "/opt/nutrition-tracker/Caddyfile": "0644",
    "/opt/nutrition-tracker/compose.yaml": "0644",
    "/opt/nutrition-tracker/external-images.lock.json": "0644",
    "/usr/local/sbin/install-nutrition-docker-ce": "0750",
    "/usr/local/sbin/nutrition-assert-object-egress-firewall": "0750",
    "/usr/local/sbin/nutrition-configure-host-firewall": "0750",
    "/usr/local/sbin/nutrition-configure-object-egress-firewall": "0750",
    "/usr/local/sbin/nutrition-contain-failed-release": "0750",
    "/usr/local/sbin/nutrition-credential-rotation-lock": "0750",
    "/usr/local/sbin/nutrition-install-initial-secrets": "0750",
    "/usr/local/sbin/nutrition-instance-identity": "0750",
    "/usr/local/sbin/nutrition-object-egress-firewall-watchdog": "0750",
    "/usr/local/sbin/nutrition-prepare-internal-pki": "0750",
    "/usr/local/sbin/nutrition-prepare-object-storage-egress": "0750",
    "/usr/local/sbin/nutrition-prepare-storage": "0750",
    "/usr/local/sbin/nutrition-release-orchestrator": "0750",
}
bootstrap_section = locals_tf.split("  bootstrap_files = {", 1)[1].split("\n  cloud_init =", 1)[0]
actual_bootstrap_modes = dict(
    re.findall(r'(?ms)^    "(/[^"]+)" = \{.*?^      mode\s*= "([0-7]{4})"$', bootstrap_section)
)
assert actual_bootstrap_modes == expected_bootstrap_modes
assert cloud_init.count("  - path:") == 3
assert "  - path: /var/lib/cloud/nutrition-bootstrap-files.json.xz.b85" in cloud_init
assert "  - path: /var/lib/cloud/nutrition-bootstrap-files.sha256" in cloud_init
assert "  - path: /usr/local/sbin/nutrition-unpack-bootstrap" in cloud_init
assert cloud_init.index("[/usr/local/sbin/nutrition-unpack-bootstrap]") < cloud_init.index(
    "nutrition-configure-host-firewall"
)
assert "sourceLockSha256 = filesha256" in locals_tf
assert "content = jsonencode(local.external_runtime_image_lock)" in locals_tf
assert "image.approved && image.scan.critical == 0" in locals_tf
assert "metadata_payload_size_bytes <= 30000" in compute_tf
assert 'regex("^[ -~]+$", trimspace(key))' in variables_tf
assert "printable-ASCII OpenSSH public key" in variables_tf

assert "oci.customer-oci.com" in locals_tf
assert "oraclecloud.com" not in runtime_example
assert "us-east-1" not in runtime_example
assert "EXPORT_ARTIFACT_DELETE_VERSION_POLICY=latest" in runtime_example
assert "OCI_PILOT_DATA_CLASSIFICATION=synthetic-reviewer-only" in runtime_example
assert '"OCI_PILOT_DATA_CLASSIFICATION": "synthetic-reviewer-only"' in preflight
assert "OCI controlled-beta restore version inventory" in preflight
assert "ERASURE_REPLAY_LEDGER_RESTORE_VERSION_LIST_PROVIDER=oci_native" in restore_example
assert "ERASURE_REPLAY_LEDGER_RESTORE_OCI_PRIVATE_KEY_FILE=/run/oci/restore-private-key.pem" in restore_example
assert "MINIO" not in deploy_example and "minio" not in locals_tf.lower()

assert 'resource "oci_objectstorage_bucket" "exports"' in object_storage_tf
assert 'resource "oci_objectstorage_bucket" "ledger"' in object_storage_tf
assert object_storage_tf.count('access_type           = "NoPublicAccess"') == 2
assert object_storage_tf.count('versioning            = "Disabled"') == 1
assert object_storage_tf.count('versioning            = "Enabled"') == 1
assert object_storage_tf.count("prevent_destroy = true") >= 6
assert 'resource "oci_identity_customer_secret_key"' not in object_storage_tf
assert 'resource "oci_identity_api_key"' not in object_storage_tf
assert 'object_prefix      = "exports/v1/*"' in object_storage_tf
assert 'object_prefix      = "erasure-ledger/v1/*"' in object_storage_tf

def role_contract(role: str, next_role: str | None) -> str:
    start = object_storage_tf.index(f"    {role} = {{")
    end = object_storage_tf.index(f"    {next_role} = {{", start) if next_role else object_storage_tf.index("  }\n}\n\nresource", start)
    return object_storage_tf[start:end]


assert 'object_permissions = ["OBJECT_READ"]' in role_contract("export_reader", "export_writer")
assert 'object_permissions = ["OBJECT_CREATE", "OBJECT_READ", "OBJECT_DELETE"]' in role_contract("export_writer", "ledger_writer")
assert 'object_permissions = ["OBJECT_CREATE", "OBJECT_READ"]' in role_contract("ledger_writer", "ledger_restore")
assert 'object_permissions = ["OBJECT_INSPECT", "OBJECT_READ"]' in role_contract("ledger_restore", None)
assert "target.bucket.name='${each.value.bucket_name}'" in object_storage_tf
assert "target.object.name='${each.value.object_prefix}'" in object_storage_tf
assert "SERVICE_CIDR_BLOCK" in network_tf and "oci_core_service_gateway.object_storage.id" in network_tf
assert 'object_bridge_cidr  = "172.31.255.0/28"' in locals_tf
assert "serviceCidr" in locals_tf and "compatHost" in locals_tf and "nativeHost" in locals_tf

assert "iptables -I FORWARD 1" in object_egress_firewall
assert "--dport 443" in object_egress_firewall
assert "REJECT --reject-with icmp-port-unreachable" in object_egress_firewall
assert "--dport 53" not in object_egress_firewall
assert "PartOf=docker.service firewalld.service" in object_egress_systemd
assert "ExecStart=/usr/local/sbin/nutrition-object-egress-firewall-watchdog" in object_egress_systemd
assert "SuccessExitStatus=3" in object_egress_systemd
assert "OnFailure=nutrition-release-failure-containment.service" in object_egress_systemd
assert "nutrition-object-egress-firewall.service" in systemd
assert "nutrition-object-egress-firewall-watchdog.timer" in cloud_init
assert "SuccessExitStatus=3" in object_egress_watchdog_systemd
assert "OnFailure=nutrition-release-failure-containment.service" in object_egress_watchdog_systemd
assert "OnCalendar=*-*-* *:*:00,15,30,45" in object_egress_watchdog_timer
watchdog_quarantine = object_egress_watchdog.index("iptables -I FORWARD 1")
watchdog_lock = object_egress_watchdog.index('flock -w 120 9')
watchdog_containment = object_egress_watchdog.index("nutrition-contain-failed-release --lock-held")
watchdog_repair = object_egress_watchdog.index("nutrition-configure-object-egress-firewall")
watchdog_recheck = object_egress_watchdog.rindex("nutrition-assert-object-egress-firewall")
assert watchdog_quarantine < watchdog_lock < watchdog_containment < watchdog_repair < watchdog_recheck
assert "exit 3" in object_egress_watchdog
assert "trap invalidate_on_true_failure EXIT" in object_egress_watchdog
watchdog_main = object_egress_watchdog.index("if /usr/local/sbin/nutrition-assert-object-egress-firewall")
watchdog_assertion = object_egress_watchdog.index("nutrition-assert-object-egress-firewall", watchdog_main)
watchdog_invalidation = object_egress_watchdog.index(
    "systemctl --no-block stop nutrition-tracker.service", watchdog_assertion
)
assert watchdog_assertion < watchdog_invalidation < watchdog_quarantine
assert "--lock-held" in failure_containment
assert 'readlink "/proc/$$/fd/9"' in failure_containment
assert start_body.rindex("nutrition-assert-object-egress-firewall") < start_body.index(
    "up -d --wait --wait-timeout 300 api web worker"
)
assert 'socket.getaddrinfo(host, 443, socket.AF_INET, socket.SOCK_STREAM)' in object_egress_preparer
assert 'OUTPUT = OUTPUT_DIRECTORY / "object-storage-hosts.env"' in object_egress_preparer
assert "outside the Terraform-frozen Object Storage service CIDR" in object_egress_preparer
assert "Object-egress bridge" in object_egress_preparer
assert "network.subnet_of(bridge)" in object_egress_preparer
assert "candidate.version == bridge.version" in object_egress_preparer
assert "/usr/local/sbin/nutrition-assert-object-egress-firewall" in preflight
assert "Object Storage host map differs from Terraform coordinates" in preflight

assert "TARGET_NAMES = (\"runtime\", \"database\", \"api\", \"worker\", \"meili\", \"restore\")" in initial_secrets
assert "REPLACE_OCI_LEDGER_RESTORE_KEY_FINGERPRINT" in initial_secrets
assert "1000, 1000, 0o400" in object_credential_installer
assert "label=com.docker.compose.service={service}" in object_credential_installer
assert '"object-storage-live-canary"' in object_credential_installer
assert '"object-egress-negative-canary"' in object_credential_installer
assert "aws" not in object_credential_provisioner
assert "AWS_ACCESS_KEY_ID" not in object_credential_provisioner
assert "install_reviewed_host_script" in object_credential_provisioner
assert "scp -q \"$source\"" in object_credential_provisioner
assert "digest=$(sha256sum \"$source\"" in object_credential_provisioner
assert "sudo /run/nutrition-install-object-storage-credentials" in object_credential_provisioner
assert "/usr/local/sbin/nutrition-bootstrap-meili-keys meili-bootstrap" in object_credential_provisioner
assert "/usr/local/sbin/nutrition-deployment-preflight deployment-preflight" in object_credential_provisioner
assert "/usr/local/sbin/nutrition-image-admission image-admission" in object_credential_provisioner
assert "verify_plan_bound_helpers" in object_credential_provisioner
assert "Local operator helper differs from Terraform-applied bytes" in object_credential_provisioner
assert "pinned-helpers" in object_credential_provisioner
assert "os.O_EXCL" in object_credential_provisioner
assert "os.fsync(stream.fileno())" in object_credential_provisioner
assert "Operator-installed helper differs from Terraform-applied bytes" in preflight
assert '"deployment-preflight.sh": "/usr/local/sbin/nutrition-deployment-preflight"' in preflight
assert locals_tf.count("filesha256(\"${path.module}/files/") == 4
assert '"/usr/local/sbin/nutrition-install-object-storage-credentials"' not in locals_tf
assert '"/usr/local/sbin/nutrition-bootstrap-meili-keys"' not in locals_tf
assert '"/usr/local/sbin/nutrition-deployment-preflight"' not in locals_tf
assert '"/usr/local/sbin/nutrition-image-admission"' not in locals_tf
assert "AWS4-HMAC-SHA256" in object_credential_canary
assert '"versionId", native_version' in object_credential_canary
assert "native_items) != 1" in object_credential_canary
assert object_credential_canary.index('credentials["ledgerWriter"], "PUT", ledger_bucket') < object_credential_canary.index('credentials["exportWriter"], "GET", ledger_bucket')
assert object_credential_canary.index('credentials["exportWriter"], "GET", ledger_bucket') < object_credential_canary.index('credentials["exportWriter"], "DELETE", export_bucket')
assert "expect_status=404" in object_credential_canary
assert "timeout=30" in object_credential_canary
assert "for directory in sorted({path.parent for path in rendered} | {START_ADMISSION.parent})" in object_credential_installer
assert '"rotationLockToken"' in object_credential_installer
assert "assert_rotation_lock(bundle[\"rotationLockToken\"])" in object_credential_installer
assert "lock_probe.returncode != 75" in object_credential_installer
assert "START_ADMISSION" in object_credential_installer
assert "nutrition-object-credential-start-admission" in orchestrator
assert "Credential rotation has not admitted this release start" in orchestrator
assert "flock -n -E 75 9" in credential_rotation_lock
assert "rm -f -- \"$admission_file\"" in credential_rotation_lock
rotation_acquire = object_credential_provisioner.index("\nacquire_remote_rotation_lock\n")
assert rotation_acquire < object_credential_provisioner.index("count=$(active_customer_key_count", rotation_acquire)
assert object_credential_provisioner.index("sudo systemctl stop nutrition-tracker.service", rotation_acquire) < object_credential_provisioner.index("nutrition-release-orchestrator stop", rotation_acquire) < object_credential_provisioner.index("iam customer-secret-key create", rotation_acquire)
assert object_credential_provisioner.index("iam user api-key upload", rotation_acquire) < object_credential_provisioner.index("sudo /run/nutrition-install-object-storage-credentials", rotation_acquire)
assert object_credential_provisioner.index("sudo /run/nutrition-install-object-storage-credentials", rotation_acquire) < object_credential_provisioner.index("sudo systemctl start nutrition-tracker.service", rotation_acquire)
assert "release_remote_rotation_lock" in object_credential_provisioner

assert internal_pki.index("flock -n 8") < internal_pki.index('rotation_staging_root=$(mktemp')
assert "activating|deactivating|reloading" in internal_pki
assert "readonly operation_services=(migrate object-egress-negative-canary object-storage-live-canary erasure-restore-attestation database-readiness)" in internal_pki
assert "readonly runtime_services=(api web worker caddy postgres meilisearch)" in internal_pki
assert internal_pki.index('for service in "${operation_services[@]}"') < internal_pki.index('rotation_staging_root=$(mktemp')
assert 'for service in "${containment_services[@]}"' in internal_pki
assert "--force-recreate" in internal_pki and "--pull never" in internal_pki
assert "-starttls postgres" in internal_pki
assert "-verify_hostname meili.internal" in internal_pki
assert internal_pki.count("contain_failed_pki_reload") == 2
assert "systemctl --no-block stop nutrition-tracker.service" in internal_pki
assert "PKI reload failed; application/core containers were stopped" in internal_pki
assert "trap pki_exit_cleanup EXIT" in internal_pki
assert "trap 'exit 143' HUP INT TERM" in internal_pki
assert "pki_reload_attempted=$stack_requires_reload" in internal_pki
assert "pki_reload_committed=1" in internal_pki
for guarded_primitive in (
    'openssl verify -CAfile "$ca_dir/ca.crt" "$directory/server.crt" >/dev/null || return 1',
    'openssl x509 -checkend "$minimum_seconds" -noout -in "$directory/server.crt" >/dev/null || return 1',
    'grep -Fq "DNS:$dns_name" || return 1',
    '[[ "$key_digest" == "$cert_digest" ]] || return 1',
    'cmp -s "$ca_dir/ca.crt" "$trust_dir/ca.crt" || return 1',
):
    assert guarded_primitive in internal_pki
assert internal_pki.count("return 0") >= 4
assert "TimeoutStartSec=10min" in internal_pki_systemd
assert "TimeoutStopSec=10min" in internal_pki_systemd
assert "TimeoutStartSec=20min" in container_runtime_systemd
assert "TimeoutStopSec=2min" in container_runtime_systemd
assert "OnFailure=nutrition-release-failure-containment.service" in systemd
assert "OnFailure=nutrition-release-failure-containment.service" in internal_pki_systemd
assert "SuccessExitStatus=75" in internal_pki_systemd
assert "flock -w 120 9" in failure_containment
for contained_service in (
    "api", "web", "worker", "migrate", "object-egress-negative-canary",
    "object-storage-live-canary", "erasure-restore-attestation",
    "database-readiness", "caddy", "postgres", "meilisearch",
):
    assert contained_service in failure_containment
assert "systemctl --no-block stop nutrition-tracker.service" in failure_containment
assert "TimeoutStartSec=15min" in failure_containment_systemd
rotate_body = internal_pki.split("\nrotate_leaves() {", 1)[1].split("\n}\n", 1)[0]
assert rotate_body.index("verify_all 14") < rotate_body.index("reload_and_verify_served_leaves") < rotate_body.rindex("cleanup_rotation_staging")
init_body = internal_pki.split("  init)\n", 1)[1].split("    ;;", 1)[0]
assert init_body.index("acquire_release_lock_and_inspect_stack") < init_body.index('[[ -e "$ca_dir/ca.key"') < init_body.index("install -d -m 0711")

# Exercise the exact verify_leaf function body with real OpenSSL fixtures.
# Every malformed/expired/wrong-SAN/key-mismatch case must return nonzero even
# though the function is invoked in an `if`, where Bash disables errexit.
pki_verification_functions = internal_pki[
    internal_pki.index("certificate_specifications() {"):
    internal_pki.index("acquire_release_lock_and_inspect_stack() {")
]
pki_openssl = pathlib.Path("/opt/homebrew/opt/openssl@3/bin/openssl")
if not pki_openssl.exists():
    pki_openssl = pathlib.Path("openssl")


def run_leaf_verifier(root: pathlib.Path, minimum_days: int = 14) -> subprocess.CompletedProcess:
    verifier = f"""#!/usr/bin/env bash
set -euo pipefail
pki_root=$1
ca_dir="$pki_root/ca"
trust_dir="$pki_root/trust"
{pki_verification_functions}
if verify_leaf postgres postgres "$2" "$3" "$4"; then
  exit 0
fi
exit 1
"""
    return subprocess.run(
        ["bash", "-s", "--", str(root), str(os.getuid()), str(os.getgid()), str(minimum_days)],
        input=verifier,
        text=True,
        capture_output=True,
        check=False,
        env={
            **os.environ,
            "PATH": f"{root / 'bin'}:{pki_openssl.parent}:{os.environ.get('PATH', '')}"
            if pki_openssl.is_absolute()
            else f"{root / 'bin'}:{os.environ.get('PATH', '')}",
        },
    )


with tempfile.TemporaryDirectory() as pki_temporary_directory:
    pki_fixture = pathlib.Path(pki_temporary_directory)
    ca_fixture = pki_fixture / "ca"
    leaf_fixture = pki_fixture / "postgres"
    shim_directory = pki_fixture / "bin"
    ca_fixture.mkdir(mode=0o700)
    leaf_fixture.mkdir(mode=0o750)
    shim_directory.mkdir(mode=0o700)
    stat_shim = shim_directory / "stat"
    stat_shim.write_text(
        "#!/usr/bin/env python3\n"
        "import grp, os, pathlib, pwd, stat, sys\n"
        "if len(sys.argv) != 4 or sys.argv[1] != '-c': raise SystemExit(64)\n"
        "metadata = pathlib.Path(sys.argv[3]).stat()\n"
        "values = {'%u': str(metadata.st_uid), '%g': str(metadata.st_gid), "
        "'%U': pwd.getpwuid(metadata.st_uid).pw_name, '%G': grp.getgrgid(metadata.st_gid).gr_name, "
        "'%a': format(stat.S_IMODE(metadata.st_mode), 'o')}\n"
        "result = sys.argv[2]\n"
        "for key, value in values.items(): result = result.replace(key, value)\n"
        "print(result)\n",
        encoding="ascii",
    )
    stat_shim.chmod(0o700)
    config_fixture = leaf_fixture / "openssl.cnf"
    config_fixture.write_text(
        "[req]\ndistinguished_name=dn\nprompt=no\nreq_extensions=extensions\n"
        "[dn]\nCN=postgres\n[extensions]\nsubjectAltName=DNS:postgres\n"
        "keyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n",
        encoding="ascii",
    )
    openssl_commands = (
        [str(pki_openssl), "genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048", "-out", str(ca_fixture / "ca.key")],
        [str(pki_openssl), "req", "-x509", "-new", "-key", str(ca_fixture / "ca.key"), "-days", "365", "-subj", "/CN=test-ca", "-out", str(ca_fixture / "ca.crt")],
        [str(pki_openssl), "genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048", "-out", str(leaf_fixture / "server.key")],
        [str(pki_openssl), "req", "-new", "-key", str(leaf_fixture / "server.key"), "-config", str(config_fixture), "-out", str(leaf_fixture / "server.csr")],
        [str(pki_openssl), "x509", "-req", "-in", str(leaf_fixture / "server.csr"), "-CA", str(ca_fixture / "ca.crt"), "-CAkey", str(ca_fixture / "ca.key"), "-CAcreateserial", "-days", "90", "-sha256", "-extfile", str(config_fixture), "-extensions", "extensions", "-out", str(leaf_fixture / "server.crt")],
    )
    for command in openssl_commands:
        subprocess.run(command, check=True, capture_output=True)
    (leaf_fixture / "server.key").chmod(0o600)
    (leaf_fixture / "server.crt").chmod(0o644)
    valid_key = (leaf_fixture / "server.key").read_bytes()
    valid_certificate = (leaf_fixture / "server.crt").read_bytes()
    valid_verification = run_leaf_verifier(pki_fixture)
    assert valid_verification.returncode == 0, valid_verification.stderr
    assert run_leaf_verifier(pki_fixture, minimum_days=120).returncode != 0

    subprocess.run(
        [str(pki_openssl), "x509", "-req", "-in", str(leaf_fixture / "server.csr"), "-CA", str(ca_fixture / "ca.crt"), "-CAkey", str(ca_fixture / "ca.key"), "-days", "0", "-sha256", "-extfile", str(config_fixture), "-extensions", "extensions", "-out", str(leaf_fixture / "server.crt")],
        check=True,
        capture_output=True,
    )
    (leaf_fixture / "server.crt").chmod(0o644)
    assert run_leaf_verifier(pki_fixture).returncode != 0
    (leaf_fixture / "server.crt").write_bytes(valid_certificate)
    (leaf_fixture / "server.crt").chmod(0o644)

    wrong_san_config = leaf_fixture / "wrong-san.cnf"
    wrong_san_config.write_text(config_fixture.read_text(encoding="ascii").replace("DNS:postgres", "DNS:wrong.internal"), encoding="ascii")
    subprocess.run(
        [str(pki_openssl), "x509", "-req", "-in", str(leaf_fixture / "server.csr"), "-CA", str(ca_fixture / "ca.crt"), "-CAkey", str(ca_fixture / "ca.key"), "-days", "90", "-sha256", "-extfile", str(wrong_san_config), "-extensions", "extensions", "-out", str(leaf_fixture / "server.crt")],
        check=True,
        capture_output=True,
    )
    (leaf_fixture / "server.crt").chmod(0o644)
    assert run_leaf_verifier(pki_fixture).returncode != 0

    (leaf_fixture / "server.crt").write_bytes(valid_certificate)
    subprocess.run(
        [str(pki_openssl), "genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048", "-out", str(leaf_fixture / "server.key")],
        check=True,
        capture_output=True,
    )
    (leaf_fixture / "server.key").chmod(0o600)
    assert run_leaf_verifier(pki_fixture).returncode != 0

    (leaf_fixture / "server.key").write_bytes(valid_key)
    (leaf_fixture / "server.key").chmod(0o600)
    (leaf_fixture / "server.crt").write_text("not a certificate\n", encoding="ascii")
    (leaf_fixture / "server.crt").chmod(0o644)
    assert run_leaf_verifier(pki_fixture).returncode != 0

# The shared firewall assertion must reject missing/reordered parent hooks and
# any inverted or extra match token even when all expected tokens are present.
firewall_namespace = {"__name__": "object_egress_firewall_contract"}
exec(compile(object_egress_assertion, "object-egress-firewall-contract", "exec"), firewall_namespace)
bridge_fixture = "172.31.255.0/28"
service_fixture = "134.70.0.0/17"
chain_fixture = firewall_namespace["CHAIN"]
jump_fixture = ["-A", "FORWARD", "-s", bridge_fixture, "-j", chain_fixture]
rules_fixture = [
    ["-A", chain_fixture, "-d", service_fixture, "-p", "tcp", "-m", "tcp", "--dport", "443", "-m", "conntrack", "--ctstate", "ESTABLISHED", "-j", "ACCEPT"],
    ["-A", chain_fixture, "-d", service_fixture, "-p", "tcp", "-m", "tcp", "--dport", "443", "-m", "conntrack", "--ctstate", "NEW", "-j", "ACCEPT"],
    ["-A", chain_fixture, "-j", "REJECT", "--reject-with", "icmp-port-unreachable"],
]
firewall_namespace["verify"]([jump_fixture], rules_fixture, bridge_fixture, service_fixture)
blocked_firewall_fixtures = (
    ([], rules_fixture),
    ([["-A", "FORWARD", "-j", "ACCEPT"], jump_fixture], rules_fixture),
    ([jump_fixture, jump_fixture], rules_fixture),
    ([jump_fixture], rules_fixture[:-1]),
    ([jump_fixture], [["-A", chain_fixture, "-m", "conntrack", "--ctstate", "ESTABLISHED", "-j", "ACCEPT"], rules_fixture[1], rules_fixture[2]]),
    ([jump_fixture], [rules_fixture[0], rules_fixture[1][:2] + ["!"] + rules_fixture[1][2:], rules_fixture[2]]),
    ([jump_fixture], [rules_fixture[0], rules_fixture[1][:-2] + ["!", "-j", "ACCEPT"], rules_fixture[2]]),
)
for forward_fixture, egress_fixture in blocked_firewall_fixtures:
    try:
        firewall_namespace["verify"](forward_fixture, egress_fixture, bridge_fixture, service_fixture)
    except SystemExit:
        pass
    else:
        raise AssertionError("noncanonical or orphaned object-egress rules must fail closed")

external_variables = {"MEILI_IMAGE"}
assert set(external_lock["images"]) == external_variables
for variable, image in external_lock["images"].items():
    assert f"{variable}={image['ref']}" in deploy_example
assert all(image["approved"] is True and image["scan"] == {
    "critical": 0, "high": 0, "total": 0, "result": "passed",
} for image in external_lock["images"].values())
for variable, repository in {
    "CADDY_IMAGE": "ghcr.io/liangzixuan/cronometer-gold-caddy",
    "POSTGRES_IMAGE": "ghcr.io/liangzixuan/cronometer-gold-postgres",
    "API_IMAGE": "ghcr.io/liangzixuan/cronometer-gold-api",
    "WEB_IMAGE": "ghcr.io/liangzixuan/cronometer-gold-web",
    "WORKER_IMAGE": "ghcr.io/liangzixuan/cronometer-gold-worker",
    "MIGRATOR_IMAGE": "ghcr.io/liangzixuan/cronometer-gold-migrator",
}.items():
    assert re.search(rf"(?m)^{variable}={re.escape(repository)}@sha256:REPLACE_[A-Z0-9_]+$", deploy_example)
assert "ff1588d49ac2" not in deploy_example and "9891b652cf8f" not in deploy_example
assert preflight.index("nutrition-image-admission validate") < preflight.index(
    "docker pull --platform linux/arm64"
)
assert preflight.index("docker pull --platform linux/arm64") < preflight.index(
    "nutrition-image-admission inspect"
)
assert preflight.index("nutrition-image-admission inspect") < preflight.index(
    "/usr/bin/docker compose"
)
assert "does not exactly match its reviewed repository" in image_admission
assert "does not resolve to its uniquely reviewed ARM64 child" in image_admission
assert '"org.opencontainers.image.revision": revision' in image_admission
assert '"org.opencontainers.image.source": "https://github.com/liangzixuan/cronometer-gold"' in image_admission
assert '"org.opencontainers.image.version": f"sha-{revision}"' in image_admission
assert '"io.cronometer.runtime.contract": "uid-gid-1000-net-bind-service"' in image_admission
assert '"io.cronometer.runtime.contract": "uid-gid-70-preowned-pgdata-and-tmpfs"' in image_admission

compression_fixture = {
    f"/etc/nutrition-tracker/fixture-{index}": {
        "content": "#!/bin/sh\n# transport comment\n\necho ready\n" if index == 0 else "fixture\n",
        "mode": "0750" if index == 0 else "0600",
    }
    for index in range(20)
}
compression = subprocess.run(
    [sys.executable, str(ROOT / "files/compress-bootstrap.py")],
    input=json.dumps({"payload": json.dumps(compression_fixture)}),
    text=True,
    capture_output=True,
    check=True,
)
compression_result = json.loads(compression.stdout)
compressed_payload = lzma.decompress(
    base64.b85decode(compression_result["bundle_base85"]),
    format=lzma.FORMAT_XZ,
)
assert hashlib.sha256(compressed_payload).hexdigest() == compression_result["payload_sha256"]
transport_fixture = json.loads(compressed_payload)
assert transport_fixture["/etc/nutrition-tracker/fixture-0"]["content"] == (
    "#!/bin/sh\necho ready\n"
)

# Execute the embedded admission parser against the compact host projection.
# Approved Meilisearch evidence must pass; a changed approval/scan must block
# before any image pull.
runtime_lock = {
    "schemaVersion": external_lock["schemaVersion"],
    "sourceLockSha256": hashlib.sha256(
        (ROOT / "external-images.lock.json").read_bytes()
    ).hexdigest(),
    "reviewedAt": external_lock["reviewedAt"],
    "policy": {
        key: external_lock["policy"][key]
        for key in (
            "platform",
            "scanner",
            "scannerVersion",
            "databaseUpdatedAt",
            "severities",
            "includeUnfixed",
            "ignorePolicy",
        )
    },
    "images": {
        variable: {
            key: image[key]
            for key in (
                "repository",
                "version",
                "platform",
                "digest",
                "arm64Digest",
                "ref",
                "approved",
                "scan",
            )
        }
        for variable, image in external_lock["images"].items()
    },
}
assert set(runtime_lock) == {
    "schemaVersion", "sourceLockSha256", "reviewedAt", "policy", "images",
}
deploy_fixture = deploy_example
for variable, repository in {
    "CADDY_IMAGE": "ghcr.io/liangzixuan/cronometer-gold-caddy",
    "POSTGRES_IMAGE": "ghcr.io/liangzixuan/cronometer-gold-postgres",
    "API_IMAGE": "ghcr.io/liangzixuan/cronometer-gold-api",
    "WEB_IMAGE": "ghcr.io/liangzixuan/cronometer-gold-web",
    "WORKER_IMAGE": "ghcr.io/liangzixuan/cronometer-gold-worker",
    "MIGRATOR_IMAGE": "ghcr.io/liangzixuan/cronometer-gold-migrator",
}.items():
    deploy_fixture = re.sub(
        rf"(?m)^{variable}=.*$", f"{variable}={repository}@sha256:{'a' * 64}", deploy_fixture
    )
image_admission_namespace = {"__name__": "image_admission_contract"}
exec(compile(image_admission, "image-admission-contract", "exec"), image_admission_namespace)
with tempfile.TemporaryDirectory() as temporary_directory:
    temporary = pathlib.Path(temporary_directory)
    deploy_path = temporary / "deploy.env"
    lock_path = temporary / "external-images.lock.json"
    deploy_path.write_text(deploy_fixture, encoding="utf-8")
    lock_path.write_text(json.dumps(runtime_lock), encoding="utf-8")
    image_admission_namespace["validate"](str(deploy_path), str(lock_path))

    blocked_lock = copy.deepcopy(runtime_lock)
    blocked_lock["images"]["MEILI_IMAGE"]["approved"] = False
    blocked_lock["images"]["MEILI_IMAGE"]["scan"] = {
        "critical": 0, "high": 1, "total": 1, "result": "blocked",
    }
    lock_path.write_text(json.dumps(blocked_lock), encoding="utf-8")
    try:
        image_admission_namespace["validate"](str(deploy_path), str(lock_path))
    except SystemExit as error:
        assert str(error).startswith("External dependency admission is blocked:")
    else:
        raise AssertionError("unapproved external dependency evidence must block deployment")

# Exercise the root-only atomic unpacker in a temporary allowlisted tree. The
# ownership syscalls are stubbed because this regression runs unprivileged; the
# production path still checks root ownership before parsing and chowns every
# staged file before replace.
unpacker_namespace = {"__name__": "bootstrap_unpacker_contract"}
exec(
    compile(
        (ROOT / "files/unpack-bootstrap.py").read_text(encoding="utf-8"),
        "bootstrap-unpacker-contract",
        "exec",
    ),
    unpacker_namespace,
)
with tempfile.TemporaryDirectory() as temporary_directory:
    temporary = pathlib.Path(temporary_directory)
    allowed_root = temporary / "allowed"
    bundle_path = temporary / "bundle.json.xz"
    digest_path = temporary / "bundle.sha256"
    payload = {
        str(allowed_root / f"file-{index}"): {
            "content": f"content-{index}\n",
            "mode": "0600" if index % 2 else "0644",
        }
        for index in range(20)
    }
    raw_payload = json.dumps(payload).encode("utf-8")
    bundle_path.write_text(
        base64.b85encode(
            lzma.compress(raw_payload, format=lzma.FORMAT_XZ, check=lzma.CHECK_SHA256, preset=9)
        ).decode("ascii"),
        encoding="ascii",
    )
    digest_path.write_text(hashlib.sha256(raw_payload).hexdigest() + "\n", encoding="ascii")
    bundle_path.chmod(0o600)
    digest_path.chmod(0o600)

    class RootOwnedFile:
        def __init__(self, path):
            self.path = path

        def stat(self):
            current = self.path.stat()
            return types.SimpleNamespace(st_uid=0, st_gid=0, st_mode=current.st_mode)

        def read_bytes(self):
            return self.path.read_bytes()

        def read_text(self, **arguments):
            return self.path.read_text(**arguments)

        def unlink(self):
            self.path.unlink()

    original_geteuid = unpacker_namespace["os"].geteuid
    original_chown = unpacker_namespace["os"].chown
    try:
        unpacker_namespace["BUNDLE"] = RootOwnedFile(bundle_path)
        unpacker_namespace["DIGEST"] = RootOwnedFile(digest_path)
        unpacker_namespace["ALLOWED_ROOTS"] = (allowed_root,)
        unpacker_namespace["os"].geteuid = lambda: 0
        unpacker_namespace["os"].chown = lambda *_arguments: None
        unpacker_namespace["main"]()
    finally:
        unpacker_namespace["os"].geteuid = original_geteuid
        unpacker_namespace["os"].chown = original_chown
    assert not bundle_path.exists()
    assert not digest_path.exists()
    for index in range(20):
        installed = allowed_root / f"file-{index}"
        assert installed.read_text(encoding="utf-8") == f"content-{index}\n"
        expected_mode = 0o600 if index % 2 else 0o644
        assert stat.S_IMODE(installed.stat().st_mode) == expected_mode

print("OCI static runtime contracts passed")
