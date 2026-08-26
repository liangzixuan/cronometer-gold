from __future__ import annotations

import importlib.util
import contextlib
import io
import json
import py_compile
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[3]
WRAPPER = ROOT / "infra" / "localstack" / "dev-profile.py"
COMPOSE = ROOT / "infra" / "localstack" / "compose.dev.yml"
README = ROOT / "infra" / "localstack" / "README.md"
ADR = ROOT / "docs" / "adr" / "0010-persistent-localstack-development-profile.md"

SPEC = importlib.util.spec_from_file_location("nutrition_localstack_dev_profile", WRAPPER)
if SPEC is None or SPEC.loader is None:  # pragma: no cover - import machinery guard
    raise RuntimeError("Could not load persistent LocalStack wrapper")
PROFILE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = PROFILE
SPEC.loader.exec_module(PROFILE)


class PersistentLocalStackContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.compose = COMPOSE.read_text(encoding="utf-8")
        cls.wrapper = WRAPPER.read_text(encoding="utf-8")
        cls.readme = README.read_text(encoding="utf-8")
        cls.adr = ADR.read_text(encoding="utf-8")

    def test_compose_is_exactly_pinned_loopback_only_and_persistent(self) -> None:
        self.assertIn("localstack/localstack:2026.7.5@", self.compose)
        self.assertIn(
            "sha256:0d74e1d2d7ce13a3cb25fc64cf15eb225f1c95c762e56e057bc6a9ed0ed29306",
            self.compose,
        )
        self.assertIn('SERVICES: s3,iam,sts', self.compose)
        self.assertIn('ENFORCE_IAM: "1"', self.compose)
        self.assertIn('IAM_SOFT_MODE: "0"', self.compose)
        self.assertIn('PERSISTENCE: "1"', self.compose)
        self.assertIn('"127.0.0.1:${LOCALSTACK_GATEWAY_PORT:-4566}:4566"', self.compose)
        self.assertIn("localstack-state:/var/lib/localstack", self.compose)
        self.assertIn('restart: "no"', self.compose)
        self.assertNotIn("0.0.0.0", self.compose)
        self.assertNotIn("/var/run/docker.sock", self.compose)
        self.assertNotIn("privileged:", self.compose)
        self.assertNotIn("network_mode: host", self.compose)
        self.assertNotRegex(self.compose, r"localstack/localstack:(latest|stable|dev)(?:\W|$)")

    def test_compose_has_one_named_volume_and_no_host_mount(self) -> None:
        self.assertEqual(self.compose.count("localstack-state:/var/lib/localstack"), 1)
        self.assertIn(
            "name: nutrition-tracker-localstack-development-state-"
            "${LOCALSTACK_PROFILE_NAMESPACE:?wrapper-required}",
            self.compose,
        )
        self.assertNotIn("/Users/", self.compose)
        self.assertNotIn("./", self.compose)

    def test_token_is_runtime_only_and_has_no_argument_channel(self) -> None:
        self.assertIn("LOCALSTACK_AUTH_TOKEN: ${LOCALSTACK_AUTH_TOKEN-}", self.compose)
        self.assertNotRegex(
            self.compose,
            r"LOCALSTACK_AUTH_TOKEN:\s*[A-Za-z0-9_-]{16,}",
        )
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            PROFILE.parse_arguments(["up", "--token", "forbidden"])
        self.assertNotIn("add_argument(\"--token", self.wrapper)
        self.assertNotIn("shell=True", self.wrapper)

    def test_compose_uses_the_same_isolated_docker_configuration(self) -> None:
        self.assertIn('(plugin_directory / "docker-compose").symlink_to', self.wrapper)
        self.assertIn('compose_prefix = [*self.prefix, "compose"]', self.wrapper)
        self.assertNotIn(
            'compose_prefix = [docker, "--host", endpoint, "compose"]',
            self.wrapper,
        )

    def test_persistent_restore_role_uses_only_localstack_compatibility_policy(self) -> None:
        role = next(
            candidate
            for candidate in PROFILE.ROLES
            if candidate.user_name == "nutrition-erasure-restore"
        )
        self.assertEqual(
            role.policy_path,
            ROOT / "infra" / "localstack" / "erasure-restore-policy.json",
        )

    def test_no_volume_reset_or_broad_cleanup_command_exists(self) -> None:
        self.assertNotIn("--volumes", self.wrapper)
        self.assertNotIn("docker system prune", self.wrapper)
        self.assertNotIn("volume rm", self.wrapper)
        self.assertNotIn("reset", PROFILE.parse_arguments.__doc__ or "")
        package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
        self.assertFalse(any("reset" in name for name in package["scripts"] if "localstack" in name))

    def test_package_scripts_route_only_through_guarded_wrapper(self) -> None:
        scripts = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["scripts"]
        self.assertEqual(
            scripts["infra:localstack:up"],
            "python3 -B infra/localstack/dev-profile.py up",
        )
        self.assertEqual(
            scripts["infra:localstack:down"],
            "python3 -B infra/localstack/dev-profile.py down",
        )
        self.assertEqual(
            scripts["infra:localstack:status"],
            "python3 -B infra/localstack/dev-profile.py status",
        )
        self.assertEqual(
            scripts["test:localstack:dev"],
            "python3 -B infra/localstack/dev-profile.py verify",
        )
        self.assertEqual(
            scripts["dev:localstack"],
            "python3 -B infra/localstack/dev-profile.py run",
        )
        self.assertEqual(
            scripts["test:localstack"],
            "python3 -B infra/localstack/run-tests.py",
        )

    def test_docs_preserve_minio_and_reject_phone_or_release_hosting(self) -> None:
        self.assertIn("MinIO CI lane remains mandatory", self.readme)
        self.assertIn("LocalStack is never a phone endpoint", self.readme)
        self.assertIn("no volume-reset command", self.readme)
        self.assertIn("noninteractive invocation fails closed", self.readme)
        self.assertIn("not a deployment target", self.adr)
        self.assertIn("keep ADR 0009's one-shot fixture, the MinIO CI lane", self.adr)

    def test_wrapper_compiles_without_repository_bytecode(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            py_compile.compile(
                str(WRAPPER),
                cfile=str(Path(directory) / "dev-profile.pyc"),
                doraise=True,
            )


class PersistentLocalStackUnitTest(unittest.TestCase):
    def test_token_uses_environment_without_prompt(self) -> None:
        with mock.patch.object(PROFILE.getpass, "getpass") as prompt:
            self.assertEqual(
                PROFILE.developer_auth_token({"LOCALSTACK_AUTH_TOKEN": "developer-token"}),
                "developer-token",
            )
        prompt.assert_not_called()

    def test_token_prompts_non_echoing_only_on_an_interactive_stdin(self) -> None:
        fake_stdin = mock.Mock()
        fake_stdin.isatty.return_value = True
        with (
            mock.patch.object(PROFILE.sys, "stdin", fake_stdin),
            mock.patch.object(PROFILE.getpass, "getpass", return_value="prompt-token") as prompt,
        ):
            self.assertEqual(PROFILE.developer_auth_token({}), "prompt-token")
        prompt.assert_called_once_with("LocalStack Developer Auth Token: ")

    def test_missing_noninteractive_token_fails_closed(self) -> None:
        fake_stdin = mock.Mock()
        fake_stdin.isatty.return_value = False
        with (
            mock.patch.object(PROFILE.sys, "stdin", fake_stdin),
            mock.patch.object(PROFILE.getpass, "getpass") as prompt,
            self.assertRaises(PROFILE.LocalStackDevelopmentError),
        ):
            PROFILE.developer_auth_token({})
        prompt.assert_not_called()

    def test_token_and_port_validation_reject_unsafe_values(self) -> None:
        for token in (
            "",
            " leading",
            "trailing ",
            "middle space",
            "line\nbreak",
            "a" * 4_097,
        ):
            if token == "":
                continue
            with self.assertRaises(PROFILE.LocalStackDevelopmentError):
                PROFILE.developer_auth_token({"LOCALSTACK_AUTH_TOKEN": token})
        for port in ("", "4566 ", "0x11d6", "1023", "65536", "１２３４"):
            with self.assertRaises(PROFILE.LocalStackDevelopmentError):
                PROFILE.gateway_port({"LOCALSTACK_GATEWAY_PORT": port})
        self.assertEqual(PROFILE.gateway_port({}), 4566)
        self.assertEqual(PROFILE.gateway_port({"LOCALSTACK_GATEWAY_PORT": "14566"}), 14566)

    def test_sanitized_environment_removes_cloud_localstack_and_proxies(self) -> None:
        result = PROFILE.sanitized_environment(
            {
                "PATH": "/bin",
                "AWS_PROFILE": "real",
                "AWS_SECRET_ACCESS_KEY": "secret",
                "LOCALSTACK_AUTH_TOKEN": "token",
                "LOCALSTACK_GATEWAY_PORT": "4566",
                "HTTPS_PROXY": "https://proxy.invalid",
                "NODE_OPTIONS": "--require=/unsafe/preload.cjs",
                "EXPO_PUBLIC_API_URL": "https://api.example.org",
            }
        )
        self.assertEqual(
            result,
            {
                "PATH": "/bin",
                "EXPO_PUBLIC_API_URL": "https://api.example.org",
            },
        )

    def _credentials(self):
        return {
            role.user_name: PROFILE.Credentials(
                f"LKIA{'A' * (12 + index)}", f"synthetic-secret-{index}"
            )
            for index, role in enumerate(PROFILE.ROLES)
        }

    def test_generated_runtime_and_restore_roles_are_separated(self) -> None:
        credentials = self._credentials()
        endpoint = "http://127.0.0.1:4566"
        runtime = PROFILE.runtime_environment(credentials, endpoint)
        restore = PROFILE.restore_environment(credentials, endpoint)
        self.assertEqual(runtime["EXPORT_ARTIFACT_STORE"], "s3")
        self.assertEqual(runtime["ERASURE_REPLAY_LEDGER_STORE"], "s3")
        self.assertEqual(runtime["EXPORT_ARTIFACT_DELETE_VERSION_POLICY"], "suspended_null")
        self.assertNotIn("LOCALSTACK_AUTH_TOKEN", runtime)
        self.assertNotIn("ARTIFACT_STORE_ADMIN_ACCESS_KEY_ID", runtime)
        self.assertNotIn("ERASURE_REPLAY_LEDGER_RESTORE_ACCESS_KEY_ID", runtime)
        self.assertIn("ERASURE_REPLAY_LEDGER_RESTORE_ACCESS_KEY_ID", restore)
        self.assertNotIn("EXPORT_ARTIFACT_READ_ACCESS_KEY_ID", restore)
        self.assertEqual(
            restore["ERASURE_REPLAY_LEDGER_RESTORE_VERSION_LIST_PROVIDER"],
            "s3_compatible",
        )

    def test_custom_gateway_port_is_reused_and_mismatch_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            profile_file = Path(directory) / "profile.env"
            profile_file.write_text("LOCALSTACK_GATEWAY_PORT=14566\n", encoding="utf-8")
            profile_file.chmod(0o600)
            with mock.patch.object(PROFILE, "PROFILE_ENVIRONMENT_FILE", profile_file):
                self.assertEqual(PROFILE.effective_gateway_port({}), 14566)
                self.assertEqual(
                    PROFILE.effective_gateway_port(
                        {"LOCALSTACK_GATEWAY_PORT": "14566"}
                    ),
                    14566,
                )
                with self.assertRaisesRegex(
                    PROFILE.LocalStackDevelopmentError, "does not match"
                ):
                    PROFILE.effective_gateway_port(
                        {"LOCALSTACK_GATEWAY_PORT": "4566"}
                    )
            missing = Path(directory) / "missing.env"
            with mock.patch.object(PROFILE, "PROFILE_ENVIRONMENT_FILE", missing):
                self.assertEqual(PROFILE.effective_gateway_port({}), 4566)

    def test_checkout_namespace_separates_project_and_retained_volume_names(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            first = Path(directory) / "checkout-a"
            second = Path(directory) / "checkout-b"
            first.mkdir()
            second.mkdir()
            first_namespace = PROFILE.checkout_namespace(first)
            second_namespace = PROFILE.checkout_namespace(second)
        self.assertRegex(first_namespace, r"^[0-9a-f]{16}$")
        self.assertNotEqual(first_namespace, second_namespace)
        self.assertTrue(PROFILE.PROJECT_NAME.endswith(PROFILE.CHECKOUT_NAMESPACE))
        self.assertTrue(PROFILE.VOLUME_NAME.endswith(PROFILE.CHECKOUT_NAMESPACE))

    def test_atomic_environment_files_are_private_strict_and_replaceable(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            local_data = root / ".local-data"
            profile_state = local_data / "localstack"
            runtime_file = profile_state / "runtime.env"
            with (
                mock.patch.object(PROFILE, "LOCAL_DATA_DIRECTORY", local_data),
                mock.patch.object(PROFILE, "PROFILE_STATE_DIRECTORY", profile_state),
            ):
                PROFILE.atomic_write_environment(runtime_file, {"ONE": "first"})
                self.assertEqual(stat.S_IMODE(profile_state.stat().st_mode), 0o700)
                self.assertEqual(stat.S_IMODE(runtime_file.stat().st_mode), 0o600)
                self.assertEqual(
                    PROFILE.parse_environment_file(runtime_file, {"ONE"}),
                    {"ONE": "first"},
                )
                PROFILE.atomic_write_environment(runtime_file, {"ONE": "second"})
                self.assertEqual(
                    PROFILE.parse_environment_file(runtime_file, {"ONE"}),
                    {"ONE": "second"},
                )
                runtime_file.chmod(0o644)
                with self.assertRaises(PROFILE.LocalStackDevelopmentError):
                    PROFILE.atomic_write_environment(runtime_file, {"ONE": "unsafe"})

    def test_symlink_generated_file_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "target"
            target.write_text("ONE=value\n", encoding="utf-8")
            link = root / "runtime.env"
            link.symlink_to(target)
            with self.assertRaises(PROFILE.LocalStackDevelopmentError):
                PROFILE.parse_environment_file(link, {"ONE"})

    def test_version_inventory_rejects_delete_markers_duplicates_and_wrong_versions(self) -> None:
        valid = {
            "IsTruncated": False,
            "Versions": [
                {
                    "Key": "exports/v1/job/json.enc",
                    "VersionId": "null",
                    "IsLatest": True,
                }
            ],
        }
        PROFILE.verify_version_inventory(
            valid,
            bucket=PROFILE.EXPORT_BUCKET,
            prefixes=("exports/v1/", "integration/"),
            null_versions=True,
        )
        invalid_values = (
            {**valid, "DeleteMarkers": [{}]},
            {**valid, "IsTruncated": True},
            {
                **valid,
                "Versions": [valid["Versions"][0], valid["Versions"][0]],
            },
            {
                **valid,
                "Versions": [
                    {
                        "Key": "exports/v1/job/json.enc",
                        "VersionId": "real-version",
                        "IsLatest": True,
                    }
                ],
            },
        )
        for value in invalid_values:
            with self.assertRaises(PROFILE.LocalStackDevelopmentError):
                PROFILE.verify_version_inventory(
                    value,
                    bucket=PROFILE.EXPORT_BUCKET,
                    prefixes=("exports/v1/", "integration/"),
                    null_versions=True,
                )

    def test_root_dotenv_token_detection_handles_export_syntax(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / ".env"
            path.write_text("NODE_ENV=development\n", encoding="utf-8")
            self.assertFalse(PROFILE.dotenv_declares_localstack_token(path))
            path.write_text(
                "# forbidden\n export LOCALSTACK_AUTH_TOKEN = value\n",
                encoding="utf-8",
            )
            self.assertTrue(PROFILE.dotenv_declares_localstack_token(path))

    def test_root_dotenv_rejects_all_cloud_and_proxy_control_variables(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / ".env"
            path.write_text(
                "\n".join(
                    (
                        "NODE_ENV=development",
                        " \ufeff AWS_PROFILE: real",
                        "export AWS_SECRET_ACCESS_KEY : hidden",
                        "LOCALSTACK_GATEWAY_PORT: 14566",
                        "LOCALSTACK_AUTH_TOKEN: secret",
                        "https_proxy: https://proxy.invalid",
                        "NODE_OPTIONS: --require=/unsafe/preload.cjs",
                    )
                )
                + "\n",
                encoding="utf-8",
            )
            self.assertEqual(
                PROFILE.prohibited_dotenv_variables(path),
                {
                    "AWS_PROFILE",
                    "AWS_SECRET_ACCESS_KEY",
                    "LOCALSTACK_GATEWAY_PORT",
                    "LOCALSTACK_AUTH_TOKEN",
                    "https_proxy",
                    "NODE_OPTIONS",
                },
            )
            self.assertTrue(PROFILE.dotenv_declares_localstack_token(path))

    def test_run_starts_only_api_worker_and_required_package_watchers(self) -> None:
        class FakeSession:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return None

        with tempfile.TemporaryDirectory() as directory:
            repository_root = Path(directory)
            root_environment_file = repository_root / ".env"
            runtime_environment_file = repository_root / "runtime.env"
            root_environment_file.write_text("NODE_ENV=development\n", encoding="utf-8")
            runtime_environment_file.write_text("EXPORT_ARTIFACT_STORE=s3\n", encoding="utf-8")
            sanitized_child_environment = {
                "PATH": "/opt/homebrew/bin:/usr/bin",
                "EXPO_PUBLIC_API_URL": "https://phone.invalid",
            }
            with (
                mock.patch.object(PROFILE, "REPOSITORY_ROOT", repository_root),
                mock.patch.object(
                    PROFILE, "RUNTIME_ENVIRONMENT_FILE", runtime_environment_file
                ),
                mock.patch.object(PROFILE, "effective_gateway_port", return_value=4566),
                mock.patch.object(PROFILE.shutil, "which", return_value="/pnpm"),
                mock.patch.object(PROFILE, "DockerSession", return_value=FakeSession()),
                mock.patch.object(
                    PROFILE,
                    "running_profile",
                    return_value=("a" * 64, "http://127.0.0.1:4566"),
                ),
                mock.patch.object(PROFILE, "verify_existing_profile"),
                mock.patch.object(
                    PROFILE,
                    "sanitized_environment",
                    side_effect=lambda _environment: dict(
                        sanitized_child_environment
                    ),
                ),
                mock.patch.object(
                    PROFILE, "run_process_group", return_value=73
                ) as run_process_group,
            ):
                self.assertEqual(PROFILE.run_development({"PATH": "/usr/bin"}), 73)

        arguments = run_process_group.call_args.args[0]
        self.assertEqual(
            arguments,
            [
                "/pnpm",
                "exec",
                "dotenv",
                "--override",
                "-e",
                str(root_environment_file),
                "-e",
                str(runtime_environment_file),
                "--",
                "turbo",
                "run",
                "dev",
                "--filter=@nutrition-tracker/api",
                "--filter=@nutrition-tracker/worker",
            ],
        )
        self.assertNotIn("@nutrition-tracker/mobile", arguments)
        self.assertNotIn("@nutrition-tracker/web", arguments)
        child_environment = sanitized_child_environment
        self.assertEqual(
            run_process_group.call_args.kwargs,
            {
                "description": "LocalStack-backed development tasks",
                "environment": child_environment,
                "timeout_seconds": None,
            },
        )

    def test_run_graph_exactly_binds_required_server_watchers(self) -> None:
        turbo = json.loads((ROOT / "turbo.json").read_text(encoding="utf-8"))
        self.assertNotIn("globalPassThroughEnv", turbo)
        required_watchers = [
            "@nutrition-tracker/artifact-store#dev",
            "@nutrition-tracker/contracts#dev",
            "@nutrition-tracker/db#dev",
            "@nutrition-tracker/domain#dev",
            "@nutrition-tracker/search#dev",
        ]
        for task_name in (
            "@nutrition-tracker/api#dev",
            "@nutrition-tracker/worker#dev",
        ):
            self.assertEqual(turbo["tasks"][task_name]["with"], required_watchers)
        self.assertIn(
            "EXPORT_ARTIFACT_DELETE_VERSION_POLICY",
            turbo["tasks"]["@nutrition-tracker/worker#dev"]["passThroughEnv"],
        )
        for package in (ROOT / "apps" / "api", ROOT / "apps" / "worker"):
            package_json = json.loads(
                (package / "package.json").read_text(encoding="utf-8")
            )
            self.assertIn(
                "node ../../scripts/polling-tsx-watch.mjs",
                package_json["scripts"]["dev"],
            )
            self.assertIn(
                "--include ../../packages/artifact-store/dist/**/*.js",
                package_json["scripts"]["dev"],
            )
            self.assertIn(
                "--include ../../packages/domain/dist/**/*.js",
                package_json["scripts"]["dev"],
            )
        package_watch_command = (
            "node ../../scripts/polling-tsx-watch.mjs "
            '--include "src/**/*.ts" --include package.json '
            "--include tsconfig.build.json --include tsconfig.json "
            "--include ../../tsconfig.base.json "
            "../../scripts/watch-typescript-build.mjs"
        )
        for package_name in ("artifact-store", "contracts", "domain", "search"):
            package = ROOT / "packages" / package_name
            package_json = json.loads(
                (package / "package.json").read_text(encoding="utf-8")
            )
            self.assertEqual(package_json["scripts"]["dev"], package_watch_command)
        db_package = json.loads(
            (ROOT / "packages" / "db" / "package.json").read_text(encoding="utf-8")
        )
        self.assertEqual(
            db_package["scripts"]["dev"],
            package_watch_command.replace(
                "--include package.json",
                '--include "../domain/dist/**/*.d.ts" --include package.json',
            ),
        )

    def test_create_user_failure_does_not_delete_an_unowned_user(self) -> None:
        class FakeAws:
            def __init__(self):
                self.calls = []

            def command(self, arguments, _description, **_kwargs):
                self.calls.append(tuple(arguments))
                raise PROFILE.LocalStackDevelopmentError("create-user failed")

        aws = FakeAws()
        with self.assertRaisesRegex(
            PROFILE.LocalStackDevelopmentError, "create-user failed"
        ):
            PROFILE.create_roles(aws)
        self.assertEqual(
            aws.calls,
            [("iam", "create-user", "--user-name", PROFILE.ROLES[0].user_name)],
        )

    def test_process_cleanup_kills_group_after_leader_has_exited(self) -> None:
        process = mock.Mock()
        process.pid = 4242
        process.poll.return_value = 0
        with (
            mock.patch.object(
                PROFILE, "wait_for_process_group_exit", side_effect=(False, True)
            ) as wait_for_group,
            mock.patch.object(PROFILE, "process_group_exists", return_value=False),
            mock.patch.object(PROFILE.os, "killpg") as kill_group,
        ):
            PROFILE.stop_process_group(process, "test descendants")
        self.assertEqual(
            kill_group.call_args_list,
            [
                mock.call(4242, PROFILE.signal.SIGTERM),
                mock.call(4242, PROFILE.signal.SIGKILL),
            ],
        )
        self.assertEqual(wait_for_group.call_count, 2)

    def test_command_start_failure_is_sanitized(self) -> None:
        with (
            mock.patch.object(
                PROFILE.subprocess,
                "Popen",
                side_effect=OSError("raw Docker helper detail"),
            ),
            self.assertRaisesRegex(
                PROFILE.LocalStackDevelopmentError, "could not start Docker probe"
            ) as raised,
        ):
            PROFILE.command(
                ["docker", "version"],
                description="Docker probe",
                environment={},
                timeout_seconds=1,
                sensitive_output=True,
            )
        self.assertNotIn("raw Docker helper detail", str(raised.exception))

    def test_command_timeout_stops_process_group_before_returning(self) -> None:
        process = mock.Mock()
        process.returncode = None
        process.communicate.side_effect = PROFILE.subprocess.TimeoutExpired(
            ["docker", "compose", "up"], 1
        )
        with (
            mock.patch.object(
                PROFILE.subprocess, "Popen", return_value=process
            ) as popen,
            mock.patch.object(PROFILE, "stop_command_process_group") as stop_group,
            self.assertRaisesRegex(
                PROFILE.LocalStackDevelopmentError, "timed out after 1 seconds"
            ),
        ):
            PROFILE.command(
                ["docker", "compose", "up"],
                description="Compose launch",
                environment={},
                timeout_seconds=1,
                sensitive_output=True,
            )
        self.assertTrue(popen.call_args.kwargs["start_new_session"])
        stop_group.assert_called_once_with(process, "Compose launch")

    def test_ambiguous_access_key_creation_rolls_back_enumerated_unknown_key(self) -> None:
        class FakeAws:
            def __init__(self, malformed: bool):
                self.malformed = malformed
                self.users = set()
                self.keys = {}
                self.sensitive_list_seen = False

            def command(self, arguments, _description, **kwargs):
                operation = tuple(arguments[:2])
                user_name = (
                    arguments[arguments.index("--user-name") + 1]
                    if "--user-name" in arguments
                    else None
                )
                if operation == ("iam", "create-user"):
                    self.users.add(user_name)
                elif operation == ("iam", "list-access-keys"):
                    self.sensitive_list_seen = kwargs.get("sensitive_output") is True
                    metadata = [
                        {"AccessKeyId": key_id, "Status": "Active"}
                        for key_id in self.keys.get(user_name, set())
                    ]
                    return mock.Mock(
                        returncode=0,
                        stdout=json.dumps({"AccessKeyMetadata": metadata}),
                        stderr="",
                    )
                elif operation == ("iam", "delete-access-key"):
                    key_id = arguments[arguments.index("--access-key-id") + 1]
                    self.keys.get(user_name, set()).discard(key_id)
                elif operation == ("iam", "delete-user"):
                    if not self.keys.get(user_name):
                        self.users.discard(user_name)
                elif operation == ("iam", "get-user"):
                    if user_name not in self.users:
                        return mock.Mock(
                            returncode=255,
                            stdout="",
                            stderr="NoSuchEntity",
                        )
                    return mock.Mock(returncode=0, stdout="{}", stderr="")
                return mock.Mock(returncode=0, stdout="{}", stderr="")

            def json(self, arguments, _description, **_kwargs):
                if tuple(arguments[:2]) == ("iam", "create-access-key"):
                    user_name = arguments[arguments.index("--user-name") + 1]
                    self.keys[user_name] = {"LKIAUNKNOWN0001"}
                    if self.malformed:
                        return {}
                    raise PROFILE.LocalStackDevelopmentError(
                        "create access key timed out"
                    )
                raise AssertionError(f"unexpected JSON call: {arguments}")

        for malformed in (False, True):
            with self.subTest(malformed=malformed):
                aws = FakeAws(malformed)
                with self.assertRaises(PROFILE.LocalStackDevelopmentError):
                    PROFILE.create_roles(aws)
                self.assertEqual(aws.users, set())
                self.assertTrue(all(not keys for keys in aws.keys.values()))
                self.assertTrue(aws.sensitive_list_seen)

    def test_status_uses_only_read_only_profile_verification(self) -> None:
        class FakeSession:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return None

        session = FakeSession()
        with (
            mock.patch.object(PROFILE, "effective_gateway_port", return_value=4566),
            mock.patch.object(PROFILE, "DockerSession", return_value=session),
            mock.patch.object(PROFILE, "container_id", return_value="a" * 64),
            mock.patch.object(PROFILE, "container_is_running", return_value=True),
            mock.patch.object(PROFILE, "wait_for_health"),
            mock.patch.object(PROFILE, "verify_existing_profile") as verify_existing,
            mock.patch.object(PROFILE, "provision_or_verify") as provision,
            mock.patch.object(PROFILE, "atomic_write_environment") as write_environment,
        ):
            PROFILE.status_profile({})
        verify_existing.assert_called_once_with(
            session, "a" * 64, "http://127.0.0.1:4566"
        )
        provision.assert_not_called()
        write_environment.assert_not_called()

    def test_status_rejects_exited_token_container_with_exact_remediation(self) -> None:
        class FakeSession:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return None

        with (
            mock.patch.object(PROFILE, "effective_gateway_port", return_value=4566),
            mock.patch.object(PROFILE, "DockerSession", return_value=FakeSession()),
            mock.patch.object(PROFILE, "container_id", return_value="a" * 64),
            mock.patch.object(PROFILE, "container_is_running", return_value=False),
            self.assertRaisesRegex(
                PROFILE.LocalStackDevelopmentError,
                r"exited token-bearing.*pnpm infra:localstack:down",
            ),
        ):
            PROFILE.status_profile({})

    def test_cross_checkout_labels_block_stop_before_container_mutation(self) -> None:
        reference = "a" * 64

        class FakeSession:
            def __init__(self):
                self.calls = []

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return None

            def docker(self, arguments, *_args, **_kwargs):
                self.calls.append(list(arguments))
                if arguments[0] == "ps":
                    return mock.Mock(returncode=0, stdout=f"{reference}\n", stderr="")
                if arguments[0] == "inspect":
                    return mock.Mock(
                        returncode=0,
                        stdout=json.dumps(
                            {
                                "com.docker.compose.project": PROFILE.PROJECT_NAME,
                                "com.docker.compose.service": "localstack",
                                "com.docker.compose.project.working_dir": "/other/checkout",
                                "com.docker.compose.project.config_files": str(
                                    PROFILE.COMPOSE_FILE
                                ),
                            }
                        ),
                        stderr="",
                    )
                raise AssertionError(f"unexpected mutation: {arguments}")

        session = FakeSession()
        with (
            mock.patch.object(PROFILE, "effective_gateway_port", return_value=4566),
            mock.patch.object(PROFILE, "DockerSession", return_value=session),
            self.assertRaisesRegex(
                PROFILE.LocalStackDevelopmentError, "this checkout"
            ),
        ):
            PROFILE.stop_profile({})
        self.assertFalse(any(call[0] == "rm" for call in session.calls))

    def test_compose_file_directory_label_is_accepted_for_this_checkout(self) -> None:
        reference = "d" * 64

        class FakeSession:
            def docker(self, arguments, *_args, **_kwargs):
                if arguments[0] == "ps":
                    return mock.Mock(returncode=0, stdout=f"{reference}\n", stderr="")
                if arguments[0] == "inspect":
                    return mock.Mock(
                        returncode=0,
                        stdout=json.dumps(
                            {
                                "com.docker.compose.project": PROFILE.PROJECT_NAME,
                                "com.docker.compose.service": "localstack",
                                "com.docker.compose.project.working_dir": str(
                                    PROFILE.COMPOSE_FILE.parent
                                ),
                                "com.docker.compose.project.config_files": str(
                                    PROFILE.COMPOSE_FILE
                                ),
                            }
                        ),
                        stderr="",
                    )
                raise AssertionError(f"unexpected Docker call: {arguments}")

        self.assertEqual(PROFILE.profile_container_ids(FakeSession()), (reference,))

    def test_failed_start_removes_and_proves_token_container_absence(self) -> None:
        class FakeSession:
            def __init__(self):
                self.compose_calls = []
                self.docker_calls = []
                self.environment = {}

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return None

            def docker(self, arguments, *_args, **_kwargs):
                self.docker_calls.append(list(arguments))
                return mock.Mock(returncode=0, stdout="", stderr="")

            def compose(self, arguments, *_args, **_kwargs):
                self.compose_calls.append(list(arguments))
                return mock.Mock(returncode=0, stdout="", stderr="")

        session = FakeSession()
        with (
            mock.patch.object(PROFILE, "DockerSession", return_value=session),
            mock.patch.object(PROFILE, "container_id", return_value=None),
            mock.patch.object(PROFILE, "require_free_loopback_port"),
            mock.patch.object(
                PROFILE,
                "running_profile",
                side_effect=PROFILE.LocalStackDevelopmentError("health failed"),
            ),
            mock.patch.object(
                PROFILE,
                "profile_container_ids",
                side_effect=(("a" * 64,), ()),
            ),
            self.assertRaisesRegex(PROFILE.LocalStackDevelopmentError, "health failed"),
        ):
            PROFILE.start_profile({"LOCALSTACK_AUTH_TOKEN": "developer-token"})
        self.assertTrue(any(call and call[0] == "up" for call in session.compose_calls))
        self.assertFalse(any(call and call[0] == "down" for call in session.compose_calls))
        self.assertIn(["rm", "--force", "a" * 64], session.docker_calls)

    def test_term_after_container_create_masks_signals_and_removes_exact_id(self) -> None:
        reference = "b" * 64

        class FakeSession:
            def __init__(self):
                self.compose_calls = []
                self.docker_calls = []
                self.environment = {}

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return None

            def docker(self, arguments, *_args, **_kwargs):
                self.docker_calls.append(list(arguments))
                return mock.Mock(returncode=0, stdout="", stderr="")

            def compose(self, arguments, *_args, **_kwargs):
                self.compose_calls.append(list(arguments))
                return mock.Mock(returncode=0, stdout="", stderr="")

        session = FakeSession()
        cancellation_scope = mock.Mock()
        with (
            mock.patch.object(PROFILE, "DockerSession", return_value=session),
            mock.patch.object(PROFILE, "container_id", return_value=None),
            mock.patch.object(PROFILE, "require_free_loopback_port"),
            mock.patch.object(
                PROFILE,
                "running_profile",
                side_effect=PROFILE.LocalStackCancellation(PROFILE.signal.SIGTERM),
            ),
            mock.patch.object(
                PROFILE,
                "profile_container_ids",
                side_effect=((reference,), ()),
            ),
            self.assertRaises(PROFILE.LocalStackCancellation),
        ):
            PROFILE.start_profile(
                {"LOCALSTACK_AUTH_TOKEN": "developer-token"}, cancellation_scope
            )
        cancellation_scope.mask_cleanup.assert_called_once_with()
        self.assertIn(["rm", "--force", reference], session.docker_calls)

    def test_ambiguous_start_surfaces_original_and_cleanup_failure(self) -> None:
        class FakeSession:
            environment = {}

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return None

            def docker(self, *_args, **_kwargs):
                return mock.Mock(returncode=0, stdout="", stderr="")

            def compose(self, arguments, *_args, **_kwargs):
                if arguments and arguments[0] == "up":
                    raise PROFILE.LocalStackDevelopmentError("compose up timed out")
                return mock.Mock(returncode=1, stdout="", stderr="")

        session = FakeSession()
        with (
            mock.patch.object(PROFILE, "DockerSession", return_value=session),
            mock.patch.object(PROFILE, "container_id", return_value=None),
            mock.patch.object(PROFILE, "require_free_loopback_port"),
            mock.patch.object(
                PROFILE,
                "profile_container_ids",
                return_value=("a" * 64,),
            ),
            mock.patch.object(PROFILE, "START_FAILURE_RECONCILIATION_SECONDS", 0),
            self.assertRaisesRegex(
                PROFILE.LocalStackDevelopmentError,
                "compose up timed out.*cleanup also failed.*1 container",
            ),
        ):
            PROFILE.start_profile({"LOCALSTACK_AUTH_TOKEN": "developer-token"})


if __name__ == "__main__":
    unittest.main()
