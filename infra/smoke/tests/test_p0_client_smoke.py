from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
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
LEGACY_FLOW_IDS = (
    "unauthenticated-entry",
    "register",
    "sign-in",
    "session-restore",
    "unauthorized-session-rejection",
    "food-search",
    "diary-add-edit-delete",
    "diary-repeat",
    "diary-pagination",
    "recipe-create-revise-log",
    "goal-create-revise-progress",
    "retention-trends",
    "custom-food-create-revise-log",
    "biometric-create-edit-delete",
    "reminder-create-pause-revoke",
    "account-export-download",
    "sign-out-private-cleanup",
    "account-erasure",
    "erasure-status-after-session-revocation",
)
NEW_SHARED_FLOW_IDS = ("diary-group-configuration", "diary-day-note")


def instant(value: datetime) -> str:
    return value.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def compact(value: object) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


class CaptureBundle:
    def __init__(self, root: Path):
        self.root = root
        self.paths: dict[str, str] = {}
        self.values: dict[str, dict[str, object]] = {}
        observed = datetime(2026, 8, 26, tzinfo=timezone.utc)
        self.started_at = instant(observed)
        for role in SMOKE.CLIENT_ROLES:
            results = []
            for flow_id in SMOKE.FLOW_IDS_BY_CLIENT[role]:
                results.append(
                    {
                        "flowId": flow_id,
                        "outcome": "passed",
                        "observedAt": instant(observed),
                    }
                )
                observed += timedelta(minutes=1)
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

        self.executed_at = self.values["android"]["capturedAt"]
        self.completed_at = instant(observed)

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
            "startedAt": self.started_at,
            "executedAt": self.executed_at,
            "completedAt": self.completed_at,
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
        self.assertEqual(report["executedAt"], "2026-08-26T01:04:00.000Z")
        self.assertEqual(report["completedAt"], "2026-08-26T01:05:00.000Z")
        # Canonical JSON sorts object keys; role order is bound independently by
        # source_capture_bundle_sha256 and flow order remains array-significant.
        self.assertEqual(set(report["clients"]), set(SMOKE.CLIENT_ROLES))
        for role in SMOKE.CLIENT_ROLES:
            self.assertEqual(
                [result["flowId"] for result in report["clients"][role]["results"]],
                list(SMOKE.FLOW_IDS_BY_CLIENT[role]),
            )
            self.assertEqual(
                report["clients"][role]["captureSha256"],
                hashlib.sha256(Path(self.bundle.paths[role]).read_bytes()).hexdigest(),
            )

    def test_exact_role_inventories_preserve_all_legacy_ids_and_order(self) -> None:
        expected_browser = (
            "unauthenticated-entry", "register", "sign-in", "session-restore",
            "unauthorized-session-rejection", "food-search", "diary-add-edit-delete",
            "diary-repeat", "diary-pagination", "diary-group-configuration",
            "recipe-create-revise-log", "goal-create-revise-progress", "retention-trends",
            "custom-food-create-revise-log", "diary-day-note", "biometric-create-edit-delete",
            "reminder-create-pause-revoke", "account-export-download", "sign-out-private-cleanup",
            "account-erasure", "erasure-status-after-session-revocation",
        )
        expected_native = expected_browser[:6] + ("camera-barcode-capture",) + expected_browser[6:]
        self.assertEqual(dict(SMOKE.FLOW_IDS_BY_CLIENT), {
            "browser": expected_browser, "ios": expected_native, "android": expected_native,
        })
        self.assertEqual([len(SMOKE.FLOW_IDS_BY_CLIENT[role]) for role in SMOKE.CLIENT_ROLES], [21, 22, 22])
        for flows in SMOKE.FLOW_IDS_BY_CLIENT.values():
            self.assertIsInstance(flows, tuple)
            self.assertEqual(tuple(flow for flow in flows if flow in LEGACY_FLOW_IDS), LEGACY_FLOW_IDS)
        with self.assertRaises(TypeError):
            SMOKE.FLOW_IDS_BY_CLIENT["browser"] = expected_native

    def test_bundle_digest_has_fixed_role_order_and_binds_every_capture(self) -> None:
        raws = {
            role: Path(self.bundle.paths[role]).read_bytes() for role in SMOKE.CLIENT_ROLES
        }
        expected = SMOKE.source_capture_bundle_sha256(raws)
        self.assertEqual(SMOKE.REPORT_SCHEMA, "nutrition-tracker-p0-client-smoke-report-v3")
        self.assertEqual(SMOKE.REVIEW_PACKAGE_SCHEMA, "nutrition-tracker-p0-client-smoke-review-package-v3")
        self.assertEqual(SMOKE.CAPTURE_SCHEMA, "nutrition-tracker-p0-client-smoke-capture-v3")
        self.assertEqual(SMOKE.SOURCE_BUNDLE_SCHEMA, "nutrition-tracker-p0-client-smoke-source-capture-bundle-v3")
        suffix = "".join(f"{role}\n{hashlib.sha256(raws[role]).hexdigest()}\n" for role in ("browser", "ios", "android"))
        for version in (1, 2, 3):
            digest = hashlib.sha256(
                (f"nutrition-tracker-p0-client-smoke-source-capture-bundle-v{version}\n" + suffix).encode()
            ).hexdigest()
            if version == 3:
                self.assertEqual(expected, digest)
            else:
                self.assertNotEqual(expected, digest)
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

    def test_v3_cutover_rejects_old_or_unsupported_package_and_capture_schemas(self) -> None:
        for version in (1, 2, 4):
            with self.subTest(package=version):
                self.index = self.bundle.write()
                index = json.loads(self.index.read_text())
                index["schemaVersion"] = f"nutrition-tracker-p0-client-smoke-review-package-v{version}"
                self.index.write_bytes(compact(index))
                with self.assertRaisesRegex(SMOKE.P0SmokeError, "Review-package schema"):
                    SMOKE.normalize_candidate(str(self.index))
            for role in SMOKE.CLIENT_ROLES:
                with self.subTest(capture=version, role=role):
                    self.index = self.bundle.write()
                    self.rewrite(role, lambda value: value.update(
                        schemaVersion=f"nutrition-tracker-p0-client-smoke-capture-v{version}"
                    ))
                    with self.assertRaisesRegex(SMOKE.P0SmokeError, "capture schema"):
                        SMOKE.normalize_candidate(str(self.index))

    def test_rejects_each_missing_new_flow(self) -> None:
        for role in SMOKE.CLIENT_ROLES:
            additions = NEW_SHARED_FLOW_IDS + (() if role == "browser" else ("camera-barcode-capture",))
            for flow_id in additions:
                with self.subTest(role=role, flow=flow_id):
                    self.index = self.bundle.write()
                    self.rewrite(role, lambda value: value.update(
                        results=[row for row in value["results"] if row["flowId"] != flow_id]
                    ))
                    with self.assertRaisesRegex(SMOKE.P0SmokeError, "exact ordered P0 flow inventory"):
                        SMOKE.normalize_candidate(str(self.index))

    def test_rejects_other_roles_inventory_without_not_applicable_escape(self) -> None:
        for role, source in (("browser", "ios"), ("ios", "browser"), ("android", "browser")):
            with self.subTest(role=role, source=source):
                self.index = self.bundle.write()
                self.rewrite(role, lambda value: value.update(
                    results=self.bundle.values[source]["results"],
                    capturedAt=self.bundle.values[source]["capturedAt"],
                ))
                with self.assertRaisesRegex(SMOKE.P0SmokeError, "exact ordered P0 flow inventory"):
                    SMOKE.normalize_candidate(str(self.index))
        self.index = self.bundle.write()
        self.rewrite("ios", lambda value: value["results"][6].update(outcome="not-applicable"))
        with self.assertRaisesRegex(SMOKE.P0SmokeError, "ordered structural pass assertion"):
            SMOKE.normalize_candidate(str(self.index))

    def test_rejects_duplicate_or_reordered_new_flows_at_unchanged_count(self) -> None:
        for role in SMOKE.CLIENT_ROLES:
            additions = NEW_SHARED_FLOW_IDS + (() if role == "browser" else ("camera-barcode-capture",))
            for flow_id in additions:
                for mutation in ("duplicate", "reorder"):
                    with self.subTest(role=role, flow=flow_id, mutation=mutation):
                        self.index = self.bundle.write()
                        def mutate(value):
                            rows = value["results"]
                            position = next(i for i, row in enumerate(rows) if row["flowId"] == flow_id)
                            if mutation == "duplicate":
                                rows[position - 1]["flowId"] = flow_id
                            else:
                                rows[position - 1]["flowId"], rows[position]["flowId"] = (
                                    rows[position]["flowId"], rows[position - 1]["flowId"]
                                )
                        self.rewrite(role, mutate)
                        with self.assertRaisesRegex(SMOKE.P0SmokeError, "ordered structural pass assertion"):
                            SMOKE.normalize_candidate(str(self.index))

    def test_rejects_legacy_nineteen_flows_relabelled_as_v3(self) -> None:
        for role in SMOKE.CLIENT_ROLES:
            with self.subTest(role=role):
                self.index = self.bundle.write()
                self.rewrite(role, lambda value: value.update(
                    results=[row for row in value["results"] if row["flowId"] in LEGACY_FLOW_IDS]
                ))
                with self.assertRaisesRegex(SMOKE.P0SmokeError, "exact ordered P0 flow inventory"):
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
        for flows in SMOKE.FLOW_IDS_BY_CLIENT.values():
            for flow_id in flows:
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
