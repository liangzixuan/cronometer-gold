#!/usr/bin/env python3
"""Operate the attended, synthetic-only persistent LocalStack development profile."""

from __future__ import annotations

import argparse
import getpass
import hashlib
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
from typing import Any, Mapping, Sequence


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
COMPOSE_FILE = REPOSITORY_ROOT / "infra" / "localstack" / "compose.dev.yml"
POLICY_DIRECTORY = REPOSITORY_ROOT / "infra" / "minio"
EXPORT_LIFECYCLE_FILE = REPOSITORY_ROOT / "infra" / "localstack" / "export-lifecycle.json"
LOCAL_DATA_DIRECTORY = REPOSITORY_ROOT / ".local-data"
PROFILE_STATE_DIRECTORY = LOCAL_DATA_DIRECTORY / "localstack"
RUNTIME_ENVIRONMENT_FILE = PROFILE_STATE_DIRECTORY / "runtime.env"
RESTORE_ENVIRONMENT_FILE = PROFILE_STATE_DIRECTORY / "restore.env"
PROFILE_ENVIRONMENT_FILE = PROFILE_STATE_DIRECTORY / "profile.env"


def checkout_namespace(repository_root: Path) -> str:
    canonical_root = repository_root.resolve(strict=False)
    return hashlib.sha256(os.fsencode(canonical_root)).hexdigest()[:16]


CHECKOUT_NAMESPACE = checkout_namespace(REPOSITORY_ROOT)
PROJECT_NAME = f"nutrition-tracker-localstack-development-{CHECKOUT_NAMESPACE}"
VOLUME_NAME = f"nutrition-tracker-localstack-development-state-{CHECKOUT_NAMESPACE}"
IMAGE = (
    "localstack/localstack:2026.7.5@"
    "sha256:0d74e1d2d7ce13a3cb25fc64cf15eb225f1c95c762e56e057bc6a9ed0ed29306"
)
REGION = "us-east-1"
EXPORT_BUCKET = "nutrition-private-exports"
LEDGER_BUCKET = "nutrition-erasure-ledger"
SERVICES = ("s3", "iam", "sts")
START_FAILURE_RECONCILIATION_SECONDS = 20
PROCESS_GROUP_TERM_SECONDS = 5
PROCESS_GROUP_KILL_SECONDS = 5
PUBLIC_ACCESS_BLOCK = {
    "BlockPublicAcls": True,
    "IgnorePublicAcls": True,
    "BlockPublicPolicy": True,
    "RestrictPublicBuckets": True,
}
PROXY_VARIABLES = {
    "ALL_PROXY",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "all_proxy",
    "http_proxy",
    "https_proxy",
    "no_proxy",
}
DEVELOPMENT_PROCESS_CONTROL_VARIABLES = {"NODE_OPTIONS"}


class LocalStackDevelopmentError(RuntimeError):
    """A fail-closed development-profile error."""


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


@dataclass(frozen=True)
class Role:
    user_name: str
    policy_path: Path
    access_key_variable: str
    secret_key_variable: str
    environment_file: str


ROLES = (
    Role(
        "nutrition-export-writer",
        POLICY_DIRECTORY / "export-writer-policy.json",
        "EXPORT_ARTIFACT_WRITE_ACCESS_KEY_ID",
        "EXPORT_ARTIFACT_WRITE_SECRET_ACCESS_KEY",
        "runtime",
    ),
    Role(
        "nutrition-export-reader",
        POLICY_DIRECTORY / "export-reader-policy.json",
        "EXPORT_ARTIFACT_READ_ACCESS_KEY_ID",
        "EXPORT_ARTIFACT_READ_SECRET_ACCESS_KEY",
        "runtime",
    ),
    Role(
        "nutrition-erasure-writer",
        POLICY_DIRECTORY / "erasure-writer-policy.json",
        "ERASURE_REPLAY_LEDGER_WRITE_ACCESS_KEY_ID",
        "ERASURE_REPLAY_LEDGER_WRITE_SECRET_ACCESS_KEY",
        "runtime",
    ),
    Role(
        "nutrition-erasure-restore",
        REPOSITORY_ROOT / "infra" / "localstack" / "erasure-restore-policy.json",
        "ERASURE_REPLAY_LEDGER_RESTORE_ACCESS_KEY_ID",
        "ERASURE_REPLAY_LEDGER_RESTORE_SECRET_ACCESS_KEY",
        "restore",
    ),
)


def step(message: str) -> None:
    print(f"[localstack-dev] {message}", flush=True)


def sanitized_environment(source: Mapping[str, str]) -> dict[str, str]:
    return {
        key: value
        for key, value in source.items()
        if key not in PROXY_VARIABLES
        and not key.startswith("AWS_")
        and not key.startswith("LOCALSTACK_")
        and key.upper() not in DEVELOPMENT_PROCESS_CONTROL_VARIABLES
    }


def developer_auth_token(environment: Mapping[str, str]) -> str:
    token = environment.get("LOCALSTACK_AUTH_TOKEN", "")
    if not token:
        if not sys.stdin.isatty():
            raise LocalStackDevelopmentError(
                "LOCALSTACK_AUTH_TOKEN is absent and a noninteractive process cannot prompt for it"
            )
        try:
            token = getpass.getpass("LocalStack Developer Auth Token: ")
        except (EOFError, KeyboardInterrupt) as error:
            raise LocalStackDevelopmentError("LocalStack token prompt was cancelled") from error
    if (
        not token
        or len(token) > 4_096
        or token != token.strip()
        or any(
            character.isspace()
            or ord(character) < 0x20
            or ord(character) == 0x7F
            for character in token
        )
    ):
        raise LocalStackDevelopmentError(
            "LOCALSTACK_AUTH_TOKEN is empty, oversized, or contains whitespace/control characters"
        )
    return token


def gateway_port(environment: Mapping[str, str]) -> int:
    raw_port = environment.get("LOCALSTACK_GATEWAY_PORT", "4566")
    if not raw_port.isascii() or not raw_port.isdecimal():
        raise LocalStackDevelopmentError(
            "LOCALSTACK_GATEWAY_PORT must contain only decimal digits"
        )
    port = int(raw_port)
    if port < 1_024 or port > 65_535:
        raise LocalStackDevelopmentError(
            "LOCALSTACK_GATEWAY_PORT must be between 1024 and 65535"
        )
    return port


def effective_gateway_port(environment: Mapping[str, str]) -> int:
    explicit_port = (
        gateway_port(environment) if "LOCALSTACK_GATEWAY_PORT" in environment else None
    )
    persisted_port: int | None = None
    if PROFILE_ENVIRONMENT_FILE.exists() or PROFILE_ENVIRONMENT_FILE.is_symlink():
        persisted = parse_environment_file(
            PROFILE_ENVIRONMENT_FILE, {"LOCALSTACK_GATEWAY_PORT"}
        )
        persisted_port = gateway_port(persisted)
    if explicit_port is not None and persisted_port is not None and explicit_port != persisted_port:
        raise LocalStackDevelopmentError(
            "LOCALSTACK_GATEWAY_PORT does not match the retained development profile"
        )
    if explicit_port is not None:
        return explicit_port
    if persisted_port is not None:
        return persisted_port
    return gateway_port({})


def command(
    arguments: Sequence[str],
    *,
    description: str,
    environment: Mapping[str, str],
    timeout_seconds: int,
    sensitive_output: bool = False,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    try:
        process = subprocess.Popen(
            list(arguments),
            cwd=REPOSITORY_ROOT,
            env=dict(environment),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            start_new_session=True,
        )
    except OSError as error:
        raise LocalStackDevelopmentError(f"could not start {description}") from error
    try:
        stdout, stderr = process.communicate(timeout=timeout_seconds)
    except subprocess.TimeoutExpired as error:
        try:
            stop_command_process_group(process, description)
        except LocalStackDevelopmentError as cleanup_error:
            raise LocalStackDevelopmentError(
                f"{description} timed out after {timeout_seconds} seconds; {cleanup_error}"
            ) from error
        raise LocalStackDevelopmentError(
            f"{description} timed out after {timeout_seconds} seconds"
        ) from error
    except BaseException as error:
        try:
            stop_command_process_group(process, description)
        except LocalStackDevelopmentError as cleanup_error:
            raise LocalStackDevelopmentError(
                f"{description} was interrupted; {cleanup_error}"
            ) from error
        raise
    result = subprocess.CompletedProcess(
        list(arguments), process.returncode, stdout, stderr
    )
    if check and result.returncode != 0:
        detail = ""
        if not sensitive_output:
            rendered = result.stderr.strip() or result.stdout.strip()
            if rendered:
                detail = f": {rendered[:1_500]}"
        raise LocalStackDevelopmentError(f"{description} failed{detail}")
    return result


def stop_command_process_group(
    process: subprocess.Popen[str], description: str
) -> None:
    previous_handlers = {
        signum: signal.signal(signum, signal.SIG_IGN)
        for signum in (signal.SIGTERM, signal.SIGHUP)
    }
    try:
        stop_process_group(process, description)
    finally:
        for stream in (process.stdout, process.stderr):
            if stream is not None:
                stream.close()
        for signum, handler in previous_handlers.items():
            signal.signal(signum, handler)


def parse_json(result: subprocess.CompletedProcess[str], description: str) -> Any:
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise LocalStackDevelopmentError(f"{description} returned invalid JSON") from error


def local_docker_endpoint(docker: str, environment: Mapping[str, str]) -> str:
    result = command(
        [docker, "context", "inspect"],
        description="Docker context inspection",
        environment=environment,
        timeout_seconds=30,
    )
    data = parse_json(result, "Docker context inspection")
    try:
        endpoint = data[0]["Endpoints"]["docker"]["Host"]
    except (IndexError, KeyError, TypeError) as error:
        raise LocalStackDevelopmentError(
            "Docker context did not expose one engine endpoint"
        ) from error
    if not isinstance(endpoint, str):
        raise LocalStackDevelopmentError("Docker engine endpoint is not a string")
    parsed = urllib.parse.urlsplit(endpoint)
    if parsed.scheme != "unix" or parsed.netloc or not parsed.path.startswith("/"):
        raise LocalStackDevelopmentError(
            "persistent LocalStack development requires a local Unix-socket Docker engine"
        )
    try:
        socket_mode = os.stat(parsed.path).st_mode
    except OSError as error:
        raise LocalStackDevelopmentError(
            "the selected local Docker socket is unavailable"
        ) from error
    if not stat.S_ISSOCK(socket_mode):
        raise LocalStackDevelopmentError("the selected Docker endpoint is not a Unix socket")
    return endpoint


def local_compose_plugin(environment: Mapping[str, str]) -> Path:
    candidate = shutil.which("docker-compose", path=environment.get("PATH"))
    if not candidate:
        raise LocalStackDevelopmentError(
            "docker-compose must be installed on PATH so the wrapper can isolate the Compose plugin"
        )
    try:
        resolved = Path(candidate).resolve(strict=True)
        metadata = resolved.stat()
    except OSError as error:
        raise LocalStackDevelopmentError(
            "the docker-compose executable on PATH could not be resolved"
        ) from error
    if (
        not stat.S_ISREG(metadata.st_mode)
        or not os.access(resolved, os.X_OK)
        or (metadata.st_mode & stat.S_IWOTH) != 0
    ):
        raise LocalStackDevelopmentError(
            "the docker-compose executable on PATH must be executable, regular, and not world-writable"
        )
    return resolved


class DockerSession:
    def __init__(self, inherited_environment: Mapping[str, str]):
        docker = shutil.which("docker")
        if not docker:
            raise LocalStackDevelopmentError("docker is required")
        self.base_environment = sanitized_environment(inherited_environment)
        endpoint = local_docker_endpoint(docker, self.base_environment)
        compose_plugin = local_compose_plugin(self.base_environment)
        self.environment = {
            key: value
            for key, value in self.base_environment.items()
            if not key.startswith("DOCKER_")
        }
        self._temporary_directory = tempfile.TemporaryDirectory(
            prefix="nutrition-localstack-dev-docker-"
        )
        try:
            configuration_directory = Path(self._temporary_directory.name)
            configuration_directory.chmod(0o700)
            configuration_file = configuration_directory / "config.json"
            configuration_file.write_text('{"auths":{}}\n', encoding="utf-8")
            configuration_file.chmod(0o600)
            plugin_directory = configuration_directory / "cli-plugins"
            plugin_directory.mkdir(mode=0o700)
            (plugin_directory / "docker-compose").symlink_to(compose_plugin)
            compose_environment_file = configuration_directory / "empty-compose.env"
            compose_environment_file.write_text("", encoding="utf-8")
            compose_environment_file.chmod(0o600)
            self.prefix = [
                docker,
                "--config",
                str(configuration_directory),
                "--host",
                endpoint,
            ]
            compose_prefix = [*self.prefix, "compose"]
            compose_probe = command(
                [*compose_prefix, "version"],
                description="isolated Docker Compose availability check",
                environment=self.environment,
                timeout_seconds=30,
                check=False,
            )
            if compose_probe.returncode != 0:
                raise LocalStackDevelopmentError(
                    "the isolated Docker Compose plugin is unavailable; repair or install docker-compose first"
                )
            self.compose_prefix = [
                *compose_prefix,
                "--env-file",
                str(compose_environment_file),
                "--file",
                str(COMPOSE_FILE),
                "--project-name",
                PROJECT_NAME,
            ]
        except BaseException:
            self._temporary_directory.cleanup()
            raise

    def close(self) -> None:
        self._temporary_directory.cleanup()

    def docker(
        self,
        arguments: Sequence[str],
        description: str,
        *,
        environment: Mapping[str, str] | None = None,
        timeout_seconds: int = 60,
        sensitive_output: bool = False,
        check: bool = True,
    ) -> subprocess.CompletedProcess[str]:
        return command(
            [*self.prefix, *arguments],
            description=description,
            environment=environment if environment is not None else self.environment,
            timeout_seconds=timeout_seconds,
            sensitive_output=sensitive_output,
            check=check,
        )

    def compose(
        self,
        arguments: Sequence[str],
        description: str,
        *,
        environment: Mapping[str, str] | None = None,
        timeout_seconds: int = 60,
        sensitive_output: bool = False,
        check: bool = True,
    ) -> subprocess.CompletedProcess[str]:
        return command(
            [*self.compose_prefix, *arguments],
            description=description,
            environment=environment if environment is not None else self.environment,
            timeout_seconds=timeout_seconds,
            sensitive_output=sensitive_output,
            check=check,
        )

    def __enter__(self) -> "DockerSession":
        return self

    def __exit__(self, _type: object, _value: object, _traceback: object) -> None:
        self.close()


def compose_environment(
    session: DockerSession, port: int, token: str | None = None
) -> dict[str, str]:
    environment = dict(session.environment)
    environment["LOCALSTACK_GATEWAY_PORT"] = str(port)
    environment["LOCALSTACK_PROFILE_NAMESPACE"] = CHECKOUT_NAMESPACE
    if token is not None:
        environment["LOCALSTACK_AUTH_TOKEN"] = token
    return environment


def profile_container_ids(session: DockerSession) -> tuple[str, ...]:
    result = session.docker(
        [
            "ps",
            "--all",
            "--quiet",
            "--no-trunc",
            "--filter",
            f"label=com.docker.compose.project={PROJECT_NAME}",
            "--filter",
            "label=com.docker.compose.service=localstack",
        ],
        "LocalStack development container lookup",
        timeout_seconds=30,
    )
    candidates = tuple(line.strip() for line in result.stdout.splitlines() if line.strip())
    if len(candidates) != len(set(candidates)) or any(
        re.fullmatch(r"[0-9a-f]{64}", candidate) is None for candidate in candidates
    ):
        raise LocalStackDevelopmentError(
            "Docker returned an unexpected LocalStack container reference"
        )
    for candidate in candidates:
        labels_result = session.docker(
            [
                "inspect",
                "--format",
                "{{json .Config.Labels}}",
                candidate,
            ],
            "LocalStack development container label inspection",
            timeout_seconds=30,
        )
        labels = parse_json(
            labels_result, "LocalStack development container label inspection"
        )
        expected_labels = {
            "com.docker.compose.project": PROJECT_NAME,
            "com.docker.compose.service": "localstack",
            "com.docker.compose.project.working_dir": str(COMPOSE_FILE.parent),
            "com.docker.compose.project.config_files": str(COMPOSE_FILE),
        }
        if not isinstance(labels, dict) or any(
            labels.get(key) != value for key, value in expected_labels.items()
        ):
            raise LocalStackDevelopmentError(
                "container labels do not match this checkout's dedicated LocalStack "
                "development profile"
            )
    return candidates


def container_id(session: DockerSession, _port: int) -> str | None:
    candidates = profile_container_ids(session)
    if len(candidates) > 1:
        raise LocalStackDevelopmentError(
            "the dedicated LocalStack development profile has multiple containers"
        )
    return candidates[0] if candidates else None


def container_is_running(session: DockerSession, reference: str) -> bool:
    state = session.docker(
        ["inspect", "--format", "{{.State.Running}}", reference],
        "LocalStack development container state inspection",
        timeout_seconds=30,
    ).stdout.strip()
    if state not in {"true", "false"}:
        raise LocalStackDevelopmentError("Docker returned an invalid running state")
    return state == "true"


def require_free_loopback_port(port: int) -> None:
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        probe.bind(("127.0.0.1", port))
    except OSError as error:
        raise LocalStackDevelopmentError(f"127.0.0.1:{port} is already in use") from error
    finally:
        probe.close()


def wait_for_health(endpoint: str, timeout_seconds: int = 120) -> dict[str, Any]:
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    deadline = time.monotonic() + timeout_seconds
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            request = urllib.request.Request(f"{endpoint}/_localstack/health", method="GET")
            with opener.open(request, timeout=2) as response:
                if response.status != 200:
                    raise LocalStackDevelopmentError(
                        "LocalStack health endpoint did not return HTTP 200"
                    )
                health = json.load(response)
            states = health.get("services", {})
            if all(states.get(service) in {"available", "running"} for service in SERVICES):
                return health
        except (
            OSError,
            urllib.error.URLError,
            json.JSONDecodeError,
            LocalStackDevelopmentError,
        ) as error:
            last_error = error
        time.sleep(0.5)
    raise LocalStackDevelopmentError(
        f"LocalStack did not become ready within {timeout_seconds} seconds"
    ) from last_error


class AwsLocal:
    def __init__(self, session: DockerSession, reference: str):
        self.session = session
        self.reference = reference

    def command(
        self,
        arguments: Sequence[str],
        description: str,
        *,
        credentials: Credentials | None = None,
        sensitive_output: bool = False,
        check: bool = True,
    ) -> subprocess.CompletedProcess[str]:
        environment = dict(self.session.environment)
        exec_environment: list[str] = []
        if credentials is not None:
            environment.update(
                {
                    "AWS_ACCESS_KEY_ID": credentials.access_key_id,
                    "AWS_SECRET_ACCESS_KEY": credentials.secret_access_key,
                    "AWS_DEFAULT_REGION": REGION,
                }
            )
            exec_environment = [
                "--env",
                "AWS_ACCESS_KEY_ID",
                "--env",
                "AWS_SECRET_ACCESS_KEY",
                "--env",
                "AWS_DEFAULT_REGION",
            ]
        return self.session.docker(
            [
                "exec",
                *exec_environment,
                self.reference,
                "awslocal",
                "--region",
                REGION,
                "--output",
                "json",
                *arguments,
            ],
            description,
            environment=environment,
            timeout_seconds=30,
            sensitive_output=sensitive_output,
            check=check,
        )

    def json(
        self,
        arguments: Sequence[str],
        description: str,
        *,
        credentials: Credentials | None = None,
        sensitive_output: bool = False,
    ) -> Any:
        return parse_json(
            self.command(
                arguments,
                description,
                credentials=credentials,
                sensitive_output=sensitive_output,
            ),
            description,
        )

    def require_access_denied(
        self, credentials: Credentials, arguments: Sequence[str], description: str
    ) -> None:
        result = self.command(
            arguments,
            description,
            credentials=credentials,
            check=False,
        )
        combined = f"{result.stderr}\n{result.stdout}"
        if result.returncode == 0 or not re.search(r"AccessDenied", combined, re.IGNORECASE):
            raise LocalStackDevelopmentError(
                f"{description} did not fail specifically with AccessDenied"
            )


def ensure_private_state_directory() -> None:
    if LOCAL_DATA_DIRECTORY.exists() or LOCAL_DATA_DIRECTORY.is_symlink():
        metadata = LOCAL_DATA_DIRECTORY.lstat()
        if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
            raise LocalStackDevelopmentError(".local-data is not a real directory")
    else:
        LOCAL_DATA_DIRECTORY.mkdir(mode=0o700)
    if PROFILE_STATE_DIRECTORY.exists() or PROFILE_STATE_DIRECTORY.is_symlink():
        metadata = PROFILE_STATE_DIRECTORY.lstat()
        if (
            not stat.S_ISDIR(metadata.st_mode)
            or stat.S_ISLNK(metadata.st_mode)
            or metadata.st_uid != os.getuid()
            or (stat.S_IMODE(metadata.st_mode) & 0o077) != 0
        ):
            raise LocalStackDevelopmentError(
                "generated LocalStack state directory must be owned, real, and mode 0700"
            )
    else:
        PROFILE_STATE_DIRECTORY.mkdir(mode=0o700)
        PROFILE_STATE_DIRECTORY.chmod(0o700)


def assert_existing_private_state_directory() -> None:
    if not LOCAL_DATA_DIRECTORY.exists() or LOCAL_DATA_DIRECTORY.is_symlink():
        raise LocalStackDevelopmentError(".local-data is missing or not a real directory")
    local_metadata = LOCAL_DATA_DIRECTORY.lstat()
    if not stat.S_ISDIR(local_metadata.st_mode):
        raise LocalStackDevelopmentError(".local-data is not a real directory")
    if not PROFILE_STATE_DIRECTORY.exists() or PROFILE_STATE_DIRECTORY.is_symlink():
        raise LocalStackDevelopmentError(
            "generated LocalStack state directory is missing or unsafe"
        )
    metadata = PROFILE_STATE_DIRECTORY.lstat()
    if (
        not stat.S_ISDIR(metadata.st_mode)
        or metadata.st_uid != os.getuid()
        or stat.S_IMODE(metadata.st_mode) != 0o700
    ):
        raise LocalStackDevelopmentError(
            "generated LocalStack state directory must be owned, real, and mode 0700"
        )


def assert_private_generated_file(path: Path) -> None:
    metadata = path.lstat()
    if (
        not stat.S_ISREG(metadata.st_mode)
        or stat.S_ISLNK(metadata.st_mode)
        or metadata.st_uid != os.getuid()
        or stat.S_IMODE(metadata.st_mode) != 0o600
    ):
        raise LocalStackDevelopmentError(
            f"generated file {path.name} must be an owned regular mode-0600 file"
        )


def parse_environment_file(path: Path, expected_keys: set[str]) -> dict[str, str]:
    assert_private_generated_file(path)
    values: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            raise LocalStackDevelopmentError(f"generated file {path.name} is malformed")
        key, value = line.split("=", 1)
        if not re.fullmatch(r"[A-Z][A-Z0-9_]*", key) or key in values:
            raise LocalStackDevelopmentError(f"generated file {path.name} is malformed")
        if any(ord(character) < 0x20 or ord(character) == 0x7F for character in value):
            raise LocalStackDevelopmentError(f"generated file {path.name} is malformed")
        values[key] = value
    if set(values) != expected_keys:
        raise LocalStackDevelopmentError(
            f"generated file {path.name} has missing or unexpected variables"
        )
    return values


def atomic_write_environment(path: Path, values: Mapping[str, str]) -> None:
    ensure_private_state_directory()
    if path.exists() or path.is_symlink():
        assert_private_generated_file(path)
    rendered = "# Generated by infra/localstack/dev-profile.py; synthetic local use only.\n"
    rendered += "\n".join(f"{key}={values[key]}" for key in sorted(values))
    rendered += "\n"
    descriptor, temporary_name = tempfile.mkstemp(
        dir=PROFILE_STATE_DIRECTORY,
        prefix=f".{path.name}.",
        text=True,
    )
    temporary_path = Path(temporary_name)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(rendered)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary_path, path)
        assert_private_generated_file(path)
    finally:
        try:
            temporary_path.unlink()
        except FileNotFoundError:
            pass


def validate_credentials(credentials: Credentials, role: Role) -> None:
    if not re.fullmatch(r"LKIA[A-Z0-9]{8,124}", credentials.access_key_id):
        raise LocalStackDevelopmentError(
            f"{role.user_name} does not have a LocalStack-scoped access key"
        )
    if (
        not credentials.secret_access_key
        or len(credentials.secret_access_key) > 2_048
        or any(
            ord(character) < 0x21 or ord(character) == 0x7F
            for character in credentials.secret_access_key
        )
    ):
        raise LocalStackDevelopmentError(
            f"{role.user_name} has invalid generated secret-key material"
        )


def runtime_environment(
    credentials_by_user: Mapping[str, Credentials], endpoint: str
) -> dict[str, str]:
    values = {
        "RETENTION_FEATURES_ENABLED": "true",
        "EXPORT_ARTIFACT_STORE": "s3",
        "EXPORT_ARTIFACT_DELETE_VERSION_POLICY": "suspended_null",
        "EXPORT_ARTIFACT_ENDPOINT": endpoint,
        "EXPORT_ARTIFACT_REGION": REGION,
        "EXPORT_ARTIFACT_BUCKET": EXPORT_BUCKET,
        "ERASURE_REPLAY_LEDGER_STORE": "s3",
        "ERASURE_REPLAY_LEDGER_ENDPOINT": endpoint,
        "ERASURE_REPLAY_LEDGER_REGION": REGION,
        "ERASURE_REPLAY_LEDGER_BUCKET": LEDGER_BUCKET,
    }
    for role in ROLES:
        if role.environment_file != "runtime":
            continue
        credentials = credentials_by_user[role.user_name]
        values[role.access_key_variable] = credentials.access_key_id
        values[role.secret_key_variable] = credentials.secret_access_key
    return values


def restore_environment(
    credentials_by_user: Mapping[str, Credentials], endpoint: str
) -> dict[str, str]:
    role = next(candidate for candidate in ROLES if candidate.environment_file == "restore")
    credentials = credentials_by_user[role.user_name]
    return {
        "ERASURE_REPLAY_LEDGER_STORE": "s3",
        "ERASURE_REPLAY_LEDGER_ENDPOINT": endpoint,
        "ERASURE_REPLAY_LEDGER_REGION": REGION,
        "ERASURE_REPLAY_LEDGER_BUCKET": LEDGER_BUCKET,
        "ERASURE_REPLAY_LEDGER_RESTORE_VERSION_LIST_PROVIDER": "s3_compatible",
        role.access_key_variable: credentials.access_key_id,
        role.secret_key_variable: credentials.secret_access_key,
    }


def load_generated_credentials(
    endpoint: str, *, require_endpoint_match: bool = False
) -> dict[str, Credentials]:
    expected_runtime = runtime_environment(
        {
            role.user_name: Credentials("LKIA00000000", "placeholder")
            for role in ROLES
        },
        endpoint,
    )
    expected_restore = restore_environment(
        {
            role.user_name: Credentials("LKIA00000000", "placeholder")
            for role in ROLES
        },
        endpoint,
    )
    runtime = parse_environment_file(RUNTIME_ENVIRONMENT_FILE, set(expected_runtime))
    restore = parse_environment_file(RESTORE_ENVIRONMENT_FILE, set(expected_restore))
    configured_endpoints = {
        runtime["EXPORT_ARTIFACT_ENDPOINT"],
        runtime["ERASURE_REPLAY_LEDGER_ENDPOINT"],
        restore["ERASURE_REPLAY_LEDGER_ENDPOINT"],
    }
    if len(configured_endpoints) != 1:
        raise LocalStackDevelopmentError(
            "generated files contain inconsistent LocalStack endpoints"
        )
    configured_endpoint = next(iter(configured_endpoints))
    endpoint_match = re.fullmatch(
        r"http://127\.0\.0\.1:([0-9]{4,5})", configured_endpoint
    )
    if endpoint_match is None or not 1_024 <= int(endpoint_match.group(1)) <= 65_535:
        raise LocalStackDevelopmentError(
            "generated files contain a non-loopback or invalid LocalStack endpoint"
        )
    if require_endpoint_match and configured_endpoint != endpoint:
        raise LocalStackDevelopmentError(
            "generated files do not match the running LocalStack endpoint"
        )
    for values, name in ((runtime, "runtime.env"), (restore, "restore.env")):
        if values["ERASURE_REPLAY_LEDGER_ENDPOINT"] != configured_endpoint:
            raise LocalStackDevelopmentError(
                f"generated file {name} contains a non-loopback LocalStack endpoint"
            )
    fixed_runtime = {
        key: value
        for key, value in expected_runtime.items()
        if not key.endswith("ACCESS_KEY_ID") and not key.endswith("SECRET_ACCESS_KEY")
    }
    fixed_restore = {
        key: value
        for key, value in expected_restore.items()
        if not key.endswith("ACCESS_KEY_ID") and not key.endswith("SECRET_ACCESS_KEY")
    }
    for values, fixed, name in (
        (runtime, fixed_runtime, "runtime.env"),
        (restore, fixed_restore, "restore.env"),
    ):
        for key, expected in fixed.items():
            if key.endswith("_ENDPOINT"):
                continue
            if values[key] != expected:
                raise LocalStackDevelopmentError(
                    f"generated file {name} has drifted LocalStack coordinates"
                )
    credentials_by_user: dict[str, Credentials] = {}
    for role in ROLES:
        values = runtime if role.environment_file == "runtime" else restore
        credentials = Credentials(
            values[role.access_key_variable], values[role.secret_key_variable]
        )
        validate_credentials(credentials, role)
        credentials_by_user[role.user_name] = credentials
    return credentials_by_user


def list_names(response: Any, collection: str, field: str, description: str) -> set[str]:
    if not isinstance(response, dict) or not isinstance(response.get(collection), list):
        raise LocalStackDevelopmentError(f"{description} returned an unexpected shape")
    names: set[str] = set()
    for item in response[collection]:
        if not isinstance(item, dict) or not isinstance(item.get(field), str):
            raise LocalStackDevelopmentError(f"{description} returned an unexpected shape")
        names.add(item[field])
    return names


def configure_bucket_topology(aws: AwsLocal, create_buckets: bool) -> None:
    if create_buckets:
        for bucket in (EXPORT_BUCKET, LEDGER_BUCKET):
            aws.command(["s3api", "create-bucket", "--bucket", bucket], f"create {bucket}")
    for bucket in (EXPORT_BUCKET, LEDGER_BUCKET):
        aws.command(
            [
                "s3api",
                "put-public-access-block",
                "--bucket",
                bucket,
                "--public-access-block-configuration",
                "BlockPublicAcls=true,IgnorePublicAcls=true,"
                "BlockPublicPolicy=true,RestrictPublicBuckets=true",
            ],
            f"protect {bucket}",
        )
    aws.command(
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
    aws.command(
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
    aws.command(
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
    lifecycle = json.loads(EXPORT_LIFECYCLE_FILE.read_text(encoding="utf-8"))
    aws.command(
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


def verify_version_inventory(
    response: Any, *, bucket: str, prefixes: tuple[str, ...], null_versions: bool
) -> None:
    if not isinstance(response, dict) or response.get("IsTruncated") is True:
        raise LocalStackDevelopmentError(f"{bucket} version inventory is incomplete")
    versions = response.get("Versions", [])
    delete_markers = response.get("DeleteMarkers", [])
    if not isinstance(versions, list) or not isinstance(delete_markers, list) or delete_markers:
        raise LocalStackDevelopmentError(f"{bucket} has an invalid version history")
    keys: set[str] = set()
    for version in versions:
        if not isinstance(version, dict):
            raise LocalStackDevelopmentError(f"{bucket} has an invalid version history")
        key = version.get("Key")
        version_id = version.get("VersionId")
        if (
            not isinstance(key, str)
            or not key.startswith(prefixes)
            or key in keys
            or version.get("IsLatest") is not True
            or (null_versions and version_id != "null")
            or (not null_versions and version_id in {None, "", "null"})
        ):
            raise LocalStackDevelopmentError(f"{bucket} has an invalid version history")
        keys.add(key)


def verify_bucket_topology(aws: AwsLocal) -> None:
    for bucket in (EXPORT_BUCKET, LEDGER_BUCKET):
        public_block = aws.json(
            ["s3api", "get-public-access-block", "--bucket", bucket],
            f"verify {bucket} public-access block",
        ).get("PublicAccessBlockConfiguration")
        if public_block != PUBLIC_ACCESS_BLOCK:
            raise LocalStackDevelopmentError(f"{bucket} public-access block has drifted")
        bucket_policy = aws.command(
            ["s3api", "get-bucket-policy", "--bucket", bucket],
            f"verify {bucket} bucket-policy absence",
            check=False,
        )
        if bucket_policy.returncode == 0 or not re.search(
            r"NoSuchBucketPolicy",
            f"{bucket_policy.stderr}\n{bucket_policy.stdout}",
            re.IGNORECASE,
        ):
            raise LocalStackDevelopmentError(f"{bucket} unexpectedly has a bucket policy")
    export_versioning = aws.json(
        ["s3api", "get-bucket-versioning", "--bucket", EXPORT_BUCKET],
        "verify export versioning",
    )
    ledger_versioning = aws.json(
        ["s3api", "get-bucket-versioning", "--bucket", LEDGER_BUCKET],
        "verify ledger versioning",
    )
    if export_versioning.get("Status") != "Suspended":
        raise LocalStackDevelopmentError("export bucket versioning is not suspended")
    if ledger_versioning.get("Status") != "Enabled":
        raise LocalStackDevelopmentError("ledger bucket versioning is not enabled")
    expected_lifecycle = json.loads(EXPORT_LIFECYCLE_FILE.read_text(encoding="utf-8"))
    actual_lifecycle = aws.json(
        ["s3api", "get-bucket-lifecycle-configuration", "--bucket", EXPORT_BUCKET],
        "verify export lifecycle",
    )
    if actual_lifecycle.get("Rules") != expected_lifecycle.get("Rules"):
        raise LocalStackDevelopmentError("export lifecycle configuration has drifted")
    ledger_lifecycle = aws.command(
        ["s3api", "get-bucket-lifecycle-configuration", "--bucket", LEDGER_BUCKET],
        "verify ledger lifecycle absence",
        check=False,
    )
    if ledger_lifecycle.returncode == 0 or not re.search(
        r"NoSuchLifecycleConfiguration",
        f"{ledger_lifecycle.stderr}\n{ledger_lifecycle.stdout}",
        re.IGNORECASE,
    ):
        raise LocalStackDevelopmentError("ledger bucket unexpectedly has a lifecycle rule")
    verify_version_inventory(
        aws.json(
            ["s3api", "list-object-versions", "--bucket", EXPORT_BUCKET],
            "audit export version inventory",
        ),
        bucket=EXPORT_BUCKET,
        prefixes=("exports/v1/", "integration/"),
        null_versions=True,
    )
    verify_version_inventory(
        aws.json(
            ["s3api", "list-object-versions", "--bucket", LEDGER_BUCKET],
            "audit ledger version inventory",
        ),
        bucket=LEDGER_BUCKET,
        prefixes=("erasure-ledger/v1/",),
        null_versions=False,
    )


def credentials_from_access_key_result(response: Any, role: Role) -> Credentials:
    try:
        access_key = response["AccessKey"]
        credentials = Credentials(
            access_key["AccessKeyId"], access_key["SecretAccessKey"]
        )
    except (KeyError, TypeError) as error:
        raise LocalStackDevelopmentError(
            f"access-key creation for {role.user_name} returned an unexpected shape"
        ) from error
    validate_credentials(credentials, role)
    return credentials


def remove_created_roles(
    aws: AwsLocal,
    created_user_names: set[str],
    known_credentials_by_user: Mapping[str, Credentials] | None = None,
) -> None:
    def cleanup_command(
        arguments: Sequence[str],
        description: str,
        *,
        sensitive_output: bool = False,
    ) -> subprocess.CompletedProcess[str] | None:
        try:
            return aws.command(
                arguments,
                description,
                check=False,
                sensitive_output=sensitive_output,
            )
        except LocalStackDevelopmentError:
            return None

    for role in reversed(ROLES):
        if role.user_name not in created_user_names:
            continue
        cleanup_command(
            [
                "iam",
                "delete-user-policy",
                "--user-name",
                role.user_name,
                "--policy-name",
                f"{role.user_name}-inline",
            ],
            f"roll back policy for {role.user_name}",
        )
        access_key_listing = cleanup_command(
            ["iam", "list-access-keys", "--user-name", role.user_name],
            f"discover rollback access keys for {role.user_name}",
            sensitive_output=True,
        )
        access_key_id_set: set[str] = set()
        if (
            known_credentials_by_user is not None
            and role.user_name in known_credentials_by_user
        ):
            access_key_id_set.add(
                known_credentials_by_user[role.user_name].access_key_id
            )
        if access_key_listing is not None and access_key_listing.returncode == 0:
            try:
                listing = json.loads(access_key_listing.stdout)
                metadata = listing["AccessKeyMetadata"]
                if not isinstance(metadata, list) or listing.get("IsTruncated") is True:
                    raise TypeError
                parsed_ids = tuple(item["AccessKeyId"] for item in metadata)
                if (
                    any(
                        not isinstance(key_id, str)
                        or re.fullmatch(r"LKIA[A-Z0-9]{8,124}", key_id) is None
                        for key_id in parsed_ids
                    )
                    or len(parsed_ids) != len(set(parsed_ids))
                ):
                    raise TypeError
                access_key_id_set.update(parsed_ids)
            except (json.JSONDecodeError, KeyError, TypeError):
                pass
        for access_key_id in sorted(access_key_id_set):
            cleanup_command(
                [
                    "iam",
                    "delete-access-key",
                    "--user-name",
                    role.user_name,
                    "--access-key-id",
                    access_key_id,
                ],
                f"roll back access key for {role.user_name}",
                sensitive_output=True,
            )
        cleanup_command(
            ["iam", "delete-user", "--user-name", role.user_name],
            f"roll back IAM user {role.user_name}",
        )
    unproven_absence: list[str] = []
    for user_name in sorted(created_user_names):
        verification = cleanup_command(
            ["iam", "get-user", "--user-name", user_name],
            f"verify rollback removal for {user_name}",
        )
        if verification is None:
            unproven_absence.append(user_name)
            continue
        output = f"{verification.stderr}\n{verification.stdout}"
        if verification.returncode == 0 or not re.search(
            r"NoSuchEntity", output, re.IGNORECASE
        ):
            unproven_absence.append(user_name)
    if unproven_absence:
        raise LocalStackDevelopmentError(
            "IAM rollback left one or more dedicated development users behind"
        )


def create_roles(aws: AwsLocal) -> dict[str, Credentials]:
    created: dict[str, Credentials] = {}
    created_users: set[str] = set()
    try:
        for role in ROLES:
            policy = json.loads(role.policy_path.read_text(encoding="utf-8"))
            aws.command(
                ["iam", "create-user", "--user-name", role.user_name],
                f"create IAM user {role.user_name}",
            )
            created_users.add(role.user_name)
            response = aws.json(
                ["iam", "create-access-key", "--user-name", role.user_name],
                f"create access key for {role.user_name}",
                sensitive_output=True,
            )
            credentials = credentials_from_access_key_result(response, role)
            created[role.user_name] = credentials
            identity = aws.json(
                ["sts", "get-caller-identity"],
                f"verify identity for {role.user_name}",
                credentials=credentials,
            )
            if identity.get("Arn") != f"arn:aws:iam::000000000000:user/{role.user_name}":
                raise LocalStackDevelopmentError(
                    f"{role.user_name} credentials resolved to the wrong principal"
                )
            aws.require_access_denied(
                credentials,
                ["s3api", "list-buckets"],
                f"pre-policy denial for {role.user_name}",
            )
            aws.command(
                [
                    "iam",
                    "put-user-policy",
                    "--user-name",
                    role.user_name,
                    "--policy-name",
                    f"{role.user_name}-inline",
                    "--policy-document",
                    json.dumps(policy, separators=(",", ":"), sort_keys=True),
                ],
                f"attach policy for {role.user_name}",
            )
        return created
    except BaseException as error:
        try:
            remove_created_roles(aws, created_users, created)
        except LocalStackDevelopmentError as cleanup_error:
            raise LocalStackDevelopmentError(
                f"IAM role creation failed ({render_start_failure(error)}); "
                f"rollback also failed: {cleanup_error}"
            ) from error
        raise


def verify_roles(aws: AwsLocal, credentials_by_user: Mapping[str, Credentials]) -> None:
    for role in ROLES:
        credentials = credentials_by_user[role.user_name]
        validate_credentials(credentials, role)
        access_keys = aws.json(
            ["iam", "list-access-keys", "--user-name", role.user_name],
            f"list access keys for {role.user_name}",
            sensitive_output=True,
        ).get("AccessKeyMetadata")
        if (
            not isinstance(access_keys, list)
            or len(access_keys) != 1
            or access_keys[0].get("AccessKeyId") != credentials.access_key_id
            or access_keys[0].get("Status") != "Active"
        ):
            raise LocalStackDevelopmentError(
                f"{role.user_name} must have exactly one matching active access key"
            )
        policy_names = aws.json(
            ["iam", "list-user-policies", "--user-name", role.user_name],
            f"list inline policies for {role.user_name}",
        ).get("PolicyNames")
        expected_policy_name = f"{role.user_name}-inline"
        if policy_names != [expected_policy_name]:
            raise LocalStackDevelopmentError(
                f"{role.user_name} inline policy set has drifted"
            )
        attached = aws.json(
            ["iam", "list-attached-user-policies", "--user-name", role.user_name],
            f"list attached policies for {role.user_name}",
        ).get("AttachedPolicies")
        if attached != []:
            raise LocalStackDevelopmentError(
                f"{role.user_name} unexpectedly has an attached managed policy"
            )
        groups = aws.json(
            ["iam", "list-groups-for-user", "--user-name", role.user_name],
            f"list groups for {role.user_name}",
        ).get("Groups")
        if groups != []:
            raise LocalStackDevelopmentError(
                f"{role.user_name} unexpectedly belongs to an IAM group"
            )
        round_trip = aws.json(
            [
                "iam",
                "get-user-policy",
                "--user-name",
                role.user_name,
                "--policy-name",
                expected_policy_name,
            ],
            f"verify policy for {role.user_name}",
        ).get("PolicyDocument")
        if isinstance(round_trip, str):
            round_trip = json.loads(urllib.parse.unquote(round_trip))
        expected_policy = json.loads(role.policy_path.read_text(encoding="utf-8"))
        if round_trip != expected_policy:
            raise LocalStackDevelopmentError(f"{role.user_name} policy has drifted")
        identity = aws.json(
            ["sts", "get-caller-identity"],
            f"verify identity for {role.user_name}",
            credentials=credentials,
        )
        if identity.get("Arn") != f"arn:aws:iam::000000000000:user/{role.user_name}":
            raise LocalStackDevelopmentError(
                f"{role.user_name} credentials resolved to the wrong principal"
            )
        aws.require_access_denied(
            credentials,
            ["s3api", "list-buckets"],
            f"bucket-list denial for {role.user_name}",
        )
        if role.user_name == "nutrition-erasure-restore":
            compatibility_listing = aws.json(
                [
                    "s3api",
                    "list-object-versions",
                    "--bucket",
                    LEDGER_BUCKET,
                    "--prefix",
                    "integration/localstack-condition-compatibility-probe",
                ],
                "LocalStack restore version-list compatibility check",
                credentials=credentials,
            )
            if (
                compatibility_listing.get("IsTruncated") is True
                or compatibility_listing.get("Versions", []) != []
                or compatibility_listing.get("DeleteMarkers", []) != []
            ):
                raise LocalStackDevelopmentError(
                    "LocalStack restore version-list compatibility probe was not empty"
                )


def inspect_profile_inventory(aws: AwsLocal) -> tuple[set[str], set[str]]:
    identity = aws.json(["sts", "get-caller-identity"], "LocalStack root identity check")
    if (
        identity.get("Account") != "000000000000"
        or identity.get("Arn") != "arn:aws:iam::000000000000:root"
    ):
        raise LocalStackDevelopmentError(
            "LocalStack root identity did not match the isolated development account"
        )
    bucket_names = list_names(
        aws.json(["s3api", "list-buckets"], "list LocalStack buckets"),
        "Buckets",
        "Name",
        "bucket listing",
    )
    user_names = list_names(
        aws.json(["iam", "list-users"], "list LocalStack IAM users"),
        "Users",
        "UserName",
        "IAM user listing",
    )
    return bucket_names, user_names


def verify_existing_profile(
    session: DockerSession, reference: str, endpoint: str
) -> dict[str, Credentials]:
    assert_existing_private_state_directory()
    profile_environment = parse_environment_file(
        PROFILE_ENVIRONMENT_FILE, {"LOCALSTACK_GATEWAY_PORT"}
    )
    if endpoint != f"http://127.0.0.1:{gateway_port(profile_environment)}":
        raise LocalStackDevelopmentError(
            "retained profile port does not match the running LocalStack endpoint"
        )
    aws = AwsLocal(session, reference)
    bucket_names, user_names = inspect_profile_inventory(aws)
    if bucket_names != {EXPORT_BUCKET, LEDGER_BUCKET} or user_names != {
        role.user_name for role in ROLES
    }:
        raise LocalStackDevelopmentError(
            "persistent LocalStack buckets or users are incomplete or unexpected"
        )
    credentials_by_user = load_generated_credentials(
        endpoint, require_endpoint_match=True
    )
    verify_bucket_topology(aws)
    verify_roles(aws, credentials_by_user)
    return credentials_by_user


def provision_or_verify(
    session: DockerSession, reference: str, endpoint: str
) -> dict[str, Credentials]:
    ensure_private_state_directory()
    aws = AwsLocal(session, reference)
    bucket_names, user_names = inspect_profile_inventory(aws)
    expected_buckets = {EXPORT_BUCKET, LEDGER_BUCKET}
    expected_users = {role.user_name for role in ROLES}
    generated_files_exist = (
        RUNTIME_ENVIRONMENT_FILE.exists() or RUNTIME_ENVIRONMENT_FILE.is_symlink(),
        RESTORE_ENVIRONMENT_FILE.exists() or RESTORE_ENVIRONMENT_FILE.is_symlink(),
    )
    if bucket_names == set() and user_names == set() and generated_files_exist == (False, False):
        configure_bucket_topology(aws, create_buckets=True)
    elif (
        bucket_names == expected_buckets
        and user_names == set()
        and generated_files_exist == (False, False)
    ):
        empty_export = aws.json(
            ["s3api", "list-object-versions", "--bucket", EXPORT_BUCKET],
            "verify empty interrupted export bucket",
        )
        empty_ledger = aws.json(
            ["s3api", "list-object-versions", "--bucket", LEDGER_BUCKET],
            "verify empty interrupted ledger bucket",
        )
        if empty_export.get("Versions") or empty_export.get("DeleteMarkers"):
            raise LocalStackDevelopmentError(
                "credential-free export bucket contains unexpected objects"
            )
        if empty_ledger.get("Versions") or empty_ledger.get("DeleteMarkers"):
            raise LocalStackDevelopmentError(
                "credential-free ledger bucket contains unexpected objects"
            )
        configure_bucket_topology(aws, create_buckets=False)
    elif not (
        bucket_names == expected_buckets
        and user_names == expected_users
        and generated_files_exist == (True, True)
    ):
        raise LocalStackDevelopmentError(
            "persistent LocalStack buckets, users, or generated credential files are incomplete or unexpected"
        )

    if user_names == set():
        credentials_by_user = create_roles(aws)
        try:
            atomic_write_environment(
                RUNTIME_ENVIRONMENT_FILE,
                runtime_environment(credentials_by_user, endpoint),
            )
            atomic_write_environment(
                RESTORE_ENVIRONMENT_FILE,
                restore_environment(credentials_by_user, endpoint),
            )
        except BaseException as error:
            for generated_file in (RUNTIME_ENVIRONMENT_FILE, RESTORE_ENVIRONMENT_FILE):
                try:
                    assert_private_generated_file(generated_file)
                    generated_file.unlink()
                except (FileNotFoundError, LocalStackDevelopmentError):
                    pass
            try:
                remove_created_roles(
                    aws, set(credentials_by_user), credentials_by_user
                )
            except LocalStackDevelopmentError as cleanup_error:
                raise LocalStackDevelopmentError(
                    f"generated credential write failed ({render_start_failure(error)}); "
                    f"IAM rollback also failed: {cleanup_error}"
                ) from error
            raise
    else:
        credentials_by_user = load_generated_credentials(
            endpoint, require_endpoint_match=True
        )
    verify_bucket_topology(aws)
    verify_roles(aws, credentials_by_user)
    if user_names != set():
        atomic_write_environment(
            RUNTIME_ENVIRONMENT_FILE,
            runtime_environment(credentials_by_user, endpoint),
        )
        atomic_write_environment(
            RESTORE_ENVIRONMENT_FILE,
            restore_environment(credentials_by_user, endpoint),
        )
    return credentials_by_user


def running_profile(
    session: DockerSession, port: int
) -> tuple[str, str]:
    reference = container_id(session, port)
    if reference is None or not container_is_running(session, reference):
        raise LocalStackDevelopmentError(
            "persistent LocalStack is not running; run pnpm infra:localstack:up first"
        )
    endpoint = f"http://127.0.0.1:{port}"
    wait_for_health(endpoint, timeout_seconds=30)
    return reference, endpoint


def cleanup_failed_start(
    session: DockerSession, port: int, *, ambiguous_launch: bool
) -> str | None:
    reconcile_until = time.monotonic() + (
        START_FAILURE_RECONCILIATION_SECONDS if ambiguous_launch else 0
    )
    last_problem = "cleanup did not run"
    while True:
        try:
            candidates = profile_container_ids(session)
            if len(candidates) > 1:
                raise LocalStackDevelopmentError(
                    "the dedicated LocalStack development profile has multiple containers"
                )
            if candidates:
                reference = candidates[0]
                session.docker(
                    ["rm", "--force", reference],
                    "failed LocalStack development start cleanup",
                    timeout_seconds=30,
                    sensitive_output=True,
                    check=False,
                )
                remaining = profile_container_ids(session)
            else:
                remaining = ()
        except LocalStackDevelopmentError as error:
            remaining = ()
            last_problem = str(error)
            inspection_failed = True
        else:
            inspection_failed = False
            if remaining:
                last_problem = (
                    "exact checkout-label inspection still found "
                    f"{len(remaining)} container(s)"
                )

        if not inspection_failed and not remaining:
            if not ambiguous_launch or time.monotonic() >= reconcile_until:
                return None
        elif time.monotonic() >= reconcile_until:
            return last_problem

        time.sleep(0.5)


def render_start_failure(error: BaseException) -> str:
    if isinstance(error, LocalStackDevelopmentError):
        return str(error)
    rendered = str(error).strip()
    return f"{type(error).__name__}{f': {rendered}' if rendered else ''}"


def start_profile(
    environment: Mapping[str, str],
    cancellation_scope: TerminationSignalScope | None = None,
) -> None:
    port = effective_gateway_port(environment)
    token = developer_auth_token(environment)
    with DockerSession(environment) as session:
        compose_attempted = False
        compose_completed = False
        try:
            existing = container_id(session, port)
            if existing is None:
                require_free_loopback_port(port)
            step("pulling the exact digest-pinned LocalStack image")
            session.docker(
                ["pull", IMAGE],
                "LocalStack image pull",
                timeout_seconds=600,
            )
            launch_environment = compose_environment(session, port, token)
            step("starting the attended loopback-only persistent development service")
            compose_attempted = True
            session.compose(
                [
                    "up",
                    "--detach",
                    "--wait",
                    "--wait-timeout",
                    "120",
                    "--pull",
                    "never",
                    "localstack",
                ],
                "LocalStack development profile start",
                environment=launch_environment,
                timeout_seconds=180,
                sensitive_output=True,
            )
            compose_completed = True
            reference, endpoint = running_profile(session, port)
            step("creating or verifying private buckets and least-privilege IAM roles")
            provision_or_verify(session, reference, endpoint)
            atomic_write_environment(
                PROFILE_ENVIRONMENT_FILE,
                {"LOCALSTACK_GATEWAY_PORT": str(port)},
            )
        except BaseException as error:
            if cancellation_scope is not None:
                cancellation_scope.mask_cleanup()
            cleanup_problem = cleanup_failed_start(
                session,
                port,
                ambiguous_launch=compose_attempted and not compose_completed,
            )
            if cleanup_problem is not None:
                raise LocalStackDevelopmentError(
                    f"start failed ({render_start_failure(error)}); cleanup also failed: "
                    f"{cleanup_problem}"
                ) from error
            raise
    step(f"ready at http://127.0.0.1:{port}; generated credentials remain private and ignored")


def stop_profile(
    environment: Mapping[str, str],
    cancellation_scope: TerminationSignalScope | None = None,
) -> None:
    port = effective_gateway_port(environment)
    with DockerSession(environment) as session:
        candidates = profile_container_ids(session)
        if len(candidates) > 1:
            raise LocalStackDevelopmentError(
                "the dedicated LocalStack development profile has multiple containers"
            )
        if cancellation_scope is not None:
            cancellation_scope.mask_cleanup()
        step("removing the token-bearing container while retaining synthetic named-volume state")
        if candidates:
            session.docker(
                ["rm", "--force", candidates[0]],
                "LocalStack development profile shutdown",
                timeout_seconds=30,
                sensitive_output=True,
            )
        if container_id(session, port) is not None:
            raise LocalStackDevelopmentError(
                "shutdown could not prove the LocalStack development container was removed"
            )
    step("stopped; the dedicated synthetic state volume and generated role files were retained")


def status_profile(environment: Mapping[str, str]) -> None:
    port = effective_gateway_port(environment)
    with DockerSession(environment) as session:
        reference = container_id(session, port)
        if reference is None:
            step("absent (no LocalStack development container)")
            return
        if not container_is_running(session, reference):
            raise LocalStackDevelopmentError(
                "an exited token-bearing LocalStack development container remains; "
                "run pnpm infra:localstack:down to remove it exactly"
            )
        endpoint = f"http://127.0.0.1:{port}"
        wait_for_health(endpoint, timeout_seconds=10)
        verify_existing_profile(session, reference, endpoint)
    step(f"running and verified at http://127.0.0.1:{port}")


def process_group_exists(process_group_id: int) -> bool:
    try:
        os.killpg(process_group_id, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def wait_for_process_group_exit(
    process: subprocess.Popen[bytes], process_group_id: int, timeout_seconds: int
) -> bool:
    deadline = time.monotonic() + timeout_seconds
    while True:
        process.poll()
        if not process_group_exists(process_group_id):
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(0.1)


def stop_process_group(process: subprocess.Popen[bytes], description: str) -> None:
    process_group_id = process.pid
    try:
        os.killpg(process_group_id, signal.SIGTERM)
    except ProcessLookupError:
        pass
    if not wait_for_process_group_exit(
        process, process_group_id, PROCESS_GROUP_TERM_SECONDS
    ):
        try:
            os.killpg(process_group_id, signal.SIGKILL)
        except ProcessLookupError:
            pass

        wait_for_process_group_exit(
            process, process_group_id, PROCESS_GROUP_KILL_SECONDS
        )

    if process.poll() is None:
        try:
            process.wait(timeout=1)
        except subprocess.TimeoutExpired:
            pass

    if process_group_exists(process_group_id) or process.poll() is None:
        raise LocalStackDevelopmentError(
            f"could not stop the complete {description} process group"
        )


def run_process_group(
    arguments: Sequence[str],
    *,
    description: str,
    environment: Mapping[str, str],
    timeout_seconds: int | None,
) -> int:
    try:
        process = subprocess.Popen(
            list(arguments),
            cwd=REPOSITORY_ROOT,
            env=dict(environment),
            start_new_session=True,
        )
    except OSError as error:
        raise LocalStackDevelopmentError(f"could not start {description}") from error
    previous_handlers: dict[int, Any] = {}

    def terminate_from_signal(signum: int, _frame: object) -> None:
        raise SystemExit(128 + signum)

    for signum in (signal.SIGTERM, signal.SIGHUP):
        previous_handlers[signum] = signal.signal(signum, terminate_from_signal)
    try:
        return process.wait(timeout=timeout_seconds)
    except subprocess.TimeoutExpired as error:
        stop_process_group(process, description)
        raise LocalStackDevelopmentError(
            f"{description} timed out after {timeout_seconds} seconds"
        ) from error
    except KeyboardInterrupt:
        stop_process_group(process, description)
        return 130
    except BaseException:
        stop_process_group(process, description)
        raise
    finally:
        for signum, handler in previous_handlers.items():
            signal.signal(signum, handler)


def integration_environment(
    inherited_environment: Mapping[str, str], endpoint: str
) -> dict[str, str]:
    credentials = load_generated_credentials(endpoint, require_endpoint_match=True)
    environment = sanitized_environment(inherited_environment)
    environment.update(runtime_environment(credentials, endpoint))
    environment.update(restore_environment(credentials, endpoint))
    environment.update(
        {
            "NODE_ENV": "test",
            "RUN_ARTIFACT_STORE_INTEGRATION": "1",
            "ARTIFACT_STORE_ADMIN_ACCESS_KEY_ID": "test",
            "ARTIFACT_STORE_ADMIN_SECRET_ACCESS_KEY": "test",
            "AWS_EC2_METADATA_DISABLED": "true",
        }
    )
    return environment


def verify_profile(environment: Mapping[str, str]) -> None:
    port = effective_gateway_port(environment)
    pnpm = shutil.which("pnpm")
    if not pnpm:
        raise LocalStackDevelopmentError("pnpm is required")
    with DockerSession(environment) as session:
        reference, endpoint = running_profile(session, port)
        verify_existing_profile(session, reference, endpoint)
        test_environment = integration_environment(environment, endpoint)
        with tempfile.TemporaryDirectory(prefix="nutrition-localstack-dev-aws-") as directory:
            credentials_file = Path(directory) / "credentials"
            config_file = Path(directory) / "config"
            credentials_file.write_text("", encoding="utf-8")
            config_file.write_text("", encoding="utf-8")
            credentials_file.chmod(0o600)
            config_file.chmod(0o600)
            test_environment.update(
                {
                    "AWS_SHARED_CREDENTIALS_FILE": str(credentials_file),
                    "AWS_CONFIG_FILE": str(config_file),
                }
            )
            step("running the encrypted S3 compatibility suite against persistent state")
            result = run_process_group(
                [pnpm, "--filter", "@nutrition-tracker/artifact-store", "test:integration"],
                description="persistent LocalStack artifact-store integration suite",
                environment=test_environment,
                timeout_seconds=180,
            )
            if result != 0:
                raise LocalStackDevelopmentError(
                    "persistent LocalStack artifact-store integration suite failed"
                )
        verify_existing_profile(session, reference, endpoint)
    step("persistent LocalStack profile verification passed")


def prohibited_dotenv_variables(path: Path) -> set[str]:
    prohibited: set[str] = set()
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        candidate = re.sub(r"^[\s\ufeff]+", "", line).rstrip()
        if not candidate or candidate.startswith("#"):
            continue
        match = re.match(
            r"(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|:\s+)",
            candidate,
        )
        if match is None:
            continue
        name = match.group(1)
        uppercase_name = name.upper()
        if (
            uppercase_name.startswith("AWS_")
            or uppercase_name.startswith("LOCALSTACK_")
            or uppercase_name in {value.upper() for value in PROXY_VARIABLES}
            or uppercase_name in DEVELOPMENT_PROCESS_CONTROL_VARIABLES
        ):
            prohibited.add(name)
    return prohibited


def dotenv_declares_localstack_token(path: Path) -> bool:
    return any(
        name.upper() == "LOCALSTACK_AUTH_TOKEN"
        for name in prohibited_dotenv_variables(path)
    )


def run_development(environment: Mapping[str, str]) -> int:
    root_environment_file = REPOSITORY_ROOT / ".env"
    if not root_environment_file.is_file() or root_environment_file.is_symlink():
        raise LocalStackDevelopmentError(
            "root .env is missing or unsafe; copy .env.example to .env first"
        )
    prohibited_variables = prohibited_dotenv_variables(root_environment_file)
    if prohibited_variables:
        raise LocalStackDevelopmentError(
            "root .env must not declare AWS, LocalStack, proxy, or process control variables: "
            + ", ".join(sorted(prohibited_variables, key=str.upper))
        )
    port = effective_gateway_port(environment)
    pnpm = shutil.which("pnpm")
    if not pnpm:
        raise LocalStackDevelopmentError("pnpm is required")
    with DockerSession(environment) as session:
        reference, endpoint = running_profile(session, port)
        verify_existing_profile(session, reference, endpoint)
    child_environment = sanitized_environment(environment)
    step("starting repository development tasks with LocalStack application roles only")
    return run_process_group(
        [
            pnpm,
            "exec",
            "dotenv",
            "--override",
            "-e",
            str(root_environment_file),
            "-e",
            str(RUNTIME_ENVIRONMENT_FILE),
            "--",
            "turbo",
            "run",
            "dev",
            "--filter=@nutrition-tracker/api",
            "--filter=@nutrition-tracker/worker",
        ],
        description="LocalStack-backed development tasks",
        environment=child_environment,
        timeout_seconds=None,
    )


def parse_arguments(arguments: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Operate the guarded persistent LocalStack development profile."
    )
    parser.add_argument("command", choices=("up", "down", "status", "verify", "run"))
    return parser.parse_args(arguments)


def main(arguments: Sequence[str] | None = None) -> int:
    options = parse_arguments(sys.argv[1:] if arguments is None else arguments)
    environment = dict(os.environ)
    if options.command == "up":
        with TerminationSignalScope() as cancellation_scope:
            start_profile(environment, cancellation_scope)
        return 0
    if options.command == "down":
        with TerminationSignalScope() as cancellation_scope:
            stop_profile(environment, cancellation_scope)
        return 0
    if options.command == "status":
        status_profile(environment)
        return 0
    if options.command == "verify":
        verify_profile(environment)
        return 0
    return run_development(environment)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except LocalStackCancellation as error:
        print(
            f"[localstack-dev] CANCELLED: received signal {error.signum}",
            file=sys.stderr,
        )
        raise SystemExit(128 + error.signum) from None
    except LocalStackDevelopmentError as error:
        print(f"[localstack-dev] ERROR: {error}", file=sys.stderr)
        raise SystemExit(1) from None
