# Azure synthetic-beta infrastructure (blocked)

> **NOT DEPLOYABLE YET.** This directory can describe an empty Azure host, but
> the application runtime, persistent-volume initialization, release admission,
> backup/restore evidence, and host-firewall procedure have not completed their
> Azure integration review. Do not run `terraform plan` or `terraform apply`, do
> not point Name.com DNS at Azure, and do not put real personal, nutrition, or
> health data on this infrastructure.

This is a deliberately narrow pivot away from capacity-constrained OCI compute.
It defines one on-demand, non-HA Arm64 VM for a **synthetic-data-only beta** in a
dedicated resource group in East US 2. The target is exactly
`Standard_E2ps_v5`: 2 vCPUs, 16 GiB RAM, and an Ampere Altra Arm64 processor.
Microsoft's current size table documents those characteristics, but regional
availability and price must still be checked live before every plan. See the
[official Epsv5 size documentation](https://learn.microsoft.com/en-us/azure/virtual-machines/sizes/memory-optimized/epsv5-series).

Terraform does not manage `nourishing.app` or any DNS record. Name.com DNS must
stay unchanged through infrastructure review, host bootstrap, internal
readiness, and ACME-port preparation. Caddy cannot obtain the public
certificates first: HTTP-01 or TLS-ALPN validation requires the public A records
to resolve to Azure. Certificate issuance therefore happens only after a
separately reviewed DNS cutover, followed immediately by external TLS and
allowlist checks with a defined rollback.

This is a **compute-only** pivot. The existing private, versioned OCI Object
Storage buckets and their least-privilege IAM identities remain the off-host
export/erasure-ledger boundary. This Azure Terraform module must not destroy or
mutate them. After Azure assigns the static public IPv4, a separate reviewed OCI
plan must bind all four role policies to an OCI network source containing only
that Azure `/32`; application credentials must not be installed before that
change passes its canaries. Beyond the VM's two required managed disks, this
module creates no Azure storage account or object-storage service, and the
target runtime must not substitute node-local MinIO. The Azure VM will require outbound
TCP/443 to the exact reviewed OCI S3-compatible and native Object Storage
endpoints so the normal artifact path, live credential canary, and exact-version
restore can continue using the existing storage plane. The hybrid outbound
path, current OCI public-range evidence, OCI credentials, and host firewall are
not configured by Terraform and remain release blockers. Runtime admission must
also record current bucket bytes, object versions, and monthly Object Storage
request usage, and reserve explicit headroom for the ledger and approved backup;
Azure budget alerts cannot see OCI consumption.

## What this module fixes in place

| Boundary | Fixed choice | Why it is fail-closed |
| --- | --- | --- |
| Subscription | One explicit credit-bearing Azure subscription with `spendingLimit=On` | A fresh live preflight is mandatory. Removing the spending limit or upgrading to pay-as-you-go is not authorized. |
| Region | `eastus2` only | There is no cross-region or availability fallback. |
| Compute | One regular/on-demand `Standard_E2ps_v5` VM | No Spot priority, scale set, alternate size, reservation, or capacity fallback exists in the code. |
| Image | Canonical Ubuntu 24.04 LTS Arm64, exact numeric version | `latest`, an unverified version, and a Marketplace plan are rejected. |
| OS storage | 64 GiB `StandardSSD_LRS` | The OS disk is replaceable and contains no authoritative beta state. |
| Data storage | Separate 64 GiB `StandardSSD_LRS` managed disk, host caching `None` | Both a Terraform `prevent_destroy` guard and an Azure `CanNotDelete` lock protect it. Disabling host caching is the conservative mixed PostgreSQL/WAL/Meilisearch choice; deletion protection is not a backup. |
| Edge | One Standard, Regional, static public IPv4 | Terraform `prevent_destroy` and an Azure `CanNotDelete` lock protect the address because it becomes the OCI network-source trust anchor. No Azure DNS, load balancer, NAT gateway, firewall, or Bastion is created. |
| Ingress | TCP/22 from one current public `/32`; TCP/80 and 443 from `Internet` | Port 80 is required for Caddy ACME. The runtime must gate all beta application routes to the same one `/32`; an NSG cannot distinguish ACME paths from application paths. |
| Runtime | Empty host | Terraform supplies no `custom_data`, cloud-init application start, registry secret, application secret, or database password. |
| Off-host artifacts | Existing OCI buckets and role identities retained; policies separately tightened to the assigned Azure `/32` | Azure replaces compute only. This module does not mutate OCI, create Azure Blob, or add a VM-local object-store substitute. |
| Cost controls | four-hour first-session deadline with at least one hour of apply-time lead, recurring daily shutdown at that UTC time, no auto-start, RG budget alerts at 50/80/100% actual and 100% forecast | These reduce and report usage; they do not make the resources free or impose a hard monthly cap. |

The module does **not** create a managed database, Container Registry, Key
Vault, Azure storage account, DNS zone, load balancer, NAT gateway, capacity
reservation, backup vault, or additional server. Terraform's Azure provider is configured with
`resource_provider_registrations = "none"`; it will not silently register a
provider. Every required provider must already be registered and recorded in
the fresh preflight evidence.

The protected data disk is **not a backup**. `prevent_destroy` and
`CanNotDelete` reduce accidental deletion; they do not recover from filesystem
or database corruption, operator error inside the guest, compromised
credentials, a lost region, or a bad write replicated onto the same disk. This
module intentionally creates no Azure Disk Backup, Recovery Services vault,
snapshot schedule, or PostgreSQL backup destination because none has yet passed
cost and restore review. The beta remains **NOT DEPLOYABLE** until one of these
is separately approved and implemented:

- Azure Disk Backup with current pricing, vault/snapshot charges, retention,
  and permissions reviewed; or
- encrypted off-host PostgreSQL backups with credentials isolated from the
  online database and a reviewed retention/deletion policy.

Whichever design is selected must target an approximately 24-hour RPO and prove
a manual restore into a clean database before DNS cutover. Existing OCI export
and erasure-ledger buckets do not by themselves constitute a PostgreSQL backup.
Do not infer backup coverage from the disk lock and do not silently add billable
backup resources to this module.

The data-disk attachment deliberately uses host caching `None`. Microsoft's
[Azure IaaS data-tier guidance](https://learn.microsoft.com/en-us/azure/architecture/reference-architectures/n-tier/high-security-iaas)
recommends no host caching for write-heavy/high-consistency database workloads;
the disk mixes PostgreSQL data/WAL, Meilisearch, and bounded work spools.

## Cost boundary

This is not an Azure free-tier configuration. The on-demand VM, both managed
disks, and static public IPv4 can consume Azure for Students credit. Auto-
shutdown deallocates compute daily, and nothing in this module starts it again,
but retained disks and the static address can continue to incur charges while
the VM is deallocated. Microsoft states that public IP addresses have a charge
and that a static address is retained until its resource is deleted; review the
[public IP documentation](https://learn.microsoft.com/en-us/azure/virtual-network/ip-services/virtual-network-public-ip-address).

An Azure budget is only a delayed alert. Microsoft says cost data can lag by
8-24 hours and that crossing a budget threshold does not stop resources or
consumption; see [Create and manage Azure budgets](https://learn.microsoft.com/en-us/azure/cost-management-billing/costs/tutorial-acm-create-budgets).
The subscription spending limit is the hard outer guard for most credit-backed
usage. Keep it on. Microsoft documents both exceptions and the fact that
services are disabled after credit is exhausted in
[Azure spending limit](https://learn.microsoft.com/en-us/azure/cost-management-billing/manage/spending-limit).

Immediately before any future plan, use the Azure pricing calculator and the
live subscription's billing currency to estimate the VM, two 64 GiB Standard
SSD disks, and Standard static IPv4 for the intended daily run hours. Stop if
the estimate, taxes, credit behavior, or spending-limit status is unclear. A
budget alert is not authorization to spend its configured amount.

Cross-cloud requests or data transfer between Azure and OCI can also consume
allowances or incur charges on either platform. Refresh both providers' current
pricing before runtime admission; this Terraform budget sees Azure resource-
group costs only and cannot alert on OCI usage.

Every empty-host plan records a fresh shutdown deadline between one and four
hours after both plan and apply; Terraform derives the recurring UTC shutdown
time from that deadline. The one-hour minimum prevents a slow apply from missing
the first minute-granular shutdown window. After apply, verify in the Azure
control plane that the shutdown schedule is enabled and targets the intended
UTC time before treating the empty-host phase as successful. This bounds the
first paid session. It does not prevent a
later manual start just after the daily schedule from running nearly 24 hours.
Until a reviewed guest watchdog exists, every later start must therefore be
attended, paired with an explicit deallocation deadline, and verified
deallocated in the Azure control plane.

## Hard blockers before the first empty-host plan

These checks admit only the empty host and static IPv4. They do not admit the
application or DNS:

1. The tracked Git tree and reviewed commit are clean, and no OCI saved plan or
   state is reused for Azure.
2. Azure CLI is signed in to the intended authenticated student tenant
   and subscription. The live subscription policy reports quota ID
   `AzureForStudents_2018-01-01`, the subscription is `Enabled`, its current
   portal credit page shows at least the configured
   monthly budget remaining in USD, and its subscription policy still reports
   `spendingLimit=On`. The authoritative credit expiry is recorded and remains
   at least seven days beyond both plan and apply, leaving an attended window to
   revoke retained-OCI credentials and remove trust before Azure can disable or
   reclaim resources. Confirm the offer against Microsoft's current
   Confirm that policy and the portal offer against Microsoft's current
   [Azure for Students terms](https://azure.microsoft.com/en-us/pricing/offers/ms-azr-0170p/).
3. `Standard_E2ps_v5` is returned for `eastus2`, with no restrictions, and its
   live capabilities report `vCPUs=2`, `MemoryGB=16`, `CpuArchitectureType=Arm64`,
   `HyperVGenerations` containing `V2`, and no true `TrustedLaunchDisabled`
   capability. Both the regional total-vCPU quota and Epsv5-family quota have at
   least two vCPUs remaining; SKU visibility alone is not capacity or quota proof.
4. The exact Canonical `ubuntu-24_04-lts:server-arm64` image
   version is returned live in East US 2. Its image metadata reports
   `architecture=Arm64`, `hyperVGeneration=V2`, a `SecurityType` value containing
   Trusted Launch support, `location=eastus2`, active/non-deprecated state, and
   `plan=null`. `latest` is never copied into tfvars.
5. `Microsoft.Authorization`, `Microsoft.Compute`, `Microsoft.Consumption`,
   `Microsoft.DevTestLab`, `Microsoft.Network`, and `Microsoft.Resources` are
   already `Registered`.
   Registration is an account mutation and is outside this module; stop and ask
   before registering anything.
6. The operator address is derived from a direct network path appropriate for
   SSH, independently checked, and supplied as one globally routable `/32` for
   both `admin_ipv4_cidr` and `beta_allowed_ipv4_cidr`.
7. One Ed25519 public key and one or more monitored alert email addresses are
   ready. Private keys, Azure tokens, credentials, and application secrets never
   enter Terraform variables, state, shell arguments, or Git.

The exact cost acknowledgement and fresh `live_preflight` checks are the
Terraform preconditions for this empty-host plan. There is intentionally no
runtime-ready precondition: the assigned Azure static IPv4 must exist before
the retained OCI IAM network-source restrictions and the hybrid egress path can
be finalized and tested. Terraform remains hard-pinned to an empty host by the
absence of `custom_data`, application secrets, and any application-start
resource.

## Hard blockers after the empty host and before DNS

1. The hybrid runtime implementation and admission contracts receive a
   separate, commit-specific review. They must define idempotent mounting of
   the preserved disk at `/var/lib/nutrition-tracker`, start nothing until
   release admission passes,
   enforce the Caddy `/32` gate, and prove synthetic backup and exact-version
   erasure-ledger restore against the retained OCI buckets. They must also allow
   outbound TCP/443 only through the reviewed host-firewall path to the required
   OCI Object Storage endpoints (plus separately admitted ACME/image-fetch
   bootstrap paths) and prove that unrelated object egress fails. Refresh and
   re-review the official OCI public-range lock before using it; never widen
   stale ranges merely to unblock deployment. Live host drills occur after the
   guarded infrastructure creation and before DNS. Until then this module stays
   blocked and Name.com DNS stays unchanged.
2. A separately cost-reviewed Azure Disk Backup design or encrypted off-host
   PostgreSQL backup design is implemented, targets an approximately 24-hour
   RPO, and has passed a manual restore into a clean database. The protected
   data disk and existing OCI artifact buckets do not close this blocker.
3. Live OCI Object Storage usage and request counts are captured immediately
   before admission. The reviewed headroom policy accounts for all object
   versions and failed-cleanup residue, keeps the append-only ledger and chosen
   database backup below the tenancy's current free allowances, and stops rather
   than widening caps or accepting billable storage/requests. The Azure runtime
   is fixed at a 256 MiB export artifact/spool cap, one concurrent read, and a
   512 MiB read-window/search-spool cap; these are containment limits, not proof
   of remaining OCI capacity.

Representative **read-only** checks, after selecting the intended subscription:

```sh
az account show --subscription "$AZURE_STUDENT_SUBSCRIPTION_ID"

az rest --method get \
  --url "https://management.azure.com/subscriptions/$AZURE_STUDENT_SUBSCRIPTION_ID?api-version=2020-01-01"

az vm list-skus --subscription "$AZURE_STUDENT_SUBSCRIPTION_ID" \
  --location eastus2 --size Standard_E2ps_v5 --all

az vm list-usage --subscription "$AZURE_STUDENT_SUBSCRIPTION_ID" \
  --location eastus2

az vm image list --subscription "$AZURE_STUDENT_SUBSCRIPTION_ID" \
  --location eastus2 --publisher Canonical \
  --offer ubuntu-24_04-lts --sku server-arm64 --all

az vm image show --subscription "$AZURE_STUDENT_SUBSCRIPTION_ID" \
  --location eastus2 \
  --urn "Canonical:ubuntu-24_04-lts:server-arm64:$EXACT_IMAGE_VERSION"

az provider show --subscription "$AZURE_STUDENT_SUBSCRIPTION_ID" \
  --namespace Microsoft.Compute
```

Repeat `az provider show` for every provider listed above. Read the credit
balance and expiry from Azure Portal **Education > Overview > Student offer
details** if the CLI does not expose authoritative fields. The generic billing
**Benefits** blade can show no credits for this offer and must not override the
Education Hub evidence. Do not infer remaining credit from an empty cost query.

Record the exact results in ignored `terraform.tfvars`. `live_preflight` is an
operator-supplied attestation rather than an Azure data source because the
credit balance and subscription policy are billing-plane facts with different
permissions and update delays. Terraform rejects evidence older than four hours
both at plan time and, using a second runtime timestamp check, at apply time.
The attested subscription UUID must exactly match the provider subscription.
Set `budget_start_date_utc` to the first UTC instant of the current month;
Terraform rejects a plan or apply that crosses into another month. Always
generate a brand-new saved plan after refreshing the evidence.

## DNS and certificate sequence

DNS and public certificate readiness are two ordered phases, not one
prerequisite:

### Phase 1: Azure host proof with Name.com unchanged

After the empty-host infrastructure and cost gates are separately authorized,
create only the empty host and static IPv4 from one independently audited saved
plan. Keep the existing Name.com A-record state unchanged while the operator
completes the post-apply hybrid runtime and backup blockers:

1. verifies the exact Azure public IPv4, SSH `/32`, data-disk mount identity,
   container runtime, immutable Arm64 image admission, and full-stack start;
2. proves local/internal readiness, retained-OCI-storage credential canaries,
   exact-version erasure-ledger restore, the approved PostgreSQL backup/manual
   restore drill, restart, and failure containment with synthetic data;
3. proves the host firewall's reviewed OCI HTTPS egress policy and negative
   egress canaries; and
4. validates the public-edge Caddy configuration while keeping its separate
   `edge` profile stopped, and proves Azure/host firewalls are prepared to
   accept public TCP/80 and TCP/443 for ACME and the gated application.

Public Caddy certificate issuance is **not** a Phase 1 success criterion. Do
not claim that `https://api.nourishing.app` or `https://app.nourishing.app` is
ready while its public A record still resolves somewhere other than the new
Azure IPv4.

### Phase 2: separately reviewed DNS cutover and external proof

Record the exact prior Name.com A-record state and rollback action first. Then,
in an attended change window, update only the reviewed application A records to
the verified static Azure IPv4. Do not add an AAAA record because this module
creates no IPv6 endpoint. After authoritative and independent public resolvers
return the new A records:

1. start the previously stopped `edge` profile and watch Caddy complete
   production ACME issuance without changing ACME CA,
   challenge type, or firewall scope merely to force success;
2. validate the certificate chain, hostname, and expiry from an external
   client; prove that non-challenge plain-HTTP requests receive the explicit
   `404` rather than an automatic redirect or application response;
3. prove the approved reviewer `/32` reaches only the intended beta routes and
   a source outside that allowlist receives the fail-closed response; and
4. repeat readiness plus OCI canary/restore smoke checks through the public
   origin without introducing real data.

If DNS propagation, ACME, TLS, routing, the `/32` gate, readiness, or retained
OCI storage checks fail, restore the recorded prior A-record state (including
removing a record if it was previously absent), stop public application
traffic, and investigate without widening access. DNS remains a manual
Name.com operation outside Terraform in both phases.

## Future Terraform workflow (not authorized yet)

The following documents the intended workflow; it is not permission to run it
while the status banner says **NOT DEPLOYABLE YET**.

```sh
cd infra/azure
cp terraform.tfvars.example terraform.tfvars
# Replace every REPLACE marker from the same fresh evidence set.
# Keep deployment_acknowledgement empty during initial review.

terraform init -backend=false -lockfile=readonly
terraform fmt -check -recursive
terraform validate
python3 tests/static-contracts.py
```

After all pre-plan empty-host blockers close, a human reviewer must inspect
current Azure retail pricing and the complete planned graph. Only then may the
acknowledgement be set to this exact single line:

```text
I ACKNOWLEDGE THIS IS A SYNTHETIC-ONLY NON-HA ON-DEMAND AZURE BETA THAT CAN CONSUME CREDIT; THE HOST STARTS EMPTY; NO PAID FALLBACK OR AUTOMATIC START IS AUTHORIZED
```

The only acceptable infrastructure plan has exactly one resource group, VNet,
subnet, NSG and association, static Standard IPv4, NIC, E2ps_v5 Linux VM,
preserved managed disk and attachment, one data-disk delete lock, one public-IP
delete lock, shutdown schedule, and resource-group budget. It must have no
delete or replacement actions on an existing deployment and no resource outside
that list.

The command-line auditor accepts only a binary `.tfplan`; it does not accept an
operator-supplied JSON export. Use a brand-new saved plan in an owned
mode-0700 directory, make the plan mode 0600, and have the auditor invoke the
exact Terraform 1.5.7 binary's `show -json` internally. It prints no planned
values and can create a mode-0600, non-secret v2 attestation containing only the
plan size/hash, reviewed Terraform path/version/hash, the canonical Azure VM
resource ID derived from the audited subscription and name prefix, and the
non-secret four-digit UTC shutdown recurrence derived from the audited deadline.
That ID is the sole failure-containment target:

```sh
AZURE_PLAN_DIR="$(mktemp -d)"
chmod 0700 "$AZURE_PLAN_DIR"
terraform plan -out="$AZURE_PLAN_DIR/empty-host.tfplan"
chmod 0600 "$AZURE_PLAN_DIR/empty-host.tfplan"
python3 tests/audit_saved_plan.py \
  "$AZURE_PLAN_DIR/empty-host.tfplan" \
  --write-attestation "$AZURE_PLAN_DIR/empty-host.plan-attestation.json"
```

Do not redirect or retain `terraform show -json` output. The auditor accepts
only the exact 14-resource create-only graph and independently binds every
meaningful planned value to this module's reviewed contract: the sole unaliased
AzureRM 4.79.0 provider and its exact subscription/registration/deletion-guard
configuration; each resource's provider; exact names, tags, and wiring; the one
`/32` SSH source and fixed TCP/22, TCP/80, and TCP/443 rules; static Standard
Regional IPv4; the `Standard_E2ps_v5` Arm64 VM and exact Canonical image version;
password authentication disabled; the real AzureRM sensitive mask; 64-GiB
`StandardSSD_LRS` OS and data disks; the UTC shutdown schedule and notification;
and the bounded monthly budget and all four notifications. It also rejects
omitted or unreviewed non-empty fields, placeholders, Spot/alternate/oversized
resources, imports, drift, moves, replacement metadata, unexpected sensitivity,
and unknown values outside a small per-resource allowlist for the reviewed
Terraform 1.5.7/AzureRM 4.79.0 JSON shape and provider-computed attributes. The
configuration representation must prove the reviewed resource-ID wiring rather
than merely leave those IDs unknown.

Terraform 1.5.7 saved-plan JSON does not emit `applyable`, `complete`, or
`errored` metadata, so this workflow makes no safety claim based on those
fields. Its enforceable boundary is a successful internal render plus the exact
semantic graph, input, configuration, lifecycle, check, unknown, and sensitivity
contracts above.

Terraform intentionally reports the `azurerm_resource_group.beta` precondition
check as `unknown` in a saved plan because its second freshness/month-boundary
evaluation uses `timestamp()` and therefore runs again at apply time. The
auditor admits only that exact resource/check/instance `unknown` shape; the VM
SKU check must be `pass`, all plan-time-known false conditions already prevent
plan creation, and any other unknown, failed, errored, extra, or malformed check
is rejected. This preserves the apply-time freshness guard instead of weakening
or deleting it. Never apply a stale or speculative plan.

After a separate human review authorizes that exact hash, apply only through the
attestation-consuming wrapper; never run a separate raw `terraform apply`:

```sh
python3 tests/apply_audited_plan.py \
  "$AZURE_PLAN_DIR/empty-host.tfplan" \
  "$AZURE_PLAN_DIR/empty-host.plan-attestation.json"
```

The wrapper reruns the internal render and full semantic audit, requires the
new result to equal the prior attestation, requires an interactive confirmation
containing the exact SHA-256, pins Azure CLI 2.71.0, proves that CLI is logged in
to the exact enabled audited AzureCloud subscription, and performs a live VM
inventory read proving the exact attested VM absent immediately before apply.
It reopens and hashes the exact plan inode immediately before execution, strips
Terraform CLI, proxy, loader, cloud-endpoint, dynamic-extension, and unrelated
process overrides, and starts a bounded isolated Terraform child with only the
fixed `terraform apply -input=false -no-color` argument vector and inherited
read-only plan descriptor. It accepts no Terraform flags and does not use
`-auto-approve`. Any mismatch or noninteractive invocation stops before
Terraform apply.

A zero Terraform exit is accepted only after an independent Azure control-plane
read proves the exact `Microsoft.DevTestLab/schedules` resource is successfully
provisioned and enabled, targets the attested VM, is the expected Compute VM
shutdown task, uses `UTC`, and has the exact attested four-digit recurrence. On a
nonzero exit, 30-minute timeout, `SIGINT`, `SIGTERM`, `SIGHUP`, supervision
failure, or missing/disabled shutdown schedule, the wrapper first stops and
reaps Terraform's isolated process group. It revalidates the Azure CLI hash
immediately before the first containment command; a mismatch stops before any
Azure mutation and requires manual inspection/deallocation. It then uses only
that CLI and the explicit attested subscription/VM target to request
deallocation, and revalidates the hash again before trusting the final proof.
It accepts only exact `PowerState/deallocated`, or successful structured VM
inventory reads proving absence continuously across the full ten-minute Azure
long-running-operation settle window. The original apply failure remains
nonzero. Failure to prove process quiescence or either safe terminal state emits
a distinct `EMERGENCY` error and requires immediate manual inspection; it never
treats `stopped`, `deallocating`, one 404, or one empty inventory result as safe.
This is compute-charge containment, not rollback: a partially created managed
disk or static public IP can still incur charges and must be reconciled in a
separately reviewed state/live-resource inspection after every failed apply.

The data-disk and public-IP locks and their `prevent_destroy` guards are
intentional. A normal Terraform destroy is expected to fail rather than erase
the disk or release the trusted address. Removing any guard, deleting the
resource group, or cleaning up preserved data requires a separate review. Once
OCI credentials have been installed, decommission in this exact order: stop the
runtime; revoke all four Customer Secret Keys and the offline restore API key;
verify that the revoked credentials are denied; remove or change the OCI network
source and its four policy bindings; only then remove the public-IP delete lock
and release the address. This ordering prevents a future Azure tenant from
receiving an IP that still authorizes old, non-expiring OCI credentials.

## Runtime handoff (still blocked)

Infrastructure creation alone is not a release. Before any application start,
the Azure runtime work must at minimum:

- partition, format, and persistently mount only the LUN-0 separate data disk at
  `/var/lib/nutrition-tracker` without formatting an already initialized disk;
  bind both preparation and every preflight to the reviewed filesystem UUID and
  Azure disk serial in the root-owned data-disk identity file;
- install and pin the reviewed container runtime without a workstation Docker
  credential helper or secret in cloud-init;
- admit the existing immutable `linux/arm64` images and fail before starting on
  any architecture, digest, signature, or provenance mismatch;
- run PostgreSQL and Meilisearch within the reviewed 16 GiB memory envelope;
- retain the existing OCI Object Storage buckets/IAM, provision no MinIO or
  Azure storage replacement, and pass both the S3-compatible canary and native
  exact-version restore across outbound HTTPS to only the reviewed OCI
  endpoints;
- implement only the separately cost-reviewed backup choice, meet the
  approximately 24-hour database RPO, and prove a manual clean-database restore;
- enforce Caddy's application allowlist as exactly
  `beta_allowed_ipv4_cidr` while leaving ACME routing reachable;
- prove restart, disk reattachment, database recovery, exact-version ledger
  restore, credential rotation, and full-stack failure containment; and
- produce an explicit DNS cutover and rollback procedure for Name.com.

This Terraform module always emits `runtime_deployment_status` as a hard
operational warning because its permanent scope is empty-host infrastructure;
it never deploys or attests the application runtime. Completing the separately
reviewed host/runtime work does not silently change that output or the
`terraform-scope=empty-host-only` tag. Keep DNS unchanged and use no real data
until the external admission evidence is complete. Existing OCI storage
resources stay in place throughout this pivot.
