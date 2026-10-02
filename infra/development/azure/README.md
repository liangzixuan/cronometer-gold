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

The six inputs retain the existing Azure collector formats: host assessment `records` for credit lots/balance; development provider `commands` for subscription/billing/Network/DevTestLab; Compute registration `commands`; exact quota and B4ps SKU `commands`; exact image `commands`. The auditor binds command identity, completion, timestamps and original receipt bytes. It consumes the selected Azure response fields and retained stdout/stderr digests; receipts that omit raw stdout do not acquire raw-byte verification through this check. Inputs are locally collected and unsigned.

`live_preflight` is the exact derived subset: earliest selected read start, subscription, both spending limits, USD balance/expiry, regional/family remaining cores and all six original report hashes. Every selected read must be at most four hours old. The plan must be at most fifteen minutes old. The command recomputes these facts from original receipts and rejects mismatches. The same-day shutdown deadline must align to a UTC minute and remain one to four hours away, both when planned and when audited. Terraform preconditions recheck time and credit inputs at apply, but cannot recollect account facts; a future session executor must do that separately.

At least USD20 credit and thirty-one days of credit validity beyond shutdown are required. The earlier USD15.0268 four-hour-plus-retention estimate is dated planning evidence. The reserve is not a charge cap: disks, IP retention, I/O and transfer can continue costing money after deallocation. Spending protection must remain On at both subscription and billing-profile levels.

## Network and remaining acceptance

SSH is restricted to one globally routable administrator IPv4 /32. Public TCP443 supports future TLS-ALPN certificate handling. All other inbound traffic, including port80, dependency ports and default VNet ingress, is denied. Public443 is not application authorization. A later Caddy configuration must enforce the same administrator /32 on every application request, disable HTTP challenge/redirect listeners and pass denial probes before exposure.

Mailpit must use a separate capture-only network and cannot share API/object-store egress. This root configures no listener, DNS, certificate, secret or application runtime.

The native schedule is only a planned UTC shutdown contract. Before any real session is activated, an independently qualified executor must audit/apply the saved plan, bind actual resource ownership, read the schedule back and prove failure cleanup through deallocation or disposal. The authentication preflight does not execute such a session or provide a Windows/Linux Azure CLI bridge. Daily shutdown is best effort; retained disks/IP need explicit owned cleanup. Fixed Docker package eligibility and all runtime/image, DNS, access-control and hosted journey gates remain separate prerequisites. No provisioning is authorized by a successful local audit.
