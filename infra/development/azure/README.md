# Azure development empty host

This separate Terraform root describes one disposable, synthetic-only host in Canada Central. It creates exactly eleven resources: a resource group, VNet, subnet, NSG, association, static IPv4 address, NIC, Arm64 VM, data disk, disk attachment and UTC shutdown schedule. It installs no application or host software.

The pinned Standard_B4ps_v2 has four CPUs and 16 GiB RAM. Its reported TrustedLaunchDisabled capability requires secure boot and vTPM to remain disabled. Ubuntu is pinned to `Canonical:ubuntu-24_04-lts:server-arm64:24.04.202609040`; there is no region, size or image fallback. Password login and VM extensions are disabled. Both disks are 64-GiB StandardSSD_LRS. This root has no preservation locks or automatic start.

For the separately authorized software and encrypted-volume installation, use
[the installed staging path](hosted/README.md). The empty-host Terraform root
still installs no application and does not grant installation or deployment authority.

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

Node owns each Python, Azure CLI and Terraform process directly through the shared Linux supervisor. The Python helper only validates, reads, copies and retains protected evidence and publishes results; it starts no subprocesses. The fixed sequence validates authentication, checks Terraform identity, initializes without a backend or lock update, plans with ordinary exit-zero semantics and renders the retained private plan descriptor. There is no shell command, arbitrary Terraform argument, runner override or pin override in the CLI. The exported function's injected command boundary exists for synthetic sequence tests.

Each child runs under the pinned `prlimit` executable with a 512-MiB per-file limit. Captured JSON is limited to 20 MiB, ordinary command output to 64 KiB and stderr to the shared runner's 64-KiB bound. The command admits a narrow session file set, checks at most 96 entries and an aggregate bound of 1,132 MiB after each child. These post-command checks do not continuously cap aggregate disk use. The ten-minute operation budget includes phase deadlines; a planning child has at most four minutes. INT, TERM and HUP request owned cleanup. Parent loss closes supervisor IPC and terminates that owned group. If the OS refuses final group termination, success is forbidden and finite recovery is not established.

On success, the complete private operation tree remains, including the binary plan, original rendered JSON, four authentication responses, version/session/configuration records, source/input files, provider mirror and owned working directories. The create-only mode0600 `result.json` binds their exact `retained_evidence` inventory: file hashes, sizes and modes, directory entries and the admitted provider link. The existing limits of 96 entries and 1,132 MiB remain. The validated binary, rendered, version, session, authentication and phase hashes must match that inventory before publication; the caller verifies the retained tree again before accepting completion.

The binary digest must match the exact descriptor rendered by Terraform, and rendered variables must match the protected request. The downstream session rechecks the retained plan tree before admission, alongside the original request, source, evidence, tool, provider, freshness, phase and binary checks. A missing, changed or extra proof entry cannot be accepted. Retain the request and all original input files for a later audit/apply decision; this command performs no evidence or scratch deletion. The phase records and raw responses remain unsigned local observations. Any failed phase retains private partial files for inspection; a post-publication failure may leave a complete result with durability or final verification unconfirmed. Never infer acceptance from file presence alone.

Tests cover the pure input/auditor/publication stages and a full injected sequence with synthetic Azure/Terraform responses. Separate actual native fixtures qualify the limiter, output/file limits, descriptor conservation, timeout, resistant descendants and parent loss. They do not execute an Azure plan, authenticate a real provider session or qualify allocation, shutdown, deployment or release.

## Native six-family evidence collection

`scripts/azure-development-evidence.mjs` collects the twelve fixed read responses used by
the existing development plan policy. It uses native Azure CLI 2.90.0 through the
pinned limiter and owned process supervisor. The four authentication reads must
pass before collection. Billing-profile discovery is a fixed subscription GET;
credit reads use only its validated identifier. Two fixed GETs read the selected
subscription's `sys.regionrestriction` assignment and built-in definition
`b86dabb9-b578-4d7b-b842-3b45e95769a1`, using API version `2026-06-01`.
Both receipts stay in the existing `providers` family. Four authentication phases
and twelve read phases must complete within the original operation bounds. The
command neither registers a provider nor follows a missing-capacity, pagination
or alternate-endpoint fallback.

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
identity, protection, region-policy, quota, SKU and image rules pass. The supported
system assignment must apply to the exact subscription with default enforcement,
no exclusions, overrides or selectors, and an allowed-location list that includes
`canadacentral`. Its matching built-in definition must retain the reviewed
version `1.0.0` Indexed deny rule and Array parameter. Missing, stale, changed,
ambiguous or denying policy evidence prevents all family and index publication.
This check covers that system policy; it does not evaluate every applicable policy
or reserve physical capacity. Native SKU and image region comparisons accept ASCII
case variation such as `CanadaCentral`, while preserving raw response bytes.
Whitespace aliases and multiple SKU locations are rejected. The derived
`live_preflight.location` must match the Terraform host profile and saved plan.
Separate storage acquisition and custody roots retain their own explicit profiles.

The index's `evidence_sha256` binds the six files for the plan request's existing
`evidence_paths`. Files alone do not prove command success. Failed operations retain bounded private partial material;
an error after index publication leaves its durability or caller verification
unconfirmed. Inspect and preserve that evidence before another operation.

Native family files use `nourishing.azure-native-evidence.v1` / schemaVersion2,
with actual `/usr/bin/az` argv, pinned launcher/version/source, original UTC bounds,
raw stdout bytes tied to parsed selected values, and observed stderr byte counts
and hashes. Stderr text is never returned or published. The auditor accepts this
explicit format separately from the historical Windows records; it does not
relabel old evidence. These are unsigned local observations, not provider
attestations or permission to apply a plan.

The fixed policy GETs follow the official [assignment](https://learn.microsoft.com/en-us/rest/api/policy-authorization/policy-assignments/get?view=rest-policy-authorization-2026-06-01)
and [built-in definition](https://learn.microsoft.com/en-us/rest/api/policy-authorization/policy-definitions/get-built-in?view=rest-policy-authorization-2026-06-01)
REST contracts.

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

The native Linux session command has eight fixed modes. Select any real mutation
separately after reviewing the exact plan and current resource budget. The local
tests use synthetic Azure/Terraform responses and do not qualify a real allocation,
shutdown or deletion.

```sh
node scripts/azure-development-session.mjs --source-digest
node scripts/azure-development-session.mjs execute --input /absolute/private/execute.json
node scripts/azure-development-session.mjs reconcile --input /absolute/private/reconcile.json
node scripts/azure-development-session.mjs reconcile-partial --input /absolute/private/reconcile-partial.json
node scripts/azure-development-session.mjs reconcile-dispose --input /absolute/private/reconcile-dispose.json
node scripts/azure-development-session.mjs observe-shutdown --input /absolute/private/observe-shutdown.json
node scripts/azure-development-session.mjs deallocate --input /absolute/private/deallocate.json
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
- `reconcile` and `reconcile-partial`: `execute_request`, `execute_directory`, `execute_session_sha256`
  and `execute_intent_sha256`, binding the original protected execute request,
  private directory, session snapshot and durable unknown-outcome intent.
- `reconcile-dispose`: `dispose_request`, `dispose_directory`, `dispose_session_sha256`
  and `dispose_intent_sha256`, binding the separate original disposal request,
  private directory, session snapshot and durable unknown-outcome intent.
- `observe-shutdown`: `ownership_result`, `ownership_result_sha256`, referring to
  a completed `execute` or complete `reconcile` result. Partial ownership, disposal
  and previous observation results are rejected.
- `deallocate`: `ownership_result`, `ownership_result_sha256`, referring to a
  completed `execute` or complete `reconcile` result. Partial ownership and prior
  shutdown/deallocation results are rejected.
- `prepare-dispose`: `ownership_result`, `ownership_result_sha256`, referring to
  the completed execution or separate reconciliation result and its retained
  exact local state.
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

`reconcile` makes a separate read-only ownership record when a failed execution
left complete state. It preserves the original directory, authenticates its
request/session/intent and retained admission artifacts, and checks admission at
the recorded intent time. This establishes retained policy consistency only:
the old intent did not hash those admission outputs, so their original observation
chronology is not attested. The new result binds their currently observed hashes;
it does not renew old credit evidence or claim the original apply completed.

The caller must first establish that the original owned processes settled and
that no other actor uses the state or resource group. These are external
preconditions. The CLI has no persisted process-owner identity and cannot infer
descendant settlement from PID absence; its result records
`external_quiescence_verified: false`. A real qualification wrapper must retain
its own observed ownership/settlement evidence.

Reconciliation copies protected complete state into a new private operation,
renders that exact copy and the original held binary, authenticates the current
profile, and checks fresh terminal resource membership, relationships and available
generation markers. Missing, partial, changed, emergency or ambiguous state,
pending provisioning and foreign or replaced resources fail. No apply, plan,
refresh, import or state repair runs. Original phases may be absent; they are not
reconstructed. The new result says `mode: "reconcile"`, `reconciled: true` and
`original_execution_outcome: "unconfirmed"`. It can feed the separately reviewed
deletion workflow below. Neither reconciliation nor schedule readback proves an actual shutdown occurred.

`reconcile-partial` uses the same retained execution descriptor for a complete
state file containing a nonempty proper subset of the approved addresses. The
resource group must survive, and every surviving relationship must have its
retained endpoint. Raw and rendered state must agree before subset GETs are
derived. Each surviving resource must be terminal; the complete group inventory
must contain exactly those real resources, including the VM’s implicit OS disk.
Unattached disks/IPs must have no owner, absent associations must have no live
link, and surviving attachments must agree in both directions. Unknown addresses,
orphaned references, tainted/deposed/multiple instances, extra resources, pending
operations and replacement evidence reject recovery. Failed GETs do not prove
absence. Complete `execute` and `reconcile` still require all eleven addresses.

A partial result records `mode: "reconcile-partial"`, `ownership_scope: "partial"`
and the exact `state_addresses`, while keeping the original execution unconfirmed
and external quiescence unverified. It proves current subset ownership only, not
a complete deployment or shutdown protection. Missing/emergency state and remote
operations that may still be running remain outside this recovery path.

`prepare-dispose` authenticates the current native profile and rereads the owned
graph before producing a saved delete-only plan for exactly the retained
Terraform addresses (all eleven for complete ownership, or the recorded partial
subset). It performs no apply. `dispose` authenticates again, requires
unchanged state lineage/serial, binary and live ownership, then applies the exact
reviewed deletion plan once. Success requires empty retained state and a complete
resource-group inventory proving the owned group absent. Deallocation alone does
not satisfy disposal because disks and IP addresses may remain billable. Old
create-time credit evidence remains historical custody evidence during disposal;
it is not misrepresented as a fresh spending assessment.

`reconcile-dispose` records current absence after a disposal whose command exit,
final readback or publication was uncertain. It accepts only protected empty
resulting state with the original lineage and an increased serial. It checks the
reviewed pre-delete ownership state against the original session baseline and
retained pre-apply state/rendering/readbacks at the intent time; it never uses the
mutated state as that historical admission. This proves retained policy consistency,
not original observation chronology or a successful apply.

The new operation preserves every original file, including any already-published
result. It authenticates freshly, renders the copied empty state and exact deletion
plan, and requires a complete successful subscription inventory showing the group
absent. Errors, pagination, duplicate/malformed entries, remaining resources,
changed or emergency state all fail. No plan, apply, refresh, import, repair or
retry runs. The separate result records `disposal_observed: true`,
`original_disposal_outcome: "unconfirmed"`, `external_quiescence_verified: false`
and `remote_operation_completion_verified: false`. Caller-established local
settlement, remote quiescence and exclusive use remain prerequisites. Current
absence is not remote operation completion or scheduled-shutdown evidence.
Reduced or lost state requires separate recovery; this result cannot authorize
another deletion. Tests use synthetic responses and establish no real Azure cleanup.

`observe-shutdown` makes one read-only observation after the original shutdown
deadline has passed. It preserves the original private ownership directory and
checks its exact state, lineage, serial, resource IDs and generation identifiers.
Fresh authentication, complete state rendering and the full resource graph remain
required. The fixed VM GET uses `api-version=2026-03-01&$expand=instanceView`, so
the runtime status and VM generation arrive in the same response. Only one
unambiguous `PowerState/deallocated` is accepted; stopped, running, transitional,
missing and malformed states fail. Display text and optional status timestamps
do not establish the power state or when it changed.

The separate private result binds the original ownership receipt and the fresh
response/phase hashes. Original allocation facts are checked only at their recorded
admission time; the new deadline does not renew them. This is Azure's reported
last-known state, without proof of schedule causation, transition time, permanent
shutdown, remote-operation completion or external quiescence. It is not disposal:
disks and IP addresses may still incur charges. Observation results cannot become
ownership or deletion-preparation inputs. There is no stop/deallocate call,
polling or retry, and local synthetic tests do not qualify real Azure shutdown.

`deallocate` requests one non-destructive stop of a completely owned VM. It
authenticates and checks the original binary plan, copied state and complete live
graph before publishing a durable mutation intent. The intent binds the exact VM
ID, generation and pre-action graph. One fixed `az vm deallocate --ids` command
then runs under the existing supervisor, with a five-minute child limit. No force,
hibernation, `--no-wait`, caller retry or alternative target is selected. Azure CLI
may poll internally; one CLI invocation is not a claim of one HTTP request.

The complete post-action graph must retain the original IDs, generations, state
hash, lineage and serial. Its expanded VM response must report exactly one
`PowerState/deallocated`. The original operation and state remain unchanged. A
command failure, interruption, changed graph, missing readback or publication
uncertainty rejects completion and preserves the intent and partial files. Local
process settlement does not cancel the remote action or establish its completion.

This mode may run before or after the schedule deadline under its own accepted
finite shutdown scope; it renews no original host lease. The caller must first
settle application/host work and establish exclusive use. Full ownership only is
supported: partial apply, lost/emergency state and uncertain remote work still
need separate reconciliation. Pre/post generation checks cannot make Azure's
deallocation request conditional or prove exclusive use. The result is not an
allocation, restart, disposal or later-host authorization. Disks, IP addresses,
state and all evidence remain; their costs can continue. Controlled tests qualify
source behavior only, not an actual Azure shutdown or hosted acceptance.

Protocol: [Azure CLI VM deallocation](https://learn.microsoft.com/en-us/cli/azure/vm?view=azure-cli-latest#az-vm-deallocate).

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
uncertain operation. Complete-state or partial reconciliation requires its own explicit request. The unchanged supervisor discards raw stderr, so complete
emergency diagnostic or state recovery is not established. A failed process may
have started a remote operation; local settlement is not Azure cancellation.
Publication failure may leave a complete result with durability or verification
unconfirmed. Keep all artifacts for manual review, and never infer success from
file presence. No runtime bootstrap, application exposure or release gate is
satisfied by these local lifecycle observations.


## Saved-plan audit boundary

The pinned Terraform 1.5.7 renderer can include an outputs-only prior state. The
auditor admits only format1.0, the pinned version, an exactly empty root module
and the three derived nonsensitive string outputs. Existing resources, child
modules and altered output values or types remain rejected. Approved unknown
object fields may be omitted; known values and list positions remain mandatory.

For the VM, `after_sensitive` must mark `admin_password` and `custom_data`, plus
either the singleton `admin_ssh_key[0].public_key` leaf or the whole
`admin_ssh_key` collection. Terraform 1.5.7 can represent a sensitive collection
with a whole-value mark. The known singleton username and public key must still
match the protected inputs before either mask is accepted. Unrelated sensitive
paths remain rejected; other resource masks must contain no sensitive leaves.
This does not add a `planned_values.sensitive_values` metadata requirement.

The VM NIC reference has one field-specific alternative: Terraform may mark the
whole list unknown. This interpretation relies on the reviewed `main.tf` singleton
containing the owned NIC reference and the maintained command's source binding.
Standalone plan JSON reference metadata does not prove expression cardinality.
Resolved state and live responses must still contain exactly that one owned NIC.

The VM explicitly disables termination notifications with `enabled=false` and
`timeout="PT5M"`. Plan and resolved state require the exact known singleton block;
an unknown block is rejected. Live scheduled-event data may omit the termination
profile or return it disabled, with an absent/null timeout or `PT5M`. Other
profiles, enabled notifications and changed timeouts fail. The separate UTC
shutdown schedule remains required.

The pinned AzureRM 4.79.0 defaults are known values: VM
`platform_fault_domain` is integer `-1`, `extensions_time_budget` is string
`PT1H30M`, and public-IP `idle_timeout_in_minutes` is integer `4`. Plan changes,
planned values and resolved raw/rendered state require these exact types and
values before comparison or computed-field sanitation. Missing, null, changed or
unknown values fail.

Live VM responses must omit or return null for `platformFaultDomain` and
`virtualMachineScaleSet`. The extension budget may be absent/null or `PT1H30M`,
matching the provider's read fallback; the extension list must still be empty.
Live public-IP `idleTimeoutInMinutes` must be integer `4`. The provider sends that
value explicitly and has no absent-to-four read fallback. These checks do not
enable VM scale-set membership, extensions or new unknown fields.

The NIC gateway field stays unconfigured. Only its exact computed plan leaf may
be unknown; a configured expression or known nonempty relationship fails. Raw
and rendered state must agree on the provider's empty-string representation
before computed fields are sanitized, and the live gateway relationship must be
absent or null. These checks preserve the foreign-attachment boundary.

The first retained real plan failed audit and remains failed. Changing this
policy or Terraform source invalidates the old native evidence provenance.
Synthetic representation tests establish local policy behavior; a new real plan
requires fresh source-bound evidence and a separately selected invocation.


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

## Azure credential maintenance canary

The worker image includes the separate maintenance entrypoint
`node dist/azure-object-storage-credential-canary.js`. It does not start the normal
worker or discover credentials. Running it against Azure requires its own accepted
resource, credential-custody and synthetic-write/deletion scope. Source checks do
not authorize execution or establish hosted readiness.

The command requires `NODE_ENV=development`,
`NOURISHING_API_PROFILE=hosted-development`, and both `EXPORT_ARTIFACT_STORE` and
`ERASURE_REPLAY_LEDGER_STORE` set to `azure`. Supply the existing container URLs,
prefixes and writer SAS fields explicitly. Also supply
`EXPORT_ARTIFACT_AZURE_READ_SAS`, `EXPORT_ARTIFACT_AZURE_DELETE_OBSERVER_SAS` and
`ERASURE_REPLAY_LEDGER_AZURE_RESTORE_SAS`. Their exact permissions are respectively
`r`, `l` and `rl`; export and ledger writers use `rcd` and `rc`. Export and ledger
accounts must differ. No issuer login, SAS creation or application-key input is
part of this command.

Within a 60-second deadline and 5-second operation deadlines, the command creates
64-byte random synthetic export and ledger objects, verifies full reads, and reads
exact observed ledger versions. Direct Azure SDK probes test forbidden writes,
deletes, lists and cross-account reads. A local role guard or an unrelated error
cannot count as a provider denial. Positive reads after the probes must still
work, and the ledger version must remain unchanged. Container SAS permissions do
not prove isolation between prefixes inside one container.

Only a complete successful probe sequence permits export cleanup. The separate
list-only credential must observe the live unversioned export before the probes
and again before cleanup. After deletion it must observe an empty exact-name inventory, including
versions and snapshots. The ledger canary remains. Failures preserve uncertain
objects and return a generic error. The command publishes its nonsecret ID and
fixed object-key suffixes before its first write, and aborts requests on SIGINT or
SIGTERM. A hard process loss cannot produce a final result; reconcile the recorded
names before another run. Both success and operation failure include a
nonsecret `canaryId`; reconcile the owned names
`<export-prefix>exports/v1/credential-canary/<canaryId>` and
`<ledger-prefix>erasure-ledger/v1/credential-canary/<canaryId>` within the accepted
scope. Keep command output in the operator's private evidence log. The command
prints no SAS, container URL, payload or native version token. No automatic retry
or failed-run cleanup is performed.

Controlled-response tests use the installed SDK and bounded HTTPS transport. They
prove request generation and response handling only. Actual issuer grants,
versioning settings, retained-resource policy and hosted recovery remain separate
acceptance requirements. Azure protocol permission references:
[delegation SAS](https://learn.microsoft.com/en-us/rest/api/storageservices/create-user-delegation-sas),
[Put Block](https://learn.microsoft.com/en-us/rest/api/storageservices/put-block),
[Put Block List](https://learn.microsoft.com/en-us/rest/api/storageservices/put-block-list).

## Subscription resource and usage baseline

`scripts/azure-development-baseline.mjs` is a separate finite read-only collector.
It runs the same four fixed authentication checks, then one resource-list GET and
one Cost Management usage-query POST for the expected subscription. The existing
six-family collector keeps its separate ten-read sequence. Both use the shared
bounded collector process boundary; neither accepts arbitrary commands or URLs.

The new mode0600 request in an owned mode0700 directory has exactly
`schema_version` (integer1), `source_sha256`, `identity_file`, `profile_directory`,
`operation_name` (`nourishing-baseline-` plus12lowercase hexadecimal characters)
and `not_after_utc`. Review the current `--source-digest` independently. Input
paths, identity, profile configuration, source, launcher and original operation
directory are conserved. Execution still needs its own admitted scope.

```sh
node scripts/azure-development-baseline.mjs --input /absolute/private/request.json
node scripts/azure-development-baseline.mjs --verify-result /absolute/private/request.json \
  --index-sha256 INDEPENDENTLY_RECORDED_INDEX_SHA256
```

The fixed resource projection preserves IDs, names, types, locations, SKU, plan,
managedBy and continuation, omitting opaque properties and tag values. It admits
at most200 resources in the expected subscription and rejects duplicate IDs or
continuation. This is a subscription inventory, not account-wide ownership,
resource health, storage-version or custody acceptance.

The hash-bound owned `cost-query.json` selects Usage/MonthToDate,
PreTaxCost/Sum, granularity None and ResourceGroup grouping. The projected table
retains column names/types, rows, currency and continuation. Columns may be
reordered, but the exact three-column schema must match. At most200 rows are
admitted, without pagination or currency conversion. Signed finite costs are
observations; explicit empty rows establish no zero bill. Empty stdout/204,
missing data, duplicate groups, malformed values or continuation reject success.

Authentication/control output is bounded to128KiB, each query to1MiB, diagnostics
to64KiB and the retained operation to4MiB after commands. Each child has at most
60seconds within ten minutes of work and a30second settlement reserve. The
request horizon is at most15minutes. The pinned limiter also enforces its existing
per-file bound. Six CLI invocations do not qualify the CLI's underlying HTTP
attempt count, status receipt, retry or redirect behavior. No caller retry,
page-follow or fallback is selected.

The original body, session, raw projected responses, phases and scratch directories
remain private. A create-only index binds their complete inventory and bounded
summary without duplicating the raw query tables. The retained consumer checks
the independent index hash, original directory, inputs, source, authentication,
phases and raw results again before operating-envelope review. It uses the same
finite input horizon; it does not refresh observations. Failures retain partial
or already-published evidence and never authorize deletion or imply no output.

Source tests intercept provider calls and use synthetic identities/responses. They
do not establish actual access, billing completeness, current credit, an enforced
spending limit or hosted readiness. Cost observations can be delayed and exclude
credits and other billing components; retain the separate credit and complete
resource/lifetime/copy budget requirements before allocation.

Protocol references: [resource list](https://learn.microsoft.com/en-us/rest/api/resources/resources/list?view=rest-resources-2021-04-01),
[usage query](https://learn.microsoft.com/en-us/rest/api/cost-management/query/usage?tabs=HTTP&view=rest-cost-management-2025-03-01),
and [cost data coverage](https://learn.microsoft.com/en-us/azure/cost-management-billing/costs/understand-cost-mgt-data).

## Prepared-host development runtime

The source entrypoint `scripts/azure-development-runtime.mjs` runs one finite,
synthetic journey with an explicit private or finite client variant on an already qualified Linux ARM64 host. It consumes
prepared tools, images, encrypted storage, network policy, files and a supervisor.
Preparing that host, acquiring images and credentials, and admitting an actual
invocation require their own resource, custody, lifetime and zero-cost evidence.
This command does not provision or configure the host.

```sh
node scripts/azure-development-runtime.mjs run \
  --input /absolute/private/runtime.json --input-sha256 REVIEWED_INPUT_SHA256
```

The protected mode0600 input uses canonical JSON with one trailing newline inside
an owned mode0700 directory. Its exact fields are `schemaVersion`, `kind`, `owner`,
`project`, `root`, `sourceRevision`, `notAfterUtc`, `holdSeconds`, `clientAccess`, `tools`, `images`,
`files`, `database`, `mail`, `journey`, `host`, `supervisor` and `recovery`.
`schemaVersion` is `1`; `kind` is `nutrition-development-runtime-input-v1`.
`owner` is a new UUID and `project` is `nourishing-development-<owner>`.
`sourceRevision` binds a clean source checkout. `root` is the prepared private
runtime directory. Each tool has an absolute path and a reviewed SHA256.
The running Node executable must match its input identity.

The consumer modules define the remaining exact input structures:

- `azure-development-runtime-prepared.mjs` holds the private directory and file
  inventory. Files include separate mail send/review configuration and a public
  CA. Role ownership, file bytes and metadata remain checked through held paths.
- `azure-development-runtime-images.mjs` admits seven exact local ARM64 image
  identities through the maintained backend and Mailpit validators.
- `azure-development-runtime-configuration.mjs` validates the fixed
  `runtime/compose.yaml` and internal Caddy configuration against current API and
  worker parsers. Dependencies and application listeners stay private.
- `azure-development-runtime-host.mjs` checks the prepared encrypted backing
  paths, host and Docker identities, native tools, private DNS and packet policy.
  `azure-development-runtime-supervision.mjs` checks the existing bounded native
  supervisor. Neither module installs tools or changes the host policy.
- `recovery` binds the protected `<root>/recovery/settings.json` and its hash.
  It supplies current storage-recovery assembly and PostgreSQL operator inputs,
  exact destinations, scoped credentials and recovery key references. Keep its
  values out of source, shell arguments and ordinary logs.

The original input horizon is at most four hours away. The complete controller
requires two 30-minute reserves plus at least one minute of remaining work after
supervisor admission. Allow time for admission itself. Its work deadline is the
earlier of 30 minutes before supervisor fallback and 60 minutes before the
original horizon. This leaves ordinary owned shutdown time and a further
hard-loss reserve. `holdSeconds` is an integer from 0 to 900. A hold is limited by
the remaining work budget. These bounds are not a continuous-hosting or billing
authorization.

The fixed path observes an absent owned project, records creation intent and
conserves full container/network identities before starting dependencies. It runs
migrations twice, the Azure credential canary, scoped search-key issuance and
synthetic catalogue seeding. Current assembly qualification and protected
encrypted backup, exact-version download and fenced restore must pass before
runtime grants, original-database replay and API/worker readiness. The restored
drill database remains fenced; applications use the original synthetic database.

The private journey registers two owners, verifies captured mail, exercises
password recovery, searches or creates food, logs and edits a diary entry, then
stops and restarts API/worker services and checks the saved diary. Separate mail
send and capture-review identities are required. The source proof uses the actual
API and worker factories above controlled raw SQL and HTTP responses; it does not
qualify native PostgreSQL enforcement, actual TLS/Mailpit permissions or hosted
persistence.

`clientAccess` must be `null` for the private variant. The public variant is an
object with exactly `adminIpv4Cidr`, `notBeforeUtc` and `notAfterUtc`. It selects one
public IPv4 /32 and a canonical UTC window from 60 to 900 seconds, aligned to whole
seconds. The window starts after controller admission and ends within the original
work deadline. Set `holdSeconds` to `0` for this variant.

The same creation record includes a tenth owned service, `client-edge`, using the
admitted Caddy image. Only IPv4 TCP443 maps to its TCP8443 listener. The fixed host
is `dev-api.nourishing.app`. The held inputs also include `pki/client.crt` (controller
owner, mode0444) and `pki/client.key` (UID/GID1000, mode0400). The public leaf must
match the hostname without a wildcard, be valid now and cover the full window.
These parser checks do not establish chain trust, key pairing or credential custody.
Caddy configuration validation is a health check, not a live HTTPS probe.

The edge starts after encrypted recovery, replay readiness, the private two-owner
journey, API/worker restart and exact diary readback. The controller checks current
API/worker and edge readiness during the window. Each wait between checks is at
most 30 seconds; guarded operations use their own bounded time. Before admission,
the controller waits with held-input and original-lease checks, then repeats full
source, host and application readiness checks before opening the edge. Cancellation, changed inputs or lost readiness enters owned shutdown.
Request admission ends 30 seconds before the client deadline. The API retains a
matching UTC and host-monotonic transport deadline, 15 seconds before that deadline,
across restart. It closes the listener and accepted sockets even while ordinary or
signal cleanup is pending. One cached close promise retains any cleanup failure.
Already-issued database work can still settle after transport closure.

Normal and parent-loss cleanup attempt the edge before all other known owned IDs.
A refused edge stop remains a failure and does not skip later owned stops. The host
policy admits only established TCP replies from edge address172.30.0.5:8443 to the
selected administrator, in addition to the existing bounded Azure egress rules.
Neither this consumer nor the source tests change a firewall or create trust.
Actual Caddy adaptation, certificate/key pairing, HTTPS, packet policy and the
Windows-to-hosted journey remain separate operational acceptance.

The create-only private journal retains mutation intent, raw observations and
outcomes. It permits at most 1024 records, 1 MiB per record and 64 MiB in total.
Normal finalization attempts each known owned service separately, including after
an earlier stop refusal. API and worker stop windows are 305 and 610 seconds.
Volumes, recovery material, canaries, backups and uncertain outcomes remain.
Success is returned only after owned stops and all local holders close. The
terminal journal event always records `runtimeAcceptanceRecorded: false`; any
observed journey in that event does not turn failed cleanup into success.

After controller loss, the separately selected recovery command uses the same
protected input and original lease:

```sh
node scripts/azure-development-runtime.mjs stop \
  --input /absolute/private/runtime.json --input-sha256 REVIEWED_INPUT_SHA256
```

Recovery refuses a still-live original controller, a changed boot/source or an
expired original horizon. It uses only conserved durable IDs from the original
journal prefix and rechecks ownership before stopping them. It loads no service
environment or recovery keys. Retain incomplete evidence and unknown resources
for scoped reconciliation; neither command authorizes deletion or lease renewal.

The successful source result remains `operationalAcceptance: false` and
`applicationTrafficBlocked: true`. Actual native host, packet/TLS policy, issuer
grants, provider resources, custody, remaining allowance and the persistent
Windows-to-hosted journey need their own accepted evidence before execution.
