#Requires -Version 7.0
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
try {
    if (-not $IsWindows -or [IntPtr]::Size -ne 8) { throw 'Unsupported controller platform.' }
    Add-Type -Path (Join-Path $PSScriptRoot 'windows-owned-process.cs')
    [void][WindowsOwnedProcess]::InitializeControllerConsole()
    $request = [WindowsOwnedProcess]::ReadRequestLine([Console]::In) | ConvertFrom-Json -AsHashtable
    $expected = @('arguments', 'cwd', 'environment', 'executable', 'maxOutputBytes', 'timeoutMs')
    if ((($request.Keys | Sort-Object) -join ',') -cne ($expected -join ',')) { throw 'Invalid request fields.' }
    foreach ($path in @($request.executable, $request.cwd)) {
        if ($path -isnot [string] -or -not [IO.Path]::IsPathFullyQualified($path) -or $path.Contains([char]0)) {
            throw 'Invalid command path.'
        }
    }
    if ($request.arguments -isnot [array] -or $request.arguments.Count -gt 128) { throw 'Invalid argument array.' }
    foreach ($argument in $request.arguments) {
        if ($argument -isnot [string] -or $argument.Contains([char]0)) { throw 'Invalid argument.' }
    }
    if ($request.timeoutMs -isnot [long] -and $request.timeoutMs -isnot [int]) { throw 'Invalid time bound.' }
    if ($request.maxOutputBytes -isnot [long] -and $request.maxOutputBytes -isnot [int]) { throw 'Invalid output bound.' }
    if ($request.timeoutMs -lt 100 -or $request.timeoutMs -gt 240000 -or $request.maxOutputBytes -lt 1 -or $request.maxOutputBytes -gt 20000000) { throw 'Invalid bounds.' }
    if ($request.environment -isnot [Collections.IDictionary]) { throw 'Invalid environment.' }
    $environment = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in $request.environment.GetEnumerator()) {
        if ($entry.Key -isnot [string] -or $entry.Value -isnot [string] -or $entry.Key.Length -eq 0 -or $entry.Key.Contains('=') -or $entry.Key.Contains([char]0) -or $entry.Value.Contains([char]0)) { throw 'Invalid environment entry.' }
        $environment.Add($entry.Key, $entry.Value)
    }
    $result = [WindowsOwnedProcess]::Run($request.executable, [string[]]$request.arguments, $request.cwd, $environment, [int]$request.timeoutMs, [int]$request.maxOutputBytes, [Console]::In)
    [Console]::Out.WriteLine('R:' + ($result | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
    # Exit closes any failed output readers and the controller's non-inherited handles.
    [Environment]::Exit(0)
} catch {
    # Never echo request contents, command arguments or untrusted exception text.
    [Console]::Error.WriteLine('Windows command controller failed before verified completion.')
    [Environment]::Exit(125)
}
