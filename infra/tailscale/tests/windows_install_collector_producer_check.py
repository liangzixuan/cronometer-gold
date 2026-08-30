from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import NoReturn

from infra.tailscale import windows_install_snapshot as SNAPSHOT
from infra.tailscale.tests import test_windows_install_collector as STATIC
from infra.tailscale.tests import test_windows_install_snapshot as FIXTURES


PHASES = ("preinstall", "postinstall")
POWERSHELL_VERSION = re.compile(
    r"\APowerShell (?P<major>[0-9]+)\.(?P<minor>[0-9]+)\.(?P<patch>[0-9]+)\Z"
)
PROCESS_TIMEOUT_SECONDS = 20
MAX_FAILURE_STDERR_BYTES = 16384
GENERIC_FAILURE_MARKER = b"Windows install evidence collection failed closed."
POWERSHELL_INJECTION_VARIABLES = frozenset(
    name.casefold()
    for name in (
        "__PSLockdownPolicy",
        "PSExecutionPolicyPreference",
    )
)
POWERSHELL_INJECTION_PREFIXES = (
    "complus_",
    "corehost_",
    "coreclr_",
    "cor_",
    "dotnet_",
    "dyld_",
    "ld_",
    "powershell_",
    "psmodule",
)


class ProducerProofError(Exception):
    pass


def _fail(stage: str) -> NoReturn:
    raise ProducerProofError(stage)


def _run_process(
    argv: list[str],
    *,
    input_bytes: bytes | None,
    environment: dict[str, str],
    timeout_seconds: int,
) -> subprocess.CompletedProcess[bytes]:
    try:
        return subprocess.run(
            argv,
            input=input_bytes,
            stdin=subprocess.DEVNULL if input_bytes is None else None,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            timeout=timeout_seconds,
            env=environment,
        )
    except (OSError, subprocess.TimeoutExpired):
        _fail("process-boundary")


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError:
        _fail("powershell-identity")
    return digest.hexdigest()


def _sanitized_environment() -> dict[str, str]:
    environment = {
        key: value
        for key, value in os.environ.items()
        if key.casefold() not in POWERSHELL_INJECTION_VARIABLES
        and not key.casefold().startswith(POWERSHELL_INJECTION_PREFIXES)
    }
    environment["POWERSHELL_TELEMETRY_OPTOUT"] = "1"
    environment["POWERSHELL_UPDATECHECK"] = "Off"
    environment["DOTNET_CLI_TELEMETRY_OPTOUT"] = "1"
    return environment


def _resolve_powershell(
    environment: dict[str, str],
) -> tuple[str, str, str, str, str]:
    if os.name == "nt":
        executable = shutil.which(
            "pwsh.exe", path=environment.get("PATH")
        ) or shutil.which("pwsh", path=environment.get("PATH"))
    else:
        executable = shutil.which(
            "pwsh", path=environment.get("PATH")
        ) or shutil.which("pwsh.exe", path=environment.get("PATH"))
    if executable is None:
        _fail("powershell-unavailable")
    try:
        executable_path = Path(executable).resolve(strict=True)
    except (OSError, RuntimeError):
        _fail("powershell-identity")
    if not executable_path.is_file() or not executable_path.is_absolute():
        _fail("powershell-identity")
    executable = str(executable_path)
    executable_sha256 = _sha256_file(executable_path)

    version_result = _run_process(
        [executable, "--version"],
        input_bytes=None,
        environment=environment,
        timeout_seconds=5,
    )
    if version_result.returncode != 0 or version_result.stderr:
        _fail("powershell-version")
    try:
        version = version_result.stdout.decode("utf-8", errors="strict").strip()
    except UnicodeDecodeError:
        _fail("powershell-version")
    version_match = POWERSHELL_VERSION.fullmatch(version)
    if version_match is None:
        _fail("powershell-version")
    version_tuple = tuple(
        int(version_match.group(name)) for name in ("major", "minor", "patch")
    )
    if version_tuple < (7, 4, 0):
        _fail("powershell-version")

    collector_argument = str(STATIC.COLLECTOR)
    if os.name == "nt":
        runtime_kind = "windows"
    elif executable_path.suffix.lower() == ".exe":
        runtime_kind = "wsl-windows-bridge"
        if not environment.get("WSL_DISTRO_NAME"):
            _fail("powershell-path")
        bridge_result = _run_process(
            ["wslpath", "-w", collector_argument],
            input_bytes=None,
            environment=environment,
            timeout_seconds=5,
        )
        if bridge_result.returncode != 0 or bridge_result.stderr:
            _fail("powershell-path")
        try:
            collector_argument = bridge_result.stdout.decode(
                "utf-8", errors="strict"
            ).strip()
        except UnicodeDecodeError:
            _fail("powershell-path")
        if not collector_argument.startswith("\\\\wsl.localhost\\"):
            _fail("powershell-path")
    elif sys.platform.startswith("linux"):
        runtime_kind = "native-linux"
    else:
        runtime_kind = "native-posix"

    return (
        executable,
        collector_argument,
        version,
        runtime_kind,
        executable_sha256,
    )


def _canonical_fixture_input(corpus: dict[str, object], challenge: str) -> bytes:
    fixture = FIXTURES._canonical(
        {"artifactCorpus": corpus, "challenge": challenge}
    )
    try:
        characters = fixture.decode("utf-8", errors="strict")
    except UnicodeDecodeError:
        _fail("fixture-input")
    if not characters.isascii() or not 2 <= len(characters) <= 131072:
        _fail("fixture-input")
    return fixture


def _fixture_input_for_challenge(challenge: str) -> bytes:
    corpus = SNAPSHOT._corpus_value(FIXTURES.TEST_CORPUS)
    corpus["artifactCorpusSha256"] = FIXTURES._corpus_sha256()
    return _canonical_fixture_input(corpus, challenge)


def _fixture_input() -> bytes:
    return _fixture_input_for_challenge(FIXTURES.CHALLENGE)


def _fixture_input_with_array_corpus_kind() -> bytes:
    corpus = SNAPSHOT._corpus_value(FIXTURES.TEST_CORPUS)
    corpus["corpusKind"] = ["test"]
    corpus["artifactCorpusSha256"] = FIXTURES._commitment(corpus)
    return _canonical_fixture_input(corpus, FIXTURES.CHALLENGE)


def _fixture_leak_tokens(
    fixture_input: bytes,
    *,
    reviewed_public_bytes: tuple[bytes, ...],
) -> tuple[bytes, ...]:
    try:
        fixture_value = json.loads(fixture_input.decode("utf-8", errors="strict"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        _fail("fixture-input")
    strings: list[str] = []

    def collect(value: object) -> None:
        if isinstance(value, str):
            strings.append(value)
        elif isinstance(value, list):
            for item in value:
                collect(item)
        elif isinstance(value, dict):
            for item in value.values():
                collect(item)

    collect(fixture_value)
    tokens: set[bytes] = set()
    for value in strings:
        encoded = value.encode("utf-8")
        if len(encoded) < 8:
            continue
        for offset in range(len(encoded) - 7):
            tokens.add(encoded[offset : offset + 8])
    return tuple(
        sorted(
            token
            for token in tokens
            if not any(token in public_value for public_value in reviewed_public_bytes)
        )
    )


def _run_phase(
    executable: str,
    collector_argument: str,
    phase: str,
    fixture_input: bytes,
    environment: dict[str, str],
) -> bytes:
    if phase not in PHASES:
        _fail("phase")
    result = _run_process(
        [
            executable,
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-File",
            collector_argument,
            "-Phase",
            phase,
            "-SyntheticFixture",
        ],
        input_bytes=fixture_input,
        environment=environment,
        timeout_seconds=PROCESS_TIMEOUT_SECONDS,
    )
    if result.returncode != 0 or result.stderr:
        _fail(f"{phase}-process")
    output = result.stdout
    challenge = FIXTURES.CHALLENGE.encode("ascii")
    if (
        not 2 <= len(output) <= SNAPSHOT.MAX_SNAPSHOT_BYTES
        or output.startswith(b"\xef\xbb\xbf")
        or b"\r" in output
        or output.count(b"\n") != 1
        or not output.endswith(b"\n")
        or challenge in output
    ):
        _fail(f"{phase}-output")
    return output


def _run_negative_case(
    executable: str,
    collector_argument: str,
    *,
    case_name: str,
    fixture_input: bytes,
    leak_tokens: tuple[bytes, ...],
    environment: dict[str, str],
) -> None:
    result = _run_process(
        [
            executable,
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-File",
            collector_argument,
            "-Phase",
            "preinstall",
            "-SyntheticFixture",
        ],
        input_bytes=fixture_input,
        environment=environment,
        timeout_seconds=PROCESS_TIMEOUT_SECONDS,
    )
    if (
        result.returncode == 0
        or result.stdout != b""
        or not 1 <= len(result.stderr) <= MAX_FAILURE_STDERR_BYTES
        or GENERIC_FAILURE_MARKER not in result.stderr
        or any(token in result.stderr for token in leak_tokens)
    ):
        _fail(f"negative-{case_name}")


def _proof() -> dict[str, object]:
    if STATIC.collector_surface_violations(STATIC.SOURCE):
        _fail("collector-source")
    collector_bytes = STATIC.COLLECTOR.read_bytes()
    if (
        collector_bytes.startswith(b"\xef\xbb\xbf")
        or b"\r" in collector_bytes
        or hashlib.sha256(collector_bytes).hexdigest() != STATIC.COLLECTOR_SHA256
    ):
        _fail("collector-source")

    environment = _sanitized_environment()
    (
        executable,
        collector_argument,
        version,
        runtime_kind,
        executable_sha256,
    ) = _resolve_powershell(environment)
    fixture_input = _fixture_input()

    expected = {
        "preinstall": FIXTURES._canonical(FIXTURES._preinstall()),
        "postinstall": FIXTURES._canonical(FIXTURES._postinstall()),
    }
    produced: dict[str, bytes] = {}
    for phase in PHASES:
        first = _run_phase(
            executable,
            collector_argument,
            phase,
            fixture_input,
            environment,
        )
        second = _run_phase(
            executable,
            collector_argument,
            phase,
            fixture_input,
            environment,
        )
        if first != second or first != expected[phase]:
            _fail(f"{phase}-golden")
        produced[phase] = first

    invalid_challenge = FIXTURES.CHALLENGE[:-1]
    invalid_fixture_input = _fixture_input_for_challenge(invalid_challenge)
    _run_negative_case(
        executable,
        collector_argument,
        case_name="invalid-challenge",
        fixture_input=invalid_fixture_input,
        leak_tokens=_fixture_leak_tokens(
            invalid_fixture_input,
            reviewed_public_bytes=(
                GENERIC_FAILURE_MARKER,
                STATIC.SOURCE.encode("utf-8"),
                str(STATIC.COLLECTOR).encode("utf-8"),
                collector_argument.encode("utf-8"),
            ),
        ),
        environment=environment,
    )
    array_scalar_input = _fixture_input_with_array_corpus_kind()
    _run_negative_case(
        executable,
        collector_argument,
        case_name="array-shaped-corpus-kind",
        fixture_input=array_scalar_input,
        leak_tokens=_fixture_leak_tokens(
            array_scalar_input,
            reviewed_public_bytes=(
                GENERIC_FAILURE_MARKER,
                STATIC.SOURCE.encode("utf-8"),
                str(STATIC.COLLECTOR).encode("utf-8"),
                collector_argument.encode("utf-8"),
            ),
        ),
        environment=environment,
    )
    oversize_marker = b"oversize-test-only-input"
    oversize_input = oversize_marker + (b"x" * (131073 - len(oversize_marker)))
    oversize_leak_tokens = tuple(
        sorted(
            {
                oversize_input[offset : offset + 8]
                for offset in range(len(oversize_input) - 7)
            }
        )
    )
    _run_negative_case(
        executable,
        collector_argument,
        case_name="oversize-input",
        fixture_input=oversize_input,
        leak_tokens=oversize_leak_tokens,
        environment=environment,
    )

    try:
        manifest = SNAPSHOT.validate_install_snapshot_pair(
            produced["preinstall"],
            produced["postinstall"],
            expected_challenge=FIXTURES.CHALLENGE,
            artifact_corpora=FIXTURES.TEST_CORPORA,
        )
    except SNAPSHOT.WindowsInstallSnapshotError:
        _fail("validated-output")
    try:
        manifest_value = json.loads(manifest.decode("utf-8", errors="strict"))
        preinstall_value = json.loads(
            produced["preinstall"].decode("utf-8", errors="strict")
        )
        postinstall_value = json.loads(
            produced["postinstall"].decode("utf-8", errors="strict")
        )
    except (UnicodeDecodeError, json.JSONDecodeError):
        _fail("validated-output")
    if (
        manifest != FIXTURES._canonical(manifest_value)
        or manifest_value.get("artifactCorpusKind") != "test"
        or manifest_value.get("restrictedCommandsExecuted") is not False
        or manifest_value.get("productionArtifactCorpusMatched") is not False
        or preinstall_value.get("restrictedCommandsExecuted") is not False
        or postinstall_value.get("restrictedCommandsExecuted") is not False
        or FIXTURES.CHALLENGE.encode("ascii") in manifest
    ):
        _fail("validated-output")
    if _sha256_file(Path(executable)) != executable_sha256:
        _fail("powershell-identity")

    return {
        "collectorSha256": STATIC.COLLECTOR_SHA256,
        "manifestBytes": len(manifest),
        "manifestSha256": hashlib.sha256(manifest).hexdigest(),
        "negativeCasesRun": 3,
        "postinstallBytes": len(produced["postinstall"]),
        "postinstallSha256": hashlib.sha256(produced["postinstall"]).hexdigest(),
        "powerShellExecutableSha256": executable_sha256,
        "powerShellRuntime": runtime_kind,
        "powerShellVersion": version,
        "preinstallBytes": len(produced["preinstall"]),
        "preinstallSha256": hashlib.sha256(produced["preinstall"]).hexdigest(),
        "productionArtifactCorpusMatched": False,
        "runsPerPhase": 2,
        "status": "ok",
    }


def main() -> int:
    try:
        proof = _proof()
    except ProducerProofError as error:
        sys.stderr.write(f"Synthetic collector producer proof failed closed: {error}\n")
        return 1
    except Exception:
        sys.stderr.write(
            "Synthetic collector producer proof failed closed: unexpected\n"
        )
        return 1
    sys.stdout.buffer.write(FIXTURES._canonical(proof))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
