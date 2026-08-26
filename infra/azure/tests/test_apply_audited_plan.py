from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock


TESTS = Path(__file__).resolve().parent
sys.path.insert(0, str(TESTS))
import apply_audited_plan as APPLY  # noqa: E402


SUBSCRIPTION = "11111111-2222-3333-4444-555555555555"
VM_ID = (
    f"/subscriptions/{SUBSCRIPTION}/resourceGroups/nutrition-beta-rg/"
    "providers/Microsoft.Compute/virtualMachines/nutrition-beta-vm"
)
TARGET = APPLY.VmTarget(
    resource_id=VM_ID,
    subscription_id=SUBSCRIPTION,
    resource_group="nutrition-beta-rg",
    vm_name="nutrition-beta-vm",
)


def result(plan_hash: str = "a" * 64) -> dict[str, object]:
    return {
        "schema": "nutrition-tracker.azure-saved-plan-attestation.v2",
        "failure_containment_vm_resource_id": VM_ID,
        "shutdown_schedule_utc_time": "1800",
        "plan_sha256": plan_hash,
        "plan_size_bytes": 123,
        "terraform_binary": "/opt/homebrew/Cellar/terraform/1.5.7/bin/terraform",
        "terraform_sha256": "b" * 64,
        "terraform_version": "1.5.7",
    }


def completed(payload: object, returncode: int = 0) -> subprocess.CompletedProcess[bytes]:
    return subprocess.CompletedProcess(
        [], returncode, stdout=json.dumps(payload).encode(), stderr=b""
    )


def azure_version(version: str = "2.71.0") -> dict[str, object]:
    return {
        "azure-cli": version,
        "azure-cli-core": version,
        "extensions": {},
    }


class ApplyAuditedPlanTests(unittest.TestCase):
    def test_verify_requires_exact_attestation_identity(self) -> None:
        expected = result()
        with (
            mock.patch.object(APPLY, "load_attestation", return_value=expected),
            mock.patch.object(APPLY, "audit_binary_plan", return_value=expected),
        ):
            self.assertEqual(
                APPLY.verify_attested_plan(
                    Path("plan.tfplan"), Path("audit.plan-attestation.json")
                ),
                expected,
            )

        changed = result("c" * 64)
        with (
            mock.patch.object(APPLY, "load_attestation", return_value=expected),
            mock.patch.object(APPLY, "audit_binary_plan", return_value=changed),
            self.assertRaises(APPLY.PlanAuditError),
        ):
            APPLY.verify_attested_plan(
                Path("plan.tfplan"), Path("audit.plan-attestation.json")
            )

        changed_target = {
            **expected,
            "failure_containment_vm_resource_id": VM_ID.replace(
                "nutrition-beta", "different-beta"
            ),
        }
        with (
            mock.patch.object(APPLY, "load_attestation", return_value=changed_target),
            mock.patch.object(APPLY, "audit_binary_plan", return_value=expected),
            self.assertRaises(APPLY.PlanAuditError),
        ):
            APPLY.verify_attested_plan(
                Path("plan.tfplan"), Path("audit.plan-attestation.json")
            )

    def test_target_is_exactly_derived_from_attested_arm_id(self) -> None:
        self.assertEqual(APPLY._parse_vm_target(VM_ID), TARGET)
        self.assertEqual(APPLY._parse_shutdown_utc_time("1800"), "1800")
        for invalid in (
            VM_ID.replace("nutrition-beta-vm", "different-vm"),
            VM_ID.replace("Microsoft.Compute", "Microsoft.ClassicCompute"),
            VM_ID + "/extensions/unreviewed",
            "/subscriptions/not-a-uuid/resourceGroups/x/providers/x/x",
        ):
            with self.subTest(invalid=invalid), self.assertRaises(APPLY.PlanAuditError):
                APPLY._parse_vm_target(invalid)
        for invalid_time in (None, "", "2400", "1260", "18:00", 1800):
            with self.subTest(invalid_time=invalid_time), self.assertRaises(
                APPLY.PlanAuditError
            ):
                APPLY._parse_shutdown_utc_time(invalid_time)

    def test_environments_strip_overrides_and_separate_auth_boundaries(self) -> None:
        hostile = {
            "HOME": "/reviewed-home",
            "ARM_CLIENT_ID": "preserved-auth",
            "ARM_CLIENT_SECRET": "preserved-secret",
            "ARM_UNREVIEWED_OVERRIDE": "removed",
            "ARM_ENVIRONMENT": "usgovernment",
            "ARM_METADATA_HOSTNAME": "evil.invalid",
            "ARM_MSI_ENDPOINT": "https://evil.invalid",
            "ARM_OIDC_REQUEST_TOKEN": "removed-request-token",
            "ARM_OIDC_REQUEST_URL": "https://evil.invalid",
            "AZURE_CONFIG_DIR": "/tmp/evil-azure",
            "AZURE_EXTENSION_USE_DYNAMIC_INSTALL": "yes_without_prompt",
            "HTTP_PROXY": "http://proxy.invalid",
            "TF_CLI_ARGS_apply": "-target=evil",
            "TF_LOG": "TRACE",
            "TF_REATTACH_PROVIDERS": "evil",
            "PYTHONPATH": "/tmp/evil",
            "DYLD_INSERT_LIBRARIES": "/tmp/evil.dylib",
        }
        with mock.patch.dict(os.environ, hostile, clear=True):
            terraform_environment = APPLY._apply_environment(Path("/private/plan"))
            azure_environment = APPLY._azure_environment(Path("/private/plan"))
        self.assertEqual(terraform_environment["ARM_CLIENT_ID"], "preserved-auth")
        self.assertEqual(terraform_environment["ARM_CLIENT_SECRET"], "preserved-secret")
        self.assertNotIn("ARM_UNREVIEWED_OVERRIDE", terraform_environment)
        for forbidden_arm in (
            "ARM_ENVIRONMENT",
            "ARM_METADATA_HOSTNAME",
            "ARM_MSI_ENDPOINT",
            "ARM_OIDC_REQUEST_TOKEN",
            "ARM_OIDC_REQUEST_URL",
        ):
            self.assertNotIn(forbidden_arm, terraform_environment)
        for forbidden in (
            "HTTP_PROXY",
            "TF_CLI_ARGS_apply",
            "TF_LOG",
            "TF_REATTACH_PROVIDERS",
            "PYTHONPATH",
            "DYLD_INSERT_LIBRARIES",
        ):
            self.assertNotIn(forbidden, terraform_environment)
        self.assertEqual(terraform_environment["TF_INPUT"], "0")
        self.assertEqual(terraform_environment["TF_CLI_CONFIG_FILE"], "/dev/null")
        self.assertEqual(terraform_environment["TMPDIR"], "/private/plan")
        self.assertNotIn("ARM_CLIENT_ID", azure_environment)
        self.assertNotIn("ARM_CLIENT_SECRET", azure_environment)
        self.assertNotIn("AZURE_CONFIG_DIR", azure_environment)
        self.assertEqual(azure_environment["AZURE_EXTENSION_USE_DYNAMIC_INSTALL"], "no")

    def test_preflight_uses_live_exact_subscription_and_requires_target_absent(self) -> None:
        account = {
            "id": SUBSCRIPTION.upper(),
            "state": "Enabled",
            "environmentName": "AzureCloud",
        }
        with (
            mock.patch.dict(os.environ, {}, clear=True),
            mock.patch.object(
                APPLY,
                "_run_azure",
                side_effect=[
                    completed(azure_version()),
                    completed(account),
                    completed([]),
                ],
            ) as run,
        ):
            APPLY._preflight_azure_account_and_target(
                Path("/reviewed/az"), TARGET, {"HOME": "/private"}
            )
        self.assertEqual(run.call_args_list[0].args[1][0], "version")
        account_arguments = run.call_args_list[1].args[1]
        inventory_arguments = run.call_args_list[2].args[1]
        self.assertEqual(account_arguments[0:2], ["account", "show"])
        self.assertEqual(
            account_arguments[account_arguments.index("--subscription") + 1], SUBSCRIPTION
        )
        self.assertEqual(inventory_arguments[0:2], ["vm", "list"])
        self.assertEqual(
            inventory_arguments[inventory_arguments.index("--subscription") + 1],
            SUBSCRIPTION,
        )

        with (
            mock.patch.dict(os.environ, {}, clear=True),
            mock.patch.object(
                APPLY,
                "_run_azure",
                side_effect=[
                    completed(azure_version()),
                    completed(account),
                    completed([VM_ID.upper()]),
                ],
            ),
            self.assertRaises(APPLY.PlanAuditError),
        ):
            APPLY._preflight_azure_account_and_target(
                Path("/reviewed/az"), TARGET, {"HOME": "/private"}
            )

    def test_preflight_rejects_wrong_arm_subscription(self) -> None:
        account = {
            "id": SUBSCRIPTION,
            "state": "Enabled",
            "environmentName": "AzureCloud",
        }
        with (
            mock.patch.dict(
                os.environ,
                {"ARM_SUBSCRIPTION_ID": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"},
                clear=True,
            ),
            mock.patch.object(
                APPLY,
                "_run_azure",
                side_effect=[completed(azure_version()), completed(account)],
            ),
            self.assertRaises(APPLY.PlanAuditError),
        ):
            APPLY._preflight_azure_account_and_target(
                Path("/reviewed/az"), TARGET, {"HOME": "/private"}
            )

    def test_preflight_rejects_disabled_or_malformed_account(self) -> None:
        for account in (
            {"id": SUBSCRIPTION, "state": "Disabled", "environmentName": "AzureCloud"},
            {"id": SUBSCRIPTION, "state": "Enabled", "environmentName": "AzureUSGovernment"},
            [],
        ):
            with (
                self.subTest(account=account),
                mock.patch.dict(os.environ, {}, clear=True),
                mock.patch.object(
                    APPLY,
                    "_run_azure",
                    side_effect=[
                        completed(azure_version()),
                        completed(account),
                    ],
                ),
                self.assertRaises(APPLY.PlanAuditError),
            ):
                APPLY._preflight_azure_account_and_target(
                    Path("/reviewed/az"), TARGET, {"HOME": "/private"}
                )

    def test_azure_cli_version_is_exactly_pinned(self) -> None:
        with mock.patch.object(
            APPLY,
            "_run_azure",
            return_value=completed(azure_version()),
        ):
            APPLY._verify_azure_cli_version(Path("/reviewed/az"), {})
        with (
            mock.patch.object(
                APPLY, "_run_azure", return_value=completed(azure_version("2.72.0"))
            ),
            self.assertRaises(APPLY.PlanAuditError),
        ):
            APPLY._verify_azure_cli_version(Path("/reviewed/az"), {})
        with (
            mock.patch.object(
                APPLY,
                "_run_azure",
                return_value=completed(
                    {
                        "azure-cli": "2.71.0",
                        "azure-cli-core": "2.71.0",
                        "extensions": {"unreviewed": "1.0.0"},
                    }
                ),
            ),
            self.assertRaises(APPLY.PlanAuditError),
        ):
            APPLY._verify_azure_cli_version(Path("/reviewed/az"), {})

    def test_azure_runner_is_closed_fixed_and_never_uses_shell(self) -> None:
        response = subprocess.CompletedProcess([], 0, stdout=b"[]", stderr=b"")
        with mock.patch.object(APPLY.subprocess, "run", return_value=response) as run:
            APPLY._run_azure(
                Path("/reviewed/az"), ["vm", "list", "--subscription", SUBSCRIPTION], {}
            )
        self.assertEqual(run.call_args.args[0][0], "/reviewed/az")
        self.assertEqual(run.call_args.kwargs["close_fds"], True)
        self.assertEqual(run.call_args.kwargs["capture_output"], True)
        self.assertNotIn("shell", run.call_args.kwargs)

        oversized = subprocess.CompletedProcess(
            [], 0, stdout=b"x" * (APPLY.MAX_AZURE_JSON_BYTES + 1), stderr=b""
        )
        with (
            mock.patch.object(APPLY.subprocess, "run", return_value=oversized),
            self.assertRaises(APPLY.PlanAuditError),
        ):
            APPLY._run_azure(Path("/reviewed/az"), ["version"], {})
        with self.assertRaises(APPLY.PlanAuditError):
            APPLY._load_azure_json(
                subprocess.CompletedProcess([], 1, stdout=b"", stderr=b"unauthorized"),
                "authenticated read",
            )

    def test_post_apply_verifies_exact_enabled_shutdown_schedule(self) -> None:
        schedule_name = "shutdown-computevm-nutrition-beta-vm"
        schedule = {
            "id": (
                f"/subscriptions/{SUBSCRIPTION}/resourceGroups/nutrition-beta-rg/"
                f"providers/Microsoft.DevTestLab/schedules/{schedule_name}"
            ),
            "name": schedule_name,
            "type": "Microsoft.DevTestLab/schedules",
            "properties": {
                "dailyRecurrence": {"time": "1800"},
                "provisioningState": "Succeeded",
                "status": "Enabled",
                "taskType": "ComputeVmShutdownTask",
                "targetResourceId": VM_ID,
                "timeZoneId": "UTC",
            },
        }
        with mock.patch.object(APPLY, "_run_azure", return_value=completed(schedule)) as run:
            APPLY._verify_shutdown_schedule(Path("/reviewed/az"), TARGET, "1800", {})
        arguments = run.call_args.args[1]
        self.assertEqual(arguments[0:2], ["resource", "show"])
        self.assertEqual(arguments[arguments.index("--subscription") + 1], SUBSCRIPTION)
        self.assertEqual(
            arguments[arguments.index("--resource-group") + 1], "nutrition-beta-rg"
        )
        self.assertEqual(arguments[arguments.index("--name") + 1], schedule_name)

        mutations = (
            ("status", "Disabled"),
            ("provisioningState", "Failed"),
            ("timeZoneId", "Central Standard Time"),
            ("dailyRecurrence", {"time": "2300"}),
        )
        for field, value in mutations:
            changed = json.loads(json.dumps(schedule))
            changed["properties"][field] = value
            with (
                self.subTest(field=field),
                mock.patch.object(APPLY, "_run_azure", return_value=completed(changed)),
                self.assertRaises(APPLY.PlanAuditError),
            ):
                APPLY._verify_shutdown_schedule(
                    Path("/reviewed/az"), TARGET, "1800", {}
                )

    def test_apply_command_is_fixed_bounded_child_with_verified_descriptor(self) -> None:
        fake = mock.Mock()
        with mock.patch.object(APPLY.subprocess, "Popen", return_value=fake) as popen:
            actual = APPLY._start_terraform_apply(
                Path("/reviewed/terraform"), 19, {"TF_INPUT": "0"}
            )
        self.assertIs(actual, fake)
        self.assertEqual(
            popen.call_args.args[0],
            [
                "/reviewed/terraform",
                "apply",
                "-input=false",
                "-no-color",
                "/dev/fd/19",
            ],
        )
        self.assertEqual(popen.call_args.kwargs["pass_fds"], (19,))
        self.assertEqual(popen.call_args.kwargs["close_fds"], True)
        self.assertEqual(popen.call_args.kwargs["start_new_session"], True)
        self.assertNotIn("shell", popen.call_args.kwargs)

    def test_absence_must_remain_structured_for_full_ten_minute_window(self) -> None:
        now = [0.0]

        def clock() -> float:
            return now[0]

        def sleep(seconds: float) -> None:
            now[0] += seconds

        observations = 0

        def absent(*_args: object) -> set[str]:
            nonlocal observations
            observations += 1
            return set()

        with mock.patch.object(APPLY, "_list_vm_ids", side_effect=absent):
            state = APPLY.contain_failed_apply(
                Path("/reviewed/az"), TARGET, {}, clock=clock, sleeper=sleep
            )
        self.assertEqual(state, "absent")
        self.assertGreaterEqual(now[0], 10 * 60)
        self.assertGreater(observations, APPLY.REQUIRED_ABSENT_OBSERVATIONS)

    def test_transient_inventory_gap_is_not_accepted_as_absence(self) -> None:
        now = [0.0]

        def clock() -> float:
            return now[0]

        def sleep(seconds: float) -> None:
            now[0] += seconds

        def inventory(*_args: object) -> set[str]:
            if 100 <= now[0] < 105:
                raise APPLY.PlanAuditError("transient")
            return set()

        with (
            mock.patch.object(APPLY, "_list_vm_ids", side_effect=inventory),
            mock.patch.object(APPLY, "_power_state", side_effect=APPLY.PlanAuditError("none")),
            mock.patch.object(APPLY, "_request_deallocation", return_value=False),
            self.assertRaisesRegex(APPLY.PlanAuditError, "EMERGENCY"),
        ):
            APPLY.contain_failed_apply(
                Path("/reviewed/az"), TARGET, {}, clock=clock, sleeper=sleep
            )

    def test_running_vm_is_deallocated_and_exact_state_is_proved(self) -> None:
        now = [0.0]
        power_states = iter(["PowerState/running", APPLY.DEALLOCATED_POWER_STATE])

        def sleep(seconds: float) -> None:
            now[0] += seconds

        with (
            mock.patch.object(APPLY, "_list_vm_ids", return_value={VM_ID.casefold()}),
            mock.patch.object(APPLY, "_power_state", side_effect=power_states),
            mock.patch.object(APPLY, "_request_deallocation", return_value=True) as stop,
        ):
            state = APPLY.contain_failed_apply(
                Path("/reviewed/az"),
                TARGET,
                {},
                clock=lambda: now[0],
                sleeper=sleep,
            )
        self.assertEqual(state, APPLY.DEALLOCATED_POWER_STATE)
        stop.assert_called_once()

    def test_early_absence_then_running_still_deallocates(self) -> None:
        now = [0.0]
        inventories = iter([set(), set(), {VM_ID.casefold()}, {VM_ID.casefold()}])
        power_states = iter(["PowerState/running", APPLY.DEALLOCATED_POWER_STATE])

        def sleep(seconds: float) -> None:
            now[0] += seconds

        with (
            mock.patch.object(APPLY, "_list_vm_ids", side_effect=inventories),
            mock.patch.object(APPLY, "_power_state", side_effect=power_states),
            mock.patch.object(APPLY, "_request_deallocation", return_value=True) as stop,
        ):
            state = APPLY.contain_failed_apply(
                Path("/reviewed/az"),
                TARGET,
                {},
                clock=lambda: now[0],
                sleeper=sleep,
            )
        self.assertEqual(state, APPLY.DEALLOCATED_POWER_STATE)
        stop.assert_called_once()

    def test_transient_deallocation_failure_retries_until_exact_safe_state(self) -> None:
        now = [0.0]
        power_states = iter(
            [
                "PowerState/running",
                "PowerState/running",
                "PowerState/running",
                "PowerState/running",
                APPLY.DEALLOCATED_POWER_STATE,
            ]
        )

        def sleep(seconds: float) -> None:
            now[0] += seconds

        with (
            mock.patch.object(APPLY, "_list_vm_ids", return_value={VM_ID.casefold()}),
            mock.patch.object(APPLY, "_power_state", side_effect=power_states),
            mock.patch.object(
                APPLY,
                "_request_deallocation",
                side_effect=[APPLY.PlanAuditError("transient"), True],
            ) as stop,
        ):
            state = APPLY.contain_failed_apply(
                Path("/reviewed/az"),
                TARGET,
                {},
                clock=lambda: now[0],
                sleeper=sleep,
            )
        self.assertEqual(state, APPLY.DEALLOCATED_POWER_STATE)
        self.assertEqual(stop.call_count, 2)

    def test_deallocating_is_not_a_safe_terminal_state(self) -> None:
        now = [0.0]

        def sleep(seconds: float) -> None:
            now[0] += seconds

        with (
            mock.patch.object(APPLY, "_list_vm_ids", return_value={VM_ID.casefold()}),
            mock.patch.object(APPLY, "_power_state", return_value="PowerState/deallocating"),
            mock.patch.object(APPLY, "_request_deallocation", return_value=True),
            self.assertRaisesRegex(APPLY.PlanAuditError, "EMERGENCY"),
        ):
            APPLY.contain_failed_apply(
                Path("/reviewed/az"),
                TARGET,
                {},
                clock=lambda: now[0],
                sleeper=sleep,
            )

    def test_stopped_and_starting_are_not_safe_terminal_states(self) -> None:
        for unsafe in ("PowerState/stopped", "PowerState/starting"):
            now = [0.0]

            def sleep(seconds: float) -> None:
                now[0] += seconds

            with (
                self.subTest(unsafe=unsafe),
                mock.patch.object(APPLY, "CONTAINMENT_SETTLE_SECONDS", 10),
                mock.patch.object(
                    APPLY, "_list_vm_ids", return_value={VM_ID.casefold()}
                ),
                mock.patch.object(APPLY, "_power_state", return_value=unsafe),
                mock.patch.object(APPLY, "_request_deallocation", return_value=False),
                self.assertRaisesRegex(APPLY.PlanAuditError, "EMERGENCY"),
            ):
                APPLY.contain_failed_apply(
                    Path("/reviewed/az"),
                    TARGET,
                    {},
                    clock=lambda: now[0],
                    sleeper=sleep,
                )

    def test_success_requires_shutdown_schedule_and_skips_containment(self) -> None:
        process = mock.Mock(pid=12345)
        with (
            mock.patch.object(APPLY, "_start_terraform_apply", return_value=process),
            mock.patch.object(
                APPLY, "_wait_for_apply", return_value=APPLY._ApplyOutcome(0, None, False)
            ),
            mock.patch.object(APPLY, "_azure_cli_hash_matches", return_value=True),
            mock.patch.object(APPLY, "_verify_shutdown_schedule") as verify,
            mock.patch.object(APPLY, "contain_failed_apply") as contain,
        ):
            code = APPLY._apply_with_containment(
                Path("/reviewed/terraform"),
                19,
                {},
                Path("/reviewed/az"),
                TARGET,
                {},
                "c" * 64,
                "1800",
            )
        self.assertEqual(code, 0)
        verify.assert_called_once_with(
            Path("/reviewed/az"), TARGET, "1800", {}
        )
        contain.assert_not_called()

    def test_nonzero_and_signal_remain_nonzero_after_containment(self) -> None:
        outcomes = [(APPLY._ApplyOutcome(7, None, False), 7)]
        outcomes.extend(
            (
                APPLY._ApplyOutcome(-number, number, False),
                128 + number,
            )
            for number in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)
        )
        outcomes.append((APPLY._ApplyOutcome(1, None, True), 1))
        for outcome, expected in outcomes:
            with self.subTest(outcome=outcome):
                process = mock.Mock(pid=12345)
                with (
                    mock.patch.object(APPLY, "_start_terraform_apply", return_value=process),
                    mock.patch.object(APPLY, "_wait_for_apply", return_value=outcome),
                    mock.patch.object(APPLY, "_stop_process_group", return_value=True),
                    mock.patch.object(APPLY, "_azure_cli_hash_matches", return_value=True),
                    mock.patch.object(APPLY, "contain_failed_apply", return_value="absent"),
                ):
                    code = APPLY._apply_with_containment(
                        Path("/reviewed/terraform"),
                        19,
                        {},
                        Path("/reviewed/az"),
                        TARGET,
                        {},
                        "c" * 64,
                    )
                self.assertEqual(code, expected)

    def test_process_group_is_stopped_before_first_containment_action(self) -> None:
        events: list[str] = []
        process = mock.Mock(pid=12345)

        def stopped(_process: object) -> bool:
            events.append("process-group-stopped")
            return True

        def contained(*_args: object) -> str:
            events.append("azure-containment")
            return "absent"

        with (
            mock.patch.object(APPLY, "_start_terraform_apply", return_value=process),
            mock.patch.object(
                APPLY, "_wait_for_apply", return_value=APPLY._ApplyOutcome(1, None, False)
            ),
            mock.patch.object(APPLY, "_stop_process_group", side_effect=stopped),
            mock.patch.object(APPLY, "_azure_cli_hash_matches", return_value=True),
            mock.patch.object(APPLY, "contain_failed_apply", side_effect=contained),
        ):
            code = APPLY._apply_with_containment(
                Path("/reviewed/terraform"), 19, {}, Path("/reviewed/az"), TARGET, {}, "c" * 64
            )
        self.assertEqual(code, 1)
        self.assertEqual(events, ["process-group-stopped", "azure-containment"])

        with (
            mock.patch.object(APPLY, "_start_terraform_apply", return_value=process),
            mock.patch.object(
                APPLY, "_wait_for_apply", return_value=APPLY._ApplyOutcome(1, None, False)
            ),
            mock.patch.object(APPLY, "_stop_process_group", return_value=False),
            mock.patch.object(APPLY, "contain_failed_apply") as contain,
            self.assertRaisesRegex(APPLY.PlanAuditError, "deallocation was not started"),
        ):
            APPLY._apply_with_containment(
                Path("/reviewed/terraform"), 19, {}, Path("/reviewed/az"), TARGET, {}, "c" * 64
            )
        contain.assert_not_called()

    def test_launch_exception_never_runs_containment(self) -> None:
        with (
            mock.patch.object(
                APPLY, "_start_terraform_apply", side_effect=OSError("exec failed")
            ),
            mock.patch.object(APPLY, "contain_failed_apply") as contain,
            self.assertRaisesRegex(APPLY.PlanAuditError, "could not start"),
        ):
            APPLY._apply_with_containment(
                Path("/reviewed/terraform"), 19, {}, Path("/reviewed/az"), TARGET, {}, "c" * 64
            )
        contain.assert_not_called()

    def test_shutdown_verification_failure_deallocates_and_fails_closed(self) -> None:
        process = mock.Mock(pid=12345)
        with (
            mock.patch.object(APPLY, "_start_terraform_apply", return_value=process),
            mock.patch.object(
                APPLY, "_wait_for_apply", return_value=APPLY._ApplyOutcome(0, None, False)
            ),
            mock.patch.object(APPLY, "_stop_process_group", return_value=True),
            mock.patch.object(APPLY, "_azure_cli_hash_matches", return_value=True),
            mock.patch.object(
                APPLY,
                "_verify_shutdown_schedule",
                side_effect=APPLY.PlanAuditError("disabled"),
            ),
            mock.patch.object(
                APPLY, "contain_failed_apply", return_value=APPLY.DEALLOCATED_POWER_STATE
            ) as contain,
            self.assertRaisesRegex(APPLY.PlanAuditError, "shutdown-schedule verification"),
        ):
            APPLY._apply_with_containment(
                Path("/reviewed/terraform"),
                19,
                {},
                Path("/reviewed/az"),
                TARGET,
                {},
                "c" * 64,
                "1800",
            )
        contain.assert_called_once()

    def test_keyboard_interrupt_after_launch_still_contains(self) -> None:
        process = mock.Mock(pid=12345)
        with (
            mock.patch.object(APPLY, "_start_terraform_apply", return_value=process),
            mock.patch.object(APPLY, "_wait_for_apply", side_effect=KeyboardInterrupt),
            mock.patch.object(APPLY, "_stop_process_group", return_value=True),
            mock.patch.object(APPLY, "_azure_cli_hash_matches", return_value=True),
            mock.patch.object(APPLY, "contain_failed_apply", return_value="absent") as contain,
            self.assertRaisesRegex(APPLY.PlanAuditError, "supervision"),
        ):
            APPLY._apply_with_containment(
                Path("/reviewed/terraform"),
                19,
                {},
                Path("/reviewed/az"),
                TARGET,
                {},
                "c" * 64,
            )
        contain.assert_called_once()

    def test_containment_or_cli_identity_failure_is_loudly_distinct(self) -> None:
        process = mock.Mock(pid=12345)
        with (
            mock.patch.object(APPLY, "_start_terraform_apply", return_value=process),
            mock.patch.object(
                APPLY, "_wait_for_apply", return_value=APPLY._ApplyOutcome(1, None, False)
            ),
            mock.patch.object(APPLY, "_stop_process_group", return_value=True),
            mock.patch.object(APPLY, "_azure_cli_hash_matches", return_value=True),
            mock.patch.object(
                APPLY,
                "contain_failed_apply",
                side_effect=APPLY.PlanAuditError("EMERGENCY: unproved"),
            ),
            self.assertRaisesRegex(APPLY.PlanAuditError, "EMERGENCY: unproved"),
        ):
            APPLY._apply_with_containment(
                Path("/reviewed/terraform"), 19, {}, Path("/reviewed/az"), TARGET, {}, "c" * 64
            )

        with (
            mock.patch.object(APPLY, "_start_terraform_apply", return_value=process),
            mock.patch.object(
                APPLY, "_wait_for_apply", return_value=APPLY._ApplyOutcome(1, None, False)
            ),
            mock.patch.object(APPLY, "_stop_process_group", return_value=True),
            mock.patch.object(APPLY, "_azure_cli_hash_matches", return_value=False),
            mock.patch.object(APPLY, "contain_failed_apply", return_value="absent") as contain,
            self.assertRaisesRegex(APPLY.PlanAuditError, "before containment"),
        ):
            APPLY._apply_with_containment(
                Path("/reviewed/terraform"), 19, {}, Path("/reviewed/az"), TARGET, {}, "c" * 64
            )
        contain.assert_not_called()

        with (
            mock.patch.object(APPLY, "_start_terraform_apply", return_value=process),
            mock.patch.object(
                APPLY, "_wait_for_apply", return_value=APPLY._ApplyOutcome(1, None, False)
            ),
            mock.patch.object(APPLY, "_stop_process_group", return_value=True),
            mock.patch.object(
                APPLY, "_azure_cli_hash_matches", side_effect=[True, False]
            ),
            mock.patch.object(APPLY, "contain_failed_apply", return_value="absent") as contain,
            self.assertRaisesRegex(APPLY.PlanAuditError, "during containment"),
        ):
            APPLY._apply_with_containment(
                Path("/reviewed/terraform"), 19, {}, Path("/reviewed/az"), TARGET, {}, "c" * 64
            )
        contain.assert_called_once()


if __name__ == "__main__":
    unittest.main()
