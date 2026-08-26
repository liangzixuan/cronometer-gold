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

from infra.tailscale import phone_policy as POLICY
from infra.tailscale import relay_evidence as RELAY


ROOT = Path(__file__).resolve().parents[3]
RUNBOOK = ROOT / "infra" / "runbooks" / "physical-device-private-https.md"
MODULE = ROOT / "infra" / "tailscale" / "relay_evidence.py"
REFERENCE = ROOT / "infra" / "tailscale" / "relay-review-package-v1.md"
IOS_BUILD = "11111111-1111-4111-8111-111111111111"
ANDROID_BUILD = "22222222-2222-4222-8222-222222222222"
ORIGIN = "https://nutrition-api.tail1234.ts.net"
LISTENER_BYTES = b"".join(
    f"p{index}\nn{endpoint}\n".encode()
    for index, endpoint in enumerate(
        (
            "127.0.0.1:4000",
            "127.0.0.1:4566",
            "127.0.0.1:5432",
            "127.0.0.1:7700",
            "127.0.0.1:9000",
            "127.0.0.1:9001",
            "*:2181",
            "*:8080",
            "*:9092",
            "[::1]:49152",
        ),
        start=100,
    )
)


def compact(value: object) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def capture(kind: str, captured_at: str, **fields: object) -> dict[str, object]:
    return {
        "schemaVersion": f"nutrition-tracker-tailscale-{kind}-capture-v1",
        "capturedAt": captured_at,
        **fields,
    }


def empty_graph(kind: str, captured_at: str) -> dict[str, object]:
    return capture(
        kind,
        captured_at,
        persistent={"TCP": {}, "Web": {}, "Services": {}, "AllowFunnel": {}},
        foreground=[],
    )


def active_graph(kind: str, captured_at: str) -> dict[str, object]:
    value = empty_graph(kind, captured_at)
    value["foreground"] = [
        {
            "mode": "foreground",
            "httpsPort": 443,
            "handlerPath": "/",
            "upstream": "http://127.0.0.1:4000",
            "allowFunnel": False,
            "services": [],
        }
    ]
    return value


def device(alias: str, node: str, ip: str, connected: bool = True) -> dict[str, object]:
    dns_names = {
        "nutrition-tracker-mac": "nutrition-api.tail1234.ts.net",
        "nutrition-tracker-phone-1": "ios-phone.tail1234.ts.net",
        "nutrition-tracker-phone-2": "android-phone.tail1234.ts.net",
    }
    return {
        "alias": alias,
        "nodeId": node,
        "userPrincipal": "reviewer@example.edu",
        "tailscaleIpv4": ip,
        "dnsName": dns_names[alias],
        "connected": connected,
    }


def identity_capture(captured_at: str, *, mac_connected: bool = True) -> dict[str, object]:
    return capture(
        "identities",
        captured_at,
        devices={
            "nutrition-tracker-mac": device(
                "nutrition-tracker-mac", "node-mac-reviewed", "100.64.0.20", mac_connected
            ),
            "nutrition-tracker-phone-1": device(
                "nutrition-tracker-phone-1", "node-ios-reviewed", "100.64.0.10"
            ),
            "nutrition-tracker-phone-2": device(
                "nutrition-tracker-phone-2", "node-android-reviewed", "100.64.0.11"
            ),
        },
    )


class CaptureBundle:
    def __init__(self, root: Path):
        self.root = root
        self.values: dict[str, object | bytes] = {}
        self.paths: dict[str, str] = {}
        listeners = POLICY.parse_lsof_snapshot(LISTENER_BYTES)
        policy = POLICY.build_phone_policy(
            ["100.64.0.10", "100.64.0.11"], "100.64.0.20", listeners
        )
        policy_raw = compact(policy)
        policy_sha = digest(policy_raw)
        event = capture(
            "configuration-event",
            "2026-08-26T00:01:00.000Z",
            eventId="config-event-reviewed-1",
            eventType="policy-update",
            outcome="applied",
            policySha256=policy_sha,
        )
        event_raw = compact(event)
        event_sha = digest(event_raw)
        ports = sorted(
            POLICY.BASELINE_DENIED_TCP_PORTS
            | {listener.port for listener in listeners if listener.port != 443}
        )
        self.values.update(
            {
                "preflightShields": capture(
                    "preflight-shields",
                    "2026-08-26T00:00:10.000Z",
                    shieldsUp=True,
                    firstConnection=True,
                ),
                "preflightServe": empty_graph("serve", "2026-08-26T00:00:20.000Z"),
                "preflightFunnel": empty_graph("funnel", "2026-08-26T00:00:30.000Z"),
                "preflightIdentities": identity_capture("2026-08-26T00:00:40.000Z"),
                "activeShields": capture(
                    "active-shields", "2026-08-26T00:04:10.000Z", shieldsUp=False
                ),
                "activeServe": active_graph("serve", "2026-08-26T00:04:20.000Z"),
                "activeFunnel": active_graph("funnel", "2026-08-26T00:04:30.000Z"),
                "activeIdentities": identity_capture("2026-08-26T00:03:00.000Z"),
                "policy": policy_raw,
                "configurationEvent": event_raw,
                "listenerSnapshot": LISTENER_BYTES,
                "teardownServe": empty_graph("serve", "2026-08-26T00:08:10.000Z"),
                "teardownFunnel": empty_graph("funnel", "2026-08-26T00:08:20.000Z"),
                "teardownShields": capture(
                    "teardown-shields", "2026-08-26T00:08:30.000Z", shieldsUp=True
                ),
                "teardownDisconnect": identity_capture(
                    "2026-08-26T00:08:40.000Z", mac_connected=False
                ),
                "accessTimeline": capture(
                    "access-timeline",
                    "2026-08-26T00:04:00.000Z",
                    policyAppliedAt="2026-08-26T00:01:00.000Z",
                    policyTestsPassedAt="2026-08-26T00:02:00.000Z",
                    identitiesRevalidatedAt="2026-08-26T00:03:00.000Z",
                    incomingEnabledAt="2026-08-26T00:04:00.000Z",
                    shieldsUpBeforePolicy=True,
                    policyTestsResult="passed",
                    unapprovedPeerHttps443="blocked",
                    policySha256=policy_sha,
                    configurationLogEventSha256=event_sha,
                    activeShieldsSha256="pending",
                    activeIdentityStatusSha256="pending",
                    listenerSnapshotSha256="pending",
                    listenerCapturedAt="2026-08-26T00:00:50.000Z",
                    iosProbeSha256="pending",
                    androidProbeSha256="pending",
                ),
            }
        )
        for platform, alias, node, ip, build_id, at in (
            (
                "ios",
                "nutrition-tracker-phone-1",
                "node-ios-reviewed",
                "100.64.0.10",
                IOS_BUILD,
                "2026-08-26T00:06:00.000Z",
            ),
            (
                "android",
                "nutrition-tracker-phone-2",
                "node-android-reviewed",
                "100.64.0.11",
                ANDROID_BUILD,
                "2026-08-26T00:07:00.000Z",
            ),
        ):
            self.values[f"{platform}Probe"] = capture(
                f"{platform}-probe",
                at,
                platform=platform,
                phoneAlias=alias,
                testedEasBuildId=build_id,
                nodeId=node,
                tailscaleIpv4=ip,
                apiOrigin=ORIGIN,
                publicCaAndHostname="passed",
                readyHttpStatus=200,
                openTcpPorts=[443],
                blockedTcpPorts=ports,
                tailscaleDisabledHttps="blocked",
                policySha256=policy_sha,
                configurationLogEventSha256=event_sha,
            )

    def write(self) -> Path:
        self.root.mkdir(mode=0o700, exist_ok=True)
        for name in RELAY.CAPTURE_NAMES:
            path = self.root / f"{name}.capture"
            raw = self.values[name] if isinstance(self.values[name], bytes) else compact(self.values[name])
            path.write_bytes(raw)
            path.chmod(0o600)
            self.paths[name] = str(path)
        timeline = json.loads((self.root / "accessTimeline.capture").read_text())
        timeline["activeShieldsSha256"] = digest((self.root / "activeShields.capture").read_bytes())
        timeline["activeIdentityStatusSha256"] = digest(
            (self.root / "activeIdentities.capture").read_bytes()
        )
        timeline["listenerSnapshotSha256"] = digest(
            (self.root / "listenerSnapshot.capture").read_bytes()
        )
        timeline["iosProbeSha256"] = digest((self.root / "iosProbe.capture").read_bytes())
        timeline["androidProbeSha256"] = digest(
            (self.root / "androidProbe.capture").read_bytes()
        )
        (self.root / "accessTimeline.capture").write_bytes(compact(timeline))
        (self.root / "accessTimeline.capture").chmod(0o600)
        index = {
            "schemaVersion": RELAY.REVIEW_PACKAGE_SCHEMA,
            "trustBoundary": RELAY.UNSIGNED_TRUST_BOUNDARY,
            "apiOrigin": ORIGIN,
            "startedAt": "2026-08-26T00:00:00.000Z",
            "executedAt": "2026-08-26T00:08:00.000Z",
            "completedAt": "2026-08-26T00:10:00.000Z",
            "buildIds": {"ios": IOS_BUILD, "android": ANDROID_BUILD},
            "captures": self.paths,
        }
        index_path = self.root / "index.json"
        index_path.write_bytes(compact(index))
        index_path.chmod(0o600)
        return index_path


class RelayEvidenceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.bundle = CaptureBundle(Path(self.temporary.name))
        self.index = self.bundle.write()

    def rewrite(self, name: str, mutate) -> None:
        path = Path(self.bundle.paths[name])
        value = json.loads(path.read_text())
        mutate(value)
        path.write_bytes(compact(value))
        path.chmod(0o600)

    def test_emits_only_canonical_redacted_v2_unsigned_candidate(self) -> None:
        raw = RELAY.normalize_relay_report_candidate(str(self.index))
        report = json.loads(raw)
        self.assertEqual(raw, RELAY._canonical(report))
        self.assertEqual(report["schemaVersion"], RELAY.REPORT_SCHEMA)
        self.assertEqual(report["trustBoundary"], RELAY.UNSIGNED_TRUST_BOUNDARY)
        self.assertEqual(
            report["sourceCaptureBundleSha256"],
            RELAY._source_capture_bundle_sha256(
                {
                    name: Path(self.bundle.paths[name]).read_bytes()
                    for name in RELAY.CAPTURE_NAMES
                }
            ),
        )
        self.assertEqual(report["apiOrigin"], ORIGIN)
        self.assertEqual(report["executedAt"], "2026-08-26T00:08:00.000Z")
        self.assertEqual(report["serve"]["upstream"], "http://127.0.0.1:4000")
        self.assertEqual(report["deviceProbes"]["ios"]["testedEasBuildId"], IOS_BUILD)
        self.assertEqual(report["deviceProbes"]["android"]["testedEasBuildId"], ANDROID_BUILD)
        for secret in (
            "100.64.0.10",
            "100.64.0.11",
            "100.64.0.20",
            "node-ios-reviewed",
            "node-android-reviewed",
            "reviewer@example.edu",
            "ios-phone.tail1234.ts.net",
            "android-phone.tail1234.ts.net",
        ):
            self.assertNotIn(secret, raw.decode())

    def test_direct_cli_emits_unsigned_candidate_with_fixed_warning(self) -> None:
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
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertEqual(
            result.stderr,
            b"Unsigned structural candidate only; independent trusted Ed25519 manifest review remains required.\n",
        )
        self.assertEqual(
            result.stdout, RELAY.normalize_relay_report_candidate(str(self.index))
        )
        # Guard the process-launch surfaces most likely to be introduced by accident;
        # the module's no-invocation boundary is also enforced by code review.
        source = MODULE.read_text(encoding="utf-8")
        for forbidden in ("import subprocess", "os.system", "Popen(", "execFile", "serve --", "funnel --", "shields-up="):
            self.assertNotIn(forbidden, source)

    def test_source_capture_bundle_digest_binds_all_ordered_role_bytes(self) -> None:
        raws = {role: f"{role}-capture\n".encode() for role in RELAY.CAPTURE_NAMES}
        expected = RELAY._source_capture_bundle_sha256(raws)
        self.assertEqual(
            RELAY._source_capture_bundle_sha256(dict(reversed(tuple(raws.items())))),
            expected,
        )
        for role in RELAY.CAPTURE_NAMES:
            with self.subTest(role=role):
                changed = dict(raws)
                changed[role] += b"changed"
                self.assertNotEqual(
                    RELAY._source_capture_bundle_sha256(changed), expected
                )

    def test_rejects_broad_or_overlapping_full_policy(self) -> None:
        policy_path = Path(self.bundle.paths["policy"])
        policy = json.loads(policy_path.read_text())
        policy["acls"] = [{"action": "accept", "src": ["*"], "dst": ["*:*" ]}]
        policy_path.write_bytes(compact(policy))
        with self.assertRaisesRegex(RELAY.RelayEvidenceError, "default allow, overlap"):
            RELAY.normalize_relay_report_candidate(str(self.index))

    def test_rejects_identity_or_connection_discontinuity(self) -> None:
        for name, mutation in (
            ("activeIdentities", lambda value: value["devices"]["nutrition-tracker-phone-1"].update(connected=False)),
            ("activeIdentities", lambda value: value["devices"]["nutrition-tracker-phone-2"].update(tailscaleIpv4="100.64.0.12")),
            ("teardownDisconnect", lambda value: value["devices"]["nutrition-tracker-mac"].update(connected=True)),
        ):
            with self.subTest(name=name):
                self.bundle = CaptureBundle(Path(self.temporary.name))
                self.index = self.bundle.write()
                self.rewrite(name, mutation)
                with self.assertRaises(RELAY.RelayEvidenceError):
                    RELAY.normalize_relay_report_candidate(str(self.index))

    def test_rejects_origin_not_bound_to_reviewed_mac_dns_identity(self) -> None:
        for name in ("preflightIdentities", "activeIdentities", "teardownDisconnect"):
            self.rewrite(
                name,
                lambda value: value["devices"]["nutrition-tracker-mac"].update(
                    dnsName="other-mac.tail1234.ts.net"
                ),
            )
        with self.assertRaisesRegex(RELAY.RelayEvidenceError, "origin does not belong"):
            RELAY.normalize_relay_report_candidate(str(self.index))

    def test_rejects_persistent_funnel_wrong_route_or_non_object_empty_state(self) -> None:
        for name, mutation in (
            ("activeServe", lambda value: value["foreground"][0].update(upstream="http://0.0.0.0:4000")),
            ("activeFunnel", lambda value: value["persistent"]["AllowFunnel"].update({"443": True})),
            ("preflightServe", lambda value: value["persistent"]["TCP"].update({"443": "configured"})),
            ("preflightServe", lambda value: value["persistent"].__setitem__("TCP", [])),
            ("preflightServe", lambda value: value["persistent"].__setitem__("Web", [])),
            ("preflightServe", lambda value: value["persistent"].__setitem__("Services", [])),
            ("preflightServe", lambda value: value["persistent"].__setitem__("AllowFunnel", [])),
        ):
            with self.subTest(name=name):
                self.bundle = CaptureBundle(Path(self.temporary.name))
                self.index = self.bundle.write()
                self.rewrite(name, mutation)
                with self.assertRaises(RELAY.RelayEvidenceError):
                    RELAY.normalize_relay_report_candidate(str(self.index))

    def test_rejects_missing_unsigned_trust_boundary_or_operator_review_time(self) -> None:
        index = json.loads(self.index.read_text())
        index["trustBoundary"] = "trusted"
        self.index.write_bytes(compact(index))
        self.index.chmod(0o600)
        with self.assertRaisesRegex(RELAY.RelayEvidenceError, "unsigned trust boundary"):
            RELAY.normalize_relay_report_candidate(str(self.index))

        self.bundle = CaptureBundle(Path(self.temporary.name))
        self.index = self.bundle.write()
        index = json.loads(self.index.read_text())
        index["reviewedAt"] = "2026-08-26T00:11:00.000Z"
        self.index.write_bytes(compact(index))
        self.index.chmod(0o600)
        with self.assertRaisesRegex(RELAY.RelayEvidenceError, "exact reviewed fields"):
            RELAY.normalize_relay_report_candidate(str(self.index))

    def test_rejects_probe_gaps_and_build_swaps(self) -> None:
        for name, mutation in (
            ("iosProbe", lambda value: value.update(testedEasBuildId=ANDROID_BUILD)),
            ("androidProbe", lambda value: value.update(openTcpPorts=[80, 443])),
            ("iosProbe", lambda value: value["blockedTcpPorts"].pop()),
            ("androidProbe", lambda value: value.update(tailscaleDisabledHttps="passed")),
        ):
            with self.subTest(name=name):
                self.bundle = CaptureBundle(Path(self.temporary.name))
                self.index = self.bundle.write()
                self.rewrite(name, mutation)
                with self.assertRaises(RELAY.RelayEvidenceError):
                    RELAY.normalize_relay_report_candidate(str(self.index))

    def test_rejects_access_or_phase_sequence_changes(self) -> None:
        self.rewrite(
            "accessTimeline",
            lambda value: value.update(incomingEnabledAt="2026-08-26T00:01:30.000Z"),
        )
        with self.assertRaisesRegex(RELAY.RelayEvidenceError, "timeline"):
            RELAY.normalize_relay_report_candidate(str(self.index))

        self.bundle = CaptureBundle(Path(self.temporary.name))
        self.index = self.bundle.write()
        self.rewrite(
            "accessTimeline",
            lambda value: value.update(capturedAt="2026-08-25T00:04:00.000Z"),
        )
        with self.assertRaisesRegex(RELAY.RelayEvidenceError, "timeline"):
            RELAY.normalize_relay_report_candidate(str(self.index))

    def test_rejects_non_integer_json_and_wraps_listener_failures(self) -> None:
        active_path = Path(self.bundle.paths["activeServe"])
        active_path.write_text(active_path.read_text().replace("443", "443.0", 1))
        active_path.chmod(0o600)
        with self.assertRaisesRegex(RELAY.RelayEvidenceError, "finite integers"):
            RELAY.normalize_relay_report_candidate(str(self.index))

        self.bundle = CaptureBundle(Path(self.temporary.name))
        self.index = self.bundle.write()
        listener_path = Path(self.bundle.paths["listenerSnapshot"])
        listener_path.write_bytes(b"not-an-lsof-record\n")
        listener_path.chmod(0o600)
        with self.assertRaisesRegex(RELAY.RelayEvidenceError, "Listener capture"):
            RELAY.normalize_relay_report_candidate(str(self.index))
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
        self.assertEqual(result.returncode, 1)
        self.assertNotIn(b"Traceback", result.stderr)

    def test_rejects_symlink_wrong_mode_duplicate_inode_and_missing_nofollow(self) -> None:
        target = Path(self.bundle.paths["iosProbe"])
        replacement = target.with_suffix(".link")
        replacement.symlink_to(target)
        index = json.loads(self.index.read_text())
        index["captures"]["iosProbe"] = str(replacement)
        self.index.write_bytes(compact(index))
        self.index.chmod(0o600)
        with self.assertRaises(RELAY.RelayEvidenceError):
            RELAY.normalize_relay_report_candidate(str(self.index))

        self.bundle = CaptureBundle(Path(self.temporary.name))
        self.index = self.bundle.write()
        Path(self.bundle.paths["iosProbe"]).chmod(0o644)
        with self.assertRaisesRegex(RELAY.RelayEvidenceError, "mode 0600"):
            RELAY.normalize_relay_report_candidate(str(self.index))

        self.bundle = CaptureBundle(Path(self.temporary.name))
        self.index = self.bundle.write()
        index = json.loads(self.index.read_text())
        index["captures"]["androidProbe"] = index["captures"]["iosProbe"]
        self.index.write_bytes(compact(index))
        self.index.chmod(0o600)
        with self.assertRaisesRegex(RELAY.RelayEvidenceError, "distinct"):
            RELAY.normalize_relay_report_candidate(str(self.index))

        with mock.patch.object(os, "O_NOFOLLOW", new=None, create=False):
            with self.assertRaises(RELAY.RelayEvidenceError):
                RELAY._secure_read(str(self.index), "index")

        for unsafe_path in ("/tmp/nul\x00capture", "/" + "x" * 4097):
            with self.subTest(unsafe_path=unsafe_path[:20]):
                with self.assertRaisesRegex(RELAY.RelayEvidenceError, "bounded path"):
                    RELAY._secure_read(unsafe_path, "index")

    def test_runbook_documents_capture_only_boundary(self) -> None:
        runbook = RUNBOOK.read_text(encoding="utf-8")
        for phrase in (
            "relay_evidence.py",
            "review-package index",
            "mode `0600`",
            "never invokes Tailscale",
            "two build-bound phone probes",
            "unsigned structural candidate",
            "sourceCaptureBundleSha256",
            "independent trusted reviewer",
        ):
            self.assertIn(phrase, runbook)

    def test_reference_covers_every_role_and_is_not_an_accepted_capture(self) -> None:
        reference = REFERENCE.read_text(encoding="utf-8")
        self.assertIn(
            "deliberately Markdown, not an accepted capture or index",
            " ".join(reference.split()),
        )
        self.assertIn(RELAY.REVIEW_PACKAGE_SCHEMA, reference)
        self.assertIn(RELAY.UNSIGNED_TRUST_BOUNDARY, reference)
        timeline_fields = ", ".join(
            f"`{field}`" for field in RELAY.ACCESS_TIMELINE_FIELDS
        )
        self.assertIn(
            "| `accessTimeline` | "
            "`nutrition-tracker-tailscale-access-timeline-capture-v1` | "
            f"{timeline_fields} |",
            reference,
        )
        for role in RELAY.CAPTURE_NAMES:
            with self.subTest(role=role):
                self.assertIn(f"| `{role}` |", reference)
                self.assertIn(f'"{role}"', reference)
        with self.assertRaises(RELAY.RelayEvidenceError):
            RELAY._json(reference.encode("utf-8"), "reference")


if __name__ == "__main__":
    unittest.main()
