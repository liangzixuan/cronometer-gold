# Windows mobile tooling

The maintained Expo wrapper supports dependency checking, native configuration
checking and JavaScript export from a qualified Windows NTFS checkout. A separate
headless Metro session serves the local Android/iOS development bundles with file
watching and live output. It uses fixed localhost port 8081 and a one-hour maximum.
Keyboard UI, LAN/tunnel access, phone exposure, native compilation, signing and
release remain separate work. The Linux process-group path remains available in WSL.

Source tests alone do not qualify this Windows path. Use it only after the native
acceptance below has passed for the source and installed payload being used.
Keep the existing Linux/default workflow for all other work. Never use OneDrive,
UNC paths, or a copied private environment as a development checkout.

## Prerequisites and commands

Use the repository's exact frozen dependencies, a supported Node installation,
and 64-bit PowerShell 7. The adapter accepts an explicit absolute `pwsh.exe` path
through `NOURISHING_POWERSHELL`; otherwise it resolves `pwsh.exe` on the ordinary
command path. It never installs tools or invokes a shell shim. PowerShell verifies
its version and platform before the application child starts.

The workspace sets `verifyDepsBeforeRun: error`, so a stale or incomplete install
stops before pnpm runs a script. Install the approved frontend dependency closure
explicitly with a frozen lockfile, then verify its payload and run the command
again. Keep `pnpm_config_verify_deps_before_run` unset in the invoking environment;
it overrides the workspace setting. An ordinary check must not trigger package
installation or install scripts. The qualified Windows local-store installation
uses outer `CI=1`; changing that environment can select a different pnpm store
layout and correctly fail the guard. The examples restore the caller's CI value.

Select the exact API origin explicitly. `https://native-qualification.invalid`
is a synthetic, unavailable destination for finite tooling proofs.
`https://dev-api.nourishing.app` is the reserved development destination; its
presence in this allowlist does not establish a provisioned or isolated backend.
Production, loopback, alternate origins and implicit defaults are rejected.
The reserved development origin also requires
`EXPO_PUBLIC_NOURISHING_PROFILE=hosted-development`; omitting that selector fails
before Expo starts. The synthetic qualification origin uses the ordinary profile.


```powershell
$env:NOURISHING_POWERSHELL = (Get-Command pwsh.exe -CommandType Application).Source
$env:EXPO_PUBLIC_API_URL = 'https://native-qualification.invalid'
$previousCI = $env:CI
try {
    $env:CI = '1'
    pnpm --filter @nutrition-tracker/mobile dependencies:check
    if ($LASTEXITCODE -ne 0) { throw 'Dependency check failed.' }
    pnpm --filter @nutrition-tracker/mobile config:check
    if ($LASTEXITCODE -ne 0) { throw 'Configuration check failed.' }
    pnpm --filter @nutrition-tracker/mobile build
    if ($LASTEXITCODE -ne 0) { throw 'Mobile export failed.' }
} finally {
    $env:CI = $previousCI
}
```

The wrapper resolves the installed `expo/bin/cli` from the mobile workspace and
checks its package name, exact version and declared executable against the mobile
manifest. It invokes that entry with the current Node executable and literal
arguments. Dependency/config commands have a 120-second limit; export has a
240-second limit. The controller has separate bounded startup and cleanup time.
Output is bounded to 4 MB, or 20 MB for native configuration JSON. Exceeding a
limit fails the command and cleans up its owned descendants.

## Headless Metro session

After the session's native acceptance, run this sequence from the repository
root with the same exact public profile, qualified Node/PowerShell and frozen
installation. The finite preflight must pass before the session starts:

~~~powershell
$env:EXPO_PUBLIC_NOURISHING_PROFILE = 'hosted-development'
$env:EXPO_PUBLIC_API_URL = 'https://dev-api.nourishing.app'
$previousCI = $env:CI
try {
    $env:CI = '1'
    pnpm --filter @nutrition-tracker/mobile dependencies:check
    if ($LASTEXITCODE -ne 0) { throw 'Dependency check failed; Metro was not started.' }
    node apps/mobile/scripts/run-expo.mjs start --localhost
    if ($LASTEXITCODE -ne 0) { throw 'Metro session failed.' }
} finally {
    $env:CI = $previousCI
}
~~~

Use the direct Node entry for the Windows session. The pnpm start/dev lifecycle
forwards Ctrl+C through its Windows shell and is not qualified for clean session
interruption. Finite pnpm commands and the Linux development commands are unchanged.
The wrapper supplies literal localhost and port 8081 arguments. An occupied port
fails without selecting another port; custom ports, LAN, tunnels and automatic
browser/device launch are not supported. A running Metro listener does not imply
that the reserved API host is available.

The Expo session child omits CI so the pinned Metro server watches files, even
though the invoking sequence retains outer `CI=1` until it restores the prior value. It retains headless
mode, both validation flags set to zero, private dotenv rejection and the same
narrow public environment. No keyboard commands or stdin relay are provided.
Output streams as it arrives, with a 4 MB combined limit; overflow fails and
cleans up the session. There is no unbounded lifetime or environment override for
duration. The one-hour deadline is a failed timeout, not a normal completed session.

Ctrl+C requests an orderly stop through the existing owner. Programmatic callers
can supply an AbortSignal. A successful session result distinguishes ordinary
completion from a requested stop. A requested stop requires confirmed real Ctrl+C
delivery, observed natural leader exit with status zero, drained output, an empty
job and no forced cleanup or watchdog. Parent loss, timeout, output errors,
unexpected descendants and uncertain cleanup remain failures. Finite commands
retain their existing cancellation errors and 120/240-second limits.

## Environment and process ownership

The Expo child receives reviewed Windows runtime paths, an isolated project Expo
home, the exact public API origin and explicit command mode. Backend, storage,
email, Doppler and arbitrary `EXPO_PUBLIC_*` values are omitted. Case collisions,
inherited environment entries, Node/TLS injection, offline mode and validation
bypasses are rejected. Private dotenv files in the repository or mobile directory
also reject startup; `.env.example` is allowed without reading its contents.

The finite profile sets `CI=1`, `EXPO_NO_DOTENV=1` and
`EXPO_UNSTABLE_HEADLESS=1`. It explicitly sets
`EXPO_NO_DEPENDENCY_VALIDATION=0` and `EXPO_NO_NEW_ARCH_COMPAT_CHECK=0`, because
headless Expo otherwise defaults those checks off. `EXPO_OFFLINE` stays absent.
Online compatibility errors remain errors; dependency checking cannot offer an
interactive install or silently repair the graph.

This projection applies to the Expo subtree. It does not sanitize the invoking
terminal or pnpm process, the existing contracts build before `config:check`, or
the following `check-eas-config` script. Keep real secrets out of that parent
environment. Qualification uses synthetic canaries and inspects the actual Expo
configuration/export and complete command logs.

One dedicated PowerShell controller creates a private Windows Job Object with
kill-on-close and no breakaway. Atomic `JOB_LIST` assignment contains the child
before it executes. A separate `HANDLE_LIST` admits only the child's stdin,
stdout and stderr pipes; the job handle and parent control pipe are excluded.
The child receives stdin EOF. Controller loss closes the sole job handle;
wrapper loss closes the control pipe and triggers bounded cleanup.

Cancellation first uses a real Ctrl+C event on the isolated owned console when
the leader is alive, then terminates the job if it does not settle. The controller
will never detach a shared user console. Natural success requires a zero exit,
fully drained output and an empty job. Timeout, overflow, lingering descendants,
failed cleanup and forced termination remain failures even if the leader exited
zero. Verified results wait for controller output closure. If termination cannot
be verified within the cleanup budget, the promise rejects with explicit cleanup
uncertainty. There are no temporary request/result files or credentials in
command arguments.

Microsoft documents the [explicit handle-list requirements](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)
and [atomic job assignment at process creation](https://devblogs.microsoft.com/oldnewthing/20230209-00/?p=107812).
Both are necessary: containing descendants does not by itself establish correct
output draining or parent-loss detection.

## Native acceptance

Run the adapter's native behavioral cases with bounded harmless processes:
zero/nonzero exit, missing executable, trailing output, overflow, timeout,
lingering descendants and a Ctrl+C-resistant grandchild. Separately terminate
the actual wrapper and controller using retained process identities, then verify
all owned descendants and listeners are gone without the external safety owner
performing cleanup. Linux skips of these cases are not native passes.

On the exact reviewed source export, run the three maintained commands with
synthetic secret canaries in the parent. Verify the frozen dependency payload and
source before and after, the actual config/export and logs, command exit status,
complete output and whole-job settlement. Keep earlier direct-CLI evidence under
its original scope. This proves finite tooling only; it does not accept a running
Windows mobile frontend, persisted-session/API-origin isolation, a hosted API,
personal devices or release artifacts.

For the headless session, use a fresh bound qualification against the maintained
direct Node command after the guarded finite preflight. Verify that every listener is IPv4 or IPv6 loopback, the readiness
response identifies the exact project, and both platform manifests lead to actual
Android/iOS bundles. Check the development API positive control and synthetic
secret markers in outputs. Exercise file watching by changing an owned ignored
synthetic entry and proving the rebuilt bundle changes; restore that fixture
afterward. Verify local reload message delivery and rejection of a mismatched
Origin. Prove occupied-port refusal without fallback, clean requested shutdown,
bounded failure behavior and wrapper/controller loss for the session mode.
Conserve tracked source, installed payload and aliases. Keep each fixture within
five minutes, and distinguish forced safety cleanup from product acceptance.
Reuse unchanged finite evidence only within its actual scope.


## Mobile origin and native identity

For the isolated development profile, set both public values explicitly:

```powershell
$env:EXPO_PUBLIC_NOURISHING_PROFILE = 'hosted-development'
$env:EXPO_PUBLIC_API_URL = 'https://dev-api.nourishing.app'
```

Then run the guarded finite check/export sequence under Prerequisites and commands,
retaining these two public values instead of the synthetic API origin.

Dynamic Expo configuration selects `Nutrition Tracker Development` and
`com.nutritionledger.app.development` for both native platforms. The slug and
registered Expo project `14022636-ab56-468c-94f6-d6106addde42` remain unchanged.
Ordinary configuration retains `com.nutritionledger.app`. The development
selector rejects production/preview intent and EAS build profiles before process
creation or configuration acceptance; this work does not add an EAS profile or
select signing credentials. Keep the existing release gates.

App bootstrap validates and freezes one API origin before reading protected
state. Every origin, including ordinary HTTPS and local origins, has a separate
SecureStore namespace, hardware signing alias and notification ownership marker.
The namespace covers sessions, diary outboxes, erasure requests and capabilities,
cleanup journals, health-device state, health journals and reminder ledgers.
Changing the API origin requires an app restart and starts with that origin's
state. Existing unqualified keys, signing aliases and reminders remain untouched;
they are not adopted, replayed or deleted by the new profile.

All mobile requests use the pinned `expo/fetch` implementation with an exact
origin check, redirect denial and ambient cookies omitted. Explicit authorization
and erasure capabilities stay in their existing request headers. There is no
production, local or alternate-host fallback. The reserved host remains
unprovisioned until separately qualified.

Native configuration records the signing alias policy and an exact alias when
an API origin is supplied. When an ordinary config has no explicit origin, its
runtime default depends on the platform, so the config does not claim one alias.
Configuration/export proves source selection only. It cannot attest which app is
installed or establish native SecureStore, hardware-key or redirect behavior.
Actual isolated app installation, Android/iOS redirect refusal without credential
forwarding, device lifecycle, hosted journeys and release acceptance remain
separate requirements. The headless local Metro session does not satisfy these
device or hosted requirements; its keyboard UI remains unsupported.
