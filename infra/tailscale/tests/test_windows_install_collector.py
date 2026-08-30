from __future__ import annotations

import hashlib
import re
import unittest
from pathlib import Path

from infra.tailscale import windows_install_snapshot as SNAPSHOT
from infra.tailscale.tests import test_windows_install_snapshot as FIXTURES


ROOT = Path(__file__).resolve().parents[3]
COLLECTOR = ROOT / "infra" / "tailscale" / "windows_install_collector.ps1"
CI_WORKFLOW = ROOT / ".github" / "workflows" / "ci.yml"
PRODUCER_CHECK = (
    ROOT
    / "infra"
    / "tailscale"
    / "tests"
    / "windows_install_collector_producer_check.py"
)
CONTRACT = ROOT / "infra" / "tailscale" / "windows-install-snapshot-v3.md"
BEGIN = "# BEGIN SECURITY-CRITICAL COLLECTOR SURFACE\n"
END = "# END SECURITY-CRITICAL COLLECTOR SURFACE\n"
COLLECTOR_SOURCE_IDENTITY_PATTERN = re.compile(
    r"(?m)^\$script:CollectorSourceSha256 = '(?P<digest>[0-9a-f]{64})'$"
)


def _security_surface(source: str) -> str:
    if source.count(BEGIN) != 1 or source.count(END) != 1:
        return ""
    return source.split(BEGIN, 1)[1].split(END, 1)[0]


SOURCE = COLLECTOR.read_text(encoding="utf-8")
CI_SOURCE = CI_WORKFLOW.read_text(encoding="utf-8")
PRODUCER_SOURCE = PRODUCER_CHECK.read_text(encoding="utf-8")
CONTRACT_SOURCE = CONTRACT.read_text(encoding="utf-8")
PRODUCER_CHECK_SHA256 = "4ec204e7f7b756e76ddbee681629ecb77f842a3363e858846ceb02635d7ad2e7"
COLLECTOR_SHA256 = "4f9012c6d83b1df6d64d3023d86ddb98ec35b62a0c290be11d8c24ee81a5d44f"
COLLECTOR_SOURCE_IDENTITY_SHA256 = (
    "fa971ddabb08c62f844a30ecd6cc387abe947ff63626e7a1d3aad1458323a215"
)
SECURITY_SURFACE_SHA256 = "f998737b853f3a5c2e832253892bfa908b6e97648e95441bd9fa6cebc71cb542"


def _normalized_collector_source(source: str) -> tuple[str, str] | None:
    matches = list(COLLECTOR_SOURCE_IDENTITY_PATTERN.finditer(source))
    if len(matches) != 1:
        return None
    match = matches[0]
    normalized = (
        source[: match.start("digest")]
        + ("0" * 64)
        + source[match.end("digest") :]
    )
    return normalized, match.group("digest")


def collector_surface_violations(source: str) -> list[str]:
    violations: list[str] = []
    if hashlib.sha256(source.encode("utf-8")).hexdigest() != COLLECTOR_SHA256:
        violations.append("collector-source")
    normalized_source = _normalized_collector_source(source)
    if normalized_source is None:
        violations.append("collector-source-identity")
    else:
        normalized, embedded_identity = normalized_source
        normalized_digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()
        if (
            embedded_identity != COLLECTOR_SOURCE_IDENTITY_SHA256
            or normalized_digest != embedded_identity
        ):
            violations.append("collector-source-identity")
    surface = _security_surface(source)
    if not surface or hashlib.sha256(surface.encode("utf-8")).hexdigest() != SECURITY_SURFACE_SHA256:
        violations.append("security-surface")

    exact_sink = "[System.Console]::Out.Write($canonicalSnapshot)"
    sink_tokens = re.findall(
        r"(?im)^.*(?:Write-(?:Host|Output|Information|Verbose|Debug|Warning|Error)|Console\]::(?:Out|Error)|Out-File|Set-Content|Add-Content|Export-Csv).*$",
        source,
    )
    if sink_tokens != [f"    {exact_sink}"]:
        violations.append("output-surface")

    forbidden = (
        r"(?i)\bInvoke-Expression\b",
        r"(?i)\bInvoke-WebRequest\b",
        r"(?i)\bStart-Process\b",
        r"(?i)\b(?:curl|wget|winget|choco|scoop)\.?(?:exe)?\b",
        r"(?i)(?<![A-Za-z])(?:tailscale|tailscaled)\.exe\b",
        r"(?i)\b(?:New|Set|Remove|Enable|Disable|Restart|Start|Stop)-(?:Service|NetFirewallRule|NetIPAddress|NetRoute|ScheduledTask)\b",
        r"(?i)\b(?:msiexec|netsh|sc)\.exe\s+[/\-]",
        r"(?m)^\s*&\s+",
        r"(?i)\b(?:Get-CimInstance|Get-NetTCPConnection|Get-NetUDPEndpoint|Get-NetFirewallProfile|Get-NetFirewallRule|Get-NetAdapter|Get-Service)\b",
        r"(?i)\b(?:Get-ComputerInfo|Get-Item|Get-ItemProperty|Get-ChildItem|Test-Path|Resolve-Path|Get-Process|Get-FileHash|Get-AuthenticodeSignature|Get-ScheduledTask|Get-NetRoute|Get-DnsClientServerAddress)\b",
        r"(?i)\b(?:HKLM:|HKCU:|Registry::|System\.(?:Diagnostics\.Process|IO\.(?:File|Directory|FileInfo|DirectoryInfo)|Net\.))",
    )
    if any(re.search(pattern, source) for pattern in forbidden):
        violations.append("forbidden-command")

    challenge_lines = [
        line.strip()
        for line in source.splitlines()
        if "$ExpectedChallenge" in line or "$fixture.challenge" in line
    ]
    expected_challenge_lines = {
        "[Parameter(Mandatory)] [string] $ExpectedChallenge",
        "if ($fixture.challenge -isnot [string] -or $fixture.challenge -cnotmatch '\\A[0-9a-f]{32}\\z') { Stop-Collector }",
        "$challengeCommitmentSha256 = Get-DomainCommitment -Domain $script:ChallengeDomain -Fields @($ExpectedChallenge)",
        "$snapshot = New-SyntheticSnapshot -Corpus $artifactCorpus -ExpectedChallenge $fixture.challenge",
    }
    if set(challenge_lines) != expected_challenge_lines or len(challenge_lines) != 4:
        violations.append("challenge-dataflow")

    production_gate = "if (-not $SyntheticFixture) { Stop-Collector }"
    first_runtime_lines = [
        line.strip()
        for line in source.split(END, 1)[1].splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ] if END in source else []
    # The gate lives inside the frozen block and precedes every validation or
    # construction call; pin its relative ordering explicitly as defense in depth.
    gate_at = source.find(production_gate)
    input_at = source.find("$fixture = Read-SyntheticInput")
    corpus_at = source.find("$artifactCorpus = Read-TestArtifactCorpus")
    snapshot_at = source.find("$snapshot = New-SyntheticSnapshot")
    if (
        min(gate_at, input_at, corpus_at, snapshot_at) < 0
        or not gate_at < input_at < corpus_at < snapshot_at
    ):
        violations.append("production-gate-order")
    if first_runtime_lines:
        violations.append("code-after-security-surface")

    if "HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)" not in source:
        violations.append("case-insensitive-path-identity")
    if source.count("[System.StringComparer]::Ordinal.Equals(") != 2:
        violations.append("exact-path-binding")
    return sorted(set(violations))


class WindowsInstallCollectorTests(unittest.TestCase):
    def test_scaffold_matches_exact_snapshot_and_raw_role_contract(self) -> None:
        self.assertEqual(collector_surface_violations(SOURCE), [])
        self.assertTrue(SOURCE.startswith("#Requires -Version 7.4\n<#\n"))
        self.assertEqual(SOURCE.count("<#"), 1)
        self.assertEqual(SOURCE.count("#>"), 1)
        self.assertIn(f"$script:SnapshotSchema = '{SNAPSHOT.SNAPSHOT_SCHEMA}'", SOURCE)
        self.assertIn(f"$script:CollectorSchema = '{SNAPSHOT.COLLECTOR_SCHEMA}'", SOURCE)
        normalized_source = _normalized_collector_source(SOURCE)
        self.assertIsNotNone(normalized_source)
        assert normalized_source is not None
        normalized, embedded_identity = normalized_source
        self.assertEqual(embedded_identity, COLLECTOR_SOURCE_IDENTITY_SHA256)
        self.assertEqual(
            hashlib.sha256(normalized.encode("utf-8")).hexdigest(),
            embedded_identity,
        )
        self.assertEqual(
            FIXTURES.TEST_CORPUS.collector_source_sha256,
            COLLECTOR_SOURCE_IDENTITY_SHA256,
        )
        artifact_roles_match = re.search(
            r"\$script:ArtifactRoles = @\(\n(?P<body>.*?)\n\)",
            SOURCE,
            re.DOTALL,
        )
        self.assertIsNotNone(artifact_roles_match)
        assert artifact_roles_match is not None
        self.assertEqual(
            tuple(re.findall(r"'([^']+)'", artifact_roles_match.group("body"))),
            (
                "installer",
                "client",
                "gui",
                "daemon",
                "driverLibrary",
                "driverInf",
                "driver",
                "catalog",
            ),
        )
        raw_roles_match = re.search(
            r"\$script:RawRoles = @\(\n(?P<body>.*?)\n\)",
            SOURCE,
            re.DOTALL,
        )
        self.assertIsNotNone(raw_roles_match)
        assert raw_roles_match is not None
        self.assertEqual(
            tuple(re.findall(r"'([^']+)'", raw_roles_match.group("body"))),
            SNAPSHOT.RAW_SOURCE_ROLES,
        )
        for role in SNAPSHOT.RAW_SOURCE_ROLES:
            self.assertIn(f"{role} = '{SNAPSHOT.SOURCE_SCHEMAS[role]}'", SOURCE)
        for literal in (
            "$script:ArtifactCorpusSchema = 'nutrition-tracker-windows-tailscale-install-artifact-corpus-v2'",
            "$script:CollectorSchema = 'nutrition-tracker-windows-tailscale-install-collector-v2'",
            "$script:ChallengeDomain = 'nutrition-tracker-windows-tailscale-install-challenge-v1'",
            "$script:SessionDomain = 'nutrition-tracker-windows-tailscale-install-session-v2'",
            "$script:CaptureDomain = 'nutrition-tracker-windows-tailscale-install-raw-capture-v2'",
            "$script:SyntheticRawDomain = 'nutrition-tracker-windows-tailscale-install-synthetic-raw-v2'",
        ):
            self.assertIn(literal, SOURCE)
        for field in (
            "authenticode",
            "catalogMembership",
            "signerLeafCertificateDerSha256",
            "timestampLeafCertificateDerSha256",
            "timestampUtc",
            "memberDigestAlgorithm",
            "memberDigest",
            "driverInfPath",
            "driverInfSha256",
        ):
            self.assertIn(field, SOURCE)

    def test_production_gate_precedes_all_corpus_parsing_and_construction(self) -> None:
        gate = SOURCE.index("if (-not $SyntheticFixture) { Stop-Collector }")
        self.assertLess(gate, SOURCE.index("$fixture = Read-SyntheticInput"))
        self.assertLess(gate, SOURCE.index("$artifactCorpus = Read-TestArtifactCorpus"))
        self.assertLess(gate, SOURCE.index("$snapshot = New-SyntheticSnapshot"))
        self.assertNotIn("PRODUCTION_INSTALL_ARTIFACT_CORPORA", SOURCE)

    def test_no_host_query_or_restricted_command_surface_exists(self) -> None:
        self.assertNotIn("forbidden-command", collector_surface_violations(SOURCE))
        self.assertNotIn("[string] $Challenge", SOURCE)
        self.assertNotIn("[string] $ArtifactCorpusJson", SOURCE)
        self.assertNotIn("ReadToEnd", SOURCE)
        self.assertEqual(SOURCE.count("$reader = [System.Console]::In"), 1)
        self.assertEqual(
            SOURCE.count("Read-BoundedStandardInput -MaximumCharacters 131072"),
            1,
        )
        self.assertEqual(SOURCE.count("[System.Console]::Out.Write("), 1)
        self.assertIn("return ,$items", SOURCE)

    def test_whole_surface_guard_rejects_direct_and_transformed_exfiltration(self) -> None:
        mutations = (
            (
                SOURCE.replace(
                    "[System.Console]::Out.Write($canonicalSnapshot)",
                    "[System.Console]::Out.Write($fixture.challenge)",
                ),
                {"output-surface", "challenge-dataflow"},
            ),
            (
                SOURCE.replace(
                    "[System.Console]::Out.Write($canonicalSnapshot)",
                    "[System.Console]::Out.Write(-join ([char[]]$fixture.challenge)[31..0])",
                ),
                {"output-surface", "challenge-dataflow"},
            ),
            (
                SOURCE.replace(
                    "restrictedCommandsExecuted = $false",
                    "restrictedCommandsExecuted = $ExpectedChallenge.Substring(0, 16)",
                    1,
                ),
                {"challenge-dataflow"},
            ),
            (
                SOURCE.replace(
                    END,
                    END + "[System.Console]::Out.Write($fixture.challenge[0..15])\n",
                ),
                {"output-surface", "challenge-dataflow", "code-after-security-surface"},
            ),
        )
        for mutation, expected_violations in mutations:
            with self.subTest(expected_violations=expected_violations):
                self.assertNotEqual(mutation, SOURCE)
                self.assertTrue(
                    expected_violations <= set(collector_surface_violations(mutation))
                )

    def test_case_variant_artifact_paths_are_treated_as_one_identity(self) -> None:
        paths = [artifact.path for artifact in FIXTURES.TEST_CORPUS.artifacts]
        paths.append(paths[0].swapcase())
        identities = {path.casefold() for path in paths}
        self.assertNotEqual(len(identities), len(paths))
        self.assertIn("[System.StringComparer]::OrdinalIgnoreCase", SOURCE)

    def test_synthetic_contract_fixtures_validate_without_running_powershell(self) -> None:
        result = SNAPSHOT.validate_install_snapshot_pair(
            FIXTURES._canonical(FIXTURES._preinstall()),
            FIXTURES._canonical(FIXTURES._postinstall()),
            expected_challenge=FIXTURES.CHALLENGE,
            artifact_corpora=FIXTURES.TEST_CORPORA,
        )
        self.assertIn(SNAPSHOT.CORPUS_MANIFEST_SCHEMA.encode(), result)
        self.assertNotIn(FIXTURES.CHALLENGE.encode(), result)

    def test_explicit_producer_check_has_a_bounded_no_shell_boundary(self) -> None:
        self.assertEqual(
            hashlib.sha256(PRODUCER_SOURCE.encode("utf-8")).hexdigest(),
            PRODUCER_CHECK_SHA256,
        )
        for forbidden in (
            "shell=True",
            "os.system",
            "os.popen",
            "Popen(",
            "tempfile",
            "NamedTemporaryFile",
            ".write_text(",
            ".write_bytes(",
        ):
            self.assertNotIn(forbidden, PRODUCER_SOURCE)
        producer_source_casefold = PRODUCER_SOURCE.casefold()
        for forbidden in (
            '"-executionpolicy"',
            '"-command"',
            '"-encodedcommand"',
        ):
            self.assertNotIn(forbidden, producer_source_casefold)
        self.assertEqual(PRODUCER_SOURCE.count('"-File",'), 2)
        self.assertEqual(PRODUCER_SOURCE.count('"-SyntheticFixture",'), 2)
        self.assertIn('input_bytes=fixture_input,', PRODUCER_SOURCE)
        self.assertIn('"-NoProfile",', PRODUCER_SOURCE)
        self.assertIn('"-NonInteractive",', PRODUCER_SOURCE)
        self.assertIn('"-SyntheticFixture",', PRODUCER_SOURCE)
        self.assertIn('if first != second or first != expected[phase]:', PRODUCER_SOURCE)
        self.assertIn("productionArtifactCorpusMatched", PRODUCER_SOURCE)
        self.assertIn('"negativeCasesRun": 3,', PRODUCER_SOURCE)
        self.assertIn('case_name="array-shaped-corpus-kind",', PRODUCER_SOURCE)
        self.assertIn('"powerShellExecutableSha256": executable_sha256,', PRODUCER_SOURCE)
        self.assertIn('"powerShellRuntime": runtime_kind,', PRODUCER_SOURCE)
        self.assertIn("reviewed_public_bytes=(", PRODUCER_SOURCE)
        self.assertIn("STATIC.SOURCE.encode(\"utf-8\")", PRODUCER_SOURCE)
        self.assertIn("range(len(oversize_input) - 7)", PRODUCER_SOURCE)
        self.assertIn("leak_tokens=oversize_leak_tokens,", PRODUCER_SOURCE)
        self.assertIn(
            "if _sha256_file(Path(executable)) != executable_sha256:",
            PRODUCER_SOURCE,
        )
        for injection_prefix in (
            '"corehost_",',
            '"dotnet_",',
            '"dyld_",',
            '"ld_",',
            '"powershell_",',
            '"psmodule",',
        ):
            self.assertIn(injection_prefix, PRODUCER_SOURCE)
        for injection_variable in (
            "__PSLockdownPolicy",
            "PSExecutionPolicyPreference",
        ):
            self.assertIn(injection_variable, PRODUCER_SOURCE)
        self.assertEqual(
            CI_SOURCE.count(
                "python3 -B -m "
                "infra.tailscale.tests.windows_install_collector_producer_check"
            ),
            1,
        )

    def test_contract_documentation_states_non_authorizing_boundary(self) -> None:
        self.assertIn("production path intentionally fails before\nhost inspection", SOURCE)
        self.assertIn("cannot authorize an install, tailnet action, or exposure", SOURCE)
        self.assertIn("performs\nno host query", SOURCE)
        self.assertIn("canonical JSON envelope from standard input", CONTRACT_SOURCE)
        self.assertIn("replacing the single embedded identity digest", CONTRACT_SOURCE)
        self.assertIn("with 64 zero\nbytes", CONTRACT_SOURCE)
        self.assertIn("has not been executed against Windows", CONTRACT_SOURCE)
        self.assertIn("not a production collector", CONTRACT_SOURCE)


if __name__ == "__main__":
    unittest.main()
