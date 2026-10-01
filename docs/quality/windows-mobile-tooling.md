# Finite Windows mobile tooling

The maintained Expo wrapper supports three finite commands from a qualified
Windows NTFS checkout: dependency checking, native configuration checking and
JavaScript export. Windows `start` and `dev` reject before creating a child.
Interactive Metro, phone access, native compilation, signing and release remain
separate work. The Linux process-group path remains available in WSL.

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
installation or install scripts.

Select the exact API origin explicitly. `https://native-qualification.invalid`
is a synthetic, unavailable destination for finite tooling proofs.
`https://dev-api.nourishing.app` is the reserved development destination; its
presence in this allowlist does not establish a provisioned or isolated backend.
Production, loopback, alternate origins and implicit defaults are rejected.

```powershell
$env:NOURISHING_POWERSHELL = (Get-Command pwsh.exe -CommandType Application).Source
$env:EXPO_PUBLIC_API_URL = 'https://native-qualification.invalid'
pnpm --filter @nutrition-tracker/mobile dependencies:check
pnpm --filter @nutrition-tracker/mobile config:check
pnpm --filter @nutrition-tracker/mobile build
```

The wrapper resolves the installed `expo/bin/cli` from the mobile workspace and
checks its package name, exact version and declared executable against the mobile
manifest. It invokes that entry with the current Node executable and literal
arguments. Dependency/config commands have a 120-second limit; export has a
240-second limit. The controller has separate bounded startup and cleanup time.
Output is bounded to 4 MB, or 20 MB for native configuration JSON. Exceeding a
limit fails the command and cleans up its owned descendants.

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
