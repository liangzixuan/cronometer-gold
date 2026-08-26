#!/usr/bin/env python3
"""Re-audit and apply exactly one previously attested Azure binary plan.

This wrapper has no plan mode, accepts no Terraform flags, and never prints plan
values. It re-renders and audits the binary plan, compares the prior mode-0600
attestation, requires an attended hash-specific confirmation, then gives a
bounded Terraform child a read-only inherited descriptor for the exact verified
plan inode. Before apply it proves the exact audited VM is absent. On any apply
failure, timeout, or termination signal, it stops the Terraform process group,
deallocates that one VM if it materialized, and fails closed unless Azure proves
the VM is deallocated or repeatedly absent through the settle window.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import signal
import stat
import subprocess
import sys
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from types import FrameType
from typing import Callable, Iterator

from audit_saved_plan import (
    DEFAULT_TERRAFORM_BINARY,
    INFRA_ROOT,
    PlanAuditError,
    _require,
    audit_binary_plan,
    load_attestation,
    open_verified_plan_descriptor,
    secure_executable_digest,
)


DEFAULT_AZURE_CLI_BINARY = Path("/opt/homebrew/bin/az")
REVIEWED_AZURE_CLI_VERSION = "2.71.0"
REVIEWED_AZURE_CLI_CORE_VERSION = "2.71.0"
APPLY_TIMEOUT_SECONDS = 30 * 60
PROCESS_STOP_GRACE_SECONDS = 15
AZURE_COMMAND_TIMEOUT_SECONDS = 45
CONTAINMENT_SETTLE_SECONDS = 10 * 60
CONTAINMENT_POLL_SECONDS = 5
REQUIRED_ABSENT_OBSERVATIONS = 12
MAX_AZURE_JSON_BYTES = 2 * 1024 * 1024
DEALLOCATED_POWER_STATE = "PowerState/deallocated"
_VM_ID_PATTERN = re.compile(
    r"/subscriptions/(?P<subscription>[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})/"
    r"resourceGroups/(?P<prefix>[a-z][a-z0-9-]{2,22}[a-z0-9])-rg/"
    r"providers/Microsoft\.Compute/virtualMachines/(?P=prefix)-vm"
)
_TERRAFORM_ARM_AUTH_KEYS = {
    "ARM_AUXILIARY_TENANT_IDS",
    "ARM_CLIENT_CERTIFICATE_PASSWORD",
    "ARM_CLIENT_CERTIFICATE_PATH",
    "ARM_CLIENT_ID",
    "ARM_CLIENT_SECRET",
    "ARM_OIDC_TOKEN",
    "ARM_OIDC_TOKEN_FILE_PATH",
    "ARM_SUBSCRIPTION_ID",
    "ARM_TENANT_ID",
    "ARM_USE_AKS_WORKLOAD_IDENTITY",
    "ARM_USE_CLI",
    "ARM_USE_MSI",
    "ARM_USE_OIDC",
}


@dataclass(frozen=True)
class VmTarget:
    resource_id: str
    subscription_id: str
    resource_group: str
    vm_name: str


@dataclass
class _SignalState:
    number: int | None = None
    process: subprocess.Popen[bytes] | None = None


@dataclass(frozen=True)
class _ApplyOutcome:
    returncode: int
    interrupted_signal: int | None
    timed_out: bool


def _apply_environment(private_directory: Path) -> dict[str, str]:
    """Preserve only Azure auth and basic locale while removing process overrides."""

    basic_keys = {"HOME", "LANG", "LC_ALL", "LC_CTYPE", "LOGNAME", "USER"}
    environment = {
        key: value
        for key, value in os.environ.items()
        if key in basic_keys or key in _TERRAFORM_ARM_AUTH_KEYS
    }
    environment.update(
        {
            "CHECKPOINT_DISABLE": "1",
            "PATH": "/usr/bin:/bin:/opt/homebrew/bin",
            "TF_CLI_CONFIG_FILE": "/dev/null",
            "TF_IN_AUTOMATION": "1",
            "TF_INPUT": "0",
            "TMPDIR": str(private_directory),
        }
    )
    return environment


def _azure_environment(private_directory: Path) -> dict[str, str]:
    """Use only the interactive Azure CLI login, never Terraform auth secrets."""

    basic_keys = {"HOME", "LANG", "LC_ALL", "LC_CTYPE", "LOGNAME", "USER"}
    environment = {
        key: value for key, value in os.environ.items() if key in basic_keys
    }
    environment.update(
        {
            "AZURE_CORE_COLLECT_TELEMETRY": "no",
            "AZURE_CORE_NO_COLOR": "yes",
            "AZURE_CORE_ONLY_SHOW_ERRORS": "yes",
            "AZURE_EXTENSION_USE_DYNAMIC_INSTALL": "no",
            "PATH": "/usr/bin:/bin:/opt/homebrew/bin",
            "TMPDIR": str(private_directory),
        }
    )
    return environment


def verify_attested_plan(
    binary_plan: Path,
    attestation_path: Path,
    terraform_binary: Path = DEFAULT_TERRAFORM_BINARY,
) -> dict[str, object]:
    """Re-audit the binary plan and require byte-for-byte attestation identity."""

    attestation = load_attestation(attestation_path.absolute())
    current = audit_binary_plan(binary_plan.absolute(), terraform_binary)
    _require(attestation == current, "attestation does not identify this exact audited plan")
    return current


def _parse_vm_target(resource_id: object) -> VmTarget:
    _require(isinstance(resource_id, str), "audited containment VM ID is missing")
    match = _VM_ID_PATTERN.fullmatch(resource_id)
    _require(match is not None, "audited containment VM ID is malformed")
    assert isinstance(resource_id, str) and match is not None
    prefix = match.group("prefix")
    return VmTarget(
        resource_id=resource_id,
        subscription_id=match.group("subscription"),
        resource_group=f"{prefix}-rg",
        vm_name=f"{prefix}-vm",
    )


def _parse_shutdown_utc_time(value: object) -> str:
    _require(
        isinstance(value, str)
        and re.fullmatch(r"(?:[01][0-9]|2[0-3])[0-5][0-9]", value) is not None,
        "audited shutdown schedule UTC time is malformed",
    )
    assert isinstance(value, str)
    return value


def _reviewed_azure_cli(path: Path = DEFAULT_AZURE_CLI_BINARY) -> Path:
    try:
        resolved = path.resolve(strict=True)
        metadata = resolved.stat()
    except OSError as error:
        raise PlanAuditError("reviewed Azure CLI is unavailable") from error
    _require(
        stat.S_ISREG(metadata.st_mode)
        and os.access(resolved, os.X_OK)
        and metadata.st_uid in {0, os.getuid()}
        and metadata.st_mode & (stat.S_IWGRP | stat.S_IWOTH) == 0,
        "reviewed Azure CLI must be an owned, non-writable executable regular file",
    )
    return resolved


def _run_azure(
    azure_cli: Path,
    arguments: list[str],
    environment: dict[str, str],
) -> subprocess.CompletedProcess[bytes]:
    try:
        completed = subprocess.run(
            [str(azure_cli), *arguments],
            cwd=INFRA_ROOT,
            env=environment,
            check=False,
            capture_output=True,
            close_fds=True,
            timeout=AZURE_COMMAND_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise PlanAuditError("Azure control-plane command did not complete") from error
    _require(
        len(completed.stdout) <= MAX_AZURE_JSON_BYTES
        and len(completed.stderr) <= MAX_AZURE_JSON_BYTES,
        "Azure control-plane response exceeded the reviewed bound",
    )
    return completed


def _load_azure_json(completed: subprocess.CompletedProcess[bytes], label: str) -> object:
    _require(completed.returncode == 0, f"{label} failed")
    try:
        return json.loads(completed.stdout.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError) as error:
        raise PlanAuditError(f"{label} returned malformed JSON") from error


def _verify_azure_cli_version(
    azure_cli: Path,
    environment: dict[str, str],
) -> None:
    document = _load_azure_json(
        _run_azure(
            azure_cli,
            ["version", "--output", "json", "--only-show-errors"],
            environment,
        ),
        "Azure CLI version verification",
    )
    _require(
        isinstance(document, dict)
        and document.get("azure-cli") == REVIEWED_AZURE_CLI_VERSION,
        f"Azure CLI must be exactly version {REVIEWED_AZURE_CLI_VERSION}",
    )
    _require(
        document.get("azure-cli-core") == REVIEWED_AZURE_CLI_CORE_VERSION
        and document.get("extensions") == {},
        "Azure CLI core must be exactly version 2.71.0 with no loaded extensions",
    )


def _list_vm_ids(
    azure_cli: Path,
    target: VmTarget,
    environment: dict[str, str],
) -> set[str]:
    completed = _run_azure(
        azure_cli,
        [
            "vm",
            "list",
            "--subscription",
            target.subscription_id,
            "--query",
            "[].id",
            "--output",
            "json",
            "--only-show-errors",
        ],
        environment,
    )
    document = _load_azure_json(completed, "Azure VM inventory read")
    _require(
        isinstance(document, list)
        and len(document) <= 10_000
        and all(isinstance(entry, str) for entry in document),
        "Azure VM inventory response is malformed",
    )
    return {str(entry).casefold() for entry in document}


def _power_state(
    azure_cli: Path,
    target: VmTarget,
    environment: dict[str, str],
) -> str | None:
    completed = _run_azure(
        azure_cli,
        [
            "vm",
            "get-instance-view",
            "--ids",
            target.resource_id,
            "--subscription",
            target.subscription_id,
            "--query",
            "instanceView.statuses[].code",
            "--output",
            "json",
            "--only-show-errors",
        ],
        environment,
    )
    document = _load_azure_json(completed, "Azure VM power-state read")
    _require(
        isinstance(document, list) and all(isinstance(entry, str) for entry in document),
        "Azure VM power-state response is malformed",
    )
    states = [str(entry) for entry in document if str(entry).startswith("PowerState/")]
    _require(len(states) <= 1, "Azure VM returned multiple power states")
    return states[0] if states else None


def _preflight_azure_account_and_target(
    azure_cli: Path,
    target: VmTarget,
    environment: dict[str, str],
) -> None:
    _verify_azure_cli_version(azure_cli, environment)
    account = _load_azure_json(
        _run_azure(
            azure_cli,
            [
                "account",
                "show",
                "--subscription",
                target.subscription_id,
                "--output",
                "json",
                "--only-show-errors",
            ],
            environment,
        ),
        "Azure account preflight",
    )
    _require(isinstance(account, dict), "Azure account preflight response is malformed")
    _require(
        isinstance(account.get("id"), str)
        and account["id"].casefold() == target.subscription_id.casefold()
        and account.get("state") == "Enabled"
        and account.get("environmentName") == "AzureCloud",
        "Azure CLI is not authenticated to the exact enabled audited subscription",
    )
    configured_subscription = os.environ.get("ARM_SUBSCRIPTION_ID")
    _require(
        configured_subscription is None
        or configured_subscription.casefold() == target.subscription_id.casefold(),
        "ARM_SUBSCRIPTION_ID does not match the exact audited subscription",
    )
    ids = _list_vm_ids(azure_cli, target, environment)
    _require(
        target.resource_id.casefold() not in ids,
        "exact audited VM already exists immediately before apply",
    )


def _verify_shutdown_schedule(
    azure_cli: Path,
    target: VmTarget,
    expected_utc_time: str,
    environment: dict[str, str],
) -> None:
    schedule_name = f"shutdown-computevm-{target.vm_name}"
    expected_id = (
        f"/subscriptions/{target.subscription_id}/resourceGroups/{target.resource_group}/"
        f"providers/Microsoft.DevTestLab/schedules/{schedule_name}"
    )
    document = _load_azure_json(
        _run_azure(
            azure_cli,
            [
                "resource",
                "show",
                "--subscription",
                target.subscription_id,
                "--resource-group",
                target.resource_group,
                "--resource-type",
                "Microsoft.DevTestLab/schedules",
                "--name",
                schedule_name,
                "--api-version",
                "2018-09-15",
                "--output",
                "json",
                "--only-show-errors",
            ],
            environment,
        ),
        "Azure shutdown-schedule verification",
    )
    _require(
        isinstance(document, dict)
        and isinstance(document.get("id"), str)
        and document["id"].casefold() == expected_id.casefold()
        and document.get("name") == schedule_name
        and isinstance(document.get("type"), str)
        and document["type"].casefold() == "microsoft.devtestlab/schedules"
        and isinstance(document.get("properties"), dict)
        and document["properties"].get("status") == "Enabled"
        and document["properties"].get("provisioningState") == "Succeeded"
        and document["properties"].get("taskType") == "ComputeVmShutdownTask"
        and document["properties"].get("timeZoneId") == "UTC"
        and isinstance(document["properties"].get("dailyRecurrence"), dict)
        and document["properties"]["dailyRecurrence"].get("time")
        == expected_utc_time
        and isinstance(document["properties"].get("targetResourceId"), str)
        and document["properties"]["targetResourceId"].casefold()
        == target.resource_id.casefold(),
        "exact enabled Azure VM shutdown schedule was not proven after apply",
    )


def _request_deallocation(
    azure_cli: Path,
    target: VmTarget,
    environment: dict[str, str],
) -> bool:
    completed = _run_azure(
        azure_cli,
        [
            "vm",
            "deallocate",
            "--ids",
            target.resource_id,
            "--subscription",
            target.subscription_id,
            "--output",
            "none",
            "--only-show-errors",
        ],
        environment,
    )
    return completed.returncode == 0


def contain_failed_apply(
    azure_cli: Path,
    target: VmTarget,
    environment: dict[str, str],
    *,
    clock: Callable[[], float] = time.monotonic,
    sleeper: Callable[[float], None] = time.sleep,
) -> str:
    """Prove the exact VM deallocated or absent through the LRO settle window."""

    started_at = clock()
    deadline = started_at + CONTAINMENT_SETTLE_SECONDS
    absent_observations = 0
    absence_proof_intact = True
    next_deallocation = 0.0
    while True:
        now = clock()
        try:
            ids = _list_vm_ids(azure_cli, target, environment)
            present = target.resource_id.casefold() in ids
        except PlanAuditError:
            present = True
            absent_observations = 0
            absence_proof_intact = False

        if not present:
            absent_observations += 1
        else:
            absent_observations = 0
            absence_proof_intact = False
            try:
                if _power_state(azure_cli, target, environment) == DEALLOCATED_POWER_STATE:
                    return DEALLOCATED_POWER_STATE
            except PlanAuditError:
                pass
            if now >= next_deallocation:
                try:
                    _request_deallocation(azure_cli, target, environment)
                except PlanAuditError:
                    pass
                next_deallocation = now + 15

        if now >= deadline:
            if (
                absence_proof_intact
                and absent_observations >= REQUIRED_ABSENT_OBSERVATIONS
            ):
                return "absent"
            break
        sleeper(min(CONTAINMENT_POLL_SECONDS, max(0.0, deadline - now)))

    raise PlanAuditError(
        "EMERGENCY: failed apply containment could not prove the exact audited VM "
        "absent through the settle window or PowerState/deallocated"
    )


@contextmanager
def _guard_termination_signals(state: _SignalState) -> Iterator[None]:
    previous: dict[int, signal.Handlers] = {}

    def handler(number: int, _frame: FrameType | None) -> None:
        if state.number is None:
            state.number = number
        process = state.process
        if process is not None and process.poll() is None:
            try:
                os.killpg(process.pid, number)
            except ProcessLookupError:
                pass

    guarded = (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)
    for number in guarded:
        previous[number] = signal.signal(number, handler)
    try:
        yield
    finally:
        for number, old_handler in previous.items():
            signal.signal(number, old_handler)


def _start_terraform_apply(
    terraform: Path,
    descriptor: int,
    environment: dict[str, str],
) -> subprocess.Popen[bytes]:
    descriptor_path = f"/dev/fd/{descriptor}"
    return subprocess.Popen(
        [str(terraform), "apply", "-input=false", "-no-color", descriptor_path],
        cwd=INFRA_ROOT,
        env=environment,
        close_fds=True,
        pass_fds=(descriptor,),
        start_new_session=True,
    )


def _stop_process_group(process: subprocess.Popen[bytes]) -> bool:
    """Stop/reap Terraform and require its isolated process group to disappear."""

    def signal_group(number: int) -> None:
        try:
            os.killpg(process.pid, number)
        except ProcessLookupError:
            pass

    if process.poll() is None:
        signal_group(signal.SIGTERM)
        try:
            process.wait(timeout=PROCESS_STOP_GRACE_SECONDS)
        except subprocess.TimeoutExpired:
            signal_group(signal.SIGKILL)
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        signal_group(signal.SIGKILL)
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            return False

    end = time.monotonic() + 5
    while time.monotonic() < end:
        try:
            os.killpg(process.pid, 0)
        except ProcessLookupError:
            return True
        signal_group(signal.SIGKILL)
        time.sleep(0.1)
    return False


def _wait_for_apply(
    process: subprocess.Popen[bytes],
    state: _SignalState,
) -> _ApplyOutcome:
    deadline = time.monotonic() + APPLY_TIMEOUT_SECONDS
    signal_deadline: float | None = None
    while True:
        if state.number is not None and signal_deadline is None:
            signal_deadline = time.monotonic() + PROCESS_STOP_GRACE_SECONDS
        if signal_deadline is not None and time.monotonic() >= signal_deadline:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            _stop_process_group(process)
            return _ApplyOutcome(
                returncode=process.returncode if process.returncode is not None else 1,
                interrupted_signal=state.number,
                timed_out=True,
            )
        try:
            returncode = process.wait(timeout=min(1.0, remaining))
            return _ApplyOutcome(returncode, state.number, False)
        except subprocess.TimeoutExpired:
            continue


def _normalize_failure_exit(outcome: _ApplyOutcome) -> int:
    if outcome.interrupted_signal is not None:
        return 128 + outcome.interrupted_signal
    if 1 <= outcome.returncode <= 125:
        return outcome.returncode
    return 1


def _azure_cli_hash_matches(azure_cli: Path, expected_sha256: str) -> bool:
    try:
        current_sha256, _ = secure_executable_digest(azure_cli)
    except BaseException:
        return False
    return current_sha256 == expected_sha256


def _apply_with_containment(
    terraform: Path,
    descriptor: int,
    terraform_environment: dict[str, str],
    azure_cli: Path,
    target: VmTarget,
    azure_environment: dict[str, str],
    azure_cli_sha256: str,
    shutdown_utc_time: str | None = None,
) -> int:
    state = _SignalState()
    process: subprocess.Popen[bytes] | None = None
    supervision_error: BaseException | None = None
    with _guard_termination_signals(state):
        try:
            process = _start_terraform_apply(terraform, descriptor, terraform_environment)
            state.process = process
            if state.number is not None:
                try:
                    os.killpg(process.pid, state.number)
                except ProcessLookupError:
                    pass
            outcome = _wait_for_apply(process, state)
        except BaseException as error:
            if process is None:
                if isinstance(error, OSError):
                    raise PlanAuditError("Terraform apply process could not start") from error
                raise
            supervision_error = error
            outcome = _ApplyOutcome(1, state.number, False)

        apply_reported_success = (
            outcome.returncode == 0
            and outcome.interrupted_signal is None
            and not outcome.timed_out
        )
        if apply_reported_success:
            if not _azure_cli_hash_matches(azure_cli, azure_cli_sha256):
                supervision_error = PlanAuditError(
                    "Azure CLI changed before post-apply shutdown verification"
                )
            else:
                try:
                    _verify_shutdown_schedule(
                        azure_cli,
                        target,
                        _parse_shutdown_utc_time(shutdown_utc_time),
                        azure_environment,
                    )
                except BaseException as error:
                    supervision_error = error
            if supervision_error is None and state.number is None:
                return 0
            outcome = _ApplyOutcome(1, state.number, False)

        assert process is not None
        try:
            process_group_stopped = _stop_process_group(process)
        except BaseException as error:
            process_group_stopped = False
            if supervision_error is None:
                supervision_error = error
        if not process_group_stopped:
            raise PlanAuditError(
                "EMERGENCY: failed Terraform process group could not be proved stopped "
                "and reaped; Azure deallocation was not started because the provider "
                "could recreate or restart the VM"
            )
        azure_cli_unchanged = _azure_cli_hash_matches(azure_cli, azure_cli_sha256)
        if not azure_cli_unchanged:
            raise PlanAuditError(
                "EMERGENCY: reviewed Azure CLI identity changed before containment; "
                "no Azure mutation was attempted and the exact VM requires manual "
                "inspection and deallocation"
            )
        try:
            containment = contain_failed_apply(azure_cli, target, azure_environment)
        except PlanAuditError:
            raise
        except BaseException:
            raise PlanAuditError(
                "EMERGENCY: failed apply containment ended without proving the exact "
                "audited VM absent or PowerState/deallocated"
            ) from None
        if not _azure_cli_hash_matches(azure_cli, azure_cli_sha256):
            raise PlanAuditError(
                "EMERGENCY: Azure CLI identity changed during containment; its proof "
                "is not trusted and the exact VM requires manual inspection and "
                "deallocation"
            )
        if supervision_error is not None:
            raise PlanAuditError(
                "Terraform apply supervision or exact shutdown-schedule verification "
                f"failed after launch; Azure containment proved VM state={containment}"
            ) from None
        print(
            "Terraform apply failed; Azure failure containment proved exact audited "
            f"VM state={containment}.",
            file=sys.stderr,
        )
        return _normalize_failure_exit(outcome)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary_plan", type=Path)
    parser.add_argument("attestation", type=Path)
    args = parser.parse_args()
    descriptor: int | None = None
    try:
        result = verify_attested_plan(args.binary_plan, args.attestation)
        _require(
            sys.stdin.isatty() and sys.stdout.isatty(),
            "apply requires an attended interactive terminal",
        )
        target = _parse_vm_target(result.get("failure_containment_vm_resource_id"))
        shutdown_utc_time = _parse_shutdown_utc_time(
            result.get("shutdown_schedule_utc_time")
        )
        digest = str(result["plan_sha256"])
        phrase = f"APPLY EXACT AZURE PLAN {digest}"
        print(f"Verified Azure plan sha256={digest}")
        entered = input(f"Type exactly '{phrase}' to apply: ")
        _require(entered == phrase, "exact hash-specific apply confirmation was not entered")

        private_directory = args.binary_plan.absolute().parent
        azure_environment = _azure_environment(private_directory)
        azure_cli = _reviewed_azure_cli()
        azure_cli_sha256, _ = secure_executable_digest(azure_cli)
        _preflight_azure_account_and_target(azure_cli, target, azure_environment)

        descriptor = open_verified_plan_descriptor(args.binary_plan.absolute(), digest)
        terraform = Path(str(result["terraform_binary"]))
        executable_hash, _ = secure_executable_digest(terraform)
        _require(
            executable_hash == result["terraform_sha256"],
            "Terraform executable changed after the plan audit",
        )
        terraform_environment = _apply_environment(private_directory)
        os.umask(0o077)
        return _apply_with_containment(
            terraform,
            descriptor,
            terraform_environment,
            azure_cli,
            target,
            azure_environment,
            azure_cli_sha256,
            shutdown_utc_time,
        )
    except (OSError, PlanAuditError) as error:
        parser.exit(1, f"Azure verified-plan apply stopped: {error}\n")
    finally:
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass


if __name__ == "__main__":
    raise SystemExit(main())
