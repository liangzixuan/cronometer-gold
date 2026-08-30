from __future__ import annotations

import ast
import copy
import hashlib
import json
import unittest
from dataclasses import replace
from pathlib import Path
from types import MappingProxyType

from infra.tailscale import windows_install_snapshot as SNAPSHOT


ROOT = Path(__file__).resolve().parents[3]
MODULE = ROOT / "infra" / "tailscale" / "windows_install_snapshot.py"
CHALLENGE = "0123456789abcdef0123456789abcdef"
OTHER_CHALLENGE = "fedcba9876543210fedcba9876543210"
BOOT_COMMITMENT = hashlib.sha256(b"synthetic-boot-session").hexdigest()
SYNTHETIC_RAW_DOMAIN = "nutrition-tracker-windows-tailscale-install-synthetic-raw-v1"


def _canonical(value: object) -> bytes:
    return (
        json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
            sort_keys=True,
        )
        + "\n"
    ).encode("utf-8")


def _commitment(value: object) -> str:
    return hashlib.sha256(_canonical(value)).hexdigest()


def _host_environment() -> dict[str, object]:
    return {
        "windowsVersion": "10.0.26200.9168",
        "powershellVersion": "7.6.4",
        "wslVersion": "2.6.1.0",
        "wslKernelVersion": "6.6.87.2-microsoft-standard-WSL2",
        "wslDistribution": "Ubuntu-24.04",
        "wsl2Enabled": True,
        "wslDistributionRunning": True,
        "wslTailscaleInstalled": False,
        "dockerDesktopVersion": "4.45.0",
        "dockerEngineVersion": "28.3.3",
        "dockerContext": "desktop-linux",
        "dockerDesktopRunning": True,
        "dockerLinuxContainers": True,
        "dockerDesktopWslIntegration": True,
        "secondWslDockerEngineInstalled": False,
    }


def _listeners() -> list[dict[str, object]]:
    values = [
        {
            "scope": "windows-host",
            "addressClass": "ipv4-loopback",
            "port": 4000,
            "protocol": "tcp",
            "ownerClass": "project-api",
            "ownerCommitmentSha256": hashlib.sha256(b"api-owner").hexdigest(),
            "ownerBinarySha256": hashlib.sha256(b"api-binary").hexdigest(),
        },
        {
            "scope": "wsl2-ubuntu",
            "addressClass": "ipv4-loopback",
            "port": 5432,
            "protocol": "tcp",
            "ownerClass": "project-dependency",
            "ownerCommitmentSha256": hashlib.sha256(b"db-owner").hexdigest(),
            "ownerBinarySha256": hashlib.sha256(b"db-binary").hexdigest(),
        },
    ]
    return sorted(
        values,
        key=lambda item: (
            item["scope"],
            item["addressClass"],
            item["protocol"],
            item["port"],
            item["ownerClass"],
            item["ownerCommitmentSha256"],
            item["ownerBinarySha256"],
        ),
    )


def _boundaries() -> dict[str, object]:
    return {
        "windowsFirewallSha256": "1" * 64,
        "hyperVFirewallSha256": "2" * 64,
        "forwardingSha256": "3" * 64,
        "hnsSha256": "4" * 64,
        "dockerSha256": "5" * 64,
        "nonTailscaleServicesSha256": "6" * 64,
        "nonTailscaleAdaptersSha256": "7" * 64,
        "windowsFirewallProfilesEnabled": True,
        "hyperVFirewallAvailable": True,
        "hyperVFirewallDefaultInboundBlocked": True,
        "portProxyEntriesPresent": False,
        "windowsIpForwardingEnabled": False,
        "hnsExternalForwardingPresent": False,
        "dockerPublishedPortsPresent": False,
        "dockerHostNetworkContainersPresent": False,
    }


INSTALLER_PATH = (
    r"C:\ProgramData\NutritionTracker\TestFixtures\test-tailscale-1.102.3.msi"
)
CLIENT_PATH = r"C:\Program Files\Tailscale Test\tailscale.exe"
DAEMON_PATH = r"C:\Program Files\Tailscale Test\tailscaled.exe"
DRIVER_PATH = r"C:\Windows\System32\drivers\testtailscale.sys"
CATALOG_PATH = (
    r"C:\Windows\System32\DriverStore\FileRepository\testtailscale\testtailscale.cat"
)
COLLECTOR_SOURCE_IDENTITY_SHA256 = (
    "de6d21f37b1922dbfb8d22e27932443c190ca0985e5d524774feb14b4e26fb18"
)


def _artifacts() -> tuple[SNAPSHOT.ArtifactExpectation, ...]:
    paths = (INSTALLER_PATH, CLIENT_PATH, DAEMON_PATH, DRIVER_PATH, CATALOG_PATH)
    hashes = (SNAPSHOT.EXPECTED_INSTALLER_SHA256, "1" * 64, "2" * 64, "3" * 64, "4" * 64)
    signers = ("a" * 64, "b" * 64, "c" * 64, "d" * 64, "e" * 64)
    return tuple(
        SNAPSHOT.ArtifactExpectation(role, path, digest, "Valid", signer)
        for role, path, digest, signer in zip(
            SNAPSHOT.ARTIFACT_ROLES, paths, hashes, signers, strict=True
        )
    )


def _source_corpora() -> tuple[SNAPSHOT.SourceCorpusExpectation, ...]:
    return tuple(
        SNAPSHOT.SourceCorpusExpectation(
            role,
            SNAPSHOT.SOURCE_SCHEMAS[role],
            hashlib.sha256(f"parser-corpus:{role}".encode()).hexdigest(),
        )
        for role in SNAPSHOT.RAW_SOURCE_ROLES
    )


def _test_corpus() -> SNAPSHOT.InstallArtifactCorpus:
    return SNAPSHOT.InstallArtifactCorpus(
        corpus_id="test-windows-tailscale-1.102.3-v1",
        corpus_kind="test",
        schema_version=SNAPSHOT.INSTALL_ARTIFACT_CORPUS_SCHEMA,
        review_source_bundle_sha256=hashlib.sha256(
            b"synthetic-corpus-review-source-bundle"
        ).hexdigest(),
        collector_schema=SNAPSHOT.COLLECTOR_SCHEMA,
        collector_source_sha256=COLLECTOR_SOURCE_IDENTITY_SHA256,
        tailscale_version=SNAPSHOT.EXPECTED_TAILSCALE_VERSION,
        artifacts=_artifacts(),
        service_path=DAEMON_PATH,
        service_argv=(DAEMON_PATH,),
        approved_host_environment_sha256=_commitment(_host_environment()),
        approved_listener_inventory_sha256=_commitment(_listeners()),
        approved_boundary_state_sha256=_commitment(_boundaries()),
        source_corpora=_source_corpora(),
    )


TEST_CORPUS = _test_corpus()
TEST_CORPORA = MappingProxyType({TEST_CORPUS.corpus_id: TEST_CORPUS})


def _corpus_sha256(corpus: SNAPSHOT.InstallArtifactCorpus = TEST_CORPUS) -> str:
    return _commitment(SNAPSHOT._corpus_value(corpus))


def _session(phase: str, corpus: SNAPSHOT.InstallArtifactCorpus = TEST_CORPUS) -> dict[str, object]:
    challenge_sha256 = SNAPSHOT.challenge_commitment(CHALLENGE)
    corpus_sha256 = _corpus_sha256(corpus)
    session_sha256 = SNAPSHOT.session_commitment(
        challenge_sha256,
        BOOT_COMMITMENT,
        corpus_sha256,
        corpus.collector_source_sha256,
    )
    sequence = 1 if phase == "preinstall" else 2
    return {
        "artifactCorpusId": corpus.corpus_id,
        "artifactCorpusSha256": corpus_sha256,
        "bootSessionCommitmentSha256": BOOT_COMMITMENT,
        "challengeCommitmentSha256": challenge_sha256,
        "collectorSchema": corpus.collector_schema,
        "collectorSourceSha256": corpus.collector_source_sha256,
        "sequence": sequence,
        "monotonicMilliseconds": 10_000 if phase == "preinstall" else 310_000,
        "sessionCommitmentSha256": session_sha256,
    }


def _raw_sources(phase: str, session: dict[str, object]) -> dict[str, object]:
    by_role = {item.role: item for item in TEST_CORPUS.source_corpora}
    result: dict[str, object] = {}
    for role in SNAPSHOT.RAW_SOURCE_ROLES:
        expectation = by_role[role]
        raw_sha256 = SNAPSHOT._domain_commitment(
            SYNTHETIC_RAW_DOMAIN,
            [
                phase,
                str(session["sequence"]),
                role,
                str(session["sessionCommitmentSha256"]),
            ],
        )
        result[role] = {
            "schemaVersion": expectation.schema_version,
            "rawSha256": raw_sha256,
            "parserCorpusSha256": expectation.parser_corpus_sha256,
            "captureCommitmentSha256": SNAPSHOT.raw_capture_commitment(
                session["sessionCommitmentSha256"],  # type: ignore[arg-type]
                phase,
                session["sequence"],  # type: ignore[arg-type]
                role,
                raw_sha256,
                expectation.parser_corpus_sha256,
            ),
        }
    return result


def _residual_state() -> dict[str, bool]:
    return {
        "productRegistrationPresent": False,
        "servicePresent": False,
        "adapterPresent": False,
        "programFilesPresent": False,
        "programDataPresent": False,
        "registryResidualPresent": False,
        "scheduledTaskPresent": False,
        "firewallRulePresent": False,
        "dnsPolicyPresent": False,
        "routePresent": False,
        "uiProcessPresent": False,
        "updateMechanismPresent": False,
    }


def _safety_state() -> dict[str, bool]:
    return {
        "loginPresent": False,
        "tailnetIdentityPresent": False,
        "serveConfigured": False,
        "funnelConfigured": False,
        "tailnetRoutesPresent": False,
        "tailnetDnsConfigured": False,
        "uiProcessRunning": False,
        "updateMechanismEnabled": False,
        "incomingConnectionsAllowed": False,
        "tailnetAddressPresent": False,
    }


def _artifact_values() -> list[dict[str, str]]:
    return [
        {
            "role": artifact.role,
            "path": artifact.path,
            "sha256": artifact.sha256,
            "signatureStatus": artifact.signature_status,
            "signerIdentitySha256": artifact.signer_identity_sha256,
        }
        for artifact in TEST_CORPUS.artifacts
    ]


def _installer_execution(phase: str) -> dict[str, object]:
    return {
        "executablePath": SNAPSHOT.MSIEXEC_PATH,
        "argv": ["/i", INSTALLER_PATH, *SNAPSHOT.MSI_FIXED_ARGUMENTS],
        "elevated": True,
        "result": None
        if phase == "preinstall"
        else {
            "exitCode": 0,
            "processExitObserved": True,
            "restartRequired": False,
            "restartInitiated": False,
            "uiLaunched": False,
        },
    }


def _preinstall() -> dict[str, object]:
    session = _session("preinstall")
    return {
        "schemaVersion": SNAPSHOT.SNAPSHOT_SCHEMA,
        "phase": "preinstall",
        "capturedAt": "2026-08-29T12:00:00.000Z",
        "session": session,
        "rawSources": _raw_sources("preinstall", session),
        "hostEnvironment": _host_environment(),
        "tailscaleInstall": {
            "installed": False,
            "clientVersion": None,
            "daemonVersion": None,
            "artifacts": None,
            "service": None,
            "adapter": None,
            "residualState": _residual_state(),
            "safetyState": None,
        },
        "installerExecution": _installer_execution("preinstall"),
        "listeners": _listeners(),
        "boundaries": _boundaries(),
        "restrictedCommandsExecuted": False,
    }


def _postinstall() -> dict[str, object]:
    session = _session("postinstall")
    daemon = TEST_CORPUS.artifacts[SNAPSHOT.ARTIFACT_ROLES.index("daemon")]
    driver = TEST_CORPUS.artifacts[SNAPSHOT.ARTIFACT_ROLES.index("driver")]
    catalog = TEST_CORPUS.artifacts[SNAPSHOT.ARTIFACT_ROLES.index("catalog")]
    return {
        "schemaVersion": SNAPSHOT.SNAPSHOT_SCHEMA,
        "phase": "postinstall",
        "capturedAt": "2026-08-29T12:05:00.000Z",
        "session": session,
        "rawSources": _raw_sources("postinstall", session),
        "hostEnvironment": _host_environment(),
        "tailscaleInstall": {
            "installed": True,
            "clientVersion": SNAPSHOT.EXPECTED_TAILSCALE_VERSION,
            "daemonVersion": SNAPSHOT.EXPECTED_TAILSCALE_VERSION,
            "artifacts": _artifact_values(),
            "service": {
                "serviceClass": "tailscale-windows-service",
                "path": DAEMON_PATH,
                "argv": [DAEMON_PATH],
                "status": "running",
                "startType": "automatic",
                "accountClass": "local-system",
                "binarySha256": daemon.sha256,
            },
            "adapter": {
                "adapterClass": "tailscale-tunnel-adapter",
                "status": "down",
                "driverPath": DRIVER_PATH,
                "driverSha256": driver.sha256,
                "catalogPath": CATALOG_PATH,
                "catalogSha256": catalog.sha256,
                "tailnetAddressPresent": False,
            },
            "residualState": None,
            "safetyState": _safety_state(),
        },
        "installerExecution": _installer_execution("postinstall"),
        "listeners": _listeners(),
        "boundaries": _boundaries(),
        "restrictedCommandsExecuted": False,
    }


def _validate(
    preinstall: dict[str, object] | None = None,
    postinstall: dict[str, object] | None = None,
    *,
    challenge: str = CHALLENGE,
    corpora: object = TEST_CORPORA,
) -> bytes:
    return SNAPSHOT.validate_install_snapshot_pair(
        _canonical(_preinstall() if preinstall is None else preinstall),
        _canonical(_postinstall() if postinstall is None else postinstall),
        expected_challenge=challenge,
        artifact_corpora=corpora,  # type: ignore[arg-type]
    )


def _refresh_raw_source_commitment(snapshot: dict[str, object], role: str) -> None:
    session = snapshot["session"]  # type: ignore[assignment]
    source = snapshot["rawSources"][role]  # type: ignore[index]
    source["captureCommitmentSha256"] = SNAPSHOT.raw_capture_commitment(  # type: ignore[index]
        session["sessionCommitmentSha256"],
        snapshot["phase"],
        session["sequence"],
        role,
        source["rawSha256"],
        source["parserCorpusSha256"],
    )


EXPECTED_IMPORTS = {
    ("from", "__future__", ("annotations",)),
    ("import", "hashlib", ()),
    ("import", "json", ()),
    ("import", "re", ()),
    ("from", "collections.abc", ("Mapping", "Sequence")),
    ("from", "dataclasses", ("dataclass",)),
    ("from", "datetime", ("datetime", "timezone")),
    ("from", "types", ("MappingProxyType",)),
    ("from", "typing", ("Any", "NoReturn")),
}
EXPECTED_CLASSES = {
    "WindowsInstallSnapshotError",
    "ArtifactExpectation",
    "SourceCorpusExpectation",
    "InstallArtifactCorpus",
    "_ValidatedSnapshot",
}
EXPECTED_FUNCTIONS = {
    "_fail",
    "_exact_keys",
    "_assert_string",
    "_assert_bool",
    "_assert_integer",
    "_assert_sha256",
    "_assert_version",
    "_assert_windows_path",
    "_reject_duplicate_keys",
    "_reject_non_integer_number",
    "_parse_bounded_integer",
    "_assert_json_text",
    "_canonical",
    "_canonical_json",
    "_sha",
    "_value_commitment",
    "_domain_commitment",
    "_instant",
    "_corpus_value",
    "_assert_corpus",
    "_select_corpus",
    "challenge_commitment",
    "session_commitment",
    "raw_capture_commitment",
    "_assert_session",
    "_assert_raw_sources",
    "_assert_host_environment",
    "_expected_artifact_values",
    "_assert_residual_state",
    "_assert_postinstall_safety",
    "_assert_service",
    "_assert_adapter",
    "_assert_tailscale_install",
    "_expected_installer_argv",
    "_assert_installer_execution",
    "_assert_listeners",
    "_assert_boundaries",
    "_validated_snapshot",
    "validate_install_snapshot_pair",
}
EXPECTED_MANIFEST_FIELDS = {
    "schemaVersion",
    "artifactCorpusId",
    "artifactCorpusKind",
    "artifactCorpusSha256",
    "artifactCorpusReviewSourceBundleSha256",
    "collectorSchema",
    "collectorSourceSha256",
    "sessionCommitmentSha256",
    "challengeCommitmentSha256",
    "bootSessionCommitmentSha256",
    "preinstallSnapshotSha256",
    "postinstallSnapshotSha256",
    "preinstallRawSourceBundleSha256",
    "postinstallRawSourceBundleSha256",
    "preinstallCapturedAt",
    "postinstallCapturedAt",
    "elapsedMilliseconds",
    "expectedTailscaleVersion",
    "expectedInstallerSha256",
    "allowedChanges",
    "unchangedCommitments",
    "restrictedCommandsExecuted",
    "productionArtifactCorpusMatched",
    "trustBoundary",
}
EXPECTED_MODULE_SHA256 = (
    "ab12f41cb33389f7b0a79f9a05cc892966261413ad9f0187393e45f2ac8cde5f"
)
EXPECTED_MANIFEST_VALUE_EXPRESSIONS = (
    ("schemaVersion", "CORPUS_MANIFEST_SCHEMA"),
    ("artifactCorpusId", "preinstall.corpus.corpus_id"),
    ("artifactCorpusKind", "preinstall.corpus.corpus_kind"),
    ("artifactCorpusSha256", "preinstall.corpus_sha256"),
    (
        "artifactCorpusReviewSourceBundleSha256",
        "preinstall.corpus.review_source_bundle_sha256",
    ),
    ("collectorSchema", "preinstall.corpus.collector_schema"),
    ("collectorSourceSha256", "preinstall.corpus.collector_source_sha256"),
    (
        "sessionCommitmentSha256",
        "preinstall.value['session']['sessionCommitmentSha256']",
    ),
    (
        "challengeCommitmentSha256",
        "preinstall.value['session']['challengeCommitmentSha256']",
    ),
    (
        "bootSessionCommitmentSha256",
        "preinstall.value['session']['bootSessionCommitmentSha256']",
    ),
    ("preinstallSnapshotSha256", "preinstall.sha256"),
    ("postinstallSnapshotSha256", "postinstall.sha256"),
    (
        "preinstallRawSourceBundleSha256",
        "_value_commitment(preinstall.value['rawSources'])",
    ),
    (
        "postinstallRawSourceBundleSha256",
        "_value_commitment(postinstall.value['rawSources'])",
    ),
    ("preinstallCapturedAt", "preinstall.value['capturedAt']"),
    ("postinstallCapturedAt", "postinstall.value['capturedAt']"),
    ("elapsedMilliseconds", "wall_milliseconds"),
    ("expectedTailscaleVersion", "EXPECTED_TAILSCALE_VERSION"),
    ("expectedInstallerSha256", "EXPECTED_INSTALLER_SHA256"),
    ("allowedChanges", "list(ALLOWED_INSTALL_CHANGES)"),
    (
        "unchangedCommitments",
        "{'hostEnvironmentSha256': "
        "_value_commitment(preinstall.value['hostEnvironment']), "
        "'listenerInventorySha256': "
        "_value_commitment(preinstall.value['listeners']), "
        "'boundaryStateSha256': "
        "_value_commitment(preinstall.value['boundaries'])}",
    ),
    ("restrictedCommandsExecuted", "False"),
    (
        "productionArtifactCorpusMatched",
        "preinstall.production_artifact_corpus_matched",
    ),
    ("trustBoundary", "TRUST_BOUNDARY"),
)


def validator_surface_violations(source: str) -> list[str]:
    tree = ast.parse(source)
    violations: list[str] = []
    if hashlib.sha256(source.encode("utf-8")).hexdigest() != EXPECTED_MODULE_SHA256:
        violations.append("source-fingerprint")
    imports: set[tuple[str, str, tuple[str, ...]]] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                imports.add(("import", alias.name, ()))
        elif isinstance(node, ast.ImportFrom):
            imports.add(
                (
                    "from",
                    node.module or "",
                    tuple(alias.name for alias in node.names),
                )
            )
    if imports != EXPECTED_IMPORTS:
        violations.append("imports")

    classes = {
        node.name for node in tree.body if isinstance(node, ast.ClassDef)
    }
    functions = {
        node.name
        for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    }
    if classes != EXPECTED_CLASSES:
        violations.append("classes")
    if functions != EXPECTED_FUNCTIONS:
        violations.append("functions")

    allowed_direct_calls = EXPECTED_CLASSES | EXPECTED_FUNCTIONS | {
        "MappingProxyType",
        "any",
        "dataclass",
        "dict",
        "enumerate",
        "frozenset",
        "int",
        "isinstance",
        "len",
        "list",
        "ord",
        "set",
        "sorted",
        "str",
        "tuple",
        "type",
        "zip",
    }
    allowed_attribute_calls_by_scope = {
        "<module>": {"compile", "lower", "sub"},
        "_assert_windows_path": {"endswith", "fullmatch", "split"},
        "_assert_sha256": {"fullmatch"},
        "_assert_version": {"fullmatch"},
        "_assert_json_text": {"items"},
        "_canonical": {"dumps", "encode"},
        "_canonical_json": {"decode", "loads"},
        "_sha": {"hexdigest", "sha256"},
        "_domain_commitment": {"encode", "join"},
        "_instant": {"fullmatch", "replace", "strftime", "strptime"},
        "_assert_corpus": {
            "append",
            "casefold",
            "fullmatch",
            "index",
            "startswith",
        },
        "_select_corpus": {"items"},
        "challenge_commitment": {"fullmatch"},
        "_assert_residual_state": {"items"},
        "_assert_postinstall_safety": {"items"},
        "_assert_service": {"index"},
        "_assert_adapter": {"index"},
        "_expected_installer_argv": {"index"},
        "_assert_listeners": {"append"},
        "validate_install_snapshot_pair": {"total_seconds"},
    }
    parents = {
        child: parent
        for parent in ast.walk(tree)
        for child in ast.iter_child_nodes(parent)
    }

    def call_scope(node: ast.AST) -> str:
        current = parents.get(node)
        while current is not None:
            if isinstance(current, (ast.FunctionDef, ast.AsyncFunctionDef)):
                return current.name
            current = parents.get(current)
        return "<module>"

    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        if isinstance(node.func, ast.Name):
            if node.func.id not in allowed_direct_calls:
                violations.append(f"call:{node.func.id}")
        elif isinstance(node.func, ast.Attribute):
            scope = call_scope(node)
            if node.func.attr not in allowed_attribute_calls_by_scope.get(scope, set()):
                violations.append(f"attribute-call:{scope}:{node.func.attr}")
        else:
            violations.append("indirect-call")

    manifest_assignments = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Assign)
        and any(isinstance(target, ast.Name) and target.id == "manifest" for target in node.targets)
    ]
    if len(manifest_assignments) != 1 or not isinstance(
        manifest_assignments[0].value, ast.Dict
    ):
        violations.append("manifest-shape")
    else:
        manifest_dict = manifest_assignments[0].value
        keys = {
            key.value
            for key in manifest_dict.keys
            if isinstance(key, ast.Constant) and isinstance(key.value, str)
        }
        if keys != EXPECTED_MANIFEST_FIELDS:
            violations.append("manifest-fields")
        expressions: list[tuple[str, str]] = []
        for key, value in zip(
            manifest_dict.keys,
            manifest_dict.values,
            strict=True,
        ):
            if not isinstance(key, ast.Constant) or not isinstance(key.value, str):
                violations.append("manifest-values")
                break
            expressions.append((key.value, ast.unparse(value)))
        if tuple(expressions) != EXPECTED_MANIFEST_VALUE_EXPRESSIONS:
            violations.append("manifest-values")

    public = next(
        (
            node
            for node in tree.body
            if isinstance(node, ast.FunctionDef)
            and node.name == "validate_install_snapshot_pair"
        ),
        None,
    )
    if public is None:
        violations.append("public-validator")
    else:
        returns = [node for node in ast.walk(public) if isinstance(node, ast.Return)]
        if len(returns) != 1 or ast.unparse(returns[0].value) != "_canonical(manifest)":
            violations.append("public-output")

    registry = next(
        (
            node
            for node in tree.body
            if isinstance(node, ast.AnnAssign)
            and isinstance(node.target, ast.Name)
            and node.target.id == "PRODUCTION_INSTALL_ARTIFACT_CORPORA"
        ),
        None,
    )
    if (
        registry is None
        or not isinstance(registry.value, ast.Call)
        or not isinstance(registry.value.func, ast.Name)
        or registry.value.func.id != "MappingProxyType"
        or len(registry.value.args) != 1
        or not isinstance(registry.value.args[0], ast.Dict)
        or registry.value.args[0].keys
    ):
        violations.append("production-registry")
    return sorted(set(violations))


class WindowsInstallSnapshotTests(unittest.TestCase):
    def assert_rejected(self, *args: object, **kwargs: object) -> None:
        with self.assertRaises(SNAPSHOT.WindowsInstallSnapshotError):
            _validate(*args, **kwargs)  # type: ignore[arg-type]

    def test_valid_test_pair_emits_redacted_deterministic_manifest(self) -> None:
        preinstall = _preinstall()
        postinstall = _postinstall()
        first = _validate(preinstall, postinstall)
        second = _validate()
        manifest = json.loads(first)
        expected_manifest = {
            "schemaVersion": SNAPSHOT.CORPUS_MANIFEST_SCHEMA,
            "artifactCorpusId": TEST_CORPUS.corpus_id,
            "artifactCorpusKind": TEST_CORPUS.corpus_kind,
            "artifactCorpusSha256": _corpus_sha256(),
            "artifactCorpusReviewSourceBundleSha256": (
                TEST_CORPUS.review_source_bundle_sha256
            ),
            "collectorSchema": TEST_CORPUS.collector_schema,
            "collectorSourceSha256": TEST_CORPUS.collector_source_sha256,
            "sessionCommitmentSha256": _session("preinstall")[
                "sessionCommitmentSha256"
            ],
            "challengeCommitmentSha256": SNAPSHOT.challenge_commitment(CHALLENGE),
            "bootSessionCommitmentSha256": BOOT_COMMITMENT,
            "preinstallSnapshotSha256": hashlib.sha256(
                _canonical(preinstall)
            ).hexdigest(),
            "postinstallSnapshotSha256": hashlib.sha256(
                _canonical(postinstall)
            ).hexdigest(),
            "preinstallRawSourceBundleSha256": _commitment(
                preinstall["rawSources"]
            ),
            "postinstallRawSourceBundleSha256": _commitment(
                postinstall["rawSources"]
            ),
            "preinstallCapturedAt": preinstall["capturedAt"],
            "postinstallCapturedAt": postinstall["capturedAt"],
            "elapsedMilliseconds": 300_000,
            "expectedTailscaleVersion": SNAPSHOT.EXPECTED_TAILSCALE_VERSION,
            "expectedInstallerSha256": SNAPSHOT.EXPECTED_INSTALLER_SHA256,
            "allowedChanges": list(SNAPSHOT.ALLOWED_INSTALL_CHANGES),
            "unchangedCommitments": {
                "hostEnvironmentSha256": _commitment(_host_environment()),
                "listenerInventorySha256": _commitment(_listeners()),
                "boundaryStateSha256": _commitment(_boundaries()),
            },
            "restrictedCommandsExecuted": False,
            "productionArtifactCorpusMatched": False,
            "trustBoundary": SNAPSHOT.TRUST_BOUNDARY,
        }

        self.assertEqual(first, second)
        self.assertEqual(manifest, expected_manifest)
        self.assertEqual(first, _canonical(expected_manifest))
        self.assertEqual(manifest["schemaVersion"], SNAPSHOT.CORPUS_MANIFEST_SCHEMA)
        self.assertEqual(manifest["artifactCorpusKind"], "test")
        self.assertEqual(manifest["elapsedMilliseconds"], 300_000)
        self.assertFalse(manifest["productionArtifactCorpusMatched"])
        self.assertFalse(
            any("authoriz" in field.casefold() for field in manifest)
        )
        self.assertEqual(
            manifest["artifactCorpusReviewSourceBundleSha256"],
            TEST_CORPUS.review_source_bundle_sha256,
        )
        self.assertFalse(manifest["restrictedCommandsExecuted"])
        self.assertEqual(manifest["allowedChanges"], list(SNAPSHOT.ALLOWED_INSTALL_CHANGES))
        self.assertEqual(manifest["trustBoundary"], SNAPSHOT.TRUST_BOUNDARY)
        for protected in (
            CHALLENGE,
            INSTALLER_PATH,
            CLIENT_PATH,
            DAEMON_PATH,
            DRIVER_PATH,
            CATALOG_PATH,
            *(
                artifact.signer_identity_sha256
                for artifact in TEST_CORPUS.artifacts
            ),
        ):
            self.assertNotIn(protected.encode(), first)

    def test_empty_immutable_production_registry_fails_closed(self) -> None:
        self.assertEqual(dict(SNAPSHOT.PRODUCTION_INSTALL_ARTIFACT_CORPORA), {})
        with self.assertRaises(TypeError):
            SNAPSHOT.PRODUCTION_INSTALL_ARTIFACT_CORPORA["x"] = TEST_CORPUS  # type: ignore[index]
        with self.assertRaises(SNAPSHOT.WindowsInstallSnapshotError):
            SNAPSHOT.validate_install_snapshot_pair(
                _canonical(_preinstall()),
                _canonical(_postinstall()),
                expected_challenge=CHALLENGE,
            )

    def test_injected_corpora_must_be_test_kind_and_test_prefixed(self) -> None:
        wrong_kind = replace(TEST_CORPUS, corpus_kind="production")
        wrong_prefix = replace(TEST_CORPUS, corpus_id="windows-tailscale-test-v1")
        for corpus in (wrong_kind, wrong_prefix):
            registry = MappingProxyType({corpus.corpus_id: corpus})
            with self.subTest(corpus=corpus.corpus_id):
                self.assert_rejected(corpora=registry)
        self.assert_rejected(corpora={TEST_CORPUS.corpus_id: TEST_CORPUS})

    def test_malformed_corpus_objects_fail_with_sanitized_errors(self) -> None:
        malformed = (
            replace(TEST_CORPUS, corpus_id=1),  # type: ignore[arg-type]
            replace(TEST_CORPUS, artifacts=(object(),)),  # type: ignore[arg-type]
            replace(TEST_CORPUS, source_corpora=(object(),)),  # type: ignore[arg-type]
        )
        for corpus in malformed:
            registry = MappingProxyType({str(corpus.corpus_id): corpus})
            with self.subTest(corpus=corpus):
                with self.assertRaises(SNAPSHOT.WindowsInstallSnapshotError) as caught:
                    _validate(corpora=registry)
                self.assertIsNone(caught.exception.__cause__)
                self.assertIsNone(caught.exception.__context__)

    def test_corpus_binds_every_artifact_hash_signer_status_and_path(self) -> None:
        mutations: list[SNAPSHOT.InstallArtifactCorpus] = []
        for index, artifact in enumerate(TEST_CORPUS.artifacts):
            for field, value in (
                ("sha256", "f" * 64),
                ("signer_identity_sha256", "0" * 64),
                ("signature_status", "UnknownError"),
                ("path", artifact.path + ".moved"),
            ):
                artifacts = list(TEST_CORPUS.artifacts)
                artifacts[index] = replace(artifact, **{field: value})
                mutations.append(replace(TEST_CORPUS, artifacts=tuple(artifacts)))
        daemon = TEST_CORPUS.artifacts[SNAPSHOT.ARTIFACT_ROLES.index("daemon")]
        daemon_case_alias = daemon.path[:3] + daemon.path[3:].swapcase()
        case_alias_artifacts = list(TEST_CORPUS.artifacts)
        client_index = SNAPSHOT.ARTIFACT_ROLES.index("client")
        case_alias_artifacts[client_index] = replace(
            case_alias_artifacts[client_index],
            path=daemon_case_alias,
            sha256=daemon.sha256,
            signer_identity_sha256=daemon.signer_identity_sha256,
        )
        mutations.append(
            replace(TEST_CORPUS, artifacts=tuple(case_alias_artifacts))
        )
        case_alias_corpus = mutations[-1]
        with self.assertRaises(SNAPSHOT.WindowsInstallSnapshotError):
            SNAPSHOT._assert_corpus(
                case_alias_corpus,
                production_registry=False,
            )
        for service_corpus in (
            replace(TEST_CORPUS, service_path=daemon_case_alias),
            replace(TEST_CORPUS, service_argv=(daemon_case_alias,)),
        ):
            with self.subTest(service_case_alias=service_corpus):
                with self.assertRaises(SNAPSHOT.WindowsInstallSnapshotError):
                    SNAPSHOT._assert_corpus(
                        service_corpus,
                        production_registry=False,
                    )
        mutations.extend(
            (
                replace(TEST_CORPUS, service_path=CLIENT_PATH),
                replace(TEST_CORPUS, service_path=daemon_case_alias),
                replace(TEST_CORPUS, service_argv=(DAEMON_PATH, "--changed")),
                replace(TEST_CORPUS, service_argv=(daemon_case_alias,)),
                replace(TEST_CORPUS, collector_source_sha256="f" * 64),
                replace(TEST_CORPUS, review_source_bundle_sha256="g" * 64),
            )
        )
        for corpus in mutations:
            with self.subTest(corpus=corpus):
                self.assert_rejected(
                    corpora=MappingProxyType({corpus.corpus_id: corpus})
                )

    def test_snapshot_artifacts_service_and_adapter_must_equal_corpus(self) -> None:
        postinstall = _postinstall()
        postinstall["tailscaleInstall"]["artifacts"][1]["sha256"] = "f" * 64  # type: ignore[index]
        self.assert_rejected(postinstall=postinstall)

        postinstall = _postinstall()
        postinstall["tailscaleInstall"]["service"]["argv"] = [  # type: ignore[index]
            DAEMON_PATH,
            "--changed",
        ]
        self.assert_rejected(postinstall=postinstall)

        postinstall = _postinstall()
        postinstall["tailscaleInstall"]["adapter"]["status"] = "up"  # type: ignore[index]
        self.assert_rejected(postinstall=postinstall)

    def test_live_expected_challenge_is_mandatory_and_not_replayable(self) -> None:
        self.assert_rejected(challenge=OTHER_CHALLENGE)
        with self.assertRaises(TypeError):
            SNAPSHOT.validate_install_snapshot_pair(  # type: ignore[call-arg]
                _canonical(_preinstall()), _canonical(_postinstall())
            )

    def test_session_binds_boot_collector_corpus_sequence_and_monotonic_time(self) -> None:
        session_fields = (
            "bootSessionCommitmentSha256",
            "collectorSourceSha256",
            "artifactCorpusSha256",
            "sessionCommitmentSha256",
        )
        for field in session_fields:
            preinstall = _preinstall()
            preinstall["session"][field] = "f" * 64  # type: ignore[index]
            with self.subTest(field=field):
                self.assert_rejected(preinstall=preinstall)

        preinstall = _preinstall()
        preinstall["session"]["sequence"] = 2  # type: ignore[index]
        self.assert_rejected(preinstall=preinstall)

        postinstall = _postinstall()
        postinstall["session"]["monotonicMilliseconds"] = 310_001  # type: ignore[index]
        self.assert_rejected(postinstall=postinstall)

    def test_every_raw_source_is_session_and_parser_corpus_bound(self) -> None:
        for role in SNAPSHOT.RAW_SOURCE_ROLES:
            for field in (
                "schemaVersion",
                "rawSha256",
                "parserCorpusSha256",
                "captureCommitmentSha256",
            ):
                preinstall = _preinstall()
                source = preinstall["rawSources"][role]  # type: ignore[index]
                source[field] = "f" * 64  # type: ignore[index]
                with self.subTest(role=role, field=field):
                    self.assert_rejected(preinstall=preinstall)

    def test_replayed_raw_source_is_rejected_even_with_refreshed_commitment(self) -> None:
        postinstall = _postinstall()
        role = SNAPSHOT.RAW_SOURCE_ROLES[0]
        postinstall["rawSources"][role]["rawSha256"] = (  # type: ignore[index]
            _preinstall()["rawSources"][role]["rawSha256"]  # type: ignore[index]
        )
        _refresh_raw_source_commitment(postinstall, role)
        self.assert_rejected(postinstall=postinstall)

    def test_exact_msi_invocation_and_result_are_required(self) -> None:
        pre_cases = (
            ("executablePath", r"C:\Windows\System32\other.exe"),
            ("argv", ["/i", INSTALLER_PATH, "/quiet"]),
            ("elevated", False),
        )
        for field, value in pre_cases:
            preinstall = _preinstall()
            preinstall["installerExecution"][field] = value  # type: ignore[index]
            with self.subTest(preinstall_field=field):
                self.assert_rejected(preinstall=preinstall)

        result_cases = (
            ("exitCode", 3010),
            ("processExitObserved", False),
            ("restartRequired", True),
            ("restartInitiated", True),
            ("uiLaunched", True),
        )
        for field, value in result_cases:
            postinstall = _postinstall()
            postinstall["installerExecution"]["result"][field] = value  # type: ignore[index]
            with self.subTest(result_field=field):
                self.assert_rejected(postinstall=postinstall)

    def test_preinstall_requires_complete_residual_absence(self) -> None:
        for field in _residual_state():
            preinstall = _preinstall()
            preinstall["tailscaleInstall"]["residualState"][field] = True  # type: ignore[index]
            with self.subTest(field=field):
                self.assert_rejected(preinstall=preinstall)

    def test_postinstall_rejects_every_forbidden_tailnet_state(self) -> None:
        for field in _safety_state():
            postinstall = _postinstall()
            postinstall["tailscaleInstall"]["safetyState"][field] = True  # type: ignore[index]
            with self.subTest(field=field):
                self.assert_rejected(postinstall=postinstall)

    def test_listener_baseline_binds_owner_and_binary_and_rejects_exposure(self) -> None:
        for address_class in (
            "ipv4-wildcard",
            "ipv6-wildcard",
            "ipv4-public",
            "tailscale-cgnat",
        ):
            preinstall = _preinstall()
            preinstall["listeners"][0]["addressClass"] = address_class  # type: ignore[index]
            with self.subTest(address_class=address_class):
                self.assert_rejected(preinstall=preinstall)

        for field in ("ownerCommitmentSha256", "ownerBinarySha256"):
            preinstall = _preinstall()
            preinstall["listeners"][0][field] = "f" * 64  # type: ignore[index]
            with self.subTest(field=field):
                self.assert_rejected(preinstall=preinstall)

    def test_host_listener_and_every_boundary_commitment_must_not_drift(self) -> None:
        postinstall = _postinstall()
        postinstall["hostEnvironment"]["windowsVersion"] = "10.0.26200.9999"  # type: ignore[index]
        self.assert_rejected(postinstall=postinstall)

        postinstall = _postinstall()
        postinstall["listeners"] = []
        self.assert_rejected(postinstall=postinstall)

        for field in (
            "windowsFirewallSha256",
            "hyperVFirewallSha256",
            "forwardingSha256",
            "hnsSha256",
            "dockerSha256",
            "nonTailscaleServicesSha256",
            "nonTailscaleAdaptersSha256",
        ):
            postinstall = _postinstall()
            postinstall["boundaries"][field] = "f" * 64  # type: ignore[index]
            with self.subTest(field=field):
                self.assert_rejected(postinstall=postinstall)

    def test_unsafe_firewall_forwarding_and_docker_booleans_fail_closed(self) -> None:
        required_true = (
            "windowsFirewallProfilesEnabled",
            "hyperVFirewallAvailable",
            "hyperVFirewallDefaultInboundBlocked",
        )
        required_false = (
            "portProxyEntriesPresent",
            "windowsIpForwardingEnabled",
            "hnsExternalForwardingPresent",
            "dockerPublishedPortsPresent",
            "dockerHostNetworkContainersPresent",
        )
        for field in required_true:
            preinstall = _preinstall()
            preinstall["boundaries"][field] = False  # type: ignore[index]
            with self.subTest(field=field):
                self.assert_rejected(preinstall=preinstall)
        for field in required_false:
            preinstall = _preinstall()
            preinstall["boundaries"][field] = True  # type: ignore[index]
            with self.subTest(field=field):
                self.assert_rejected(preinstall=preinstall)

    def test_restricted_command_attestation_and_schema_extras_fail_closed(self) -> None:
        for phase in ("preinstall", "postinstall"):
            preinstall = _preinstall()
            postinstall = _postinstall()
            target = preinstall if phase == "preinstall" else postinstall
            target["restrictedCommandsExecuted"] = True
            with self.subTest(phase=phase):
                self.assert_rejected(preinstall, postinstall)

        preinstall = _preinstall()
        preinstall["identity"] = "protected-canary"
        self.assert_rejected(preinstall=preinstall)

    def test_parser_rejects_duplicates_nonfinite_surrogates_depth_and_large_ints(self) -> None:
        hostile = (
            b'{"phase":"preinstall","phase":"postinstall"}\n',
            b'{"value":NaN}\n',
            b'{"value":1.5}\n',
            b'{"value":"\\ud800"}\n',
            b"[" * 2_000 + b"]" * 2_000 + b"\n",
            b'{"value":12345678901}\n',
            b"\xff\n",
        )
        for raw in hostile:
            with self.subTest(raw=raw[:40]):
                with self.assertRaises(SNAPSHOT.WindowsInstallSnapshotError) as caught:
                    SNAPSHOT.validate_install_snapshot_pair(
                        raw,
                        _canonical(_postinstall()),
                        expected_challenge=CHALLENGE,
                        artifact_corpora=TEST_CORPORA,
                    )
                self.assertIsNone(caught.exception.__cause__)
                self.assertIsNone(caught.exception.__context__)

    def test_wall_and_monotonic_elapsed_must_match_exactly_and_be_fresh(self) -> None:
        postinstall = _postinstall()
        postinstall["capturedAt"] = "2026-08-29T12:30:00.001Z"
        self.assert_rejected(postinstall=postinstall)

        postinstall = _postinstall()
        postinstall["capturedAt"] = "2026-08-29T11:59:59.999Z"
        self.assert_rejected(postinstall=postinstall)

    def test_exact_allowlist_and_output_guard_accept_current_module(self) -> None:
        source = MODULE.read_text(encoding="utf-8")
        self.assertEqual(validator_surface_violations(source), [])

    def test_allowlist_and_output_guard_reject_security_mutations(self) -> None:
        source = MODULE.read_text(encoding="utf-8")
        manifest_value_mutations = (
            source.replace(
                '"artifactCorpusId": preinstall.corpus.corpus_id,',
                '"artifactCorpusId": expected_challenge[::-1],',
                1,
            ),
            source.replace(
                '"artifactCorpusKind": preinstall.corpus.corpus_kind,',
                '"artifactCorpusKind": expected_challenge[:16],',
                1,
            ),
        )
        for mutated in manifest_value_mutations:
            with self.subTest(mutation="manifest-value"):
                violations = validator_surface_violations(mutated)
                self.assertIn("manifest-values", violations)
                self.assertIn("source-fingerprint", violations)

        upstream_dataflow_mutation = source.replace(
            "    manifest = {",
            '    preinstall.value["capturedAt"] = expected_challenge[::-1]\n'
            "    manifest = {",
            1,
        )
        upstream_violations = validator_surface_violations(
            upstream_dataflow_mutation
        )
        self.assertNotIn("manifest-values", upstream_violations)
        self.assertIn("source-fingerprint", upstream_violations)

        mutations = (
            source + "\nimport subprocess\n",
            source.replace(
                "return _canonical(manifest)",
                "return preinstall_raw",
                1,
            ),
            source.replace(
                '"trustBoundary": TRUST_BOUNDARY,',
                '"expectedChallenge": expected_challenge,\n'
                '        "trustBoundary": TRUST_BOUNDARY,',
                1,
            ),
            source.replace("MappingProxyType({})", "{}", 1),
            source.replace(
                'manifest = {',
                'print(expected_challenge)\n    manifest = {',
                1,
            ),
        )
        for mutated in mutations:
            with self.subTest():
                self.assertNotEqual(validator_surface_violations(mutated), [])


if __name__ == "__main__":
    unittest.main()
