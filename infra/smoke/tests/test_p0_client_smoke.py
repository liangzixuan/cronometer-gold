from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from infra.smoke import p0_client_smoke as SMOKE


ROOT = Path(__file__).resolve().parents[3]
MODULE = ROOT / "infra" / "smoke" / "p0_client_smoke.py"
REFERENCE = ROOT / "infra" / "runbooks" / "p0-client-smoke.md"
COMMIT = "a" * 40
ORIGIN = "https://nutrition-api.tail1234.ts.net"
IOS_BUILD = "11111111-1111-4111-8111-111111111111"
ANDROID_BUILD = "22222222-2222-4222-8222-222222222222"


def compact(value: object) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


class CaptureBundle:
    def __init__(self, root: Path):
        self.root = root
        self.paths: dict[str, str] = {}
        self.values: dict[str, dict[str, object]] = {}
        for role_index, role in enumerate(SMOKE.CLIENT_ROLES):
            results = []
            for flow_index, flow_id in enumerate(SMOKE.FLOW_IDS):
                minute = role_index * 20 + flow_index
                results.append(
                    {
                        "flowId": flow_id,
                        "outcome": "passed",
                        "observedAt": f"2026-08-26T00:{minute:02d}:00.000Z",
                    }
                )
            self.values[role] = {
                "schemaVersion": SMOKE.CAPTURE_SCHEMA,
                "dataClassification": SMOKE.DATA_CLASSIFICATION,
                "client": role,
                "gitCommit": COMMIT,
                "apiOrigin": ORIGIN,
                "testedEasBuildId": (
                    None if role == "browser" else IOS_BUILD if role == "ios" else ANDROID_BUILD
                ),
                "capturedAt": results[-1]["observedAt"],
                "results": results,
            }

    def write(self) -> Path:
        self.root.mkdir(mode=0o700, exist_ok=True)
        for role in SMOKE.CLIENT_ROLES:
            path = self.root / f"{role}.json"
            path.write_bytes(compact(self.values[role]))
            path.chmod(0o600)
            self.paths[role] = str(path)
        index = {
            "schemaVersion": SMOKE.REVIEW_PACKAGE_SCHEMA,
            "trustBoundary": SMOKE.UNSIGNED_TRUST_BOUNDARY,
            "dataClassification": SMOKE.DATA_CLASSIFICATION,
            "gitCommit": COMMIT,
            "apiOrigin": ORIGIN,
            "startedAt": "2026-08-26T00:00:00.000Z",
            "executedAt": "2026-08-26T00:57:00.000Z",
            "completedAt": "2026-08-26T00:58:00.000Z",
            "buildIds": {"ios": IOS_BUILD, "android": ANDROID_BUILD},
            "captures": self.paths,
        }
        path = self.root / "index.json"
        path.write_bytes(compact(index))
        path.chmod(0o600)
        return path


class P0ClientSmokeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.bundle = CaptureBundle(Path(self.temporary.name))
        self.index = self.bundle.write()

    def rewrite(self, role: str, mutate) -> None:
        path = Path(self.bundle.paths[role])
        value = json.loads(path.read_text())
        mutate(value)
        path.write_bytes(compact(value))
        path.chmod(0o600)

    def test_emits_canonical_unsigned_synthetic_candidate(self) -> None:
        raw = SMOKE.normalize_candidate(str(self.index))
        report = json.loads(raw)
        self.assertEqual(raw, SMOKE._canonical(report))
        self.assertEqual(report["schemaVersion"], SMOKE.REPORT_SCHEMA)
        self.assertEqual(report["trustBoundary"], SMOKE.UNSIGNED_TRUST_BOUNDARY)
        self.assertEqual(report["dataClassification"], "synthetic-only")
        self.assertEqual(report["gitCommit"], COMMIT)
        self.assertEqual(report["apiOrigin"], ORIGIN)
        self.assertEqual(report["executedAt"], "2026-08-26T00:57:00.000Z")
        # Canonical JSON sorts object keys; role order is bound independently by
        # source_capture_bundle_sha256 and flow order remains array-significant.
        self.assertEqual(set(report["clients"]), set(SMOKE.CLIENT_ROLES))
        for role in SMOKE.CLIENT_ROLES:
            self.assertEqual(
                [result["flowId"] for result in report["clients"][role]["results"]],
                list(SMOKE.FLOW_IDS),
            )
            self.assertEqual(
                report["clients"][role]["captureSha256"],
                hashlib.sha256(Path(self.bundle.paths[role]).read_bytes()).hexdigest(),
            )

    def test_bundle_digest_has_fixed_role_order_and_binds_every_capture(self) -> None:
        raws = {
            role: Path(self.bundle.paths[role]).read_bytes() for role in SMOKE.CLIENT_ROLES
        }
        expected = SMOKE.source_capture_bundle_sha256(raws)
        self.assertEqual(
            expected,
            SMOKE.source_capture_bundle_sha256(dict(reversed(list(raws.items())))),
        )
        for role in SMOKE.CLIENT_ROLES:
            changed = {**raws, role: raws[role] + b" "}
            self.assertNotEqual(expected, SMOKE.source_capture_bundle_sha256(changed))

    def test_rejects_missing_reordered_failed_or_nonmonotonic_flow(self) -> None:
        mutations = (
            lambda value: value["results"].pop(),
            lambda value: value["results"].__setitem__(
                slice(0, 2), list(reversed(value["results"][:2]))
            ),
            lambda value: value["results"][5].update(outcome="failed"),
            lambda value: value["results"][5].update(
                observedAt=value["results"][3]["observedAt"]
            ),
        )
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                self.bundle = CaptureBundle(Path(self.temporary.name))
                self.index = self.bundle.write()
                self.rewrite("ios", mutate)
                with self.assertRaises(SMOKE.P0SmokeError):
                    SMOKE.normalize_candidate(str(self.index))

    def test_rejects_context_build_classification_and_timing_drift(self) -> None:
        cases = (
            ("browser", lambda value: value.update(apiOrigin="https://other.tail1234.ts.net")),
            ("ios", lambda value: value.update(testedEasBuildId=ANDROID_BUILD)),
            ("android", lambda value: value.update(gitCommit="b" * 40)),
            ("browser", lambda value: value.update(dataClassification="production")),
            ("android", lambda value: value.update(capturedAt="2026-08-26T00:56:00.000Z")),
        )
        for role, mutate in cases:
            with self.subTest(role=role):
                self.bundle = CaptureBundle(Path(self.temporary.name))
                self.index = self.bundle.write()
                self.rewrite(role, mutate)
                with self.assertRaises(SMOKE.P0SmokeError):
                    SMOKE.normalize_candidate(str(self.index))

    def test_rejects_unsafe_paths_modes_duplicate_inodes_and_ambiguous_json(self) -> None:
        Path(self.bundle.paths["ios"]).chmod(0o644)
        with self.assertRaisesRegex(SMOKE.P0SmokeError, "mode 0600"):
            SMOKE.normalize_candidate(str(self.index))

        self.bundle = CaptureBundle(Path(self.temporary.name))
        self.index = self.bundle.write()
        index = json.loads(self.index.read_text())
        index["captures"]["android"] = index["captures"]["ios"]
        self.index.write_bytes(compact(index))
        self.index.chmod(0o600)
        with self.assertRaisesRegex(SMOKE.P0SmokeError, "distinct"):
            SMOKE.normalize_candidate(str(self.index))

        self.bundle = CaptureBundle(Path(self.temporary.name))
        self.index = self.bundle.write()
        browser = Path(self.bundle.paths["browser"])
        browser.write_text(browser.read_text().replace('{"apiOrigin":', '{"client":"browser","apiOrigin":', 1))
        browser.chmod(0o600)
        with self.assertRaisesRegex(SMOKE.P0SmokeError, "duplicate key"):
            SMOKE.normalize_candidate(str(self.index))

        with mock.patch.object(os, "O_NOFOLLOW", new=None, create=False):
            with self.assertRaisesRegex(SMOKE.P0SmokeError, "no-follow"):
                SMOKE.normalize_candidate(str(self.index))

    def test_direct_cli_emits_candidate_with_fixed_warning(self) -> None:
        raw = SMOKE.normalize_candidate(str(self.index))
        result = subprocess.run(
            [
                sys.executable,
                "-B",
                str(MODULE),
                "--capture-index",
                str(self.index),
                "--acknowledge-unsigned-candidate",
            ],
            cwd=ROOT,
            capture_output=True,
            check=False,
            timeout=5,
        )
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, raw)
        self.assertEqual(
            result.stderr,
            b"Unsigned synthetic P0 smoke candidate only; independent trusted Ed25519 health-manifest review remains required.\n",
        )

    def test_reference_documents_every_role_flow_and_unsigned_boundary(self) -> None:
        reference = REFERENCE.read_text(encoding="utf-8")
        for role in SMOKE.CLIENT_ROLES:
            self.assertIn(f"`{role}`", reference)
        for flow_id in SMOKE.FLOW_IDS:
            self.assertIn(f"`{flow_id}`", reference)
        for phrase in (
            SMOKE.REPORT_SCHEMA,
            SMOKE.REVIEW_PACKAGE_SCHEMA,
            SMOKE.CAPTURE_SCHEMA,
            SMOKE.UNSIGNED_TRUST_BOUNDARY,
            "mode `0600`",
            "does not authenticate",
            "independent reviewer",
        ):
            self.assertIn(phrase, reference)


if __name__ == "__main__":
    unittest.main()
