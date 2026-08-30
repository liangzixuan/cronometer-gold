#Requires -Version 7.4
<#
Offline Windows Tailscale install-evidence collector scaffold.

Contract: this source emits only the v2 snapshot consumed by
windows_install_snapshot.py. The production path intentionally fails before
host inspection while the immutable production corpus registry is empty.
The explicit SyntheticFixture path exists only to freeze canonicalization,
commitments, exact MSI record binding, and the redaction surface. It performs
no host query and cannot authorize an install, tailnet action, or exposure.

A future reviewed production implementation may add fixed read-only queries,
but must retain the fail-closed corpus gate and must never install, uninstall,
authenticate, invoke the Tailscale CLI, alter Windows/Hyper-V firewall or
network state, launch UI/browser state, download content, or write files.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $Phase,
    [Parameter()] [switch] $SyntheticFixture
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$script:CollectorSourceSha256 = 'de6d21f37b1922dbfb8d22e27932443c190ca0985e5d524774feb14b4e26fb18'

# BEGIN SECURITY-CRITICAL COLLECTOR SURFACE
$script:SnapshotSchema = 'nutrition-tracker-windows-tailscale-install-snapshot-v2'
$script:ArtifactCorpusSchema = 'nutrition-tracker-windows-tailscale-install-artifact-corpus-v1'
$script:CollectorSchema = 'nutrition-tracker-windows-tailscale-install-collector-v1'
$script:ExpectedVersion = '1.102.3'
$script:ExpectedInstallerSha256 = '03ac8183c6e3ce276e9b44281ebe7e4c02aef28a971034ca170c4b665df42dce'
$script:ChallengeDomain = 'nutrition-tracker-windows-tailscale-install-challenge-v1'
$script:SessionDomain = 'nutrition-tracker-windows-tailscale-install-session-v1'
$script:CaptureDomain = 'nutrition-tracker-windows-tailscale-install-raw-capture-v1'
$script:SyntheticRawDomain = 'nutrition-tracker-windows-tailscale-install-synthetic-raw-v1'
$script:MsiExecPath = 'C:\Windows\System32\msiexec.exe'
$script:MsiArguments = @(
    '/qn',
    '/norestart',
    'TS_NOLAUNCH=1',
    'TS_ALLOWINCOMINGCONNECTIONS=never',
    'TS_UNATTENDEDMODE=never',
    'TS_INSTALLUPDATES=never'
)
$script:ArtifactRoles = @('installer', 'client', 'daemon', 'driver', 'catalog')
$script:RawRoles = @(
    'hostEnvironment', 'tailscaleInstall', 'installerInvocation',
    'installerResult', 'listeners', 'windowsFirewall', 'hyperVFirewall',
    'forwarding', 'hns', 'docker', 'services', 'adapters'
)
$script:SourceSchemas = [ordered]@{
    hostEnvironment = 'nutrition-tracker-windows-tailscale-install-host-environment-raw-v1'
    tailscaleInstall = 'nutrition-tracker-windows-tailscale-install-tailscale-install-raw-v1'
    installerInvocation = 'nutrition-tracker-windows-tailscale-install-installer-invocation-raw-v1'
    installerResult = 'nutrition-tracker-windows-tailscale-install-installer-result-raw-v1'
    listeners = 'nutrition-tracker-windows-tailscale-install-listeners-raw-v1'
    windowsFirewall = 'nutrition-tracker-windows-tailscale-install-windows-firewall-raw-v1'
    hyperVFirewall = 'nutrition-tracker-windows-tailscale-install-hyper-v-firewall-raw-v1'
    forwarding = 'nutrition-tracker-windows-tailscale-install-forwarding-raw-v1'
    hns = 'nutrition-tracker-windows-tailscale-install-hns-raw-v1'
    docker = 'nutrition-tracker-windows-tailscale-install-docker-raw-v1'
    services = 'nutrition-tracker-windows-tailscale-install-services-raw-v1'
    adapters = 'nutrition-tracker-windows-tailscale-install-adapters-raw-v1'
}

function Stop-Collector {
    throw [System.InvalidOperationException]::new('Windows install evidence collection failed closed.')
}

function Get-Sha256Hex {
    param([Parameter(Mandatory)] [string] $Text)
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
    return [System.Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
}

function Get-DomainCommitment {
    param(
        [Parameter(Mandatory)] [string] $Domain,
        [Parameter(Mandatory)] [string[]] $Fields
    )
    return Get-Sha256Hex -Text ($Domain + "`n" + ($Fields -join "`n") + "`n")
}

function ConvertTo-SortedNode {
    param([AllowNull()] [object] $Value)
    if ($null -eq $Value) { return $null }
    if ($Value -is [string] -or $Value -is [bool] -or $Value -is [int] -or $Value -is [long]) {
        return $Value
    }
    if ($Value -is [System.Collections.IDictionary]) {
        $result = [ordered]@{}
        foreach ($key in @($Value.Keys | Sort-Object -CaseSensitive)) {
            $result[[string]$key] = ConvertTo-SortedNode -Value $Value[$key]
        }
        return $result
    }
    if ($Value -is [pscustomobject]) {
        $result = [ordered]@{}
        foreach ($property in @($Value.PSObject.Properties | Sort-Object -Property Name -CaseSensitive)) {
            $result[$property.Name] = ConvertTo-SortedNode -Value $property.Value
        }
        return $result
    }
    if ($Value -is [System.Collections.IEnumerable]) {
        $items = @($Value | ForEach-Object { ConvertTo-SortedNode -Value $_ })
        return ,$items
    }
    Stop-Collector
}

function ConvertTo-CanonicalJson {
    param([Parameter(Mandatory)] [object] $Value)
    $sorted = ConvertTo-SortedNode -Value $Value
    return (($sorted | ConvertTo-Json -Compress -Depth 32) + "`n")
}

function Assert-ExactProperties {
    param(
        [Parameter(Mandatory)] [pscustomobject] $Value,
        [Parameter(Mandatory)] [string[]] $Names
    )
    $actual = @($Value.PSObject.Properties.Name | Sort-Object -CaseSensitive)
    $expected = @($Names | Sort-Object -CaseSensitive)
    if (($actual -join "`n") -cne ($expected -join "`n")) { Stop-Collector }
}

function Assert-Sha256 {
    param([AllowNull()] [object] $Value)
    if ($Value -isnot [string] -or $Value -cnotmatch '\A[0-9a-f]{64}\z') { Stop-Collector }
}

function Read-BoundedStandardInput {
    param([Parameter(Mandatory)] [int] $MaximumCharacters)
    if ($MaximumCharacters -lt 2 -or $MaximumCharacters -gt 131072) { Stop-Collector }
    $reader = [System.Console]::In
    $buffer = [char[]]::new(4096)
    $builder = [System.Text.StringBuilder]::new()
    while ($builder.Length -le $MaximumCharacters) {
        $remaining = ($MaximumCharacters + 1) - $builder.Length
        $toRead = [System.Math]::Min($buffer.Length, $remaining)
        $read = $reader.Read($buffer, 0, $toRead)
        if ($read -eq 0) { return $builder.ToString() }
        [void] $builder.Append($buffer, 0, $read)
    }
    Stop-Collector
}

function Read-SyntheticInput {
    param([Parameter(Mandatory)] [string] $InputJson)
    if ($InputJson.Length -lt 2 -or $InputJson.Length -gt 131072) { Stop-Collector }
    try { $fixture = $InputJson | ConvertFrom-Json -Depth 32 -NoEnumerate }
    catch { Stop-Collector }
    Assert-ExactProperties -Value $fixture -Names @('artifactCorpus', 'challenge')
    if ($fixture.challenge -isnot [string] -or $fixture.challenge -cnotmatch '\A[0-9a-f]{32}\z') { Stop-Collector }
    if ($fixture.artifactCorpus -isnot [pscustomobject]) { Stop-Collector }
    if ((ConvertTo-CanonicalJson -Value $fixture) -cne $InputJson) { Stop-Collector }
    return $fixture
}

function Read-TestArtifactCorpus {
    param([Parameter(Mandatory)] [pscustomobject] $Corpus)
    $corpus = $Corpus
    Assert-ExactProperties -Value $corpus -Names @(
        'corpusId', 'corpusKind', 'schemaVersion', 'reviewSourceBundleSha256',
        'collectorSchema', 'collectorSourceSha256', 'tailscaleVersion',
        'artifacts', 'servicePath', 'serviceArgv',
        'approvedHostEnvironmentSha256', 'approvedListenerInventorySha256',
        'approvedBoundaryStateSha256', 'sourceCorpora', 'artifactCorpusSha256'
    )
    if ($corpus.corpusKind -cne 'test' -or $corpus.corpusId -cnotmatch '\Atest-[a-z0-9._-]{0,59}\z') { Stop-Collector }
    if ($corpus.schemaVersion -cne $script:ArtifactCorpusSchema -or $corpus.collectorSchema -cne $script:CollectorSchema) { Stop-Collector }
    if ($corpus.tailscaleVersion -cne $script:ExpectedVersion) { Stop-Collector }
    foreach ($digest in @(
        $corpus.reviewSourceBundleSha256, $corpus.collectorSourceSha256,
        $corpus.approvedHostEnvironmentSha256, $corpus.approvedListenerInventorySha256,
        $corpus.approvedBoundaryStateSha256, $corpus.artifactCorpusSha256
    )) { Assert-Sha256 -Value $digest }
    if ($corpus.collectorSourceSha256 -cne $script:CollectorSourceSha256) { Stop-Collector }

    if (@($corpus.artifacts).Count -ne $script:ArtifactRoles.Count) { Stop-Collector }
    $pathIdentities = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    for ($index = 0; $index -lt $script:ArtifactRoles.Count; $index += 1) {
        $artifact = $corpus.artifacts[$index]
        Assert-ExactProperties -Value $artifact -Names @('role', 'path', 'sha256', 'signatureStatus', 'signerIdentitySha256')
        if ($artifact.role -cne $script:ArtifactRoles[$index]) { Stop-Collector }
        $path = $artifact.path
        $segments = @()
        if ($path -is [string] -and $path.Length -ge 3) {
            $segments = @($path.Substring(3).Split('\'))
        }
        if (
            $path -isnot [string] -or
            $path -cnotmatch '\A[A-Z]:\\[^\x00-\x1f"*?<>|:]{1,239}\z' -or
            $path.Contains('/') -or
            $path.Contains('%') -or
            $path.EndsWith('\')
        ) { Stop-Collector }
        foreach ($segment in $segments) {
            if (
                $segment.Length -eq 0 -or
                $segment -ceq '.' -or
                $segment -ceq '..' -or
                $segment.EndsWith(' ') -or
                $segment.EndsWith('.')
            ) { Stop-Collector }
        }
        if (-not $pathIdentities.Add($artifact.path)) { Stop-Collector }
        Assert-Sha256 -Value $artifact.sha256
        Assert-Sha256 -Value $artifact.signerIdentitySha256
        if ($artifact.signatureStatus -cne 'Valid') { Stop-Collector }
    }
    if ($corpus.artifacts[0].sha256 -cne $script:ExpectedInstallerSha256) { Stop-Collector }
    if (-not [System.StringComparer]::Ordinal.Equals($corpus.servicePath, $corpus.artifacts[2].path)) { Stop-Collector }
    if (@($corpus.serviceArgv).Count -lt 1 -or @($corpus.serviceArgv).Count -gt 8 -or -not [System.StringComparer]::Ordinal.Equals($corpus.serviceArgv[0], $corpus.servicePath)) { Stop-Collector }
    foreach ($argument in @($corpus.serviceArgv)) {
        if ($argument -isnot [string] -or $argument.Length -lt 1 -or $argument.Length -gt 260 -or $argument -match '[\x00-\x1f]') { Stop-Collector }
    }

    if (@($corpus.sourceCorpora).Count -ne $script:RawRoles.Count) { Stop-Collector }
    for ($index = 0; $index -lt $script:RawRoles.Count; $index += 1) {
        $source = $corpus.sourceCorpora[$index]
        Assert-ExactProperties -Value $source -Names @('role', 'schemaVersion', 'parserCorpusSha256')
        $role = $script:RawRoles[$index]
        if ($source.role -cne $role -or $source.schemaVersion -cne $script:SourceSchemas[$role]) { Stop-Collector }
        Assert-Sha256 -Value $source.parserCorpusSha256
    }

    $committed = [ordered]@{
        corpusId = $corpus.corpusId; corpusKind = $corpus.corpusKind
        schemaVersion = $corpus.schemaVersion; reviewSourceBundleSha256 = $corpus.reviewSourceBundleSha256
        collectorSchema = $corpus.collectorSchema; collectorSourceSha256 = $corpus.collectorSourceSha256
        tailscaleVersion = $corpus.tailscaleVersion; artifacts = @($corpus.artifacts)
        servicePath = $corpus.servicePath; serviceArgv = @($corpus.serviceArgv)
        approvedHostEnvironmentSha256 = $corpus.approvedHostEnvironmentSha256
        approvedListenerInventorySha256 = $corpus.approvedListenerInventorySha256
        approvedBoundaryStateSha256 = $corpus.approvedBoundaryStateSha256
        sourceCorpora = @($corpus.sourceCorpora)
    }
    if ((Get-Sha256Hex -Text (ConvertTo-CanonicalJson -Value $committed)) -cne $corpus.artifactCorpusSha256) { Stop-Collector }
    return $corpus
}

function New-SyntheticSnapshot {
    param(
        [Parameter(Mandatory)] [pscustomobject] $Corpus,
        [Parameter(Mandatory)] [string] $ExpectedChallenge
    )
    $sequence = if ($Phase -ceq 'preinstall') { 1 } else { 2 }
    $capturedAt = if ($sequence -eq 1) { '2026-08-29T12:00:00.000Z' } else { '2026-08-29T12:05:00.000Z' }
    $monotonicMilliseconds = if ($sequence -eq 1) { 10000 } else { 310000 }
    $challengeCommitmentSha256 = Get-DomainCommitment -Domain $script:ChallengeDomain -Fields @($ExpectedChallenge)
    $bootSessionCommitmentSha256 = Get-Sha256Hex -Text 'synthetic-boot-session'
    $sessionCommitmentSha256 = Get-DomainCommitment -Domain $script:SessionDomain -Fields @(
        $challengeCommitmentSha256, $bootSessionCommitmentSha256,
        $Corpus.artifactCorpusSha256, $Corpus.collectorSourceSha256
    )
    $rawSources = [ordered]@{}
    for ($index = 0; $index -lt $script:RawRoles.Count; $index += 1) {
        $role = $script:RawRoles[$index]
        $source = $Corpus.sourceCorpora[$index]
        $rawSha256 = Get-DomainCommitment -Domain $script:SyntheticRawDomain -Fields @($Phase, [string]$sequence, $role, $sessionCommitmentSha256)
        $capture = Get-DomainCommitment -Domain $script:CaptureDomain -Fields @(
            $sessionCommitmentSha256, $Phase, [string]$sequence, $role,
            $rawSha256, $source.parserCorpusSha256
        )
        $rawSources[$role] = [ordered]@{
            schemaVersion = $source.schemaVersion; rawSha256 = $rawSha256
            parserCorpusSha256 = $source.parserCorpusSha256; captureCommitmentSha256 = $capture
        }
    }

    $hostEnvironment = [ordered]@{
        windowsVersion = '10.0.26200.9168'; powershellVersion = '7.6.4'; wslVersion = '2.6.1.0'
        wslKernelVersion = '6.6.87.2-microsoft-standard-WSL2'; wslDistribution = 'Ubuntu-24.04'
        wsl2Enabled = $true; wslDistributionRunning = $true; wslTailscaleInstalled = $false
        dockerDesktopVersion = '4.45.0'; dockerEngineVersion = '28.3.3'; dockerContext = 'desktop-linux'
        dockerDesktopRunning = $true; dockerLinuxContainers = $true; dockerDesktopWslIntegration = $true
        secondWslDockerEngineInstalled = $false
    }
    $listeners = @(
        [ordered]@{ scope = 'windows-host'; addressClass = 'ipv4-loopback'; port = 4000; protocol = 'tcp'; ownerClass = 'project-api'; ownerCommitmentSha256 = (Get-Sha256Hex -Text 'api-owner'); ownerBinarySha256 = (Get-Sha256Hex -Text 'api-binary') },
        [ordered]@{ scope = 'wsl2-ubuntu'; addressClass = 'ipv4-loopback'; port = 5432; protocol = 'tcp'; ownerClass = 'project-dependency'; ownerCommitmentSha256 = (Get-Sha256Hex -Text 'db-owner'); ownerBinarySha256 = (Get-Sha256Hex -Text 'db-binary') }
    )
    $boundaries = [ordered]@{
        windowsFirewallSha256 = ('1' * 64); hyperVFirewallSha256 = ('2' * 64); forwardingSha256 = ('3' * 64)
        hnsSha256 = ('4' * 64); dockerSha256 = ('5' * 64); nonTailscaleServicesSha256 = ('6' * 64)
        nonTailscaleAdaptersSha256 = ('7' * 64); windowsFirewallProfilesEnabled = $true
        hyperVFirewallAvailable = $true; hyperVFirewallDefaultInboundBlocked = $true
        portProxyEntriesPresent = $false; windowsIpForwardingEnabled = $false
        hnsExternalForwardingPresent = $false; dockerPublishedPortsPresent = $false
        dockerHostNetworkContainersPresent = $false
    }
    if ((Get-Sha256Hex -Text (ConvertTo-CanonicalJson -Value $hostEnvironment)) -cne $Corpus.approvedHostEnvironmentSha256) { Stop-Collector }
    if ((Get-Sha256Hex -Text (ConvertTo-CanonicalJson -Value $listeners)) -cne $Corpus.approvedListenerInventorySha256) { Stop-Collector }
    if ((Get-Sha256Hex -Text (ConvertTo-CanonicalJson -Value $boundaries)) -cne $Corpus.approvedBoundaryStateSha256) { Stop-Collector }

    $residual = [ordered]@{ productRegistrationPresent = $false; servicePresent = $false; adapterPresent = $false; programFilesPresent = $false; programDataPresent = $false; registryResidualPresent = $false; scheduledTaskPresent = $false; firewallRulePresent = $false; dnsPolicyPresent = $false; routePresent = $false; uiProcessPresent = $false; updateMechanismPresent = $false }
    $safety = [ordered]@{ loginPresent = $false; tailnetIdentityPresent = $false; serveConfigured = $false; funnelConfigured = $false; tailnetRoutesPresent = $false; tailnetDnsConfigured = $false; uiProcessRunning = $false; updateMechanismEnabled = $false; incomingConnectionsAllowed = $false; tailnetAddressPresent = $false }
    $installerArgv = @('/i', $Corpus.artifacts[0].path) + $script:MsiArguments
    if ($sequence -eq 1) {
        $tailscaleInstall = [ordered]@{ installed = $false; clientVersion = $null; daemonVersion = $null; artifacts = $null; service = $null; adapter = $null; residualState = $residual; safetyState = $null }
        $installerResult = $null
    } else {
        $tailscaleInstall = [ordered]@{
            installed = $true; clientVersion = $Corpus.tailscaleVersion; daemonVersion = $Corpus.tailscaleVersion
            artifacts = @($Corpus.artifacts); residualState = $null; safetyState = $safety
            service = [ordered]@{ serviceClass = 'tailscale-windows-service'; path = $Corpus.servicePath; argv = @($Corpus.serviceArgv); status = 'running'; startType = 'automatic'; accountClass = 'local-system'; binarySha256 = $Corpus.artifacts[2].sha256 }
            adapter = [ordered]@{ adapterClass = 'tailscale-tunnel-adapter'; status = 'down'; driverPath = $Corpus.artifacts[3].path; driverSha256 = $Corpus.artifacts[3].sha256; catalogPath = $Corpus.artifacts[4].path; catalogSha256 = $Corpus.artifacts[4].sha256; tailnetAddressPresent = $false }
        }
        $installerResult = [ordered]@{ exitCode = 0; processExitObserved = $true; restartRequired = $false; restartInitiated = $false; uiLaunched = $false }
    }
    return [ordered]@{
        schemaVersion = $script:SnapshotSchema; phase = $Phase; capturedAt = $capturedAt
        session = [ordered]@{ artifactCorpusId = $Corpus.corpusId; artifactCorpusSha256 = $Corpus.artifactCorpusSha256; bootSessionCommitmentSha256 = $bootSessionCommitmentSha256; challengeCommitmentSha256 = $challengeCommitmentSha256; collectorSchema = $Corpus.collectorSchema; collectorSourceSha256 = $Corpus.collectorSourceSha256; sequence = $sequence; monotonicMilliseconds = $monotonicMilliseconds; sessionCommitmentSha256 = $sessionCommitmentSha256 }
        rawSources = $rawSources; hostEnvironment = $hostEnvironment; tailscaleInstall = $tailscaleInstall
        installerExecution = [ordered]@{ executablePath = $script:MsiExecPath; argv = $installerArgv; elevated = $true; result = $installerResult }
        listeners = $listeners; boundaries = $boundaries; restrictedCommandsExecuted = $false
    }
}

function Write-CanonicalSnapshot {
    param([Parameter(Mandatory)] [object] $Snapshot)
    $canonicalSnapshot = ConvertTo-CanonicalJson -Value $Snapshot
    [System.Console]::Out.Write($canonicalSnapshot)
}

try {
    if (-not $SyntheticFixture) { Stop-Collector }
    if ($Phase -cne 'preinstall' -and $Phase -cne 'postinstall') { Stop-Collector }
    $inputJson = Read-BoundedStandardInput -MaximumCharacters 131072
    $fixture = Read-SyntheticInput -InputJson $inputJson
    $artifactCorpus = Read-TestArtifactCorpus -Corpus $fixture.artifactCorpus
    $snapshot = New-SyntheticSnapshot -Corpus $artifactCorpus -ExpectedChallenge $fixture.challenge
    Write-CanonicalSnapshot -Snapshot $snapshot
} catch {
    Stop-Collector
}
# END SECURITY-CRITICAL COLLECTOR SURFACE
