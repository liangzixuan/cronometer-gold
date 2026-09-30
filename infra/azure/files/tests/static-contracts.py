#!/usr/bin/env python3
"""Static contracts for the review-only Azure host runtime."""

from __future__ import annotations

import contextlib
import copy
import json
import tempfile
import hashlib
import importlib.util
import pathlib
import re
import signal
import subprocess
import sys
import unittest
from unittest import mock


FILES_ROOT = pathlib.Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = FILES_ROOT.parents[2]
PREFLIGHT_PATH = FILES_ROOT / "deployment-preflight.py"

SPEC = importlib.util.spec_from_file_location("nutrition_azure_preflight", PREFLIGHT_PATH)
if SPEC is None or SPEC.loader is None:  # pragma: no cover - import machinery guard
    raise RuntimeError("Could not load Azure deployment preflight")
PREFLIGHT = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = PREFLIGHT
SPEC.loader.exec_module(PREFLIGHT)


def text(name: str) -> str:
    return (FILES_ROOT / name).read_text(encoding="utf-8")


def integer_constant(source: str, name: str) -> int:
    match = re.search(rf"\b{re.escape(name)}\s*=\s*([0-9][0-9_]*)\s*;", source)
    if match is None:
        raise AssertionError(f"missing exact integer constant: {name}")
    return int(match.group(1).replace("_", ""))


def stop_grace_period_ms(block: str) -> int:
    matches = re.findall(r"(?m)^    stop_grace_period: ([1-9][0-9]*)s$", block)
    if len(matches) != 1:
        raise AssertionError("service must have exactly one integer-second stop grace period")
    return int(matches[0]) * 1_000


def service_blocks(compose: str) -> dict[str, str]:
    services = compose.split("services:\n", 1)[1].split("\nnetworks:\n", 1)[0]
    matches = list(re.finditer(r"^  ([a-z][a-z0-9-]*):\n", services, re.MULTILINE))
    return {
        match.group(1): services[match.start() : matches[index + 1].start() if index + 1 < len(matches) else None]
        for index, match in enumerate(matches)
    }


def environment_keys(source: str) -> set[str]:
    keys: list[str] = []
    for line in source.splitlines():
        match = re.match(r"^([A-Z][A-Z0-9_]*)=", line)
        if match is None:
            continue
        key = match.group(1)
        if key in keys:
            raise AssertionError(f"duplicate environment key in example: {key}")
        keys.append(key)
    return set(keys)


def compose_environment(block: str) -> dict[str, str]:
    lines = block.splitlines()
    start = lines.index("    environment:") + 1
    result: dict[str, str] = {}
    for line in lines[start:]:
        if not line.startswith("      ") or line.startswith("        "):
            break
        key, separator, value = line.strip().partition(":")
        if not separator or not re.fullmatch(r"[A-Z][A-Z0-9_]*", key) or key in result:
            raise AssertionError(f"invalid Compose environment entry: {line}")
        result[key] = value.strip()
    return result


def canary_consumed_environment_keys() -> set[str]:
    source = (
        REPOSITORY_ROOT / "apps/worker/src/object-storage-credential-canary.ts"
    ).read_text(encoding="utf-8")
    return set(re.findall(r'["\']([A-Z][A-Z0-9_]+)["\']', source)) | set(
        re.findall(r"environment\.([A-Z][A-Z0-9_]*)", source)
    )


class AzureRuntimeStaticContracts(unittest.TestCase):
    def test_every_service_is_profiled_and_never_auto_restarts(self) -> None:
        compose = text("compose.yaml")
        blocks = service_blocks(compose)
        self.assertEqual(
            set(blocks),
            {
                "caddy", "edge-caddy", "postgres", "meilisearch", "api", "worker", "migrate",
                "object-storage-live-canary", "erasure-restore-attestation", "database-readiness",
            },
        )
        for name, block in blocks.items():
            self.assertIn("profiles:", block, name)
        self.assertNotIn("restart: unless-stopped", compose)
        self.assertIn('restart: "no"', compose)

    def test_api_and_worker_stop_deadlines_cover_every_source_allowed_grace(self) -> None:
        compose = text("compose.yaml")
        blocks = service_blocks(compose)
        api_config = (REPOSITORY_ROOT / "apps/api/src/config.ts").read_text(encoding="utf-8")
        worker_config = (REPOSITORY_ROOT / "apps/worker/src/config.ts").read_text(
            encoding="utf-8"
        )
        worker_entrypoint = (REPOSITORY_ROOT / "apps/worker/src/index.ts").read_text(
            encoding="utf-8"
        )
        local_shutdown_budget = (
            REPOSITORY_ROOT / "scripts/local-development-shutdown-budget.mjs"
        ).read_text(encoding="utf-8")
        self.assertIn("SHUTDOWN_GRACE_MS: z.coerce.number().int().min(100).max(300_000)", api_config)
        self.assertIn(
            "SHUTDOWN_GRACE_MS: z.coerce.number().int().min(100).max(300_000)",
            worker_config,
        )
        self.assertIn("workerShutdownWatchdogMarginMs = 2_500", worker_entrypoint)
        self.assertIn("workerShutdownWatchdogMaximumMs", worker_entrypoint)
        self.assertIn("serviceShutdownPhaseMaximum = 2", local_shutdown_budget)
        self.assertIn("supervisorTerminationMarginMs = 5_000", local_shutdown_budget)
        self.assertEqual(compose.count("stop_grace_period:"), 2)
        self.assertIn("    stop_grace_period: 305s", blocks["api"])
        self.assertIn("    stop_grace_period: 610s", blocks["worker"])
        source_grace_maximum_ms = integer_constant(
            worker_entrypoint, "workerShutdownGraceMaximumMs"
        )
        worker_phases = integer_constant(
            worker_entrypoint, "workerGracefulShutdownPhaseCount"
        )
        worker_watchdog_margin_ms = integer_constant(
            worker_entrypoint, "workerShutdownWatchdogMarginMs"
        )
        shared_phases = integer_constant(
            local_shutdown_budget, "serviceShutdownPhaseMaximum"
        )
        supervisor_margin_ms = integer_constant(
            local_shutdown_budget, "supervisorTerminationMarginMs"
        )
        worker_graceful_maximum_ms = source_grace_maximum_ms * worker_phases
        worker_watchdog_maximum_ms = (
            worker_graceful_maximum_ms + worker_watchdog_margin_ms
        )
        local_supervisor_maximum_ms = (
            source_grace_maximum_ms * shared_phases + supervisor_margin_ms
        )
        api_container_deadline_ms = stop_grace_period_ms(blocks["api"])
        worker_container_deadline_ms = stop_grace_period_ms(blocks["worker"])
        self.assertEqual(worker_phases, shared_phases)
        self.assertEqual(
            api_container_deadline_ms,
            source_grace_maximum_ms + supervisor_margin_ms,
        )
        self.assertEqual(
            worker_container_deadline_ms,
            local_supervisor_maximum_ms + supervisor_margin_ms,
        )
        self.assertLess(source_grace_maximum_ms, api_container_deadline_ms)
        self.assertLess(worker_graceful_maximum_ms, worker_watchdog_maximum_ms)
        self.assertLess(worker_watchdog_maximum_ms, local_supervisor_maximum_ms)
        self.assertLess(local_supervisor_maximum_ms, worker_container_deadline_ms)
        for name, block in blocks.items():
            if name not in {"api", "worker"}:
                self.assertNotIn("stop_grace_period:", block, name)

    def test_meilisearch_drops_all_linux_capabilities(self) -> None:
        block = service_blocks(text("compose.yaml"))["meilisearch"]
        self.assertIn('user: "1000:1000"', block)
        self.assertIn("read_only: true", block)
        self.assertIn("cap_drop: [ALL]", block)
        self.assertIn("no-new-privileges:true", block)

    def test_compute_only_object_storage_contract_is_explicit(self) -> None:
        compose = text("compose.yaml")
        canary = service_blocks(compose)["object-storage-live-canary"]
        runtime = text("runtime.env.example")
        api = text("api.env.example")
        worker = text("worker.env.example")
        restore = text("restore.env.example")
        combined = compose + runtime + restore
        self.assertNotIn("minio", combined.lower())
        self.assertIn("ERASURE_REPLAY_LEDGER_RESTORE_VERSION_LIST_PROVIDER=oci_native", restore)
        self.assertIn("/run/oci/restore-private-key.pem", compose)
        self.assertIn("object_egress:", compose)
        self.assertIn("172.31.255.0/28", compose)
        self.assertIn("EXPORT_ARTIFACT_REGION=us-ashburn-1", runtime)
        inherited = set().union(
            *(environment_keys(source) for source in (runtime, api, worker, restore))
        )
        expected_empty = inherited - canary_consumed_environment_keys()
        projected = compose_environment(canary)
        self.assertEqual(
            set(projected),
            expected_empty | {"NODE_EXTRA_CA_CERTS"},
        )
        self.assertEqual(
            {key for key, value in projected.items() if value == '""'},
            expected_empty,
        )
        self.assertEqual(projected["NODE_EXTRA_CA_CERTS"], "/run/internal-ca/ca.crt")

    def test_environment_role_schemas_match_examples_and_reject_contamination(self) -> None:
        examples = {
            name: environment_keys(text(f"{name}.env.example"))
            for name in PREFLIGHT.ENVIRONMENTS
        }
        self.assertEqual(PREFLIGHT.ENVIRONMENT_KEY_SCHEMAS, examples)

        environments = {
            name: {key: "synthetic-test-value" for key in keys}
            for name, keys in examples.items()
        }
        PREFLIGHT.assert_environment_schemas(environments)
        contaminations = (
            ("api", "MEILI_MASTER_KEY"),
            ("api", "EXPORT_ARTIFACT_WRITE_SECRET_ACCESS_KEY"),
            ("worker", "ERASURE_REPLAY_LEDGER_RESTORE_SECRET_ACCESS_KEY"),
            ("restore", "MEILI_ADMIN_KEY"),
        )
        for role, key in contaminations:
            with self.subTest(role=role, key=key):
                mutated = {name: values.copy() for name, values in environments.items()}
                mutated[role][key] = "synthetic-contamination"
                with self.assertRaisesRegex(SystemExit, rf"{role}\.env key schema differs"):
                    PREFLIGHT.assert_environment_schemas(mutated)

    def test_worker_meilisearch_roles_remain_distinct_and_fail_closed(self) -> None:
        worker = text("worker.env.example")
        preflight = text("deployment-preflight.py")
        self.assertEqual(
            worker.count("MEILI_ADMIN_KEY=REPLACE_SCOPED_MEILI_ADMIN_KEY"),
            1,
        )
        self.assertEqual(
            worker.count(
                "MEILI_TASK_OBSERVER_KEY=REPLACE_SCOPED_MEILI_TASK_OBSERVER_KEY"
            ),
            1,
        )
        self.assertIn(
            "Meilisearch master, search, mutation, and task-observer credentials must be distinct",
            preflight,
        )

    def test_public_surface_is_only_caddy_and_uses_explicit_application_routes(self) -> None:
        compose = text("compose.yaml")
        caddy = text("Caddyfile")
        internal_caddy = text("Caddyfile.internal")
        blocks = service_blocks(compose)
        self.assertEqual(compose.count('      - "80:80"'), 1)
        self.assertEqual(compose.count('      - "443:443"'), 1)
        self.assertNotIn("ports:", blocks["caddy"])
        self.assertIn("profiles: [edge]", blocks["edge-caddy"])
        self.assertIn('      - "80:80"', blocks["edge-caddy"])
        self.assertIn('      - "443:443"', blocks["edge-caddy"])
        self.assertNotIn("{$API_FQDN}", internal_caddy)
        self.assertNotIn("{$WEB_FQDN}", internal_caddy)
        self.assertIn("auto_https off", internal_caddy)
        self.assertIn("remote_ip {$BETA_ALLOWED_CIDRS}", caddy)
        self.assertNotIn("private_ranges", caddy)
        self.assertIn('header Authorization "Bearer {$DEPLOYMENT_READINESS_TOKEN}"', caddy)
        self.assertIn("header_up -Authorization", caddy)
        self.assertIn("path /ready", caddy)
        self.assertIn("max_size 1MB", caddy)
        self.assertNotIn("api:3000", caddy)
        self.assertNotIn("{$WEB_FQDN}", caddy)
        for header in ("Forwarded", "X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto", "X-Real-IP"):
            self.assertEqual(caddy.count(f"header_up -{header}\n"), 2)
        self.assertIn("auto_https disable_redirects", caddy)
        self.assertIn("http://{$API_FQDN}", caddy)
        self.assertEqual(caddy.count('respond "Not Found" 404'), 2)

    def test_preflight_has_deliberate_integration_stop(self) -> None:
        deploy = text("deploy.env.example")
        preflight = text("deployment-preflight.py")
        self.assertIn("AZURE_OCI_EGRESS_ADMISSION=BLOCKED_NOT_IMPLEMENTED", deploy)
        self.assertIn("AZURE_OCI_CREDENTIAL_INSTALL_ADMISSION=BLOCKED_NOT_IMPLEMENTED", deploy)
        self.assertIn("AZURE_OCI_USAGE_ADMISSION=BLOCKED_NOT_IMPLEMENTED", deploy)
        self.assertIn("AZURE_OFF_HOST_BACKUP_ADMISSION=BLOCKED_NOT_IMPLEMENTED", deploy)
        self.assertIn("reject_unimplemented_integrations", preflight)
        self.assertIn("no Compose service is admitted to start", preflight)
        self.assertNotIn("docker\", \"pull", preflight)
        self.assertRegex(
            preflight,
            r'"--profile",\s*"edge",\s*"config",\s*"--format",\s*"json"',
        )

    def test_synthetic_artifact_limits_reserve_oci_headroom(self) -> None:
        runtime = text("runtime.env.example")
        preflight = text("deployment-preflight.py")
        expected = {
            "EXPORT_ARTIFACT_READ_MAX_ARTIFACT_BYTES": "268435456",
            "EXPORT_ARTIFACT_READ_MAX_CONCURRENCY": "1",
            "EXPORT_ARTIFACT_READ_MAX_RESERVED_BYTES": "268435456",
            "EXPORT_ARTIFACT_READ_MAX_BYTES_PER_WINDOW": "536870912",
            "RETENTION_EXPORT_SPOOL_MAX_BYTES": "268435456",
            "SEARCH_REBUILD_SPOOL_MAX_BYTES": "536870912",
        }
        for name, value in expected.items():
            self.assertIn(f"{name}={value}", runtime)
            self.assertIn(f'"{name}": "{value}"', preflight)

    def test_preflight_reuses_strict_image_admission(self) -> None:
        preflight = text("deployment-preflight.py")
        self.assertIn("IMAGE_ADMISSION_SHA256", preflight)
        self.assertNotIn("IMAGE_LOCK_SHA256", preflight)
        self.assertIn('"validate"', preflight)
        self.assertIn('"inspect"', preflight)
        admission = (REPOSITORY_ROOT / "infra/oci/files/image-admission.py").read_text(encoding="utf-8")
        self.assertIn('"linux", "arm64",', admission)
        self.assertIn("require_repository_runtime_contract", admission)
        admission_digest = hashlib.sha256(
            (REPOSITORY_ROOT / "infra/oci/files/image-admission.py").read_bytes()
        ).hexdigest()
        self.assertIn(admission_digest, preflight)
        self.assertIn(
            '"MEILI_IMAGE": "ghcr.io/liangzixuan/cronometer-gold-meilisearch"',
            preflight,
        )

    def test_preflight_validates_both_caddy_configs_without_network(self) -> None:
        preflight = text("deployment-preflight.py")
        self.assertIn("assert_caddy_configs", preflight)
        self.assertIn('PUBLIC_CADDYFILE = pathlib.Path("/opt/nutrition-tracker/Caddyfile")', preflight)
        self.assertIn(
            'INTERNAL_CADDYFILE = pathlib.Path("/opt/nutrition-tracker/Caddyfile.internal")',
            preflight,
        )
        self.assertEqual(preflight.count('"--network=none"'), 1)
        self.assertGreaterEqual(preflight.count('"validate"'), 3)
        self.assertIn("public Caddy configuration without network access", preflight)
        self.assertIn("internal Caddy configuration without network access", preflight)
        self.assertIn('"--pull=never"', preflight)
        self.assertIn('VALIDATOR_LABEL_KEY = "com.nutrition-tracker.azure-preflight-validator"', preflight)
        self.assertIn('VALIDATOR_NAME_PREFIX = "nutrition-azure-caddy-validator"', preflight)
        self.assertIn("VALIDATOR_RECONCILIATION_SECONDS = 20", preflight)
        self.assertIn('["docker", "rm", "--force", reference]', preflight)

    def test_storage_is_bound_to_reviewed_lun0_uuid_and_serial(self) -> None:
        preflight = text("deployment-preflight.py")
        storage = text("prepare-storage.sh")
        identity = text("data-disk-identity.env.example")
        for source in (preflight, storage):
            self.assertIn("/dev/disk/azure/data/by-lun/0", source)
            self.assertIn("/dev/disk/azure/scsi1/lun0", source)
            self.assertIn("AZURE_DATA_DISK_FILESYSTEM_UUID", source)
            self.assertIn("AZURE_DATA_DISK_SERIAL", source)
            self.assertIn("LUN-0", source)
        self.assertEqual(
            set(identity.splitlines()),
            {
                "AZURE_DATA_DISK_LUN=0",
                "AZURE_DATA_DISK_FILESYSTEM_UUID=REPLACE_REVIEWED_FILESYSTEM_UUID",
                "AZURE_DATA_DISK_SERIAL=REPLACE_REVIEWED_AZURE_DISK_SERIAL",
            },
        )

    def test_preflight_children_are_bounded_process_groups(self) -> None:
        preflight = text("deployment-preflight.py")
        self.assertNotIn("subprocess.check_output", preflight)
        self.assertIn("start_new_session=True", preflight)
        self.assertIn("process.communicate(timeout=timeout_seconds)", preflight)
        self.assertIn("os.killpg(process_group_id, signal.SIGTERM)", preflight)
        self.assertIn("os.killpg(process_group_id, signal.SIGKILL)", preflight)
        self.assertIn("termination_signals_masked", preflight)

    def test_preflight_pins_the_current_public_range_review(self) -> None:
        preflight = text("deployment-preflight.py")
        source = REPOSITORY_ROOT / "infra/oci/object-storage-public-ranges.lock.json"
        self.assertIn(hashlib.sha256(source.read_bytes()).hexdigest(), preflight)
        self.assertIn("datetime.timedelta(hours=168)", preflight)

    def test_reviewer_and_synthetic_guards_are_exact(self) -> None:
        deploy = text("deploy.env.example")
        preflight = text("deployment-preflight.py")
        self.assertIn("API_FQDN=staging-api.nourishing.app", deploy)
        self.assertNotIn("WEB_FQDN=", deploy)
        self.assertNotIn("WEB_IMAGE=", deploy)
        self.assertIn("DEPLOYMENT_READINESS_TOKEN=REPLACE_INDEPENDENT_64_LOWERCASE_HEX_TOKEN", deploy)
        self.assertIn("I_ACCEPT_SYNTHETIC_ONLY_SINGLE_SERVER_NON_HA_BETA", preflight)
        self.assertIn("network.prefixlen != 32", preflight)
        self.assertIn("network.is_global", preflight)
        self.assertIn("expected-reviewer-cidr", preflight)
        self.assertIn('api_fqdn != targets[target]', preflight)
        self.assertIn('"aarch64"', preflight)
        self.assertIn("14 * 1024 * 1024", preflight)

    def test_internal_pki_and_storage_exclude_object_store(self) -> None:
        pki = text("prepare-internal-pki.sh")
        storage = text("prepare-storage.sh")
        self.assertIn("meili.internal", pki)
        self.assertIn("postgres postgres", pki)
        self.assertNotIn("minio", (pki + storage).lower())
        self.assertIn('mountpoint -q "$data_root"', storage)
        self.assertIn('"$data_source" != "$root_source"', storage)

    def test_existing_application_resource_caps_are_preserved(self) -> None:
        source = (REPOSITORY_ROOT / "infra/oci/files/compose.yaml").read_text(encoding="utf-8")
        target = text("compose.yaml")
        for service in ("caddy", "postgres", "meilisearch", "api", "worker"):
            source_block = service_blocks(source)[service]
            target_block = service_blocks(target)[service]
            for key in ("cpus", "mem_limit"):
                expected = re.search(rf"^    {key}: (.+)$", source_block, re.MULTILINE)
                actual = re.search(rf"^    {key}: (.+)$", target_block, re.MULTILINE)
                self.assertIsNotNone(expected, f"{service} {key} source")
                self.assertIsNotNone(actual, f"{service} {key} target")
                self.assertEqual(actual.group(1), expected.group(1), f"{service} {key}")

    def test_rendered_api_requires_single_instance_and_preserved_limits(self) -> None:
        valid = {"services": {"api": {
            "container_name": "nutrition-ledger-azure-beta-api",
            "deploy": {"replicas": 1}, "cpus": 0.5,
            "mem_limit": "805306368", "pids_limit": 256,
        }, "edge-caddy": {"ports": [{"target": 443}]}}}
        PREFLIGHT.assert_compose_api_singleton(json.dumps(valid))
        mutations = (
            lambda s: s["api"]["deploy"].update(replicas=2),
            lambda s: s["api"]["deploy"].update(replicas=True),
            lambda s: s["api"].update(deploy=[]),
            lambda s: s.update(api=[]),
            lambda s: s["api"].update(scale=2),
            lambda s: s["api"].update(container_name="other-api"),
            lambda s: s["api"].update(cpus=2),
            lambda s: s["api"].update(mem_limit=1024 * 1024 * 1024),
            lambda s: s["api"].update(pids_limit=512),
            lambda s: s["api"].update(ports=[{"target": 4000}]),
            lambda s: s.update(web={}),
            lambda s: s.update(postgres={"ports": [{"target": 5432}]}),
        )
        for mutate in mutations:
            changed = copy.deepcopy(valid)
            mutate(changed["services"])
            with self.assertRaises(SystemExit):
                PREFLIGHT.assert_compose_api_singleton(json.dumps(changed))
        for invalid in ("not-json", "null", "{}"):
            with self.assertRaises(SystemExit):
                PREFLIGHT.assert_compose_api_singleton(invalid)

    def test_live_storage_verifier_is_source_pinned_read_only_and_failure_propagates(self) -> None:
        actual = FILES_ROOT / "object-egress.py"
        self.assertEqual(hashlib.sha256(actual.read_bytes()).hexdigest(), PREFLIGHT.OBJECT_EGRESS_SHA256)
        with mock.patch.object(PREFLIGHT, "OBJECT_EGRESS", actual), mock.patch.object(PREFLIGHT, "require_regular_file") as mode, mock.patch.object(PREFLIGHT, "command") as command:
            PREFLIGHT.assert_live_object_egress()
            mode.assert_called_once_with(actual, 0o750)
            self.assertEqual(command.call_args.args[0], ["python3", "-B", str(actual), "verify"])
            self.assertEqual(command.call_args.kwargs, {"timeout_seconds": 60, "redact_output": True})
            command.reset_mock()
            with mock.patch.object(PREFLIGHT, "OBJECT_EGRESS_SHA256", "0" * 64), self.assertRaises(SystemExit):
                PREFLIGHT.assert_live_object_egress()
            command.assert_not_called()
            command.side_effect = SystemExit("live firewall drift")
            with self.assertRaisesRegex(SystemExit, "live firewall drift"):
                PREFLIGHT.assert_live_object_egress()

    def test_rendered_storage_network_rejects_escape_paths(self) -> None:
        valid = {"networks": {
            "backend": {"internal": True, "enable_ipv6": False}, "edge": {},
            "object_egress": {
                "name": "nutrition-ledger-azure-beta-object-egress", "driver": "bridge",
                "enable_ipv6": False,
                "driver_opts": {"com.docker.network.bridge.name": "nourishing-obj",
                                "com.docker.network.bridge.enable_icc": "false"},
                "ipam": {"config": [{"subnet": "172.31.255.0/28", "gateway": "172.31.255.1"}]},
            },
        }, "services": {
            name: {"networks": {network: {} for network in networks}, "cap_drop": ["ALL"]}
            for name, networks in (
                ("api", ("backend", "object_egress")),
                ("worker", ("backend", "object_egress")),
                ("erasure-restore-attestation", ("backend", "object_egress")),
                ("object-storage-live-canary", ("object_egress",)),
                ("edge-caddy", ("backend", "edge")),
                *((name, ("backend",)) for name in ("caddy", "postgres", "meilisearch", "migrate", "database-readiness")),
            )
        }}
        for name, suffix in (("api", "api"), ("worker", "worker-1"), ("object-storage-live-canary", "object-storage-live-canary"), ("erasure-restore-attestation", "erasure-restore-attestation")):
            valid["services"][name]["container_name"] = "nutrition-ledger-azure-beta-" + suffix
        PREFLIGHT.assert_compose_object_egress(json.dumps(valid))
        mutations = (
            lambda c: c["networks"].update(unreviewed={}),
            lambda c: c["networks"]["backend"].update(internal=False),
            lambda c: c["networks"]["backend"].update(enable_ipv6=True),
            lambda c: c["services"]["worker"].update(container_name="unreviewed-client"),
            lambda c: c["networks"]["object_egress"].update(name="different"),
            lambda c: c["networks"]["object_egress"].update(driver="macvlan"),
            lambda c: c["networks"]["object_egress"].update(enable_ipv6=True),
            lambda c: c["networks"]["object_egress"].pop("enable_ipv6"),
            lambda c: c["networks"]["object_egress"].update(enable_ipv4=False),
            lambda c: c["networks"]["object_egress"].update(external=True),
            lambda c: c["networks"]["object_egress"].update(attachable=True),
            lambda c: c["networks"]["object_egress"]["driver_opts"].update({"com.docker.network.bridge.name": "other-bridge"}),
            lambda c: c["networks"]["object_egress"]["driver_opts"].update({"com.docker.network.bridge.enable_icc": "true"}),
            lambda c: c["networks"]["object_egress"]["driver_opts"].update({"com.docker.network.bridge.gateway_mode_ipv4": "routed"}),
            lambda c: c["networks"]["object_egress"]["ipam"].update(config=[{"subnet": "172.31.0.0/16"}]),
            lambda c: c["networks"]["object_egress"]["ipam"].update(options={"unreviewed": "true"}),
            lambda c: c["services"]["worker"]["networks"].update(edge={}),
            lambda c: c["services"]["worker"].update(network_mode="host"),
            lambda c: c["services"]["worker"].update(privileged=True),
            lambda c: c["services"]["worker"].update(cap_drop=[]),
            lambda c: c["services"]["worker"].update(cap_add=["NET_ADMIN"]),
            lambda c: c["services"]["worker"].update(devices=["/dev/net/tun"]),
            lambda c: c["services"]["worker"].update(ports=[{"target": 443}]),
            lambda c: c["services"]["edge-caddy"]["networks"].update(object_egress={}),
            lambda c: c["services"].pop("object-storage-live-canary"),
            lambda c: c["services"].update(unreviewed={"networks": {"backend": {}, "edge": {}}}),
            lambda c: c["services"]["migrate"]["networks"].update(edge={}),
            lambda c: c["services"]["migrate"].update(network_mode="service:edge-caddy"),
        )
        for mutate in mutations:
            changed = copy.deepcopy(valid)
            mutate(changed)
            with self.assertRaises(SystemExit):
                PREFLIGHT.assert_compose_object_egress(json.dumps(changed))
        for invalid in ("null", "{}", "invalid", json.dumps({"networks": [], "services": []})):
            with self.assertRaises(SystemExit):
                PREFLIGHT.assert_compose_object_egress(invalid)

    def test_readiness_credential_is_required_and_errors_never_echo_it(self) -> None:
        values = {
            "SYNTHETIC_ONLY_ACKNOWLEDGEMENT": PREFLIGHT.ACKNOWLEDGEMENT,
            "BETA_ALLOWED_CIDRS": "8.8.8.8/32", "API_FQDN": "staging-api.nourishing.app",
            "DEPLOYMENT_TARGET": "staging",
            "ACME_EMAIL": "synthetic@example.invalid",
            "DEPLOYMENT_READINESS_TOKEN": "0123456789abcdef" * 4,
            **{key: repository + "@sha256:" + "a" * 64 for key, repository in PREFLIGHT.IMAGE_REPOSITORIES.items()},
        }
        with tempfile.TemporaryDirectory() as directory:
            reviewer = pathlib.Path(directory) / "reviewer"
            reviewer.write_text(values["BETA_ALLOWED_CIDRS"])
            with mock.patch.object(PREFLIGHT, "REVIEWER_CIDR_FILE", reviewer), mock.patch.object(PREFLIGHT, "require_regular_file"):
                PREFLIGHT.assert_deployment(values)
                PREFLIGHT.assert_deployment({**values, "DEPLOYMENT_TARGET": "production", "API_FQDN": "api.nourishing.app"})
                for target, host in (("staging", "api.nourishing.app"), ("production", "staging-api.nourishing.app"), ("unknown", "api.nourishing.app"), ("staging", "other.example.invalid")):
                    with self.assertRaises(SystemExit):
                        PREFLIGHT.assert_deployment({**values, "DEPLOYMENT_TARGET": target, "API_FQDN": host})
                with self.assertRaises(SystemExit):
                    PREFLIGHT.assert_deployment({**values, "SYNTHETIC_ONLY_ACKNOWLEDGEMENT": "personal"})
                for token in ("", "a" * 64, "ABCDEF0123456789" * 4, "private-invalid-token", "0123456789abcdef" * 3):
                    with self.assertRaises(SystemExit) as caught:
                        PREFLIGHT.assert_deployment({**values, "DEPLOYMENT_READINESS_TOKEN": token})
                    if token:
                        self.assertNotIn(token, str(caught.exception))

    def test_edge_token_match_requires_configured_full_length_secret(self) -> None:
        caddy = text("Caddyfile")
        guard = re.search(r"vars_regexp readinessToken \{env.DEPLOYMENT_READINESS_TOKEN\} (.+)", caddy)
        self.assertIsNotNone(guard)
        pattern = re.compile(guard.group(1))
        self.assertIsNotNone(pattern.fullmatch("0123456789abcdef" * 4))
        for value in ("", "a", "unset", "0123456789abcdef" * 3, "ABCDEF0123456789" * 4):
            self.assertIsNone(pattern.fullmatch(value))
        self.assertIn('header Authorization "Bearer {$DEPLOYMENT_READINESS_TOKEN}"', caddy)

    def test_caddy_path_patterns_do_not_admit_unlisted_admin_or_dependency_routes(self) -> None:
        caddy = text("Caddyfile")
        patterns = {
            method.upper(): re.compile(pattern)
            for method, pattern in re.findall(r"path_regexp application(Get|Post|Put|Patch|Delete) (.+)", caddy)
        }
        self.assertEqual(set(patterns), {"GET", "POST", "PUT", "PATCH", "DELETE"})
        allowed = (
            ("POST", "/v1/auth/login"), ("POST", "/v1/auth/register"),
            ("GET", "/v1/foods/search"), ("GET", "/v1/foods/barcodes/0123456789012"),
            ("GET", "/v1/diary"), ("GET", "/v1/reports/nutrition"),
            ("GET", "/v1/exports/11111111-1111-4111-8111-111111111111/artifacts/csv"),
            ("POST", "/v1/account/erasure"), ("GET", "/v1/account/erasure/11111111-1111-4111-8111-111111111111"),
            ("PUT", "/v1/diary/days/2026-09-29/order"),
            ("PATCH", "/v1/diary/entries/11111111-1111-4111-8111-111111111111"), ("DELETE", "/v1/reminders/11111111-1111-4111-8111-111111111111"),
        )
        for method, path in allowed:
            self.assertIsNotNone(patterns[method].fullmatch(path), (method, path))
        denied = (
            "/ready", "/health", "/metrics", "/v1", "/v1/admin", "/v1/admin/users",
            "/indexes", "/keys", "/tasks", "/debug/pprof", "/v1/worker/run",
            "/v1/foods/search/admin", "/v1/recipes/one/admin", "/v1/exports/a/artifacts/xml",
            "/v1/recipes/admin", "/v1/custom-foods/admin", "/v1/exports/admin",
            "/v1/integrations/health/admin/disconnect", "/v1/foods/barcodes/123", "/v1/diary/entries/a/b", "/v1/auth/login/../admin",
        )
        for path in denied:
            self.assertTrue(all(pattern.fullmatch(path) is None for pattern in patterns.values()), path)
        for method, path in (("GET", "/v1/auth/login"), ("POST", "/v1/foods/search"),
                             ("DELETE", "/v1/exports/a"), ("PUT", "/v1/profile")):
            self.assertIsNone(patterns[method].fullmatch(path), (method, path))

    def test_managed_backend_image_profile_preserves_all_six_contracts(self) -> None:
        path = REPOSITORY_ROOT / "infra/oci/files/image-admission.py"
        spec = importlib.util.spec_from_file_location("managed_image_admission", path)
        assert spec is not None and spec.loader is not None
        admission = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(admission)
        profile = "appwrite-cloud-azure-v1"
        six = admission.profile_images(profile)
        self.assertEqual(set(six), set(PREFLIGHT.IMAGE_REPOSITORIES))
        self.assertEqual(set(admission.profile_images(None)), set(six) | {"WEB_IMAGE"})
        with self.assertRaisesRegex(SystemExit, "Unknown"):
            admission.profile_images("other")
        with tempfile.TemporaryDirectory() as directory:
            deploy = pathlib.Path(directory) / "deploy.env"
            runtime = pathlib.Path(directory) / "runtime.env"
            runtime.write_text("SERVICE_VERSION=" + "a" * 40 + "\n")
            values = {key: repository + "@sha256:" + "a" * 64 for key, (repository, _) in six.items()}
            def write(entries):
                deploy.write_text("".join(f"{key}={value}\n" for key, value in entries.items()))
            write(values)
            admission.validate(deploy, profile)
            with self.assertRaisesRegex(SystemExit, "WEB_IMAGE"):
                admission.validate(deploy)
            for key in six:
                for value in (None, "ghcr.io/other/image@sha256:" + "a" * 64,
                              six[key][0] + ":latest"):
                    changed = dict(values)
                    if value is None:
                        del changed[key]
                    else:
                        changed[key] = value
                    write(changed)
                    with self.assertRaises(SystemExit):
                        admission.validate(deploy, profile)
            write({**values, "WEB_IMAGE": admission.REPOSITORY_IMAGES["WEB_IMAGE"][0] + "@sha256:" + "a" * 64})
            admission.validate(deploy)
            with self.assertRaisesRegex(SystemExit, "exactly its six"):
                admission.validate(deploy, profile)
            write({**values, "FOO_IMAGE": values["API_IMAGE"]})
            with self.assertRaisesRegex(SystemExit, "exactly its six"):
                admission.validate(deploy, profile)
            write(values)
            for rejected in six:
                actual_contract = admission.require_repository_runtime_contract
                def verify(variable, config):
                    if variable == rejected:
                        actual_contract(variable, config)
                with (
                    mock.patch.object(admission, "command_json", return_value=[{"Os": "linux", "Architecture": "arm64", "Config": {}}]),
                    mock.patch.object(admission, "require_repository_source_contract") as source,
                    mock.patch.object(admission, "require_repository_runtime_contract", side_effect=verify) as contract,
                    self.assertRaises(SystemExit),
                ):
                    admission.inspect_images(deploy, runtime, profile)
                self.assertEqual(contract.call_args_list[-1].args[0], rejected)
                self.assertEqual(source.call_args_list[-1].args[0], rejected)
            with (
                mock.patch.object(admission, "command_json", return_value=[{"Os": "linux", "Architecture": "amd64", "Config": {}}]),
                self.assertRaisesRegex(SystemExit, "linux/arm64"),
            ):
                admission.inspect_images(deploy, runtime, profile)

    def test_no_cloud_lifecycle_or_automatic_start_logic(self) -> None:
        runtime_code = "\n".join(
            text(name)
            for name in (
                "compose.yaml", "deployment-preflight.py", "prepare-internal-pki.sh", "prepare-storage.sh"
            )
        ).lower()
        for forbidden in ("169.254.169.254", "terraform", "cloud-init", "systemctl enable", "docker pull"):
            self.assertNotIn(forbidden, runtime_code)

    def test_command_timeout_reconciles_the_process_group(self) -> None:
        process = mock.Mock()
        process.pid = 4242
        process.communicate.side_effect = subprocess.TimeoutExpired(["probe"], 1)
        with (
            mock.patch.object(PREFLIGHT.subprocess, "Popen", return_value=process),
            mock.patch.object(PREFLIGHT, "stop_process_group") as stop,
            self.assertRaisesRegex(SystemExit, "timed out"),
        ):
            PREFLIGHT.command(["probe"], "bounded probe", timeout_seconds=1)
        stop.assert_called_once_with(process, "bounded probe")

    def test_compose_failure_cannot_echo_rendered_secret_values(self) -> None:
        process = mock.Mock()
        process.returncode = 1
        process.communicate.return_value = ("synthetic-secret-must-not-appear", None)
        with mock.patch.object(PREFLIGHT.subprocess, "Popen", return_value=process):
            with self.assertRaises(SystemExit) as caught:
                PREFLIGHT.command(["docker", "compose", "config"], "rendered Compose contract", redact_output=True)
        self.assertEqual(str(caught.exception), "Could not inspect rendered Compose contract")

    def test_validator_inventory_keeps_exact_id_output_for_owned_cleanup(self) -> None:
        identifier = "a" * 64
        name = "nutrition-azure-caddy-validator-public-42"
        with mock.patch.object(PREFLIGHT, "command", return_value=identifier + "\n") as command:
            self.assertEqual(PREFLIGHT.validator_container_ids(name), (identifier,))
        arguments = command.call_args.args[0]
        self.assertEqual(arguments[:6], ["docker", "container", "ls", "--all", "--quiet", "--no-trunc"])
        self.assertIn("name=^/" + name + "$", arguments)
        self.assertNotIn("--format", arguments)

    def test_validator_cancellation_always_reconciles_exact_name(self) -> None:
        scope = mock.Mock()
        scope.cleanup_masked.side_effect = lambda: contextlib.nullcontext()
        with (
            mock.patch.object(PREFLIGHT, "reconcile_validator_absence") as reconcile,
            mock.patch.object(
                PREFLIGHT,
                "command",
                side_effect=PREFLIGHT.PreflightCancellation(signal.SIGTERM),
            ),
            self.assertRaises(PREFLIGHT.PreflightCancellation),
        ):
            PREFLIGHT.run_caddy_validator(
                ["docker", "run"],
                name="nutrition-azure-caddy-validator-public-42",
                label_value="public",
                description="public validator",
                cancellation_scope=scope,
            )
        self.assertEqual(
            reconcile.call_args_list,
            [
                mock.call(
                    "nutrition-azure-caddy-validator-public-42",
                    "public",
                    ambiguous_launch=False,
                ),
                mock.call(
                    "nutrition-azure-caddy-validator-public-42",
                    "public",
                    ambiguous_launch=True,
                ),
            ],
        )


if __name__ == "__main__":
    unittest.main()
