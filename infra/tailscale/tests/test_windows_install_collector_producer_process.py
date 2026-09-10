from __future__ import annotations

import contextlib
import io
import subprocess
import unittest
from unittest.mock import MagicMock, patch

from infra.tailscale.tests import windows_install_collector_producer_check as PRODUCER


STAGES = (
    "powershell-version",
    "powershell-path",
    "preinstall-process",
    "postinstall-process",
    "negative-invalid-challenge-process",
    "negative-array-shaped-corpus-kind-process",
    "negative-oversize-input-process",
)
NEGATIVE_CASES = (
    "invalid-challenge",
    "array-shaped-corpus-kind",
    "oversize-input",
)
PRIVATE_SENTINEL = "synthetic-private-sentinel-never-log"
ARGV = ["/synthetic-only/pwsh", PRIVATE_SENTINEL]
ENVIRONMENT = {"SYNTHETIC_PRIVATE": PRIVATE_SENTINEL}


@contextlib.contextmanager
def resolved_runtime(*, bridge: bool = False):
    executable = "/synthetic-only/pwsh.exe" if bridge else "/synthetic-only/pwsh"
    executable_path = MagicMock()
    executable_path.resolve.return_value = executable_path
    executable_path.is_file.return_value = True
    executable_path.is_absolute.return_value = True
    executable_path.suffix = ".exe" if bridge else ""
    executable_path.__str__.return_value = executable
    with (
        patch.object(PRODUCER.os, "name", "posix"),
        patch.object(PRODUCER.sys, "platform", "linux"),
        patch.object(PRODUCER.shutil, "which", return_value=executable),
        patch.object(PRODUCER, "Path", return_value=executable_path),
        patch.object(PRODUCER, "_sha256_file", return_value="a" * 64),
    ):
        yield executable


class WindowsInstallCollectorProducerProcessTests(unittest.TestCase):
    def test_invalid_stage_fails_before_starting_a_process(self) -> None:
        with patch.object(PRODUCER.subprocess, "run") as run:
            with self.assertRaisesRegex(PRODUCER.ProducerProofError, "^process-stage$"):
                PRODUCER._run_process(
                    ARGV,
                    stage=PRIVATE_SENTINEL,
                    input_bytes=PRIVATE_SENTINEL.encode(),
                    environment=ENVIRONMENT,
                    timeout_seconds=5,
                )
            run.assert_not_called()

    def test_each_process_failure_reports_only_its_fixed_stage_and_reason(self) -> None:
        for stage in STAGES:
            failures = (
                (
                    "timeout",
                    subprocess.TimeoutExpired(
                        ARGV,
                        5,
                        output=PRIVATE_SENTINEL.encode(),
                        stderr=PRIVATE_SENTINEL.encode(),
                    ),
                ),
                ("launch-error", OSError(13, PRIVATE_SENTINEL, PRIVATE_SENTINEL)),
            )
            for reason, failure in failures:
                with self.subTest(stage=stage, reason=reason):
                    stdout, stderr = io.StringIO(), io.StringIO()

                    def proof():
                        return PRODUCER._run_process(
                            ARGV,
                            stage=stage,
                            input_bytes=PRIVATE_SENTINEL.encode(),
                            environment=ENVIRONMENT,
                            timeout_seconds=5,
                        )

                    with (
                        patch.object(PRODUCER.subprocess, "run", side_effect=failure) as run,
                        patch.object(PRODUCER, "_proof", side_effect=proof),
                        contextlib.redirect_stdout(stdout),
                        contextlib.redirect_stderr(stderr),
                    ):
                        self.assertEqual(PRODUCER.main(), 1)
                    run.assert_called_once()
                    self.assertEqual(stdout.getvalue(), "")
                    self.assertEqual(
                        stderr.getvalue(),
                        f"Synthetic collector producer proof failed closed: {stage}-{reason}\n",
                    )
                    self.assertNotIn(PRIVATE_SENTINEL, stderr.getvalue())

    def test_completed_process_is_returned_unchanged_without_shell_or_retry(self) -> None:
        for input_bytes in (None, PRIVATE_SENTINEL.encode()):
            with self.subTest(input_bytes_present=input_bytes is not None):
                result = subprocess.CompletedProcess(ARGV, 9, b"fixture-output", b"fixture-error")
                with patch.object(PRODUCER.subprocess, "run", return_value=result) as run:
                    actual = PRODUCER._run_process(
                        ARGV,
                        stage="powershell-version",
                        input_bytes=input_bytes,
                        environment=ENVIRONMENT,
                        timeout_seconds=5,
                    )
                self.assertIs(actual, result)
                run.assert_called_once_with(
                    ARGV,
                    input=input_bytes,
                    stdin=subprocess.DEVNULL if input_bytes is None else None,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    check=False,
                    timeout=5,
                    env=ENVIRONMENT,
                )

    def test_version_discovery_keeps_five_second_budget_and_own_stage(self) -> None:
        for reason, failure in (
            ("timeout", subprocess.TimeoutExpired(ARGV, 5)),
            ("launch-error", OSError(13, PRIVATE_SENTINEL)),
        ):
            with self.subTest(reason=reason), resolved_runtime() as executable:
                with patch.object(PRODUCER.subprocess, "run", side_effect=failure) as run:
                    with self.assertRaisesRegex(
                        PRODUCER.ProducerProofError, f"^powershell-version-{reason}$"
                    ):
                        PRODUCER._resolve_powershell(ENVIRONMENT)
                run.assert_called_once()
                self.assertEqual(run.call_args.args, ([executable, "--version"],))
                self.assertEqual(run.call_args.kwargs["timeout"], 5)
                self.assertIsNone(run.call_args.kwargs["input"])
                self.assertEqual(run.call_args.kwargs["stdin"], subprocess.DEVNULL)

    def test_bridge_discovery_keeps_five_second_budget_and_own_stage(self) -> None:
        for reason, failure in (
            ("timeout", subprocess.TimeoutExpired(ARGV, 5)),
            ("launch-error", OSError(13, PRIVATE_SENTINEL)),
        ):
            with self.subTest(reason=reason), resolved_runtime(bridge=True):
                version = subprocess.CompletedProcess(ARGV, 0, b"PowerShell 7.6.5\n", b"")
                with patch.object(
                    PRODUCER.subprocess, "run", side_effect=[version, failure]
                ) as run:
                    with self.assertRaisesRegex(
                        PRODUCER.ProducerProofError, f"^powershell-path-{reason}$"
                    ):
                        PRODUCER._resolve_powershell({"WSL_DISTRO_NAME": "Synthetic-Ubuntu"})
                self.assertEqual(run.call_count, 2)
                self.assertEqual(
                    run.call_args.args,
                    (["wslpath", "-w", str(PRODUCER.STATIC.COLLECTOR)],),
                )
                self.assertEqual(run.call_args.kwargs["timeout"], 5)

    def test_each_collector_phase_keeps_twenty_second_budget_and_own_stage(self) -> None:
        for phase in PRODUCER.PHASES:
            for reason, failure in (
                ("timeout", subprocess.TimeoutExpired(ARGV, 20)),
                ("launch-error", OSError(13, PRIVATE_SENTINEL)),
            ):
                with self.subTest(phase=phase, reason=reason):
                    with patch.object(PRODUCER.subprocess, "run", side_effect=failure) as run:
                        with self.assertRaisesRegex(
                            PRODUCER.ProducerProofError, f"^{phase}-process-{reason}$"
                        ):
                            PRODUCER._run_phase(
                                "/synthetic-only/pwsh", "collector.ps1", phase, b"fixture", {}
                            )
                    run.assert_called_once()
                    self.assertEqual(run.call_args.kwargs["timeout"], 20)
                    self.assertEqual(run.call_args.kwargs["input"], b"fixture")

    def test_each_negative_case_keeps_twenty_second_budget_and_own_stage(self) -> None:
        for case_name in NEGATIVE_CASES:
            for reason, failure in (
                ("timeout", subprocess.TimeoutExpired(ARGV, 20)),
                ("launch-error", OSError(13, PRIVATE_SENTINEL)),
            ):
                with self.subTest(case_name=case_name, reason=reason):
                    with patch.object(PRODUCER.subprocess, "run", side_effect=failure) as run:
                        with self.assertRaisesRegex(
                            PRODUCER.ProducerProofError,
                            f"^negative-{case_name}-process-{reason}$",
                        ):
                            PRODUCER._run_negative_case(
                                "/synthetic-only/pwsh",
                                "collector.ps1",
                                case_name=case_name,
                                fixture_input=b"fixture",
                                leak_tokens=(b"fixture",),
                                environment={},
                            )
                    run.assert_called_once()
                    self.assertEqual(run.call_args.kwargs["timeout"], 20)
                    self.assertEqual(run.call_args.kwargs["input"], b"fixture")

    def test_collector_nonzero_exit_and_stderr_still_fail_closed(self) -> None:
        for result in (
            subprocess.CompletedProcess(ARGV, 1, b"", b""),
            subprocess.CompletedProcess(ARGV, 0, b"{}\n", b"unexpected stderr"),
        ):
            with self.subTest(returncode=result.returncode, stderr=bool(result.stderr)):
                with patch.object(PRODUCER.subprocess, "run", return_value=result) as run:
                    with self.assertRaisesRegex(PRODUCER.ProducerProofError, "^preinstall-process$"):
                        PRODUCER._run_phase(
                            "/synthetic-only/pwsh", "collector.ps1", "preinstall", b"fixture", {}
                        )
                run.assert_called_once()


if __name__ == "__main__":
    unittest.main()
