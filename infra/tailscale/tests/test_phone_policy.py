from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import unittest
from pathlib import Path
from types import ModuleType


ROOT = Path(__file__).resolve().parents[3]
MODULE_PATH = ROOT / "infra" / "tailscale" / "phone_policy.py"
RUNBOOK = ROOT / "infra" / "runbooks" / "physical-device-private-https.md"
MOBILE_README = ROOT / "apps" / "mobile" / "README.md"


def load_module() -> ModuleType:
    specification = importlib.util.spec_from_file_location("phone_policy", MODULE_PATH)
    if specification is None or specification.loader is None:
        raise RuntimeError("Unable to load phone policy module")
    module = importlib.util.module_from_spec(specification)
    sys.modules[specification.name] = module
    specification.loader.exec_module(module)
    return module


POLICY = load_module()


def snapshot(*endpoints: str) -> bytes:
    rows: list[str] = []
    for index, endpoint in enumerate(endpoints, start=100):
        rows.extend((f"p{index}", f"n{endpoint}"))
    return ("\n".join(rows) + "\n").encode()


SAFE_ENDPOINTS = (
    "127.0.0.1:4000",
    "127.0.0.1:4566",
    "127.0.0.1:5432",
    "127.0.0.1:7700",
    "127.0.0.1:9000",
    "127.0.0.1:9001",
    "*:2181",
    "*:8080",
    "*:9092",
    "*:49231",
)


class PhonePolicyTests(unittest.TestCase):
    def listeners(self, *extra: str):
        return POLICY.parse_lsof_snapshot(snapshot(*SAFE_ENDPOINTS, *extra))

    def test_renders_an_exact_device_and_tcp_443_only_grant(self) -> None:
        policy = POLICY.build_phone_policy(
            "100.64.0.10", "100.64.0.20", self.listeners("*:65343")
        )
        self.assertEqual(policy["acls"], [])
        self.assertEqual(policy["nodeAttrs"], [])
        self.assertEqual(policy["ssh"], [])
        self.assertEqual(
            policy["grants"],
            [
                {
                    "src": ["nutrition-tracker-phone"],
                    "dst": ["nutrition-tracker-mac"],
                    "ip": ["tcp:443"],
                }
            ],
        )
        tcp_test, udp_test = policy["tests"]
        self.assertEqual(tcp_test["accept"], ["nutrition-tracker-mac:443"])
        self.assertNotIn("nutrition-tracker-mac:443", tcp_test["deny"])
        for port in (22, 80, 2181, 4000, 4566, 5432, 65343, 7700, 8080, 9000, 9001, 9092):
            self.assertIn(f"nutrition-tracker-mac:{port}", tcp_test["deny"])
        self.assertEqual(udp_test["proto"], "udp")
        self.assertIn("nutrition-tracker-mac:443", udp_test["deny"])
        self.assertNotIn("*", json.dumps(policy))

    def test_rejects_non_tailscale_or_ambiguous_device_addresses(self) -> None:
        listeners = self.listeners()
        for phone_ip, mac_ip in (
            ("192.168.1.10", "100.64.0.20"),
            ("100.64.0.10", "127.0.0.1"),
            ("100.64.0.10", "100.64.0.10"),
            ("fd7a:115c:a1e0::1", "100.64.0.20"),
        ):
            with self.subTest(phone_ip=phone_ip, mac_ip=mac_ip):
                with self.assertRaises(POLICY.PhonePolicyError):
                    POLICY.build_phone_policy(phone_ip, mac_ip, listeners)

    def test_requires_every_application_service_on_exact_ipv4_loopback(self) -> None:
        for missing_port in sorted(POLICY.REQUIRED_LOOPBACK_PORTS):
            endpoints = tuple(
                endpoint
                for endpoint in SAFE_ENDPOINTS
                if not endpoint.endswith(f":{missing_port}")
            )
            with self.subTest(missing_port=missing_port):
                with self.assertRaisesRegex(POLICY.PhonePolicyError, f"TCP/{missing_port}"):
                    POLICY.build_phone_policy(
                        "100.64.0.10",
                        "100.64.0.20",
                        POLICY.parse_lsof_snapshot(snapshot(*endpoints)),
                    )

        with self.assertRaisesRegex(POLICY.PhonePolicyError, "TCP/4000"):
            POLICY.build_phone_policy(
                "100.64.0.10",
                "100.64.0.20",
                self.listeners("*:4000"),
            )

    def test_rejects_an_existing_https_listener(self) -> None:
        with self.assertRaisesRegex(POLICY.PhonePolicyError, "TCP/443"):
            POLICY.build_phone_policy(
                "100.64.0.10", "100.64.0.20", self.listeners("127.0.0.1:443")
            )

    def test_rejects_malformed_or_unbounded_lsof_snapshots(self) -> None:
        for raw in (
            b"",
            b"p1\nn127.0.0.1\n",
            b"n127.0.0.1:4000\n",
            b"pnot-a-pid\nn127.0.0.1:4000\n",
            b"p1\nx2\nn127.0.0.1:4000\n",
            b"p1\nn127.0.0.1:4000\x00",
            b"p1\nn127.0.0.1:70000\n",
            b"x" * (POLICY.MAX_LSOF_BYTES + 1),
        ):
            with self.subTest(raw=raw[:40]):
                with self.assertRaises(POLICY.PhonePolicyError):
                    POLICY.parse_lsof_snapshot(raw)

    def test_listener_collection_is_bounded_and_uses_no_shell_or_ambient_environment(self) -> None:
        calls = []

        def run(arguments, **options):
            calls.append((arguments, options))
            return subprocess.CompletedProcess(
                arguments, 0, stdout=snapshot(*SAFE_ENDPOINTS), stderr=b""
            )

        self.assertEqual(len(POLICY.discover_listeners(run)), len(SAFE_ENDPOINTS))
        arguments, options = calls[0]
        self.assertEqual(arguments[0], "/usr/sbin/lsof")
        self.assertFalse(options["shell"])
        self.assertEqual(options["timeout"], 10)
        self.assertEqual(options["cwd"], "/")
        self.assertEqual(
            options["env"],
            {"LANG": "C", "LC_ALL": "C", "PATH": "/usr/bin:/bin:/usr/sbin:/sbin"},
        )

        for result in (
            subprocess.CompletedProcess(arguments, 1, stdout=b"", stderr=b"failed"),
            subprocess.CompletedProcess(arguments, 0, stdout=snapshot(*SAFE_ENDPOINTS), stderr=b"warn"),
        ):
            with self.assertRaises(POLICY.PhonePolicyError):
                POLICY.discover_listeners(lambda *_arguments, **_options: result)

    def test_documentation_keeps_policy_and_ingress_fail_closed(self) -> None:
        runbook = RUNBOOK.read_text(encoding="utf-8")
        mobile_readme = MOBILE_README.read_text(encoding="utf-8")
        for phrase in (
            "Never use Tailscale Funnel",
            "never applies the policy",
            "default allow-all",
            "tcp:443",
            "http://127.0.0.1:4000",
            "Certificate Transparency",
            "Name.com DNS remains unchanged",
            "tailscale up --shields-up",
            "tailscale get --json shields-up",
            "tailscale set --shields-up=false",
            "attended foreground private HTTPS",
        ):
            self.assertIn(phrase, runbook)
        self.assertNotIn("serve --bg", runbook)
        self.assertIn("physical-device-private-https.md", mobile_readme)


if __name__ == "__main__":
    unittest.main()
