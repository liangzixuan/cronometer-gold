from __future__ import annotations

import importlib.util
import json
import py_compile
import re
import signal
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[3]
RUNNER = ROOT / "infra" / "localstack" / "run-tests.py"
README = ROOT / "infra" / "localstack" / "README.md"
LIFECYCLE = ROOT / "infra" / "localstack" / "export-lifecycle.json"

SPEC = importlib.util.spec_from_file_location("nutrition_localstack_fixture", RUNNER)
if SPEC is None or SPEC.loader is None:  # pragma: no cover - import machinery guard
    raise RuntimeError("Could not load the LocalStack fixture")
FIXTURE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = FIXTURE
SPEC.loader.exec_module(FIXTURE)


class LocalStackFixtureContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.runner = RUNNER.read_text(encoding="utf-8")
        cls.readme = README.read_text(encoding="utf-8")

    def test_image_is_an_exact_multi_architecture_digest(self) -> None:
        self.assertIn("localstack/localstack:2026.7.5@", self.runner)
        self.assertIn(
            "sha256:0d74e1d2d7ce13a3cb25fc64cf15eb225f1c95c762e56e057bc6a9ed0ed29306",
            self.runner,
        )
        self.assertNotRegex(self.runner, r"localstack/localstack:(latest|stable|dev)(?:\W|$)")

    def test_runtime_is_loopback_only_ephemeral_and_socketless(self) -> None:
        self.assertIn('f"127.0.0.1:{port}:4566"', self.runner)
        self.assertIn('"PERSISTENCE=0"', self.runner)
        self.assertNotIn("0.0.0.0", self.runner)
        self.assertNotIn("/var/run/docker.sock", self.runner)
        self.assertNotIn("--privileged", self.runner)
        self.assertNotIn("--network=host", self.runner)
        self.assertNotIn("--volume", self.runner)

    def test_only_s3_iam_and_sts_are_started_with_hard_enforcement(self) -> None:
        self.assertIn('"SERVICES=s3,iam,sts"', self.runner)
        self.assertIn('"ENFORCE_IAM=1"', self.runner)
        self.assertIn('"IAM_SOFT_MODE=0"', self.runner)
        self.assertIn('"PARITY_AWS_ACCESS_KEY_ID=0"', self.runner)
        self.assertIn('"S3_SKIP_SIGNATURE_VALIDATION=1"', self.runner)

    def test_token_and_generated_credentials_are_not_persisted(self) -> None:
        self.assertIn('os.environ.get("LOCALSTACK_AUTH_TOKEN", "")', self.runner)
        self.assertIn('TemporaryDirectory(prefix="nutrition-localstack-docker-")', self.runner)
        self.assertIn("config_file.chmod(0o600)", self.runner)
        self.assertIn("docker_config.chmod(0o700)", self.runner)
        self.assertNotRegex(
            self.runner,
            re.compile(r"LOCALSTACK_AUTH_TOKEN\s*=\s*['\"][A-Za-z0-9_-]{16,}['\"]"),
        )
        self.assertNotIn("shell=True", self.runner)

    def test_ambient_cloud_credentials_are_blocked_for_every_child(self) -> None:
        self.assertIn("child_base_environment = sanitized_environment(inherited_environment)", self.runner)
        self.assertIn(
            "docker_endpoint = local_docker_endpoint(docker, child_base_environment)",
            self.runner,
        )
        self.assertIn('"AWS_SHARED_CREDENTIALS_FILE": str(empty_aws_credentials)', self.runner)
        self.assertIn('"AWS_CONFIG_FILE": str(empty_aws_config)', self.runner)
        self.assertIn('"AWS_EC2_METADATA_DISABLED": "true"', self.runner)

    def test_runner_has_no_real_aws_or_other_cloud_endpoint(self) -> None:
        self.assertNotIn("amazonaws.com", self.runner)
        self.assertNotIn("oraclecloud.com", self.runner)
        self.assertNotIn("azure.com", self.runner)
        self.assertIn('endpoint = f"http://127.0.0.1:{port}"', self.runner)
        self.assertIn('not key.startswith("AWS_")', self.runner)
        self.assertIn('not key.startswith("LOCALSTACK_")', self.runner)

    def test_cleanup_is_scoped_to_the_labeled_container(self) -> None:
        self.assertIn("CONTAINER_LABEL_KEY", self.runner)
        self.assertIn("CONTAINER_LABEL_VALUE", self.runner)
        self.assertIn('[*docker_prefix, "rm", "--force", reference]', self.runner)
        self.assertNotIn("docker system prune", self.runner)
        self.assertNotIn("--volumes", self.runner)
        self.assertNotIn("image rm", self.runner)
        self.assertIn("if fixture_succeeded:", self.runner)
        self.assertIn("cleanup could not prove container absence", self.runner)

    def test_every_external_process_has_a_bound(self) -> None:
        self.assertIn("timeout_seconds=600", self.runner)
        self.assertIn("timeout_seconds=180", self.runner)
        self.assertIn("timeout=30", self.runner)
        self.assertIn("timeout=20", self.runner)
        self.assertIn("timeout=10", self.runner)

    def test_test_timeout_stops_the_complete_process_group(self) -> None:
        self.assertIn("start_new_session=True", self.runner)
        self.assertIn("os.killpg(process_group_id, signal.SIGTERM)", self.runner)
        self.assertIn("os.killpg(process_group_id, signal.SIGKILL)", self.runner)
        self.assertIn("stop_process_group(process, description)", self.runner)

    def test_term_after_create_masks_signals_and_removes_exact_fixture(self) -> None:
        reference = "c" * 64
        completed = lambda **values: mock.Mock(
            returncode=values.get("returncode", 0),
            stdout=values.get("stdout", ""),
            stderr=values.get("stderr", ""),
        )
        subprocess_results = (
            completed(),
            completed(),
            completed(stdout=f"{reference}\n"),
            completed(stdout=f"{FIXTURE.CONTAINER_LABEL_VALUE}\n"),
            completed(stdout=f"{reference}\n"),
            completed(returncode=1, stderr="No such object"),
        )
        cancellation_scope = mock.Mock()
        with (
            mock.patch.object(FIXTURE, "validate_token", return_value="developer-token"),
            mock.patch.object(FIXTURE, "gateway_port", return_value=4566),
            mock.patch.object(FIXTURE, "require_free_loopback_port"),
            mock.patch.object(
                FIXTURE.shutil,
                "which",
                side_effect=lambda executable: f"/usr/bin/{executable}",
            ),
            mock.patch.object(
                FIXTURE, "local_docker_endpoint", return_value="unix:///tmp/docker.sock"
            ),
            mock.patch.object(
                FIXTURE,
                "wait_for_health",
                side_effect=FIXTURE.LocalStackCancellation(signal.SIGTERM),
            ),
            mock.patch.object(
                FIXTURE.subprocess, "run", side_effect=subprocess_results
            ) as run,
            self.assertRaises(FIXTURE.LocalStackCancellation),
        ):
            FIXTURE.run_fixture(cancellation_scope)
        cancellation_scope.mask_cleanup.assert_called_once_with()
        self.assertIn(
            ["/usr/bin/docker", "--config"],
            [call.args[0][:2] for call in run.call_args_list],
        )
        self.assertTrue(
            any(
                arguments[-3:] == ["rm", "--force", reference]
                for arguments in (call.args[0] for call in run.call_args_list)
            )
        )

    def test_term_scope_translates_and_masks_both_cleanup_signals(self) -> None:
        original = {
            signum: signal.getsignal(signum)
            for signum in (signal.SIGTERM, signal.SIGHUP)
        }
        with FIXTURE.TerminationSignalScope() as cancellation_scope:
            handler = signal.getsignal(signal.SIGTERM)
            self.assertTrue(callable(handler))
            with self.assertRaises(FIXTURE.LocalStackCancellation):
                handler(signal.SIGTERM, None)
            cancellation_scope.mask_cleanup()
            self.assertEqual(signal.getsignal(signal.SIGTERM), signal.SIG_IGN)
            self.assertEqual(signal.getsignal(signal.SIGHUP), signal.SIG_IGN)
        for signum, handler in original.items():
            self.assertEqual(signal.getsignal(signum), handler)

    def test_ambiguous_launch_is_reconciled_before_accepting_absence(self) -> None:
        self.assertIn("AMBIGUOUS_LAUNCH_RECONCILIATION_SECONDS = 20", self.runner)
        self.assertIn("ambiguous_launch = container_id is None", self.runner)
        self.assertIn("time.monotonic() < reconcile_until", self.runner)

    def test_lifecycle_and_cross_role_denials_are_explicit(self) -> None:
        lifecycle = json.loads(LIFECYCLE.read_text(encoding="utf-8"))
        self.assertEqual(
            lifecycle,
            {
                "Rules": [
                    {
                        "ID": "localstack-export-integration-expiry",
                        "Status": "Enabled",
                        "Filter": {"Prefix": "integration/"},
                        "Expiration": {"Days": 1},
                        "AbortIncompleteMultipartUpload": {"DaysAfterInitiation": 1},
                    }
                ]
            },
        )
        self.assertIn("NoSuchLifecycleConfiguration", self.runner)
        self.assertIn("cross-bucket ledger-read denial", self.runner)
        self.assertIn("cross-bucket export-read denial", self.runner)
        self.assertIn("ledger-writer deletion denial", self.runner)
        self.assertIn("LocalStack restore version-list condition compatibility", self.runner)

    def test_restore_policy_compatibility_delta_is_localstack_only(self) -> None:
        production_path = ROOT / "infra" / "minio" / "erasure-restore-policy.json"
        compatibility_path = ROOT / "infra" / "localstack" / "erasure-restore-policy.json"
        production = json.loads(production_path.read_text(encoding="utf-8"))
        compatibility = json.loads(compatibility_path.read_text(encoding="utf-8"))
        expected = json.loads(json.dumps(production))
        list_statement = next(
            statement
            for statement in expected["Statement"]
            if statement["Action"] == ["s3:ListBucketVersions"]
        )
        self.assertEqual(
            list_statement.pop("Condition"),
            {
                "StringLike": {
                    "s3:prefix": ["erasure-ledger/v1/*"],
                }
            },
        )
        self.assertEqual(compatibility, expected)
        self.assertIn("Condition", production["Statement"][0])
        self.assertEqual(
            FIXTURE.POLICIES["nutrition-erasure-restore"], compatibility_path
        )

    def test_documented_package_commands_exist(self) -> None:
        package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
        self.assertEqual(
            package["scripts"]["test:localstack"],
            "python3 -B infra/localstack/run-tests.py",
        )
        self.assertEqual(
            package["scripts"]["test:localstack:contracts"],
            "python3 -B -m unittest discover -s infra/localstack/tests -p 'test_*.py'",
        )
        self.assertIn("pnpm test:localstack", self.readme)

    def test_runner_compiles_without_writing_repo_bytecode(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            py_compile.compile(
                str(RUNNER),
                cfile=str(Path(directory) / "run-tests.pyc"),
                doraise=True,
            )

    def test_existing_minio_permission_lane_is_retained(self) -> None:
        workflow = (ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
        self.assertIn("minio-bootstrap", workflow)
        self.assertIn("test:integration", workflow)
        for policy_name in (
            "export-writer-policy.json",
            "export-reader-policy.json",
            "erasure-writer-policy.json",
            "erasure-restore-policy.json",
        ):
            policy = json.loads((ROOT / "infra" / "minio" / policy_name).read_text(encoding="utf-8"))
            self.assertEqual(policy.get("Version"), "2012-10-17")

    def test_docs_reject_hosting_real_data_and_ci_developer_tokens(self) -> None:
        self.assertIn("not a hosting platform", self.readme)
        self.assertIn("synthetic", self.readme)
        self.assertIn("CI Auth Token", self.readme)
        self.assertIn("never", self.readme.lower())


if __name__ == "__main__":
    unittest.main()
