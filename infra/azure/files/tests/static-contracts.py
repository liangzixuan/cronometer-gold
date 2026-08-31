#!/usr/bin/env python3
"""Static contracts for the review-only Azure host runtime."""

from __future__ import annotations

import contextlib
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
                "caddy", "edge-caddy", "postgres", "meilisearch", "api", "web", "worker", "migrate",
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

    def test_public_surface_is_only_caddy_and_remains_allowlisted(self) -> None:
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
        self.assertIn("@betaAllowed remote_ip {$BETA_ALLOWED_CIDRS}", caddy)
        self.assertIn("auto_https disable_redirects", caddy)
        self.assertIn("http://{$API_FQDN}", caddy)
        self.assertIn("http://{$WEB_FQDN}", caddy)
        self.assertGreaterEqual(caddy.count('respond "Not Found" 404'), 4)

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
            r'"--profile",\s*"edge",\s*"config",\s*"--quiet"',
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
        self.assertIn("API_FQDN=api.nourishing.app", deploy)
        self.assertIn("WEB_FQDN=app.nourishing.app", deploy)
        self.assertIn("I_ACCEPT_SYNTHETIC_ONLY_SINGLE_SERVER_NON_HA_BETA", preflight)
        self.assertIn("network.prefixlen != 32", preflight)
        self.assertIn("network.is_global", preflight)
        self.assertIn("expected-reviewer-cidr", preflight)
        self.assertIn('("api.nourishing.app", "app.nourishing.app")', preflight)
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
        for service in ("caddy", "postgres", "meilisearch", "api", "web", "worker"):
            source_block = service_blocks(source)[service]
            target_block = service_blocks(target)[service]
            for key in ("cpus", "mem_limit"):
                expected = re.search(rf"^    {key}: (.+)$", source_block, re.MULTILINE)
                actual = re.search(rf"^    {key}: (.+)$", target_block, re.MULTILINE)
                self.assertIsNotNone(expected, f"{service} {key} source")
                self.assertIsNotNone(actual, f"{service} {key} target")
                self.assertEqual(actual.group(1), expected.group(1), f"{service} {key}")

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
