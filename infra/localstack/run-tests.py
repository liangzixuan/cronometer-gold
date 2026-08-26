#!/usr/bin/env python3
"""Run the opt-in LocalStack S3/IAM compatibility fixture and remove it afterward."""

from __future__ import annotations

import json
import os
import re
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from secrets import token_hex
from typing import Any, Mapping, Sequence


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
IMAGE = (
    "localstack/localstack:2026.7.5@"
    "sha256:0d74e1d2d7ce13a3cb25fc64cf15eb225f1c95c762e56e057bc6a9ed0ed29306"
)
REGION = "us-east-1"
EXPORT_BUCKET = "nutrition-private-exports"
LEDGER_BUCKET = "nutrition-erasure-ledger"
CONTAINER_LABEL_KEY = "com.nutrition-tracker.fixture"
CONTAINER_LABEL_VALUE = "localstack-s3-iam-tests"
AMBIGUOUS_LAUNCH_RECONCILIATION_SECONDS = 20
POLICY_DIRECTORY = REPOSITORY_ROOT / "infra" / "minio"
EXPORT_LIFECYCLE_FILE = REPOSITORY_ROOT / "infra" / "localstack" / "export-lifecycle.json"
POLICIES = {
    "nutrition-export-writer": POLICY_DIRECTORY / "export-writer-policy.json",
    "nutrition-export-reader": POLICY_DIRECTORY / "export-reader-policy.json",
    "nutrition-erasure-writer": POLICY_DIRECTORY / "erasure-writer-policy.json",
    "nutrition-erasure-restore": REPOSITORY_ROOT
    / "infra"
    / "localstack"
    / "erasure-restore-policy.json",
}


class LocalStackFixtureError(RuntimeError):
    """A fail-closed LocalStack fixture error."""


class LocalStackCancellation(BaseException):
    """A catchable TERM/HUP cancellation that still permits verified cleanup."""

    def __init__(self, signum: int):
        super().__init__(f"cancelled by signal {signum}")
        self.signum = signum


class TerminationSignalScope:
    """Translate TERM/HUP into cancellation, then make cleanup uninterruptible."""

    def __init__(self) -> None:
        self._previous_handlers: dict[int, Any] = {}

    def __enter__(self) -> "TerminationSignalScope":
        def cancel(signum: int, _frame: object) -> None:
            raise LocalStackCancellation(signum)

        for signum in (signal.SIGTERM, signal.SIGHUP):
            self._previous_handlers[signum] = signal.signal(signum, cancel)
        return self

    def mask_cleanup(self) -> None:
        for signum in self._previous_handlers:
            signal.signal(signum, signal.SIG_IGN)

    def __exit__(self, _type: object, _value: object, _traceback: object) -> None:
        for signum, handler in self._previous_handlers.items():
            signal.signal(signum, handler)


@dataclass(frozen=True)
class Credentials:
    access_key_id: str
    secret_access_key: str


def step(message: str) -> None:
    print(f"[localstack] {message}", flush=True)


def command(
    arguments: Sequence[str],
    *,
    description: str,
    environment: Mapping[str, str],
    sensitive_output: bool = False,
    timeout_seconds: int = 60,
) -> subprocess.CompletedProcess[str]:
    try:
        result = subprocess.run(
            list(arguments),
            cwd=REPOSITORY_ROOT,
            env=dict(environment),
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout_seconds,
        )
    except subprocess.TimeoutExpired as error:
        raise LocalStackFixtureError(
            f"{description} timed out after {timeout_seconds} seconds"
        ) from error
    if result.returncode != 0:
        detail = ""
        if not sensitive_output:
            rendered = result.stderr.strip() or result.stdout.strip()
            if rendered:
                detail = f": {rendered[:1_500]}"
        raise LocalStackFixtureError(f"{description} failed{detail}")
    return result


def parse_json(result: subprocess.CompletedProcess[str], description: str) -> Any:
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise LocalStackFixtureError(f"{description} returned invalid JSON") from error


def sanitized_environment(source: Mapping[str, str]) -> dict[str, str]:
    blocked_exact = {
        "ALL_PROXY",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "NO_PROXY",
        "all_proxy",
        "http_proxy",
        "https_proxy",
        "no_proxy",
    }
    return {
        key: value
        for key, value in source.items()
        if key not in blocked_exact
        and not key.startswith("AWS_")
        and not key.startswith("LOCALSTACK_")
    }


def process_group_exists(process_group_id: int) -> bool:
    try:
        os.killpg(process_group_id, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def stop_process_group(process: subprocess.Popen[bytes], description: str) -> None:
    process_group_id = process.pid
    try:
        os.killpg(process_group_id, signal.SIGTERM)
    except ProcessLookupError:
        pass

    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        pass

    if process_group_exists(process_group_id):
        try:
            os.killpg(process_group_id, signal.SIGKILL)
        except ProcessLookupError:
            pass

    deadline = time.monotonic() + 5
    while process_group_exists(process_group_id) and time.monotonic() < deadline:
        time.sleep(0.1)

    if process.poll() is None:
        try:
            process.wait(timeout=1)
        except subprocess.TimeoutExpired:
            pass

    if process_group_exists(process_group_id) or process.poll() is None:
        raise LocalStackFixtureError(f"could not stop the complete {description} process group")


def run_streaming_process_group(
    arguments: Sequence[str],
    *,
    description: str,
    environment: Mapping[str, str],
    timeout_seconds: int,
) -> int:
    try:
        process = subprocess.Popen(
            list(arguments),
            cwd=REPOSITORY_ROOT,
            env=dict(environment),
            start_new_session=True,
        )
    except OSError as error:
        raise LocalStackFixtureError(f"could not start {description}") from error

    try:
        return process.wait(timeout=timeout_seconds)
    except subprocess.TimeoutExpired as error:
        try:
            stop_process_group(process, description)
        except LocalStackFixtureError as cleanup_error:
            raise LocalStackFixtureError(
                f"{description} timed out after {timeout_seconds} seconds; {cleanup_error}"
            ) from error
        raise LocalStackFixtureError(
            f"{description} timed out after {timeout_seconds} seconds"
        ) from error
    except BaseException:
        stop_process_group(process, description)
        raise


def validate_token() -> str:
    token = os.environ.get("LOCALSTACK_AUTH_TOKEN", "")
    if not token:
        raise LocalStackFixtureError(
            "LOCALSTACK_AUTH_TOKEN is required; obtain a Developer Auth Token from "
            "LocalStack and inject it from a secret store"
        )
    if token != token.strip() or any(ord(character) < 0x20 or ord(character) == 0x7F for character in token):
        raise LocalStackFixtureError("LOCALSTACK_AUTH_TOKEN contains invalid whitespace or control characters")
    return token


def gateway_port() -> int:
    raw_port = os.environ.get("LOCALSTACK_GATEWAY_PORT", "4566")
    if not raw_port.isascii() or not raw_port.isdecimal():
        raise LocalStackFixtureError("LOCALSTACK_GATEWAY_PORT must contain only decimal digits")
    port = int(raw_port)
    if port < 1_024 or port > 65_535:
        raise LocalStackFixtureError("LOCALSTACK_GATEWAY_PORT must be between 1024 and 65535")
    return port


def require_free_loopback_port(port: int) -> None:
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        probe.bind(("127.0.0.1", port))
    except OSError as error:
        raise LocalStackFixtureError(f"127.0.0.1:{port} is already in use") from error
    finally:
        probe.close()


def local_docker_endpoint(docker: str, environment: Mapping[str, str]) -> str:
    result = command(
        [docker, "context", "inspect"],
        description="Docker context inspection",
        environment=environment,
    )
    data = parse_json(result, "Docker context inspection")
    try:
        endpoint = data[0]["Endpoints"]["docker"]["Host"]
    except (IndexError, KeyError, TypeError) as error:
        raise LocalStackFixtureError("Docker context did not expose one engine endpoint") from error
    if not isinstance(endpoint, str):
        raise LocalStackFixtureError("Docker engine endpoint is not a string")
    parsed = urllib.parse.urlsplit(endpoint)
    if parsed.scheme != "unix" or parsed.netloc or not parsed.path.startswith("/"):
        raise LocalStackFixtureError("LocalStack tests require a local Unix-socket Docker engine")
    try:
        socket_mode = os.stat(parsed.path).st_mode
    except OSError as error:
        raise LocalStackFixtureError("The selected local Docker socket is unavailable") from error
    if not stat.S_ISSOCK(socket_mode):
        raise LocalStackFixtureError("The selected Docker endpoint is not a Unix socket")
    return endpoint


def wait_for_health(endpoint: str, services: Sequence[str], timeout_seconds: int = 90) -> dict[str, Any]:
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    deadline = time.monotonic() + timeout_seconds
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            request = urllib.request.Request(f"{endpoint}/_localstack/health", method="GET")
            with opener.open(request, timeout=2) as response:
                if response.status != 200:
                    raise LocalStackFixtureError("LocalStack health endpoint did not return HTTP 200")
                health = json.load(response)
            states = health.get("services", {})
            if all(states.get(service) in {"available", "running"} for service in services):
                return health
        except (OSError, urllib.error.URLError, json.JSONDecodeError, LocalStackFixtureError) as error:
            last_error = error
        time.sleep(0.5)
    raise LocalStackFixtureError("LocalStack did not become ready within 90 seconds") from last_error


def run_fixture(cancellation_scope: TerminationSignalScope) -> int:
    token = validate_token()
    port = gateway_port()
    require_free_loopback_port(port)
    docker = shutil.which("docker")
    pnpm = shutil.which("pnpm")
    if not docker:
        raise LocalStackFixtureError("docker is required")
    if not pnpm:
        raise LocalStackFixtureError("pnpm is required")

    inherited_environment = dict(os.environ)
    child_base_environment = sanitized_environment(inherited_environment)
    endpoint = f"http://127.0.0.1:{port}"
    docker_endpoint = local_docker_endpoint(docker, child_base_environment)
    container_name = f"nutrition-localstack-s3-{os.getpid()}-{token_hex(4)}"
    container_id: str | None = None
    cleanup_reference: str | None = None
    fixture_succeeded = False

    with tempfile.TemporaryDirectory(prefix="nutrition-localstack-docker-") as docker_config_value:
        docker_config = Path(docker_config_value)
        docker_config.chmod(0o700)
        config_file = docker_config / "config.json"
        config_file.write_text('{"auths":{}}\n', encoding="utf-8")
        config_file.chmod(0o600)
        empty_aws_credentials = docker_config / "empty-aws-credentials"
        empty_aws_credentials.write_text("", encoding="utf-8")
        empty_aws_credentials.chmod(0o600)
        empty_aws_config = docker_config / "empty-aws-config"
        empty_aws_config.write_text("", encoding="utf-8")
        empty_aws_config.chmod(0o600)
        docker_environment = {
            key: value
            for key, value in child_base_environment.items()
            if not key.startswith("DOCKER_")
        }
        launch_environment = dict(docker_environment)
        launch_environment["LOCALSTACK_AUTH_TOKEN"] = token
        docker_prefix = [
            docker,
            "--config",
            str(docker_config),
            "--host",
            docker_endpoint,
        ]

        def docker_command(
            arguments: Sequence[str],
            description: str,
            *,
            environment: Mapping[str, str] | None = None,
            sensitive_output: bool = False,
            timeout_seconds: int = 60,
        ) -> subprocess.CompletedProcess[str]:
            return command(
                [*docker_prefix, *arguments],
                description=description,
                environment=environment if environment is not None else docker_environment,
                sensitive_output=sensitive_output,
                timeout_seconds=timeout_seconds,
            )

        def aws_command(
            arguments: Sequence[str],
            description: str,
            *,
            credentials: Credentials | None = None,
            sensitive_output: bool = False,
            check: bool = True,
        ) -> subprocess.CompletedProcess[str]:
            aws_environment = dict(docker_environment)
            exec_environment: list[str] = []
            if credentials:
                aws_environment["AWS_ACCESS_KEY_ID"] = credentials.access_key_id
                aws_environment["AWS_SECRET_ACCESS_KEY"] = credentials.secret_access_key
                aws_environment["AWS_DEFAULT_REGION"] = REGION
                exec_environment = [
                    "--env",
                    "AWS_ACCESS_KEY_ID",
                    "--env",
                    "AWS_SECRET_ACCESS_KEY",
                    "--env",
                    "AWS_DEFAULT_REGION",
                ]
            arguments_with_prefix = [
                "exec",
                *exec_environment,
                container_id or "missing-container",
                "awslocal",
                "--region",
                REGION,
                "--output",
                "json",
                *arguments,
            ]
            try:
                result = subprocess.run(
                    [*docker_prefix, *arguments_with_prefix],
                    cwd=REPOSITORY_ROOT,
                    env=aws_environment,
                    check=False,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    timeout=30,
                )
            except subprocess.TimeoutExpired as error:
                raise LocalStackFixtureError(f"{description} timed out after 30 seconds") from error
            if check and result.returncode != 0:
                detail = ""
                if not sensitive_output:
                    rendered = result.stderr.strip() or result.stdout.strip()
                    if rendered:
                        detail = f": {rendered[:1_500]}"
                raise LocalStackFixtureError(f"{description} failed{detail}")
            return result

        def aws_json(
            arguments: Sequence[str],
            description: str,
            *,
            credentials: Credentials | None = None,
            sensitive_output: bool = False,
        ) -> Any:
            return parse_json(
                aws_command(
                    arguments,
                    description,
                    credentials=credentials,
                    sensitive_output=sensitive_output,
                ),
                description,
            )

        def require_access_denied(credentials: Credentials, arguments: Sequence[str], description: str) -> None:
            result = aws_command(arguments, description, credentials=credentials, check=False)
            combined = f"{result.stderr}\n{result.stdout}"
            if result.returncode == 0 or not re.search(r"AccessDenied", combined, re.IGNORECASE):
                raise LocalStackFixtureError(f"{description} did not fail specifically with AccessDenied")

        try:
            step("checking the local Docker engine with an isolated credential-helper-free config")
            docker_command(["version"], "Docker engine check")
            step("pulling the digest-pinned LocalStack multi-architecture image")
            docker_command(["pull", IMAGE], "LocalStack image pull", timeout_seconds=600)
            step("starting one ephemeral loopback-only S3/IAM/STS emulator")
            cleanup_reference = container_name
            run_result = docker_command(
                [
                    "run",
                    "--detach",
                    "--rm",
                    "--name",
                    container_name,
                    "--label",
                    f"{CONTAINER_LABEL_KEY}={CONTAINER_LABEL_VALUE}",
                    "--publish",
                    f"127.0.0.1:{port}:4566",
                    "--env",
                    "LOCALSTACK_AUTH_TOKEN",
                    "--env",
                    "SERVICES=s3,iam,sts",
                    "--env",
                    "EAGER_SERVICE_LOADING=1",
                    "--env",
                    "ENFORCE_IAM=1",
                    "--env",
                    "IAM_SOFT_MODE=0",
                    "--env",
                    "PERSISTENCE=0",
                    "--env",
                    "S3_SKIP_SIGNATURE_VALIDATION=1",
                    "--env",
                    "PARITY_AWS_ACCESS_KEY_ID=0",
                    "--env",
                    "LOCALSTACK_RESPONSE_HEADER_ENABLED=1",
                    "--env",
                    "DISABLE_EVENTS=1",
                    "--env",
                    f"AWS_DEFAULT_REGION={REGION}",
                    "--env",
                    "AWS_ACCESS_KEY_ID=test",
                    "--env",
                    "AWS_SECRET_ACCESS_KEY=test",
                    IMAGE,
                ],
                "LocalStack container start",
                environment=launch_environment,
                sensitive_output=True,
            )
            candidate_id = run_result.stdout.strip()
            if not re.fullmatch(r"[0-9a-f]{64}", candidate_id):
                raise LocalStackFixtureError("Docker did not return an exact LocalStack container ID")
            container_id = candidate_id
            wait_for_health(endpoint, ("s3", "iam", "sts"))

            identity = aws_json(["sts", "get-caller-identity"], "LocalStack root identity check")
            if identity.get("Account") != "000000000000" or identity.get("Arn") != "arn:aws:iam::000000000000:root":
                raise LocalStackFixtureError("LocalStack root identity did not match the isolated test account")

            step("creating two private buckets with the production versioning topology")
            for bucket in (EXPORT_BUCKET, LEDGER_BUCKET):
                aws_command(["s3api", "create-bucket", "--bucket", bucket], f"create {bucket}")
                aws_command(
                    [
                        "s3api",
                        "put-public-access-block",
                        "--bucket",
                        bucket,
                        "--public-access-block-configuration",
                        "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true",
                    ],
                    f"protect {bucket}",
                )
                public_block = aws_json(
                    ["s3api", "get-public-access-block", "--bucket", bucket],
                    f"verify {bucket} public-access block",
                ).get("PublicAccessBlockConfiguration")
                if public_block != {
                    "BlockPublicAcls": True,
                    "IgnorePublicAcls": True,
                    "BlockPublicPolicy": True,
                    "RestrictPublicBuckets": True,
                }:
                    raise LocalStackFixtureError(f"{bucket} public-access block did not round-trip exactly")

            aws_command(
                [
                    "s3api",
                    "put-bucket-versioning",
                    "--bucket",
                    EXPORT_BUCKET,
                    "--versioning-configuration",
                    "Status=Enabled",
                ],
                "enable export versioning before suspension",
            )
            aws_command(
                [
                    "s3api",
                    "put-bucket-versioning",
                    "--bucket",
                    EXPORT_BUCKET,
                    "--versioning-configuration",
                    "Status=Suspended",
                ],
                "suspend export versioning",
            )
            aws_command(
                [
                    "s3api",
                    "put-bucket-versioning",
                    "--bucket",
                    LEDGER_BUCKET,
                    "--versioning-configuration",
                    "Status=Enabled",
                ],
                "enable ledger versioning",
            )
            export_versioning = aws_json(
                ["s3api", "get-bucket-versioning", "--bucket", EXPORT_BUCKET],
                "verify export versioning",
            )
            ledger_versioning = aws_json(
                ["s3api", "get-bucket-versioning", "--bucket", LEDGER_BUCKET],
                "verify ledger versioning",
            )
            if export_versioning.get("Status") != "Suspended":
                raise LocalStackFixtureError("Export bucket versioning is not suspended")
            if ledger_versioning.get("Status") != "Enabled":
                raise LocalStackFixtureError("Ledger bucket versioning is not enabled")

            lifecycle = json.loads(EXPORT_LIFECYCLE_FILE.read_text(encoding="utf-8"))
            aws_command(
                [
                    "s3api",
                    "put-bucket-lifecycle-configuration",
                    "--bucket",
                    EXPORT_BUCKET,
                    "--lifecycle-configuration",
                    json.dumps(lifecycle, separators=(",", ":"), sort_keys=True),
                ],
                "configure synthetic export lifecycle",
            )
            lifecycle_round_trip = aws_json(
                [
                    "s3api",
                    "get-bucket-lifecycle-configuration",
                    "--bucket",
                    EXPORT_BUCKET,
                ],
                "verify synthetic export lifecycle",
            )
            if lifecycle_round_trip.get("Rules") != lifecycle.get("Rules"):
                raise LocalStackFixtureError("Export lifecycle configuration did not round-trip exactly")
            ledger_lifecycle = aws_command(
                [
                    "s3api",
                    "get-bucket-lifecycle-configuration",
                    "--bucket",
                    LEDGER_BUCKET,
                ],
                "verify ledger lifecycle absence",
                check=False,
            )
            if ledger_lifecycle.returncode == 0 or not re.search(
                r"NoSuchLifecycleConfiguration",
                f"{ledger_lifecycle.stderr}\n{ledger_lifecycle.stdout}",
                re.IGNORECASE,
            ):
                raise LocalStackFixtureError(
                    "Ledger lifecycle lookup did not fail specifically with NoSuchLifecycleConfiguration"
                )

            step("creating four ephemeral IAM users and proving default denial")
            credentials_by_user: dict[str, Credentials] = {}
            for user_name, policy_path in POLICIES.items():
                policy = json.loads(policy_path.read_text(encoding="utf-8"))
                aws_command(["iam", "create-user", "--user-name", user_name], f"create IAM user {user_name}")
                key_result = aws_json(
                    ["iam", "create-access-key", "--user-name", user_name],
                    f"create access key for {user_name}",
                    sensitive_output=True,
                )
                access_key = key_result.get("AccessKey", {})
                access_key_id = access_key.get("AccessKeyId")
                secret_access_key = access_key.get("SecretAccessKey")
                if not isinstance(access_key_id, str) or not access_key_id.startswith("LKIA"):
                    raise LocalStackFixtureError(f"{user_name} did not receive a LocalStack-scoped access key")
                if not isinstance(secret_access_key, str) or not secret_access_key:
                    raise LocalStackFixtureError(f"{user_name} did not receive a secret access key")
                credentials = Credentials(access_key_id, secret_access_key)
                credentials_by_user[user_name] = credentials
                user_identity = aws_json(
                    ["sts", "get-caller-identity"],
                    f"verify identity for {user_name}",
                    credentials=credentials,
                )
                if user_identity.get("Arn") != f"arn:aws:iam::000000000000:user/{user_name}":
                    raise LocalStackFixtureError(f"{user_name} credentials resolved to the wrong principal")
                require_access_denied(
                    credentials,
                    ["s3api", "list-buckets"],
                    f"pre-policy denial for {user_name}",
                )
                policy_name = f"{user_name}-inline"
                aws_command(
                    [
                        "iam",
                        "put-user-policy",
                        "--user-name",
                        user_name,
                        "--policy-name",
                        policy_name,
                        "--policy-document",
                        json.dumps(policy, separators=(",", ":"), sort_keys=True),
                    ],
                    f"attach policy for {user_name}",
                )
                round_trip = aws_json(
                    [
                        "iam",
                        "get-user-policy",
                        "--user-name",
                        user_name,
                        "--policy-name",
                        policy_name,
                    ],
                    f"verify policy for {user_name}",
                ).get("PolicyDocument")
                if isinstance(round_trip, str):
                    round_trip = json.loads(urllib.parse.unquote(round_trip))
                if round_trip != policy:
                    raise LocalStackFixtureError(f"{user_name} policy did not round-trip exactly")

            step("running the encrypted S3 compatibility and least-privilege suite")
            test_environment = dict(child_base_environment)
            test_environment.update(
                {
                    "NODE_ENV": "test",
                    "AWS_SHARED_CREDENTIALS_FILE": str(empty_aws_credentials),
                    "AWS_CONFIG_FILE": str(empty_aws_config),
                    "AWS_EC2_METADATA_DISABLED": "true",
                    "RUN_ARTIFACT_STORE_INTEGRATION": "1",
                    "EXPORT_ARTIFACT_ENDPOINT": endpoint,
                    "EXPORT_ARTIFACT_REGION": REGION,
                    "EXPORT_ARTIFACT_BUCKET": EXPORT_BUCKET,
                    "EXPORT_ARTIFACT_WRITE_ACCESS_KEY_ID": credentials_by_user[
                        "nutrition-export-writer"
                    ].access_key_id,
                    "EXPORT_ARTIFACT_WRITE_SECRET_ACCESS_KEY": credentials_by_user[
                        "nutrition-export-writer"
                    ].secret_access_key,
                    "EXPORT_ARTIFACT_READ_ACCESS_KEY_ID": credentials_by_user[
                        "nutrition-export-reader"
                    ].access_key_id,
                    "EXPORT_ARTIFACT_READ_SECRET_ACCESS_KEY": credentials_by_user[
                        "nutrition-export-reader"
                    ].secret_access_key,
                    "ERASURE_REPLAY_LEDGER_ENDPOINT": endpoint,
                    "ERASURE_REPLAY_LEDGER_REGION": REGION,
                    "ERASURE_REPLAY_LEDGER_BUCKET": LEDGER_BUCKET,
                    "ERASURE_REPLAY_LEDGER_WRITE_ACCESS_KEY_ID": credentials_by_user[
                        "nutrition-erasure-writer"
                    ].access_key_id,
                    "ERASURE_REPLAY_LEDGER_WRITE_SECRET_ACCESS_KEY": credentials_by_user[
                        "nutrition-erasure-writer"
                    ].secret_access_key,
                    "ERASURE_REPLAY_LEDGER_RESTORE_ACCESS_KEY_ID": credentials_by_user[
                        "nutrition-erasure-restore"
                    ].access_key_id,
                    "ERASURE_REPLAY_LEDGER_RESTORE_SECRET_ACCESS_KEY": credentials_by_user[
                        "nutrition-erasure-restore"
                    ].secret_access_key,
                    "ARTIFACT_STORE_ADMIN_ACCESS_KEY_ID": "test",
                    "ARTIFACT_STORE_ADMIN_SECRET_ACCESS_KEY": "test",
                }
            )
            test_return_code = run_streaming_process_group(
                [pnpm, "--filter", "@nutrition-tracker/artifact-store", "test:integration"],
                description="LocalStack artifact-store integration suite",
                environment=test_environment,
                timeout_seconds=180,
            )
            if test_return_code != 0:
                raise LocalStackFixtureError("LocalStack artifact-store integration suite failed")

            step("auditing final bucket state and retained IAM denials")
            buckets = aws_json(["s3api", "list-buckets"], "list final LocalStack buckets")
            bucket_names = sorted(bucket.get("Name") for bucket in buckets.get("Buckets", []))
            if bucket_names != sorted([EXPORT_BUCKET, LEDGER_BUCKET]):
                raise LocalStackFixtureError("LocalStack created an unexpected bucket")

            ledger_versions = aws_json(
                ["s3api", "list-object-versions", "--bucket", LEDGER_BUCKET],
                "audit ledger versions",
            )
            versions = ledger_versions.get("Versions", [])
            delete_markers = ledger_versions.get("DeleteMarkers", [])
            if (
                len(versions) != 1
                or delete_markers
                or versions[0].get("IsLatest") is not True
                or versions[0].get("VersionId") in {None, "", "null"}
                or not str(versions[0].get("Key", "")).startswith("erasure-ledger/v1/")
            ):
                raise LocalStackFixtureError("Ledger did not retain exactly one live immutable version")

            ledger_key = str(versions[0]["Key"])
            matrix_export_key = "integration/access-matrix.bin"
            aws_command(
                [
                    "s3api",
                    "put-object",
                    "--bucket",
                    EXPORT_BUCKET,
                    "--key",
                    matrix_export_key,
                    "--body",
                    "/etc/hostname",
                ],
                "create synthetic access-matrix export object",
            )

            for user_name, credentials in credentials_by_user.items():
                require_access_denied(
                    credentials,
                    ["s3api", "list-buckets"],
                    f"post-policy bucket-list denial for {user_name}",
                )
                require_access_denied(
                    credentials,
                    ["s3api", "create-bucket", "--bucket", f"nutrition-denied-{user_name}"],
                    f"post-policy bucket-creation denial for {user_name}",
                )

            for user_name in ("nutrition-export-writer", "nutrition-export-reader"):
                require_access_denied(
                    credentials_by_user[user_name],
                    [
                        "s3api",
                        "get-object",
                        "--bucket",
                        LEDGER_BUCKET,
                        "--key",
                        ledger_key,
                        f"/tmp/{user_name}-ledger-denied",
                    ],
                    f"cross-bucket ledger-read denial for {user_name}",
                )

            for user_name in ("nutrition-erasure-writer", "nutrition-erasure-restore"):
                require_access_denied(
                    credentials_by_user[user_name],
                    [
                        "s3api",
                        "get-object",
                        "--bucket",
                        EXPORT_BUCKET,
                        "--key",
                        matrix_export_key,
                        f"/tmp/{user_name}-export-denied",
                    ],
                    f"cross-bucket export-read denial for {user_name}",
                )

            require_access_denied(
                credentials_by_user["nutrition-erasure-writer"],
                ["s3api", "delete-object", "--bucket", LEDGER_BUCKET, "--key", ledger_key],
                "ledger-writer deletion denial",
            )
            compatibility_listing = aws_json(
                [
                    "s3api",
                    "list-object-versions",
                    "--bucket",
                    LEDGER_BUCKET,
                    "--prefix",
                    "integration/outside-restore-prefix",
                ],
                "LocalStack restore version-list condition compatibility",
                credentials=credentials_by_user["nutrition-erasure-restore"],
            )
            if (
                compatibility_listing.get("IsTruncated") is True
                or compatibility_listing.get("Versions", []) != []
                or compatibility_listing.get("DeleteMarkers", []) != []
            ):
                raise LocalStackFixtureError(
                    "LocalStack restore compatibility listing unexpectedly returned objects"
                )

            aws_command(
                [
                    "s3api",
                    "delete-object",
                    "--bucket",
                    EXPORT_BUCKET,
                    "--key",
                    matrix_export_key,
                    "--version-id",
                    "null",
                ],
                "remove synthetic access-matrix export object",
            )
            export_versions = aws_json(
                ["s3api", "list-object-versions", "--bucket", EXPORT_BUCKET],
                "audit final export versions",
            )
            if export_versions.get("Versions", []) or export_versions.get("DeleteMarkers", []):
                raise LocalStackFixtureError("Export cleanup left a version or delete marker")

            step("LocalStack S3/IAM compatibility suite passed")
            fixture_succeeded = True
            return 0
        finally:
            cancellation_scope.mask_cleanup()
            reference = container_id or cleanup_reference
            if reference:
                cleanup_error: LocalStackFixtureError | None = None
                no_such_container = re.compile(r"No such (?:object|container)", re.IGNORECASE)
                ambiguous_launch = container_id is None
                reconcile_until = time.monotonic() + (
                    AMBIGUOUS_LAUNCH_RECONCILIATION_SECONDS if ambiguous_launch else 0
                )
                while cleanup_error is None:
                    try:
                        inspect = subprocess.run(
                            [
                                *docker_prefix,
                                "inspect",
                                "--format",
                                f"{{{{ index .Config.Labels \"{CONTAINER_LABEL_KEY}\" }}}}",
                                reference,
                            ],
                            cwd=REPOSITORY_ROOT,
                            env=docker_environment,
                            check=False,
                            stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE,
                            text=True,
                            timeout=10,
                        )
                    except subprocess.TimeoutExpired:
                        cleanup_error = LocalStackFixtureError(
                            f"cleanup inspection timed out; container reference {reference} may still be running"
                        )
                        break

                    inspect_output = f"{inspect.stderr}\n{inspect.stdout}"
                    if inspect.returncode != 0:
                        if not no_such_container.search(inspect_output):
                            cleanup_error = LocalStackFixtureError(
                                f"cleanup could not inspect container reference {reference}"
                            )
                            break
                        if ambiguous_launch and time.monotonic() < reconcile_until:
                            time.sleep(0.5)
                            continue
                        break

                    if inspect.stdout.strip() != CONTAINER_LABEL_VALUE:
                        cleanup_error = LocalStackFixtureError(
                            f"cleanup refused a container with a changed label: {reference}"
                        )
                        break

                    try:
                        removal = subprocess.run(
                            [*docker_prefix, "rm", "--force", reference],
                            cwd=REPOSITORY_ROOT,
                            env=docker_environment,
                            check=False,
                            stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE,
                            text=True,
                            timeout=20,
                        )
                    except subprocess.TimeoutExpired:
                        cleanup_error = LocalStackFixtureError(
                            f"cleanup removal timed out; container reference {reference} may still be running"
                        )
                        break

                    if removal.returncode != 0:
                        cleanup_error = LocalStackFixtureError(
                            f"cleanup could not remove container reference {reference}"
                        )
                        break

                    try:
                        verification = subprocess.run(
                            [*docker_prefix, "inspect", reference],
                            cwd=REPOSITORY_ROOT,
                            env=docker_environment,
                            check=False,
                            stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE,
                            text=True,
                            timeout=10,
                        )
                    except subprocess.TimeoutExpired:
                        cleanup_error = LocalStackFixtureError(
                            f"cleanup verification timed out for container reference {reference}"
                        )
                        break

                    verification_output = f"{verification.stderr}\n{verification.stdout}"
                    if verification.returncode == 0 or not no_such_container.search(
                        verification_output
                    ):
                        cleanup_error = LocalStackFixtureError(
                            f"cleanup could not prove container absence: {reference}"
                        )
                        break

                    if ambiguous_launch and time.monotonic() < reconcile_until:
                        time.sleep(0.5)
                        continue
                    break
                if cleanup_error:
                    if fixture_succeeded:
                        raise cleanup_error
                    print(f"[localstack] CLEANUP ERROR: {cleanup_error}", file=sys.stderr)


def main() -> int:
    with TerminationSignalScope() as cancellation_scope:
        return run_fixture(cancellation_scope)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except LocalStackCancellation as error:
        print(
            f"[localstack] CANCELLED: received signal {error.signum}",
            file=sys.stderr,
        )
        raise SystemExit(128 + error.signum) from None
    except LocalStackFixtureError as error:
        print(f"[localstack] ERROR: {error}", file=sys.stderr)
        raise SystemExit(1) from None
