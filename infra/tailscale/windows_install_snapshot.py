"""Validate a challenge-bound Windows Tailscale install corpus offline.

This module is deliberately pure and non-collecting.  It accepts only bounded,
canonical JSON produced by a separately reviewed collector and never reads or
writes a file, invokes a process, inspects the host, or uses the network.  The
immutable production artifact-corpus registry is intentionally empty: injected
corpora are synthetic test fixtures only and can never authorize a live install.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from types import MappingProxyType
from typing import Any, NoReturn


SNAPSHOT_SCHEMA = "nutrition-tracker-windows-tailscale-install-snapshot-v3"
CORPUS_MANIFEST_SCHEMA = (
    "nutrition-tracker-windows-tailscale-install-corpus-manifest-v3"
)
INSTALL_ARTIFACT_CORPUS_SCHEMA = (
    "nutrition-tracker-windows-tailscale-install-artifact-corpus-v2"
)
COLLECTOR_SCHEMA = "nutrition-tracker-windows-tailscale-install-collector-v2"
EXPECTED_TAILSCALE_VERSION = "1.102.3"
EXPECTED_INSTALLER_SHA256 = (
    "03ac8183c6e3ce276e9b44281ebe7e4c02aef28a971034ca170c4b665df42dce"
)
CHALLENGE_DOMAIN = "nutrition-tracker-windows-tailscale-install-challenge-v1"
SESSION_DOMAIN = "nutrition-tracker-windows-tailscale-install-session-v2"
CAPTURE_DOMAIN = "nutrition-tracker-windows-tailscale-install-raw-capture-v2"
TRUST_BOUNDARY = (
    "offline-corpus-candidate-only-no-install-tailnet-or-production-authorization"
)
ALLOWED_INSTALL_CHANGES = (
    "reviewed-tailscale-artifacts-installed",
    "reviewed-tailscale-windows-service-added",
    "reviewed-tailscale-tunnel-adapter-added-down-without-tailnet-state",
)

MAX_SNAPSHOT_BYTES = 262_144
MAX_LISTENERS = 4_096
MAX_PAIR_MILLISECONDS = 30 * 60 * 1_000
MAX_MONOTONIC_MILLISECONDS = 7 * 24 * 60 * 60 * 1_000
MAX_JSON_DEPTH = 16

SHA256_HEX = re.compile(r"^[0-9a-f]{64}$")
SHA1_HEX = re.compile(r"^[0-9a-f]{40}$")
CHALLENGE_HEX = re.compile(r"^[0-9a-f]{32}$")
SAFE_VERSION = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+()-]{0,63}$")
SAFE_CORPUS_ID = re.compile(r"^[a-z0-9][a-z0-9._-]{2,63}$")
ISO_INSTANT = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
SAFE_WINDOWS_PATH = re.compile(r"^[A-Z]:\\[^\x00-\x1f\"*?<>|:]{1,239}$")

ARTIFACT_ROLES = (
    "installer",
    "client",
    "gui",
    "daemon",
    "driverLibrary",
    "driverInf",
    "driver",
    "catalog",
)
RAW_SOURCE_ROLES = (
    "hostEnvironment",
    "tailscaleInstall",
    "installerInvocation",
    "installerResult",
    "listeners",
    "windowsFirewall",
    "hyperVFirewall",
    "forwarding",
    "hns",
    "docker",
    "services",
    "adapters",
)
SOURCE_SCHEMAS: Mapping[str, str] = MappingProxyType(
    {
        role: (
            "nutrition-tracker-windows-tailscale-install-"
            + re.sub(r"(?<!^)(?=[A-Z])", "-", role).lower()
            + ("-raw-v2" if role in ("tailscaleInstall", "adapters") else "-raw-v1")
        )
        for role in RAW_SOURCE_ROLES
    }
)
LISTENER_SCOPES = frozenset({"windows-host", "wsl2-ubuntu", "docker-desktop"})
SAFE_ADDRESS_CLASSES = frozenset(
    {"ipv4-loopback", "ipv6-loopback", "wsl-private", "docker-private"}
)
LISTENER_PROTOCOLS = frozenset({"tcp", "udp"})
OWNER_CLASSES = frozenset(
    {
        "windows-kernel",
        "windows-system-service",
        "docker-desktop",
        "wsl-system",
        "project-api",
        "project-dependency",
        "reviewed-third-party",
    }
)
MSIEXEC_PATH = r"C:\Windows\System32\msiexec.exe"
MSI_FIXED_ARGUMENTS = (
    "/qn",
    "/norestart",
    "TS_NOLAUNCH=1",
    "TS_ALLOWINCOMINGCONNECTIONS=never",
    "TS_UNATTENDEDMODE=never",
    "TS_INSTALLUPDATES=never",
)


class WindowsInstallSnapshotError(RuntimeError):
    """A snapshot, corpus, or approved transition failed closed."""


@dataclass(frozen=True)
class AuthenticodeExpectation:
    kind: str
    verification_status: str
    signer_leaf_certificate_der_sha256: str
    timestamp_leaf_certificate_der_sha256: str
    timestamp_utc: str


@dataclass(frozen=True)
class CatalogMembershipExpectation:
    verification_status: str
    catalog_role: str
    member_digest_algorithm: str
    member_digest: str


@dataclass(frozen=True)
class ArtifactExpectation:
    role: str
    path: str
    sha256: str
    authenticode: AuthenticodeExpectation | None
    catalog_membership: CatalogMembershipExpectation | None


@dataclass(frozen=True)
class SourceCorpusExpectation:
    role: str
    schema_version: str
    parser_corpus_sha256: str


@dataclass(frozen=True)
class InstallArtifactCorpus:
    corpus_id: str
    corpus_kind: str
    schema_version: str
    review_source_bundle_sha256: str
    collector_schema: str
    collector_source_sha256: str
    tailscale_version: str
    artifacts: tuple[ArtifactExpectation, ...]
    service_path: str
    service_argv: tuple[str, ...]
    approved_host_environment_sha256: str
    approved_listener_inventory_sha256: str
    approved_boundary_state_sha256: str
    source_corpora: tuple[SourceCorpusExpectation, ...]


@dataclass(frozen=True)
class _ValidatedSnapshot:
    value: dict[str, Any]
    captured_at: datetime
    monotonic_milliseconds: int
    sha256: str
    corpus: InstallArtifactCorpus
    corpus_sha256: str
    production_artifact_corpus_matched: bool


PRODUCTION_INSTALL_ARTIFACT_CORPORA: Mapping[str, InstallArtifactCorpus] = (
    MappingProxyType({})
)


def _fail(message: str) -> NoReturn:
    raise WindowsInstallSnapshotError(message)


def _exact_keys(value: Any, expected: Sequence[str], name: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != set(expected):
        _fail(f"{name} does not have the exact reviewed fields.")
    return value


def _assert_string(value: Any, name: str) -> str:
    if not isinstance(value, str):
        _fail(f"{name} must be a string.")
    return value


def _assert_bool(value: Any, name: str) -> bool:
    if type(value) is not bool:
        _fail(f"{name} must be a boolean.")
    return value


def _assert_integer(value: Any, name: str, minimum: int, maximum: int) -> int:
    if type(value) is not int or not minimum <= value <= maximum:
        _fail(f"{name} must be one bounded integer.")
    return value


def _assert_sha256(value: Any, name: str) -> str:
    if not isinstance(value, str) or not SHA256_HEX.fullmatch(value):
        _fail(f"{name} must be one lowercase SHA-256 digest.")
    return value


def _assert_version(value: Any, name: str) -> str:
    if not isinstance(value, str) or not SAFE_VERSION.fullmatch(value):
        _fail(f"{name} must be one bounded, non-identifying version token.")
    return value


def _assert_windows_path(value: Any, name: str) -> str:
    segments: list[str] = []
    if isinstance(value, str) and len(value) >= 3:
        segments = value[3:].split("\\")
    if (
        not isinstance(value, str)
        or not SAFE_WINDOWS_PATH.fullmatch(value)
        or "/" in value
        or "%" in value
        or value.endswith("\\")
        or any(
            not segment
            or segment in {".", ".."}
            or segment.endswith((" ", "."))
            for segment in segments
        )
    ):
        _fail(f"{name} must be one fixed canonical Windows path.")
    return value


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            _fail("Snapshot JSON contains a duplicate key.")
        result[key] = value
    return result


def _reject_non_integer_number(_value: str) -> NoReturn:
    _fail("Snapshot JSON numbers must be strict finite integers.")


def _parse_bounded_integer(value: str) -> int:
    if len(value) > 10:
        _fail("Snapshot JSON integers must be bounded.")
    return int(value)


def _assert_json_text(value: Any, depth: int = 0) -> None:
    if depth > MAX_JSON_DEPTH:
        _fail("Snapshot JSON nesting exceeds the reviewed limit.")
    if isinstance(value, str):
        if any(0xD800 <= ord(character) <= 0xDFFF for character in value):
            _fail("Snapshot JSON contains an invalid Unicode surrogate.")
        return
    if isinstance(value, list):
        for item in value:
            _assert_json_text(item, depth + 1)
        return
    if isinstance(value, dict):
        for key, item in value.items():
            _assert_json_text(key, depth + 1)
            _assert_json_text(item, depth + 1)


def _canonical(value: Any) -> bytes:
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


def _canonical_json(raw: bytes, name: str) -> dict[str, Any]:
    if not isinstance(raw, bytes) or not 2 <= len(raw) <= MAX_SNAPSHOT_BYTES:
        _fail(f"{name} must be bounded canonical UTF-8 JSON bytes.")
    value: Any = None
    canonical: bytes | None = None
    parse_failed = False
    try:
        value = json.loads(
            raw.decode("utf-8", errors="strict"),
            object_pairs_hook=_reject_duplicate_keys,
            parse_int=_parse_bounded_integer,
            parse_float=_reject_non_integer_number,
            parse_constant=_reject_non_integer_number,
        )
        _assert_json_text(value)
        canonical = _canonical(value)
    except (UnicodeDecodeError, UnicodeEncodeError, json.JSONDecodeError, RecursionError):
        parse_failed = True
    if parse_failed:
        _fail(f"{name} must be strict bounded UTF-8 JSON.")
    if not isinstance(value, dict) or raw != canonical:
        _fail(f"{name} must use exact canonical JSON with one final newline.")
    return value


def _sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _value_commitment(value: Any) -> str:
    return _sha(_canonical(value))


def _domain_commitment(domain: str, fields: Sequence[str]) -> str:
    return _sha((domain + "\n" + "\n".join(fields) + "\n").encode("utf-8"))


def _instant(value: Any, name: str) -> datetime:
    if not isinstance(value, str) or not ISO_INSTANT.fullmatch(value):
        _fail(f"{name} must be a canonical UTC instant with milliseconds.")
    parsed: datetime | None = None
    parse_failed = False
    try:
        parsed = datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ").replace(
            tzinfo=timezone.utc
        )
    except ValueError:
        parse_failed = True
    if parse_failed or parsed is None:
        _fail(f"{name} is not a real instant.")
    if parsed.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z" != value:
        _fail(f"{name} is not canonical.")
    return parsed


def _corpus_value(corpus: InstallArtifactCorpus) -> dict[str, Any]:
    return {
        "corpusId": corpus.corpus_id,
        "corpusKind": corpus.corpus_kind,
        "schemaVersion": corpus.schema_version,
        # Digest of the immutable external review-source bundle from which these
        # expectations were derived; this is distinct from the corpus digest.
        "reviewSourceBundleSha256": corpus.review_source_bundle_sha256,
        "collectorSchema": corpus.collector_schema,
        "collectorSourceSha256": corpus.collector_source_sha256,
        "tailscaleVersion": corpus.tailscale_version,
        "artifacts": [
            {
                "role": artifact.role,
                "path": artifact.path,
                "sha256": artifact.sha256,
                "authenticode": (
                    {
                        "kind": artifact.authenticode.kind,
                        "verificationStatus": artifact.authenticode.verification_status,
                        "signerLeafCertificateDerSha256": (
                            artifact.authenticode.signer_leaf_certificate_der_sha256
                        ),
                        "timestampLeafCertificateDerSha256": (
                            artifact.authenticode.timestamp_leaf_certificate_der_sha256
                        ),
                        "timestampUtc": artifact.authenticode.timestamp_utc,
                    }
                    if artifact.authenticode is not None
                    else None
                ),
                "catalogMembership": (
                    {
                        "verificationStatus": (
                            artifact.catalog_membership.verification_status
                        ),
                        "catalogRole": artifact.catalog_membership.catalog_role,
                        "memberDigestAlgorithm": (
                            artifact.catalog_membership.member_digest_algorithm
                        ),
                        "memberDigest": artifact.catalog_membership.member_digest,
                    }
                    if artifact.catalog_membership is not None
                    else None
                ),
            }
            for artifact in corpus.artifacts
        ],
        "servicePath": corpus.service_path,
        "serviceArgv": list(corpus.service_argv),
        "approvedHostEnvironmentSha256": (
            corpus.approved_host_environment_sha256
        ),
        "approvedListenerInventorySha256": (
            corpus.approved_listener_inventory_sha256
        ),
        "approvedBoundaryStateSha256": corpus.approved_boundary_state_sha256,
        "sourceCorpora": [
            {
                "role": source.role,
                "schemaVersion": source.schema_version,
                "parserCorpusSha256": source.parser_corpus_sha256,
            }
            for source in corpus.source_corpora
        ],
    }


def _assert_corpus(
    corpus: Any,
    *,
    production_registry: bool,
) -> tuple[InstallArtifactCorpus, str]:
    if not isinstance(corpus, InstallArtifactCorpus):
        _fail("An install artifact corpus has an unsupported immutable type.")
    if not isinstance(corpus.corpus_id, str) or not SAFE_CORPUS_ID.fullmatch(
        corpus.corpus_id
    ):
        _fail("An install artifact corpus ID is invalid.")
    if production_registry:
        if corpus.corpus_kind != "production" or corpus.corpus_id.startswith("test-"):
            _fail("The production registry contains a non-production corpus.")
    elif corpus.corpus_kind != "test" or not corpus.corpus_id.startswith("test-"):
        _fail("Injected install artifact corpora must be test-kind and test-prefixed.")
    if corpus.schema_version != INSTALL_ARTIFACT_CORPUS_SCHEMA:
        _fail("An install artifact corpus schema is unsupported.")
    _assert_sha256(
        corpus.review_source_bundle_sha256,
        "artifact corpus reviewSourceBundleSha256",
    )
    if corpus.collector_schema != COLLECTOR_SCHEMA:
        _fail("An install artifact corpus names an unsupported collector schema.")
    _assert_sha256(
        corpus.collector_source_sha256,
        "artifact corpus collectorSourceSha256",
    )
    if corpus.tailscale_version != EXPECTED_TAILSCALE_VERSION:
        _fail("An artifact corpus does not describe the exact approved version.")

    if not isinstance(corpus.artifacts, tuple) or len(corpus.artifacts) != len(
        ARTIFACT_ROLES
    ):
        _fail("An artifact corpus must contain the exact ordered artifact roles.")
    paths: list[str] = []
    for expected_role, artifact in zip(
        ARTIFACT_ROLES, corpus.artifacts, strict=True
    ):
        if not isinstance(artifact, ArtifactExpectation):
            _fail("An artifact corpus contains mutable or unsupported metadata.")
        if artifact.role != expected_role:
            _fail("An artifact corpus must contain the exact ordered artifact roles.")
        path = _assert_windows_path(artifact.path, "artifact path")
        paths.append(path)
        digest = _assert_sha256(artifact.sha256, "artifact sha256")
        expected_authenticode_kind = (
            None
            if artifact.role == "driverInf"
            else "signed-catalog"
            if artifact.role == "catalog"
            else "embedded-authenticode"
        )
        if expected_authenticode_kind is None:
            if artifact.authenticode is not None:
                _fail("The driver INF must not claim embedded Authenticode evidence.")
        else:
            authenticode = artifact.authenticode
            if not isinstance(authenticode, AuthenticodeExpectation):
                _fail("An artifact is missing immutable Authenticode evidence.")
            if authenticode.kind != expected_authenticode_kind:
                _fail("An artifact uses the wrong Authenticode evidence kind.")
            if authenticode.verification_status != "Valid":
                _fail("Every Authenticode verification status must be exactly Valid.")
            _assert_sha256(
                authenticode.signer_leaf_certificate_der_sha256,
                "artifact signerLeafCertificateDerSha256",
            )
            _assert_sha256(
                authenticode.timestamp_leaf_certificate_der_sha256,
                "artifact timestampLeafCertificateDerSha256",
            )
            _instant(authenticode.timestamp_utc, "artifact timestampUtc")

        requires_catalog_membership = artifact.role in ("driverInf", "driver")
        membership = artifact.catalog_membership
        if requires_catalog_membership:
            if not isinstance(membership, CatalogMembershipExpectation):
                _fail("A driver artifact is missing immutable catalog membership.")
            if membership.verification_status != "Valid":
                _fail("Every catalog membership status must be exactly Valid.")
            if membership.catalog_role != "catalog":
                _fail("Catalog membership must bind the exact catalog role.")
            if membership.member_digest_algorithm != "sha1":
                _fail("Catalog membership must use the reviewed SHA-1 member digest.")
            if not isinstance(membership.member_digest, str) or not SHA1_HEX.fullmatch(
                membership.member_digest
            ):
                _fail("Catalog membership must bind one lowercase SHA-1 digest.")
        elif membership is not None:
            _fail("Only the driver INF and driver may carry catalog membership.")
        if artifact.role == "installer" and digest != EXPECTED_INSTALLER_SHA256:
            _fail("The corpus installer is not the exact approved MSI.")
    if len(paths) != len({path.casefold() for path in paths}):
        _fail("Artifact corpus paths must be unique.")

    service_path = _assert_windows_path(corpus.service_path, "corpus servicePath")
    daemon = corpus.artifacts[ARTIFACT_ROLES.index("daemon")]
    if service_path != daemon.path:
        _fail("The corpus service path must be the exact daemon artifact path.")
    if (
        not isinstance(corpus.service_argv, tuple)
        or not 1 <= len(corpus.service_argv) <= 8
        or corpus.service_argv[0] != service_path
    ):
        _fail("The corpus service argv must begin with the exact service path.")
    for argument in corpus.service_argv:
        if (
            not isinstance(argument, str)
            or not 1 <= len(argument) <= 260
            or any(ord(character) < 0x20 for character in argument)
        ):
            _fail("The corpus service argv contains an invalid token.")

    for field, value in (
        ("approvedHostEnvironmentSha256", corpus.approved_host_environment_sha256),
        ("approvedListenerInventorySha256", corpus.approved_listener_inventory_sha256),
        ("approvedBoundaryStateSha256", corpus.approved_boundary_state_sha256),
    ):
        _assert_sha256(value, f"artifact corpus {field}")
    if not isinstance(corpus.source_corpora, tuple) or len(
        corpus.source_corpora
    ) != len(RAW_SOURCE_ROLES):
        _fail("The artifact corpus must bind every ordered raw-source role.")
    for expected_role, source in zip(
        RAW_SOURCE_ROLES, corpus.source_corpora, strict=True
    ):
        if not isinstance(source, SourceCorpusExpectation):
            _fail("A raw-source corpus has mutable or unsupported metadata.")
        if source.role != expected_role:
            _fail("The artifact corpus must bind every ordered raw-source role.")
        if source.schema_version != SOURCE_SCHEMAS[source.role]:
            _fail("A raw-source corpus schema is unsupported.")
        _assert_sha256(
            source.parser_corpus_sha256,
            "raw-source parserCorpusSha256",
        )

    value = _corpus_value(corpus)
    _assert_json_text(value)
    return corpus, _value_commitment(value)


def _select_corpus(
    corpus_id: Any,
    artifact_corpora: Mapping[str, InstallArtifactCorpus],
) -> tuple[InstallArtifactCorpus, str, bool]:
    if not isinstance(artifact_corpora, MappingProxyType):
        _fail("The install artifact corpus registry must be immutable.")
    production_registry = artifact_corpora is PRODUCTION_INSTALL_ARTIFACT_CORPORA
    entries: tuple[tuple[str, InstallArtifactCorpus], ...] = ()
    registry_failed = False
    try:
        entries = tuple(artifact_corpora.items())
    except (AttributeError, RuntimeError, TypeError):
        registry_failed = True
    if registry_failed:
        _fail("The install artifact corpus registry cannot be read atomically.")
    validated: dict[str, tuple[InstallArtifactCorpus, str]] = {}
    for key, candidate in entries:
        corpus, corpus_sha256 = _assert_corpus(
            candidate,
            production_registry=production_registry,
        )
        if not isinstance(key, str) or key != corpus.corpus_id or key in validated:
            _fail("An install artifact corpus registry key is inconsistent.")
        validated[key] = (corpus, corpus_sha256)
    if not isinstance(corpus_id, str) or corpus_id not in validated:
        _fail("No independently reviewed artifact corpus matches the snapshot.")
    corpus, corpus_sha256 = validated[corpus_id]
    return corpus, corpus_sha256, production_registry


def challenge_commitment(expected_challenge: str) -> str:
    """Commit a caller-supplied fresh 128-bit challenge without exposing it."""

    if not isinstance(expected_challenge, str) or not CHALLENGE_HEX.fullmatch(
        expected_challenge
    ):
        _fail("The expected challenge must be exactly 128 bits of lowercase hex.")
    return _domain_commitment(CHALLENGE_DOMAIN, (expected_challenge,))


def session_commitment(
    challenge_sha256: str,
    boot_session_sha256: str,
    artifact_corpus_sha256: str,
    collector_source_sha256: str,
) -> str:
    """Bind one operator challenge, boot, corpus, and collector source."""

    for name, value in (
        ("challenge", challenge_sha256),
        ("boot session", boot_session_sha256),
        ("artifact corpus", artifact_corpus_sha256),
        ("collector source", collector_source_sha256),
    ):
        _assert_sha256(value, f"{name} commitment")
    return _domain_commitment(
        SESSION_DOMAIN,
        (
            challenge_sha256,
            boot_session_sha256,
            artifact_corpus_sha256,
            collector_source_sha256,
        ),
    )


def raw_capture_commitment(
    session_sha256: str,
    phase: str,
    sequence: int,
    role: str,
    raw_sha256: str,
    parser_corpus_sha256: str,
) -> str:
    """Bind one raw capture to its exact session, phase, and parser corpus."""

    return _domain_commitment(
        CAPTURE_DOMAIN,
        (
            session_sha256,
            phase,
            str(sequence),
            role,
            raw_sha256,
            parser_corpus_sha256,
        ),
    )


def _assert_session(
    value: Any,
    phase: str,
    expected_challenge: str,
    artifact_corpora: Mapping[str, InstallArtifactCorpus],
) -> tuple[InstallArtifactCorpus, str, bool, int]:
    session = _exact_keys(
        value,
        (
            "artifactCorpusId",
            "artifactCorpusSha256",
            "bootSessionCommitmentSha256",
            "challengeCommitmentSha256",
            "collectorSchema",
            "collectorSourceSha256",
            "sequence",
            "monotonicMilliseconds",
            "sessionCommitmentSha256",
        ),
        "session",
    )
    corpus, corpus_sha256, production_corpus = _select_corpus(
        session["artifactCorpusId"], artifact_corpora
    )
    if session["artifactCorpusSha256"] != corpus_sha256:
        _fail("The snapshot artifact corpus commitment is stale or mismatched.")
    if session["collectorSchema"] != corpus.collector_schema:
        _fail("The snapshot collector schema is not corpus-reviewed.")
    if session["collectorSourceSha256"] != corpus.collector_source_sha256:
        _fail("The snapshot collector source is not corpus-reviewed.")
    challenge_sha256 = challenge_commitment(expected_challenge)
    if session["challengeCommitmentSha256"] != challenge_sha256:
        _fail("The snapshot does not bind the live expected challenge.")
    boot_session_sha256 = _assert_sha256(
        session["bootSessionCommitmentSha256"],
        "session.bootSessionCommitmentSha256",
    )
    expected_session_sha256 = session_commitment(
        challenge_sha256,
        boot_session_sha256,
        corpus_sha256,
        corpus.collector_source_sha256,
    )
    if session["sessionCommitmentSha256"] != expected_session_sha256:
        _fail("The snapshot session commitment is inconsistent.")
    expected_sequence = 1 if phase == "preinstall" else 2
    _assert_integer(
        session["sequence"],
        "session.sequence",
        expected_sequence,
        expected_sequence,
    )
    monotonic_milliseconds = _assert_integer(
        session["monotonicMilliseconds"],
        "session.monotonicMilliseconds",
        0,
        MAX_MONOTONIC_MILLISECONDS,
    )
    return corpus, corpus_sha256, production_corpus, monotonic_milliseconds


def _assert_raw_sources(
    value: Any,
    corpus: InstallArtifactCorpus,
    session_sha256: str,
    phase: str,
    sequence: int,
) -> dict[str, Any]:
    sources = _exact_keys(value, RAW_SOURCE_ROLES, "rawSources")
    expected_by_role = {item.role: item for item in corpus.source_corpora}
    for role in RAW_SOURCE_ROLES:
        source = _exact_keys(
            sources[role],
            (
                "schemaVersion",
                "rawSha256",
                "parserCorpusSha256",
                "captureCommitmentSha256",
            ),
            f"rawSources.{role}",
        )
        expectation = expected_by_role[role]
        if source["schemaVersion"] != expectation.schema_version:
            _fail("A raw source schema is not corpus-reviewed.")
        raw_sha256 = _assert_sha256(source["rawSha256"], "raw source sha256")
        if source["parserCorpusSha256"] != expectation.parser_corpus_sha256:
            _fail("A raw source parser corpus commitment is not reviewed.")
        expected_capture_sha256 = raw_capture_commitment(
            session_sha256,
            phase,
            sequence,
            role,
            raw_sha256,
            expectation.parser_corpus_sha256,
        )
        if source["captureCommitmentSha256"] != expected_capture_sha256:
            _fail("A raw source is not bound to this exact install session.")
    return sources


def _assert_host_environment(
    value: Any,
    corpus: InstallArtifactCorpus,
) -> dict[str, Any]:
    environment = _exact_keys(
        value,
        (
            "windowsVersion",
            "powershellVersion",
            "wslVersion",
            "wslKernelVersion",
            "wslDistribution",
            "wsl2Enabled",
            "wslDistributionRunning",
            "wslTailscaleInstalled",
            "dockerDesktopVersion",
            "dockerEngineVersion",
            "dockerContext",
            "dockerDesktopRunning",
            "dockerLinuxContainers",
            "dockerDesktopWslIntegration",
            "secondWslDockerEngineInstalled",
        ),
        "hostEnvironment",
    )
    for field in (
        "windowsVersion",
        "powershellVersion",
        "wslVersion",
        "wslKernelVersion",
        "dockerDesktopVersion",
        "dockerEngineVersion",
    ):
        _assert_version(environment[field], f"hostEnvironment.{field}")
    if environment["wslDistribution"] != "Ubuntu-24.04":
        _fail("The WSL distribution is not the reviewed Ubuntu-24.04 boundary.")
    if environment["dockerContext"] != "desktop-linux":
        _fail("The Docker context is not Docker Desktop Linux.")
    required_true = (
        "wsl2Enabled",
        "wslDistributionRunning",
        "dockerDesktopRunning",
        "dockerLinuxContainers",
        "dockerDesktopWslIntegration",
    )
    required_false = ("wslTailscaleInstalled", "secondWslDockerEngineInstalled")
    for field in (*required_true, *required_false):
        _assert_bool(environment[field], f"hostEnvironment.{field}")
    if any(not environment[field] for field in required_true):
        _fail("The reviewed WSL2 and Docker Desktop boundary is not active.")
    if any(environment[field] for field in required_false):
        _fail("Tailscale or a second Docker Engine exists inside WSL.")
    if _value_commitment(environment) != corpus.approved_host_environment_sha256:
        _fail("The host environment is not an independently reviewed baseline.")
    return environment


def _expected_artifact_values(corpus: InstallArtifactCorpus) -> list[dict[str, Any]]:
    return [
        {
            "role": artifact.role,
            "path": artifact.path,
            "sha256": artifact.sha256,
            "authenticode": (
                {
                    "kind": artifact.authenticode.kind,
                    "verificationStatus": artifact.authenticode.verification_status,
                    "signerLeafCertificateDerSha256": (
                        artifact.authenticode.signer_leaf_certificate_der_sha256
                    ),
                    "timestampLeafCertificateDerSha256": (
                        artifact.authenticode.timestamp_leaf_certificate_der_sha256
                    ),
                    "timestampUtc": artifact.authenticode.timestamp_utc,
                }
                if artifact.authenticode is not None
                else None
            ),
            "catalogMembership": (
                {
                    "verificationStatus": artifact.catalog_membership.verification_status,
                    "catalogRole": artifact.catalog_membership.catalog_role,
                    "memberDigestAlgorithm": (
                        artifact.catalog_membership.member_digest_algorithm
                    ),
                    "memberDigest": artifact.catalog_membership.member_digest,
                }
                if artifact.catalog_membership is not None
                else None
            ),
        }
        for artifact in corpus.artifacts
    ]


def _assert_residual_state(value: Any) -> dict[str, Any]:
    residuals = _exact_keys(
        value,
        (
            "productRegistrationPresent",
            "servicePresent",
            "adapterPresent",
            "programFilesPresent",
            "programDataPresent",
            "registryResidualPresent",
            "scheduledTaskPresent",
            "firewallRulePresent",
            "dnsPolicyPresent",
            "routePresent",
            "uiProcessPresent",
            "updateMechanismPresent",
        ),
        "tailscaleInstall.residualState",
    )
    for field, present in residuals.items():
        if _assert_bool(present, f"tailscaleInstall.residualState.{field}"):
            _fail("The preinstall snapshot contains residual Tailscale state.")
    return residuals


def _assert_postinstall_safety(value: Any) -> dict[str, Any]:
    safety = _exact_keys(
        value,
        (
            "loginPresent",
            "tailnetIdentityPresent",
            "serveConfigured",
            "funnelConfigured",
            "tailnetRoutesPresent",
            "tailnetDnsConfigured",
            "uiProcessRunning",
            "updateMechanismEnabled",
            "incomingConnectionsAllowed",
            "tailnetAddressPresent",
        ),
        "tailscaleInstall.safetyState",
    )
    for field, present in safety.items():
        if _assert_bool(present, f"tailscaleInstall.safetyState.{field}"):
            _fail("The installation-only snapshot contains forbidden tailnet state.")
    return safety


def _assert_service(value: Any, corpus: InstallArtifactCorpus) -> dict[str, Any]:
    service = _exact_keys(
        value,
        (
            "serviceClass",
            "path",
            "argv",
            "status",
            "startType",
            "accountClass",
            "binarySha256",
        ),
        "tailscaleInstall.service",
    )
    daemon = corpus.artifacts[ARTIFACT_ROLES.index("daemon")]
    if service != {
        "serviceClass": "tailscale-windows-service",
        "path": corpus.service_path,
        "argv": list(corpus.service_argv),
        "status": "running",
        "startType": "automatic",
        "accountClass": "local-system",
        "binarySha256": daemon.sha256,
    }:
        _fail("The postinstall service is not the exact corpus-reviewed exception.")
    return service


def _assert_adapter(value: Any, corpus: InstallArtifactCorpus) -> dict[str, Any]:
    adapter = _exact_keys(
        value,
        (
            "adapterClass",
            "status",
            "driverInfPath",
            "driverInfSha256",
            "driverPath",
            "driverSha256",
            "catalogPath",
            "catalogSha256",
            "tailnetAddressPresent",
        ),
        "tailscaleInstall.adapter",
    )
    driver_inf = corpus.artifacts[ARTIFACT_ROLES.index("driverInf")]
    driver = corpus.artifacts[ARTIFACT_ROLES.index("driver")]
    catalog = corpus.artifacts[ARTIFACT_ROLES.index("catalog")]
    _assert_bool(
        adapter["tailnetAddressPresent"],
        "tailscaleInstall.adapter.tailnetAddressPresent",
    )
    if adapter != {
        "adapterClass": "tailscale-tunnel-adapter",
        "status": "down",
        "driverInfPath": driver_inf.path,
        "driverInfSha256": driver_inf.sha256,
        "driverPath": driver.path,
        "driverSha256": driver.sha256,
        "catalogPath": catalog.path,
        "catalogSha256": catalog.sha256,
        "tailnetAddressPresent": False,
    }:
        _fail("The postinstall adapter is not the exact down corpus-reviewed exception.")
    return adapter


def _assert_tailscale_install(
    value: Any,
    phase: str,
    corpus: InstallArtifactCorpus,
) -> dict[str, Any]:
    install = _exact_keys(
        value,
        (
            "installed",
            "clientVersion",
            "daemonVersion",
            "artifacts",
            "service",
            "adapter",
            "residualState",
            "safetyState",
        ),
        "tailscaleInstall",
    )
    installed = _assert_bool(install["installed"], "tailscaleInstall.installed")
    if phase == "preinstall":
        if installed:
            _fail("Tailscale is already installed in the preinstall snapshot.")
        for field in (
            "clientVersion",
            "daemonVersion",
            "artifacts",
            "service",
            "adapter",
            "safetyState",
        ):
            if install[field] is not None:
                _fail("Preinstall Tailscale metadata must be absent.")
        _assert_residual_state(install["residualState"])
        return install

    if not installed or install["residualState"] is not None:
        _fail("Postinstall state must prove the reviewed installation present.")
    if install["clientVersion"] != corpus.tailscale_version:
        _fail("The installed client version is not corpus-reviewed.")
    if install["daemonVersion"] != corpus.tailscale_version:
        _fail("The installed daemon version is not corpus-reviewed.")
    if install["artifacts"] != _expected_artifact_values(corpus):
        _fail("Installed artifact hashes, paths, signatures, or signers differ.")
    _assert_service(install["service"], corpus)
    _assert_adapter(install["adapter"], corpus)
    _assert_postinstall_safety(install["safetyState"])
    return install


def _expected_installer_argv(corpus: InstallArtifactCorpus) -> list[str]:
    installer = corpus.artifacts[ARTIFACT_ROLES.index("installer")]
    return ["/i", installer.path, *MSI_FIXED_ARGUMENTS]


def _assert_installer_execution(
    value: Any,
    phase: str,
    corpus: InstallArtifactCorpus,
) -> dict[str, Any]:
    execution = _exact_keys(
        value,
        ("executablePath", "argv", "elevated", "result"),
        "installerExecution",
    )
    if execution["executablePath"] != MSIEXEC_PATH:
        _fail("The installer executable path is not exact msiexec.exe.")
    if execution["argv"] != _expected_installer_argv(corpus):
        _fail("The MSI invocation differs from the exact approved arguments.")
    if not _assert_bool(execution["elevated"], "installerExecution.elevated"):
        _fail("The reviewed MSI invocation must be explicitly elevated.")
    if phase == "preinstall":
        if execution["result"] is not None:
            _fail("Preinstall execution must be planned but not completed.")
        return execution
    result = _exact_keys(
        execution["result"],
        (
            "exitCode",
            "processExitObserved",
            "restartRequired",
            "restartInitiated",
            "uiLaunched",
        ),
        "installerExecution.result",
    )
    if _assert_integer(result["exitCode"], "installer result exitCode", 0, 16_441) != 0:
        _fail("The exact MSI invocation did not exit successfully.")
    if not _assert_bool(result["processExitObserved"], "processExitObserved"):
        _fail("The MSI process exit was not observed.")
    for field in ("restartRequired", "restartInitiated", "uiLaunched"):
        if _assert_bool(result[field], f"installer result {field}"):
            _fail("The MSI requested a restart or launched forbidden UI.")
    return execution


def _assert_listeners(
    value: Any,
    corpus: InstallArtifactCorpus,
) -> list[dict[str, Any]]:
    if not isinstance(value, list) or len(value) > MAX_LISTENERS:
        _fail("listeners must be one bounded complete inventory.")
    identities: list[tuple[str, str, str, int, str, str, str]] = []
    for index, item in enumerate(value):
        listener = _exact_keys(
            item,
            (
                "scope",
                "addressClass",
                "port",
                "protocol",
                "ownerClass",
                "ownerCommitmentSha256",
                "ownerBinarySha256",
            ),
            f"listeners[{index}]",
        )
        scope = _assert_string(listener["scope"], "listener scope")
        address_class = _assert_string(listener["addressClass"], "address class")
        protocol = _assert_string(listener["protocol"], "listener protocol")
        owner_class = _assert_string(listener["ownerClass"], "listener owner class")
        if scope not in LISTENER_SCOPES:
            _fail("A listener has an unsupported scope.")
        if address_class not in SAFE_ADDRESS_CLASSES:
            _fail("A listener is wildcard, public, Tailscale-addressed, or unreviewed.")
        if protocol not in LISTENER_PROTOCOLS:
            _fail("A listener has an unsupported protocol.")
        if owner_class not in OWNER_CLASSES:
            _fail("A listener owner is not represented by a reviewed class.")
        port = _assert_integer(listener["port"], "listener port", 1, 65_535)
        owner_sha256 = _assert_sha256(
            listener["ownerCommitmentSha256"], "listener owner commitment"
        )
        binary_sha256 = _assert_sha256(
            listener["ownerBinarySha256"], "listener owner binary"
        )
        identities.append(
            (
                scope,
                address_class,
                protocol,
                port,
                owner_class,
                owner_sha256,
                binary_sha256,
            )
        )
    if identities != sorted(identities) or len(identities) != len(set(identities)):
        _fail("listeners must be sorted and contain no duplicate tuple.")
    if _value_commitment(value) != corpus.approved_listener_inventory_sha256:
        _fail("The listener inventory is not an independently reviewed baseline.")
    return value


def _assert_boundaries(
    value: Any,
    corpus: InstallArtifactCorpus,
) -> dict[str, Any]:
    boundaries = _exact_keys(
        value,
        (
            "windowsFirewallSha256",
            "hyperVFirewallSha256",
            "forwardingSha256",
            "hnsSha256",
            "dockerSha256",
            "nonTailscaleServicesSha256",
            "nonTailscaleAdaptersSha256",
            "windowsFirewallProfilesEnabled",
            "hyperVFirewallAvailable",
            "hyperVFirewallDefaultInboundBlocked",
            "portProxyEntriesPresent",
            "windowsIpForwardingEnabled",
            "hnsExternalForwardingPresent",
            "dockerPublishedPortsPresent",
            "dockerHostNetworkContainersPresent",
        ),
        "boundaries",
    )
    for field in (
        "windowsFirewallSha256",
        "hyperVFirewallSha256",
        "forwardingSha256",
        "hnsSha256",
        "dockerSha256",
        "nonTailscaleServicesSha256",
        "nonTailscaleAdaptersSha256",
    ):
        _assert_sha256(boundaries[field], f"boundaries.{field}")
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
    for field in (*required_true, *required_false):
        _assert_bool(boundaries[field], f"boundaries.{field}")
    if any(not boundaries[field] for field in required_true):
        _fail("Required Windows and Hyper-V firewall protections are not proven.")
    if any(boundaries[field] for field in required_false):
        _fail("A forbidden forwarding or Docker exposure is present.")
    if _value_commitment(boundaries) != corpus.approved_boundary_state_sha256:
        _fail("The boundary state is not an independently reviewed baseline.")
    return boundaries


def _validated_snapshot(
    raw: bytes,
    expected_phase: str,
    expected_challenge: str,
    artifact_corpora: Mapping[str, InstallArtifactCorpus],
) -> _ValidatedSnapshot:
    value = _canonical_json(raw, f"{expected_phase} snapshot")
    snapshot = _exact_keys(
        value,
        (
            "schemaVersion",
            "phase",
            "capturedAt",
            "session",
            "rawSources",
            "hostEnvironment",
            "tailscaleInstall",
            "installerExecution",
            "listeners",
            "boundaries",
            "restrictedCommandsExecuted",
        ),
        f"{expected_phase} snapshot",
    )
    if snapshot["schemaVersion"] != SNAPSHOT_SCHEMA:
        _fail("The install snapshot schema is unsupported.")
    if snapshot["phase"] != expected_phase:
        _fail("The install snapshot phase is not the required phase.")
    captured_at = _instant(snapshot["capturedAt"], f"{expected_phase}.capturedAt")
    corpus, corpus_sha256, production_corpus, monotonic_milliseconds = (
        _assert_session(
            snapshot["session"],
            expected_phase,
            expected_challenge,
            artifact_corpora,
        )
    )
    session_sha256 = snapshot["session"]["sessionCommitmentSha256"]
    sequence = snapshot["session"]["sequence"]
    _assert_raw_sources(
        snapshot["rawSources"],
        corpus,
        session_sha256,
        expected_phase,
        sequence,
    )
    _assert_host_environment(snapshot["hostEnvironment"], corpus)
    _assert_tailscale_install(snapshot["tailscaleInstall"], expected_phase, corpus)
    _assert_installer_execution(snapshot["installerExecution"], expected_phase, corpus)
    _assert_listeners(snapshot["listeners"], corpus)
    _assert_boundaries(snapshot["boundaries"], corpus)
    if _assert_bool(
        snapshot["restrictedCommandsExecuted"],
        f"{expected_phase}.restrictedCommandsExecuted",
    ):
        _fail("A restricted Tailscale, policy, network, or exposure command ran.")
    return _ValidatedSnapshot(
        snapshot,
        captured_at,
        monotonic_milliseconds,
        _sha(raw),
        corpus,
        corpus_sha256,
        production_corpus,
    )


def validate_install_snapshot_pair(
    preinstall_raw: bytes,
    postinstall_raw: bytes,
    *,
    expected_challenge: str,
    artifact_corpora: Mapping[str, InstallArtifactCorpus] = (
        PRODUCTION_INSTALL_ARTIFACT_CORPORA
    ),
) -> bytes:
    """Return a structural manifest; operator install approval remains external."""

    preinstall = _validated_snapshot(
        preinstall_raw,
        "preinstall",
        expected_challenge,
        artifact_corpora,
    )
    postinstall = _validated_snapshot(
        postinstall_raw,
        "postinstall",
        expected_challenge,
        artifact_corpora,
    )
    session_fields = (
        "artifactCorpusId",
        "artifactCorpusSha256",
        "bootSessionCommitmentSha256",
        "challengeCommitmentSha256",
        "collectorSchema",
        "collectorSourceSha256",
        "sessionCommitmentSha256",
    )
    if any(
        preinstall.value["session"][field] != postinstall.value["session"][field]
        for field in session_fields
    ):
        _fail("The two snapshots do not belong to one exact install session.")
    if preinstall.corpus != postinstall.corpus:
        _fail("The install artifact corpus changed within the session.")

    wall_milliseconds = int(
        (postinstall.captured_at - preinstall.captured_at).total_seconds() * 1_000
    )
    monotonic_milliseconds = (
        postinstall.monotonic_milliseconds - preinstall.monotonic_milliseconds
    )
    if (
        not 0 < wall_milliseconds <= MAX_PAIR_MILLISECONDS
        or monotonic_milliseconds != wall_milliseconds
    ):
        _fail("Wall and monotonic elapsed time do not prove one fresh install window.")

    for role in RAW_SOURCE_ROLES:
        if (
            preinstall.value["rawSources"][role]["rawSha256"]
            == postinstall.value["rawSources"][role]["rawSha256"]
        ):
            _fail("A raw source was replayed instead of freshly recollected.")
    for field in ("hostEnvironment", "listeners", "boundaries"):
        if preinstall.value[field] != postinstall.value[field]:
            _fail("Installation changed state outside the fixed corpus exceptions.")
    for field in ("executablePath", "argv", "elevated"):
        if (
            preinstall.value["installerExecution"][field]
            != postinstall.value["installerExecution"][field]
        ):
            _fail("The planned and observed MSI invocation differ.")

    manifest = {
        "schemaVersion": CORPUS_MANIFEST_SCHEMA,
        "artifactCorpusId": preinstall.corpus.corpus_id,
        "artifactCorpusKind": preinstall.corpus.corpus_kind,
        "artifactCorpusSha256": preinstall.corpus_sha256,
        "artifactCorpusReviewSourceBundleSha256": (
            preinstall.corpus.review_source_bundle_sha256
        ),
        "collectorSchema": preinstall.corpus.collector_schema,
        "collectorSourceSha256": preinstall.corpus.collector_source_sha256,
        "sessionCommitmentSha256": preinstall.value["session"][
            "sessionCommitmentSha256"
        ],
        "challengeCommitmentSha256": preinstall.value["session"][
            "challengeCommitmentSha256"
        ],
        "bootSessionCommitmentSha256": preinstall.value["session"][
            "bootSessionCommitmentSha256"
        ],
        "preinstallSnapshotSha256": preinstall.sha256,
        "postinstallSnapshotSha256": postinstall.sha256,
        "preinstallRawSourceBundleSha256": _value_commitment(
            preinstall.value["rawSources"]
        ),
        "postinstallRawSourceBundleSha256": _value_commitment(
            postinstall.value["rawSources"]
        ),
        "preinstallCapturedAt": preinstall.value["capturedAt"],
        "postinstallCapturedAt": postinstall.value["capturedAt"],
        "elapsedMilliseconds": wall_milliseconds,
        "expectedTailscaleVersion": EXPECTED_TAILSCALE_VERSION,
        "expectedInstallerSha256": EXPECTED_INSTALLER_SHA256,
        "allowedChanges": list(ALLOWED_INSTALL_CHANGES),
        "unchangedCommitments": {
            "hostEnvironmentSha256": _value_commitment(
                preinstall.value["hostEnvironment"]
            ),
            "listenerInventorySha256": _value_commitment(
                preinstall.value["listeners"]
            ),
            "boundaryStateSha256": _value_commitment(
                preinstall.value["boundaries"]
            ),
        },
        "restrictedCommandsExecuted": False,
        "productionArtifactCorpusMatched": (
            preinstall.production_artifact_corpus_matched
        ),
        "trustBoundary": TRUST_BOUNDARY,
    }
    return _canonical(manifest)
