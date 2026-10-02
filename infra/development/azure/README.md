# Azure development empty host

This separate Terraform root describes one disposable, synthetic-only host in Central US. It creates exactly eleven resources: a resource group, VNet, subnet, NSG, association, static IPv4 address, NIC, Arm64 VM, data disk, disk attachment and UTC shutdown schedule. It installs no application or host software.

The pinned Standard_B4ps_v2 has four CPUs and 16 GiB RAM. Its reported TrustedLaunchDisabled capability requires secure boot and vTPM to remain disabled. Ubuntu is pinned to `Canonical:ubuntu-24_04-lts:server-arm64:24.04.202609040`; there is no region, size or image fallback. Password login and VM extensions are disabled. Both disks are 64-GiB StandardSSD_LRS. This root has no preservation locks or automatic start.

## Local validation

Use qualified Terraform 1.5.7 and the exact AzureRM 4.79.0 lock. Offline validation uses a private Terraform data directory and the already authenticated local provider mirror. No Azure credentials are needed:

```sh
terraform -chdir=infra/development/azure init -backend=false -lockfile=readonly -input=false
terraform -chdir=infra/development/azure fmt -check
terraform -chdir=infra/development/azure validate
python3 -B infra/development/azure/test-contract.py
```

CI installs the pinned provider through Terraform's ordinary authenticated registry mechanism. The local qualification used an existing verified mirror, with no network request. These checks and the synthetic plan cases do not establish a real Azure plan, allocation, shutdown or cleanup.

## Native authentication preflight

`auth-preflight.py` checks the qualified native Linux Azure CLI 2.90.0 before a future development session. Use the separately authenticated private Linux profile; Windows authentication caches are never copied. The command performs version and extension inventory, a projected cached account read, and one fixed AzureCloud subscription GET using API version `2022-12-01`. It invokes no login or token-output command.

Supply a mode0600 JSON file inside an owned mode0700 directory with exactly `subscriptionId` and `tenantId`, both canonical lowercase UUID strings. Keep those values out of shell arguments and logs. The explicit profile must be canonical, owned and mode0700. Its mode0600 `config` must contain only these settings:

```ini
[core]
collect_telemetry = no
no_color = yes
login_experience_v2 = off
[extension]
use_dynamic_install = no
[logging]
enable_log_file = no
[cloud]
name = AzureCloud
```

The ordinary CLI-generated `clouds.config` may be mode0600 or mode0644 within that private profile. Only `[AzureCloud] subscription` with one canonical lowercase UUID is accepted; custom clouds, endpoints and INI defaults are rejected. This cached default may differ from the expected subscription. Both account and live subscription commands select the expected subscription explicitly and must return its exact identity. Authentication caches remain under Azure CLI's control and are not inspected by this script. The child receives a minimal environment with a temporary private home, explicit profile and telemetry, file logging and dynamic extension installation disabled.

```sh
python3 -B infra/development/azure/auth-preflight.py --source-digest
python3 -B infra/development/azure/auth-preflight.py \
  --cli /usr/bin/az --profile /absolute/private/azure-profile \
  --expected-identity /absolute/private/expected-identity.json \
  --source-sha256 REVIEWED_AUTH_SOURCE_SHA256 \
  --result /absolute/private/new-auth-result.json
```

Review the source digest independently; printing it grants no approval. It binds this script and the existing auditor's source digest, including reused protected-file, child and result helpers. The launcher SHA256 pin requires the separately qualified signed CLI installation; it does not attest every installed package file. The script checks the source, launcher, expected identity and both configuration files before and after commands. Concurrent same-user replacement is outside this metadata/hash conservation boundary.

Both the cached account and live subscription must match the expected subscription and tenant and remain Enabled. The account must use AzureCloud; the live subscription must retain `AzureForStudents_2018-01-01` and spending protection `On`. Each child has a sixty-second bound and the existing disk-output limit. Nonzero exit, stderr, malformed response, leftover process group or failed cleanup rejects the result. INT, TERM and HUP settle an already-owned child group through the shared runner; repeated signals are ignored during that cleanup. Hard termination, the process-creation ownership gap and parent-loss cleanup remain outside this qualification.

The new private result contains only check outcomes, source/input/configuration hashes and hashes of parsed projected JSON. These are unsigned local observations, not raw-response or cryptographic attestations. Publication is create-only through the existing audited helper. A post-publication failure explicitly reports the complete output with durability or cleanup unconfirmed. Console rejection messages omit private CLI output and exception details.

Success establishes current read-only authentication and subscription identity/protection. Credit balance/expiry, billing-profile protection, quota, allowance, resource ownership, plan/apply, host execution and runtime/device/release acceptance require their separate evidence and approvals. The six-family saved-plan evidence below must still be freshly collected for its consuming action.

## Prepare a private development plan

The Linux command `node scripts/azure-development-plan.mjs --input /absolute/private/request.json` prepares and audits one binary plan. It never applies a plan, registers providers or installs tools. Select a real invocation separately, with current allowance evidence and explicit operational inputs. Local synthetic qualification does not establish Azure planning or host acceptance.

The request is a mode0600 JSON file in an owned mode0700 directory. It contains exactly these fields:

- `schema_version`: `1`.
- `source_sha256`: the independently reviewed result of `node scripts/azure-development-plan.mjs --source-digest`.
- `identity_file`, `profile_directory`: the protected expected-identity JSON and native Azure profile described above.
- `terraform`, `provider_directory`: the qualified Linux Terraform 1.5.7 executable and exact AzureRM 4.79.0 directory containing the authenticated binary and license.
- `operation_name`: a new `nourishing-dev-` name followed by twelve lowercase hexadecimal characters.
- `admin_ipv4_cidr`, `ssh_public_key`, `shutdown_deadline_utc`: the actual public administrator /32, public SSH key and same-day UTC shutdown deadline. Existing auditor restrictions remain in force.
- `not_after_utc`: the explicit invocation horizon. At startup at least ten minutes plus a thirty-second cleanup reserve must fit before it. The caller must place it within the currently authorized work window.
- `evidence_paths`: exactly `credit`, `providers`, `compute`, `quota`, `sku` and `image`, each naming its protected original receipt JSON. All six families are revalidated around execution.

The operation directory is created exclusively beside the request, using `operation_name`; an existing directory is rejected. The command authenticates source, native CLI, Python, Terraform, provider and input bytes. It copies only the four Terraform files, frozen lock and qualified provider into private scratch and generates explicit variables. A filesystem-only provider mirror has no network fallback. Ambient Terraform, cloud-credential, Python, Node-loading and proxy overrides are rejected. Every child receives an explicit minimal environment; private response values and plan contents are not printed.

Node owns each Python, Azure CLI and Terraform process directly through the shared Linux supervisor. The Python helper only validates, reads, copies, removes verified scratch and publishes results; it starts no subprocesses. The fixed sequence validates authentication, checks Terraform identity, initializes without a backend or lock update, plans with ordinary exit-zero semantics and renders the retained private plan descriptor. There is no shell command, arbitrary Terraform argument, runner override or pin override in the CLI. The exported function's injected command boundary exists for synthetic sequence tests.

Each child runs under the pinned `prlimit` executable with a 512-MiB per-file limit. Captured JSON is limited to 20 MiB, ordinary command output to 64 KiB and stderr to the shared runner's 64-KiB bound. The command admits a narrow session file set, checks at most 96 entries and an aggregate bound of 1,132 MiB after each child. These post-command checks do not continuously cap aggregate disk use. The ten-minute operation budget includes phase deadlines; a planning child has at most four minutes. INT, TERM and HUP request owned cleanup. Parent loss closes supervisor IPC and terminates that owned group. If the OS refuses final group termination, success is forbidden and finite recovery is not established.

On success, `plan.tfplan`, `phases.json` and the create-only mode0600 `result.json` remain in the operation directory. The binary digest must match the exact descriptor rendered by Terraform, and rendered variables must match the protected request. The result binds source, tools, original evidence and authentication responses; retain the request and all original input files for a later audit/apply decision. The phase records and parsed-response hashes are unsigned local observations. Verified scratch is removed before publication. Any failed phase retains private partial files for inspection; a post-publication failure may leave a complete result with durability or final verification unconfirmed. Never infer acceptance from file presence alone.

Tests cover the pure input/auditor/publication stages and a full injected sequence with synthetic Azure/Terraform responses. Separate actual native fixtures qualify the limiter, output/file limits, descriptor conservation, timeout, resistant descendants and parent loss. They do not execute an Azure plan, authenticate a real provider session or qualify allocation, shutdown, deployment or release.

## Native six-family evidence collection

`scripts/azure-development-evidence.mjs` collects the ten fixed read responses used by
the existing development plan policy. It uses native Azure CLI 2.90.0 through the
pinned limiter and owned process supervisor. The four authentication reads must
pass before collection. Billing-profile discovery is a fixed subscription GET;
credit reads use only its validated identifier. The command neither registers a
provider nor follows a missing-capacity, pagination or alternate-endpoint fallback.

```sh
node scripts/azure-development-evidence.mjs --source-digest
node scripts/azure-development-evidence.mjs --input /absolute/private/evidence-request.json
```

The protected mode0600 request, inside an owned mode0700 directory, has exactly:
`schema_version: 1`, reviewed `source_sha256`, `identity_file`, `profile_directory`,
`operation_name` (`nourishing-evidence-` plus twelve lowercase hexadecimal digits),
`not_after_utc` and `shutdown_deadline_utc`. Identity and profile follow the native
authentication preflight's existing protections. No administrator IP or SSH key is
needed for collection. The invocation horizon must leave ten minutes for work and
thirty seconds for cleanup and be no more than fifteen minutes away. Shutdown must
be a whole UTC minute on the same day, one to four hours away throughout collection.
These timestamps qualify evidence for later policy checks; collection schedules
no shutdown and allocates nothing.

The command creates a new private operation directory and retains raw projected
responses, phase records, source/input bindings and six family files. The complete
`index.json` is published create-only after all original allowance, freshness,
identity, protection, quota, SKU and image rules pass. Its `evidence_sha256` binds
the six files for the plan request's existing `evidence_paths`. Files alone do not
prove command success. Failed operations retain bounded private partial material;
an error after index publication leaves its durability or caller verification
unconfirmed. Inspect and preserve that evidence before another operation.

Native family files use `nourishing.azure-native-evidence.v1` / schemaVersion2,
with actual `/usr/bin/az` argv, pinned launcher/version/source, original UTC bounds,
raw stdout bytes tied to parsed selected values, and observed stderr byte counts
and hashes. Stderr text is never returned or published. The auditor accepts this
explicit format separately from the historical Windows records; it does not
relabel old evidence. These are unsigned local observations, not provider
attestations or permission to apply a plan.

Each native command is bounded to sixty seconds within the shared ten-minute work
budget. Response size is 128 KiB, stderr 64 KiB. An allowlisted operation inventory
checks a 4 MiB aggregate bound after each command; this is not a continuous aggregate
disk quota. The inherited 512 MiB per-file limiter is a separate protection. Existing
supervisor ownership and parent-loss behavior remain unchanged. If the OS refuses
final process-group termination, success is suppressed and finite recovery is not
established. No new cleanup or provider policy is inferred from the metadata fields.

Tests run the real pure helper and owned synthetic children with injected Azure
responses, plus exact native/legacy policy regressions and real stderr observations.
They establish local source behavior only. Actual native collection, a saved Azure
plan, resource ownership, shutdown/disposal and hosted runtime remain separately
qualified invocations.

## Execute and dispose of an owned empty-host session

The native Linux session command has three fixed modes. Select any real mutation
separately after reviewing the exact plan and current resource budget. The local
tests use synthetic Azure/Terraform responses and do not qualify a real allocation,
shutdown or deletion.

```sh
node scripts/azure-development-session.mjs --source-digest
node scripts/azure-development-session.mjs execute --input /absolute/private/execute.json
node scripts/azure-development-session.mjs prepare-dispose --input /absolute/private/prepare-dispose.json
node scripts/azure-development-session.mjs dispose --input /absolute/private/dispose.json
```

Each request is mode0600 inside an owned mode0700 directory. Common fields are
`schema_version: 1`, independently reviewed `source_sha256`, a new `operation_name`
(`nourishing-session-` plus twelve lowercase hexadecimal digits), and
`not_after_utc`. The horizon must leave fifteen minutes for work and thirty seconds
for cleanup, and must be no more than twenty minutes away. The caller must keep
the entire bound inside the authorized work window. Mode-specific fields are:

- `execute`: `plan_request`, `plan_result`, `plan_result_sha256`, referring to the
  retained successful development plan and its original protected request.
- `prepare-dispose`: `ownership_result`, `ownership_result_sha256`, referring to
  the completed execution result and its retained exact local state.
- `dispose`: `disposal_result`, `disposal_result_sha256`, referring to a separately
  reviewed successful preparation result. Its deletion plan is valid for at most
  fifteen minutes and must retain the same original ownership/state bindings.

The source digest binds both maintained plan/evidence policies and this session
policy. Original tool, provider, source, input and binary-plan bytes are rechecked.
Execution recollects all six evidence families, rerenders the held original plan,
revalidates both saved and fresh account facts, and requires the target resource
group to be absent. It publishes a durable unknown-outcome intent before applying
that exact descriptor once. A filesystem-only pinned provider mirror and explicit
private Terraform data directory have no provider download fallback.

After apply, the command retains and checks the Terraform state, fixed ARM
readbacks and exact resource relationships. It includes the VM-created OS disk,
requires terminal successful provisioning, rejects foreign members/extensions or
pagination, and verifies the enabled VM shutdown target, UTC time and disabled
notifications. VM, disk, network and schedule generation identifiers are bound
where their APIs provide them. A matching name or tag alone does not establish
ownership. The VM `virtual_machine_id` and VNet `guid` retained in Terraform
state must match their live generation fields before initial ownership or cleanup
can be accepted; missing or conflicting values reject the operation.

Completion requires the fixed ordered child sequence, exact tool/argument and
binary bindings, and hashes/sizes matching every retained stdout response. The
mutation intent must match the mode, source, request, plan and prior state, and
precede apply. These records remain unsigned local observations, not attestations.

`prepare-dispose` authenticates the current native profile and rereads the owned
graph before producing a saved delete-only plan for exactly the retained eleven
Terraform addresses. It performs no apply. `dispose` authenticates again, requires
unchanged state lineage/serial, binary and live ownership, then applies the exact
reviewed deletion plan once. Success requires empty retained state and a complete
resource-group inventory proving the owned group absent. Deallocation alone does
not satisfy disposal because disks and IP addresses may remain billable. Old
create-time credit evidence remains historical custody evidence during disposal;
it is not misrepresented as a fresh spending assessment.

These checks require exclusive use of the resource group and local state. Azure
readbacks do not make Terraform deletes conditional on generation or etag. The
resource group and subnet have no guaranteed immutable generation marker in the
selected contracts. A concurrent replacement between inspection and deletion
therefore remains outside this protection. Observed replacement, incomplete
membership, pending provisioning or missing state rejects the operation.

Node owns each child through the unchanged Linux limiter/supervisor; Python only
validates files and responses. Ordinary phases have a sixty-second bound, init
ninety seconds, deletion planning three minutes and apply five minutes, within
the shared fifteen-minute work budget. INT, TERM and HUP request owned cleanup.
The inherited per-file limit is 512 MiB; captured session output is at most 20 MiB
and stderr is limited to 64 KiB. The narrow operation inventory and aggregate
1,132-MiB bound are checked after children, not continuously enforced disk quotas.
If the OS refuses final group termination, success is suppressed and finite
recovery is not established.

The command retains its private operation directory: plan, original bindings,
state/backups, any `errored.tfstate`, bounded stdout, mutation intent and available
readbacks. It does not automatically retry, destroy, remove or reconcile an
uncertain operation. The unchanged supervisor discards raw stderr, so complete
emergency diagnostic or state recovery is not established. A failed process may
have started a remote operation; local settlement is not Azure cancellation.
Publication failure may leave a complete result with durability or verification
unconfirmed. Keep all artifacts for manual review, and never infer success from
file presence. No runtime bootstrap, application exposure or release gate is
satisfied by these local lifecycle observations.


## Saved-plan audit boundary

`audit-plan.py` accepts only a protected binary `.tfplan`, rendered internally through the qualified Linux AMD64 Terraform executable. It reuses the existing beta auditor's protected file and descriptor helpers without changing beta policy. Supply the independently reviewed source digest and binary-plan SHA256. The source digest covers the executable policy, Terraform files, provider lock and reused helper; printing a digest does not approve those bytes.

```sh
python3 -B infra/development/azure/audit-plan.py --source-digest
python3 -B infra/development/azure/audit-plan.py \
  --terraform /absolute/qualified/terraform \
  --provider-directory /absolute/qualified/azurerm/4.79.0/linux_amd64 \
  --plan /absolute/private/session.tfplan --plan-sha256 REVIEWED_PLAN_SHA256 \
  --source-sha256 REVIEWED_SOURCE_SHA256 \
  --evidence credit=/absolute/private/credit.json \
  --evidence providers=/absolute/private/providers.json \
  --evidence compute=/absolute/private/compute.json \
  --evidence quota=/absolute/private/quota.json \
  --evidence sku=/absolute/private/sku.json \
  --evidence image=/absolute/private/image.json \
  --result /absolute/private/local-result.json
```

Plan/evidence files require exact mode0600 inside an owned mode0700 directory. The exact qualified provider binary and license are copied into a private provider directory for rendering, with package hashes checked before and after. This requires no provider installation or network access. A real offline synthetic-state render establishes schema-loading capability only; it is not an Azure saved-plan or apply acceptance.

The result must be new and private. It is fully written and file-synced before atomic create-only publication. A post-publication directory-sync or temporary-cleanup failure reports that a complete result exists and durability/cleanup remains unconfirmed; it never claims no output. No plan values, SSH key or account response values are printed. The result contains only hashes and a local policy scope; it is not a signature, deployment attestation or permission to apply.

Historical six-family inputs retain their original Azure collector formats: host assessment `records` for credit lots/balance; development provider `commands` for subscription/billing/Network/DevTestLab; Compute registration `commands`; exact quota and B4ps SKU `commands`; exact image `commands`. The auditor binds command identity, completion, timestamps and original receipt bytes. It consumes the selected Azure response fields and retained stdout/stderr digests; receipts that omit raw stdout do not acquire raw-byte verification through this check. Inputs are locally collected and unsigned.

`live_preflight` is the exact derived subset: earliest selected read start, subscription, both spending limits, USD balance/expiry, regional/family remaining cores and all six original report hashes. Every selected read must be at most four hours old. The plan must be at most fifteen minutes old. The command recomputes these facts from original receipts and rejects mismatches. The same-day shutdown deadline must align to a UTC minute and remain one to four hours away, both when planned and when audited. Terraform preconditions recheck time and credit inputs at apply. The maintained session executor separately recollects account facts before consumption; a local audit alone does not do so.

At least USD20 credit and thirty-one days of credit validity beyond shutdown are required. The earlier USD15.0268 four-hour-plus-retention estimate is dated planning evidence. The reserve is not a charge cap: disks, IP retention, I/O and transfer can continue costing money after deallocation. Spending protection must remain On at both subscription and billing-profile levels.

## Network and remaining acceptance

SSH is restricted to one globally routable administrator IPv4 /32. Public TCP443 supports future TLS-ALPN certificate handling. All other inbound traffic, including port80, dependency ports and default VNet ingress, is denied. Public443 is not application authorization. A later Caddy configuration must enforce the same administrator /32 on every application request, disable HTTP challenge/redirect listeners and pass denial probes before exposure.

Mailpit must use a separate capture-only network and cannot share API/object-store egress. This root configures no listener, DNS, certificate, secret or application runtime.

The native schedule is only a planned UTC shutdown contract. Before any real session is activated, an independently qualified executor must audit/apply the saved plan, bind actual resource ownership, read the schedule back and prove failure cleanup through deallocation or disposal. The authentication preflight does not execute such a session or provide a Windows/Linux Azure CLI bridge. Daily shutdown is best effort; retained disks/IP need explicit owned cleanup. Fixed Docker package eligibility and all runtime/image, DNS, access-control and hosted journey gates remain separate prerequisites. No provisioning is authorized by a successful local audit.
