from __future__ import annotations

import ast
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stderr
from dataclasses import replace
from io import StringIO
from pathlib import Path
from types import ModuleType
from unittest import mock


ROOT = Path(__file__).resolve().parents[3]
MODULE_PATH = ROOT / "infra" / "tailscale" / "phone_policy.py"
WINDOWS_RUNBOOK = ROOT / "infra" / "runbooks" / "physical-device-windows-wsl2-private-https.md"


def load_module() -> ModuleType:
    specification = importlib.util.spec_from_file_location("phone_policy", MODULE_PATH)
    if specification is None or specification.loader is None:
        raise RuntimeError("Unable to load phone policy module")
    module = importlib.util.module_from_spec(specification)
    sys.modules[specification.name] = module
    specification.loader.exec_module(module)
    return module


POLICY = load_module()


SAFE_LISTENERS = [
    {"host": "127.0.0.1", "port": 1025},
    {"host": "127.0.0.1", "port": 4000},
    {"host": "127.0.0.1", "port": 4566},
    {"host": "127.0.0.1", "port": 5432},
    {"host": "127.0.0.1", "port": 7700},
    {"host": "127.0.0.1", "port": 8025},
    {"host": "127.0.0.1", "port": 9000},
    {"host": "127.0.0.1", "port": 9001},
    {"host": "127.0.0.1", "port": 2181},
    {"host": "127.0.0.1", "port": 8080},
    {"host": "127.0.0.1", "port": 9092},
    {"host": "127.0.0.1", "port": 49231},
]


def protected_input(**changes):
    value = {
        "schemaVersion": POLICY.INPUT_SCHEMA,
        "phoneTailscaleIpv4": {
            "nutrition-tracker-phone-1": "100.64.0.10",
            "nutrition-tracker-phone-2": "100.64.0.11",
        },
        "relayHostTailscaleIpv4": "100.64.0.20",
        "listeners": [dict(listener) for listener in SAFE_LISTENERS],
    }
    value.update(changes)
    return value


class PhonePolicyTests(unittest.TestCase):
    def parsed(self, **changes):
        return POLICY.parse_phone_policy_input(protected_input(**changes))

    def test_renders_exact_two_phone_host_neutral_tcp_443_policy(self) -> None:
        value = self.parsed()
        policy = POLICY.build_phone_policy(
            value.phone_tailscale_ipv4,
            value.relay_host_tailscale_ipv4,
            value.listeners,
        )
        self.assertEqual(policy["acls"], [])
        self.assertEqual(policy["nodeAttrs"], [])
        self.assertEqual(policy["ssh"], [])
        self.assertEqual(
            policy["hosts"],
            {
                "nutrition-tracker-relay-host": "100.64.0.20",
                "nutrition-tracker-phone-1": "100.64.0.10",
                "nutrition-tracker-phone-2": "100.64.0.11",
            },
        )
        self.assertEqual(
            policy["grants"],
            [
                {
                    "dst": ["nutrition-tracker-relay-host"],
                    "ip": ["tcp:443"],
                    "src": ["nutrition-tracker-phone-1", "nutrition-tracker-phone-2"],
                }
            ],
        )
        self.assertEqual(
            [(test["src"], test["proto"]) for test in policy["tests"]],
            [
                ("nutrition-tracker-phone-1", "tcp"),
                ("nutrition-tracker-phone-1", "udp"),
                ("nutrition-tracker-phone-2", "tcp"),
                ("nutrition-tracker-phone-2", "udp"),
            ],
        )
        for tcp_test in policy["tests"][::2]:
            self.assertEqual(tcp_test["accept"], ["nutrition-tracker-relay-host:443"])
            for port in sorted(POLICY.BASELINE_DENIED_TCP_PORTS | {49231}):
                self.assertIn(f"nutrition-tracker-relay-host:{port}", tcp_test["deny"])
        self.assertNotIn("nutrition-tracker-mac", json.dumps(policy))
        self.assertNotIn("*", json.dumps(policy))
        self.assertEqual(
            POLICY.render_phone_policy(value),
            f"{json.dumps(policy, ensure_ascii=False, allow_nan=False, separators=(',', ':'), sort_keys=True)}\n",
        )

    def test_requires_exact_distinct_canonical_tailscale_addresses(self) -> None:
        mutations = [
            {"nutrition-tracker-phone-1": "192.168.1.10", "nutrition-tracker-phone-2": "100.64.0.11"},
            {"nutrition-tracker-phone-1": "100.64.0.10", "nutrition-tracker-phone-2": "100.64.0.10"},
            {"nutrition-tracker-phone-1": "fd7a:115c:a1e0::1", "nutrition-tracker-phone-2": "100.64.0.11"},
            {"nutrition-tracker-phone": "100.64.0.10", "nutrition-tracker-phone-2": "100.64.0.11"},
        ]
        for phones in mutations:
            with self.subTest(phones=phones):
                with self.assertRaises(POLICY.PhonePolicyError):
                    self.parsed(phoneTailscaleIpv4=phones)
        with self.assertRaisesRegex(POLICY.PhonePolicyError, "distinct"):
            self.parsed(relayHostTailscaleIpv4="100.64.0.10")

    def test_requires_every_dependency_and_api_on_exact_ipv4_loopback(self) -> None:
        for missing_port in sorted(POLICY.REQUIRED_LOOPBACK_PORTS):
            listeners = [
                listener for listener in SAFE_LISTENERS if listener["port"] != missing_port
            ]
            with self.subTest(missing_port=missing_port):
                with self.assertRaisesRegex(POLICY.PhonePolicyError, f"TCP/{missing_port}"):
                    self.parsed(listeners=listeners)
        wrong_bind = [dict(listener) for listener in SAFE_LISTENERS]
        next(listener for listener in wrong_bind if listener["port"] == 4000)["host"] = "0.0.0.0"
        with self.assertRaisesRegex(POLICY.PhonePolicyError, "TCP/4000"):
            value = self.parsed(listeners=wrong_bind)
            POLICY.build_phone_policy(
                value.phone_tailscale_ipv4,
                value.relay_host_tailscale_ipv4,
                value.listeners,
            )

    def test_rejects_existing_https_or_malformed_structured_listeners(self) -> None:
        cases = [
            [*SAFE_LISTENERS, {"host": "127.0.0.1", "port": 443}],
            [],
            [{"host": "localhost", "port": 4000}],
            [{"host": "127.0.0.1", "port": 0}],
            [{"host": "127.0.0.1", "port": True}],
            [{"host": "127.0.0.1", "port": 4000, "process": "secret"}],
            [SAFE_LISTENERS[0], SAFE_LISTENERS[0]],
            [*SAFE_LISTENERS, {"host": "0.0.0.0", "port": 65530}],
            [*SAFE_LISTENERS, {"host": "::1", "port": 65531}],
        ]
        for listeners in cases:
            with self.subTest(listeners=listeners[:2]):
                with self.assertRaises(POLICY.PhonePolicyError):
                    self.parsed(listeners=listeners)

    def test_secure_reader_requires_canonical_mode_protected_native_wsl_input(self) -> None:
        with tempfile.TemporaryDirectory(prefix="nutrition-relay-review-") as directory_name:
            directory = Path(directory_name)
            directory.chmod(0o700)
            path = directory / "phone-policy-input.json"
            path.write_bytes(POLICY._canonical(protected_input()))
            path.chmod(0o600)
            result = POLICY.read_phone_policy_input(str(path))
            self.assertEqual(result.relay_host_tailscale_ipv4, "100.64.0.20")

            path.chmod(0o644)
            with self.assertRaisesRegex(POLICY.PhonePolicyError, "mode-0600"):
                POLICY.read_phone_policy_input(str(path))
            path.chmod(0o600)

            link = directory / "hard-link.json"
            os.link(path, link)
            with self.assertRaisesRegex(POLICY.PhonePolicyError, "single-link"):
                POLICY.read_phone_policy_input(str(path))
            link.unlink()

            symlink = directory / "symlink.json"
            symlink.symlink_to(path)
            with self.assertRaisesRegex(POLICY.PhonePolicyError, "symlink"):
                POLICY.read_phone_policy_input(str(symlink))
            symlink.unlink()

            with mock.patch.object(POLICY, "_filesystem_magic", return_value=0x01021997):
                with self.assertRaisesRegex(POLICY.PhonePolicyError, "persistent Linux"):
                    POLICY.read_phone_policy_input(str(path))

            directory.chmod(0o755)
            with self.assertRaisesRegex(POLICY.PhonePolicyError, "mode 0700"):
                POLICY.read_phone_policy_input(str(path))
            directory.chmod(0o700)

    def test_secure_reader_opens_nonregular_inputs_nonblocking(self) -> None:
        with tempfile.TemporaryDirectory(prefix="nutrition-relay-review-") as directory_name:
            directory = Path(directory_name)
            directory.chmod(0o700)
            path = directory / "not-a-regular-file.json"
            os.mkfifo(path, mode=0o600)
            real_open = os.open

            def guarded_open(target, flags, *args, **kwargs):
                if target == path.name:
                    self.assertTrue(
                        flags & os.O_NONBLOCK,
                        "protected file descriptors must be opened nonblocking before fstat",
                    )
                return real_open(target, flags, *args, **kwargs)

            with mock.patch.object(POLICY.os, "open", side_effect=guarded_open):
                with self.assertRaisesRegex(POLICY.PhonePolicyError, "mode-0600 single-link"):
                    POLICY.read_phone_policy_input(str(path))

    def test_rejects_forbidden_paths_before_resolve_and_every_git_ancestor(self) -> None:
        with mock.patch.object(Path, "resolve", side_effect=AssertionError("must not resolve")):
            for path in ("/mnt/c/OneDrive/secret.json", "/home/user/OneDrive/secret.json"):
                with self.subTest(path=path):
                    with self.assertRaises(POLICY.PhonePolicyError):
                        POLICY._normalized_absolute_path(path, "input")

        with tempfile.TemporaryDirectory(prefix="nutrition-relay-parent-") as parent_name:
            parent = Path(parent_name)
            parent.chmod(0o700)
            (parent / ".git").mkdir()
            directory = parent / "review"
            directory.mkdir(mode=0o700)
            path = directory / "phone-policy-input.json"
            path.write_bytes(POLICY._canonical(protected_input()))
            path.chmod(0o600)
            with self.assertRaisesRegex(POLICY.PhonePolicyError, "Git worktree"):
                POLICY.read_phone_policy_input(str(path))

    def test_rejects_noncanonical_duplicate_and_noninteger_json(self) -> None:
        values = [
            json.dumps(protected_input()).encode(),
            b'{"a":1,"a":2}\n',
            b'{"a":1.5}\n',
            b'{"a":NaN}\n',
            b'\xff',
        ]
        for raw in values:
            with self.subTest(raw=raw[:40]):
                with self.assertRaises(POLICY.PhonePolicyError):
                    POLICY._json(raw, "fixture")

        secret_key = "100.64.0.99"
        with self.assertRaises(POLICY.PhonePolicyError) as caught:
            POLICY._json(f'{{"{secret_key}":1,"{secret_key}":2}}\n'.encode(), "fixture")
        self.assertNotIn(secret_key, str(caught.exception))

    def test_direct_builder_revalidates_every_listener(self) -> None:
        value = self.parsed()
        cases = [
            (*value.listeners, value.listeners[0]),
            (replace(value.listeners[0], port=0), *value.listeners[1:]),
            (replace(value.listeners[0], host="localhost"), *value.listeners[1:]),
            (object(), *value.listeners[1:]),
        ]
        for listeners in cases:
            with self.subTest(first=listeners[0]):
                with self.assertRaises(POLICY.PhonePolicyError):
                    POLICY.build_phone_policy(
                        value.phone_tailscale_ipv4,
                        value.relay_host_tailscale_ipv4,
                        listeners,
                    )

    def test_cli_and_module_expose_no_collection_or_protected_value_arguments(self) -> None:
        source = MODULE_PATH.read_text(encoding="utf-8")
        for forbidden in (
            "import subprocess",
            "import socket",
            "discover_listeners",
            "parse_lsof_snapshot",
            "/usr/sbin/lsof",
            "--phone-ip",
            "--mac-ip",
            "nutrition-tracker-mac",
            "os.system",
            "os.popen",
            "os.spawn",
            "os.exec",
            "urllib",
            "requests",
        ):
            self.assertNotIn(forbidden, source)

        tree = ast.parse(source)
        allowed_import_roots = {
            "__future__",
            "argparse",
            "collections",
            "ctypes",
            "dataclasses",
            "ipaddress",
            "json",
            "os",
            "pathlib",
            "stat",
            "sys",
            "typing",
        }
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    self.assertIn(alias.name.split(".", 1)[0], allowed_import_roots)
            elif isinstance(node, ast.ImportFrom):
                self.assertIn((node.module or "").split(".", 1)[0], allowed_import_roots)
            elif isinstance(node, ast.Call):
                if isinstance(node.func, ast.Name):
                    self.assertNotIn(node.func.id, {"eval", "exec", "compile", "__import__"})
                elif (
                    isinstance(node.func, ast.Attribute)
                    and isinstance(node.func.value, ast.Name)
                    and node.func.value.id == "os"
                ):
                    self.assertFalse(node.func.attr.startswith(("exec", "spawn")))
                    self.assertNotIn(node.func.attr, {"system", "popen"})

        parser = POLICY._parser()
        option_strings = {
            option for action in parser._actions for option in action.option_strings
        }
        self.assertEqual(option_strings - {"-h", "--help"}, {"--input-file"})
        protected_stderr = StringIO()
        with redirect_stderr(protected_stderr):
            with self.assertRaises(SystemExit):
                parser.parse_args(["--phone-ip", "100.64.0.10", "--mac-ip", "100.64.0.20"])
        self.assertNotIn("100.64.0.10", protected_stderr.getvalue())
        self.assertNotIn("100.64.0.20", protected_stderr.getvalue())

    def test_windows_runbook_keeps_renderer_and_live_exposure_blocked(self) -> None:
        runbook = WINDOWS_RUNBOOK.read_text(encoding="utf-8")
        for phrase in (
            "offline framework implemented; live use remains blocked",
            "mode-0700",
            "mode-0600",
            "cannot execute PowerShell",
            "A commit or push approval does not authorize any live phase",
        ):
            self.assertIn(phrase, runbook)


if __name__ == "__main__":
    unittest.main()
