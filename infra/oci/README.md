# OCI controlled-beta pilot

This directory defines a single-node, non-HA, **synthetic-data-only** pilot in a
personal OCI tenancy in `us-ashburn-1`. Terraform has a false-by-default apply
acknowledgement, and this runbook is not blanket authorization to create cloud
resources.

Applying this module creates cloud resources. Always use a freshly reviewed
saved plan and stop on any capacity, quota, pricing, shape, storage, region, or
resource deviation. A partially failed apply can leave protected prerequisites
in Terraform state; reconcile that state and produce a new zero-destroy plan
instead of reusing the failed saved plan.

## Admission boundary

Only synthetic reviewer data is permitted. The append-only erasure ledger is
now in a private, versioned OCI Object Storage bucket, outside the VM and boot-
volume failure domain. That removes the earlier node-local common mode, but it
does not make this a production health-data service. Real personal, nutrition,
or health data remains blocked until a recorded end-to-end recovery drill has
proved the actual application signers, exact-version ledger replay, off-host
ledger survival, database recovery, key rotation, privacy/erasure behavior, and
incident response.

Caddy admits application traffic only from the explicit public networks in
`BETA_ALLOWED_CIDRS`. Startup rejects an empty list, world-open ranges,
non-public ranges, IPv4 ranges broader than `/24`, and IPv6 ranges broader than
`/64`. The only private-source exception is the payload-free `GET /ready` host
probe. ACME validation remains reachable; other unapproved API and web requests
receive `404`. Prefer one reviewer `/32` wherever possible.

## Topology and trust boundaries

The personal tenancy has one Internet Gateway, already attached to the unrelated
`GRAD695` VCN (`10.0.0.0/16`), and no NAT-gateway allowance. This module therefore
requires that VCN and gateway by explicit OCID. It creates a new aligned `/24`
subnet, route table, deny-by-default security list, and NSG without changing or
attaching the VCN's default security list, route table, or DHCP options. Refresh
`known_subnet_cidrs` immediately before every plan as the complete set of live
VCN subnet CIDRs not owned by this module. Before an initial plan, include every
pre-existing live subnet. On a recovery replan, exclude `public_subnet_cidr`
only after verifying the live subnet's OCID and CIDR exactly match state-managed
`oci_core_subnet.edge`; include it otherwise. The unchanged overlap
guard rejects a proposed CIDR used by any other live subnet.

The tenancy's Service Gateway quota is zero. The route table therefore uses the
existing Internet Gateway for ACME, image pulls, host administration, and the
regional public OCI Object Storage endpoints over TLS. The VM receives exactly
one reserved public IP; no NAT Gateway or Service Gateway is created.
Object-using containers are additionally isolated on the fixed
`172.31.255.0/28` Docker bridge. At every guarded start, the host resolves
exactly the S3 compatibility and native Object Storage hostnames, rejects any
IPv4 answer outside the two reviewed regional public Object Storage CIDRs, and
atomically supplies one pinned address for each hostname.
Those containers have no external DNS resolver. A first-position `FORWARD` rule
allows only established and new TCP/443 connections to those two CIDRs, then
rejects everything else. A direct-IP negative canary and the built
worker Object Storage canary run before migration. Caddy retains independent
edge networking for ACME; database-only operations remain on the internal
backend network.

A 15-second systemd watchdog asserts the unique first-position parent hook and
all five reviewed chain rules. Docker or firewalld restarts reapply the gate.
If reload or rule drift removes or reorders it while live-restore retains
containers, the watchdog immediately installs a first-position bridge reject,
then stops and proves the whole stack absent before repairing and rechecking.
The repaired-drift exit is an explicit successful watchdog outcome so the
calendar timer keeps recurring. This bounds detection but does not turn the
coarse public-range rule into origin or tenancy containment.

`object-storage-public-ranges.lock.json` records the official publication URL,
full-source SHA-256, upstream timestamp, retrieval/review time, region, required
tag, and exact sorted CIDRs. Terraform rejects a plan when that review is more
than 168 hours old. If Oracle's publication changes after first boot, stop the
stack and obtain a separately reviewed on-host coordinate/firewall refresh
procedure before restarting it. Updating instance metadata does not rerun
cloud-init, so a metadata-only Terraform apply is not sufficient. Never widen
or merge the published CIDRs merely to avoid that maintenance step.

This is only coarse **OCI public-range containment**. It is not an exact-origin,
namespace, tenancy, or data-exfiltration boundary: a compromised container could
address another OCI Object Storage frontend or a pre-authenticated request in
the same allowed public CIDRs. Preflight therefore requires
`OCI_PILOT_DATA_CLASSIFICATION=synthetic-reviewer-only`. Every device and
physical-evidence test must use deliberately synthetic HealthKit or Health
Connect records; personal, nutrition, and health data are a hard release
blocker for this stack.

Object storage is split by purpose:

- The private export bucket uses Standard storage with versioning disabled.
- The private ledger bucket uses Standard storage with versioning enabled and
  has no lifecycle deletion rule.
- Both use OCI-managed encryption at rest and Terraform `prevent_destroy`.
- Export-reader has `OBJECT_READ` only.
- Export-writer has `OBJECT_CREATE`, `OBJECT_READ`, and `OBJECT_DELETE`.
- Ledger-writer has `OBJECT_CREATE` and `OBJECT_READ`, with neither overwrite,
  list, nor delete permission.
- Ledger-restore has `OBJECT_INSPECT` and `OBJECT_READ` for offline version
  inventory and exact-version replay.

Every policy is restricted to its dedicated bucket and frozen object prefix
(`exports/v1/*` or `erasure-ledger/v1/*`). OCI notes that an object-name prefix
condition does not conceal other names returned by a permitted list operation;
the restore principal can therefore inspect names throughout the dedicated
ledger bucket, but cannot see the export bucket. Do not colocate unrelated
objects in either bucket.

Terraform creates IAM users, groups, memberships, capability flags, and
policies, but **never** creates a Customer Secret Key or API signing key. Those
secrets are created and rotated by the offline operator procedure below and
never enter Terraform variables, cloud-init, state, shell arguments, or Git.

OCI provider 7.32.0 can read but cannot manage DB-password or OAuth2-client
capabilities on these users. On initial creation or replacement, require both
credential lists to be empty, disable both capabilities through OCI IAM, and
replan. Terraform reads each user after its supported capability update and
hard-fails unless the complete seven-capability tuple matches: Customer Secret
Keys for all four roles, API keys only for ledger-restore, and every other
capability disabled. Never bypass this readback with a provisioner or a second
resource that also owns the user.

### Optional Azure egress network source

The compute pivot keeps these two buckets and four role identities in OCI. The
Terraform source now has an inert, fail-closed path for restricting every one
of the four role-policy statements to the Azure VM's eventual static public
IPv4. Its defaults are deliberately:

```hcl
restrict_object_storage_to_azure_egress = false
azure_object_storage_egress_cidr        = null
```

With those defaults, no network source exists and the rendered policy strings
remain byte-for-byte equivalent to the already-managed bucket, prefix, and
permission conditions. Terraform rejects a half-configured pair. The CIDR must
be one canonical, publicly routable IPv4 `/32`; private, loopback, link-local,
carrier-grade NAT, documentation, multicast, and reserved ranges are rejected.

When enabled, Terraform creates exactly one tenancy-root
`oci_identity_network_source` with the Azure `/32` as its sole
`public_source_list` entry and `services = ["none"]`. The latter is mandatory:
Oracle documents that the default `all` permits service on-behalf-of requests
whose source addresses can differ from the public list. Each existing role
policy then gains this condition inside its existing `all {}` expression:

```text
request.networkSource.name='<name-prefix>-azure-os-egress'
```

The policy resource has an explicit dependency on the network source, and its
postcondition requires the source to be `ACTIVE`. Creation therefore precedes
policy restriction. The source has `prevent_destroy`; disabling the switch
after creation is intentionally blocked rather than silently broadening the
four policies or deleting their authorization boundary.

**Activation is not yet authorized or mechanically safe in this Terraform
root.** The current state contains the retained storage/IAM/network
prerequisites but no A1 instance, VNIC, boot volume, reserved public IP, or
backup assignment. The current configuration still desires that retired A1
compute graph, so an ordinary full plan that merely sets the two Azure-binding
variables would also retry OCI compute. Do not use `-target` to hide those
actions. First implement and review a storage-only OCI desired-state mode (or a
separate, explicit state migration), then require a fresh plan whose only
resource actions are one network-source create and four in-place policy
restrictions, with zero destroys and no compute action.

Before that future apply, also prove from live IAM inventory that the four
users have no additional group membership or policy grant that could bypass
these statements. Do not install or reinstall their credentials on Azure until
all four updated statements are read back with the network-source condition.
With the rotated credentials, first prove denial from an address outside the
network source, then deliver them to Azure and require the Azure-source allow
canary before application start. Before releasing or replacing the Azure static
IP, stop the runtime and revoke the corresponding credentials; update the `/32`
only through another reviewed in-place plan.

## Planned resources and possible charges

| Resource | Reviewed default | Cost / quota warning |
| --- | --- | --- |
| Compartment | New dedicated compartment | No direct charge; contained services may charge. |
| Existing VCN/Internet Gateway | Read only | Shared with an unrelated workload; this is logical, not VCN-level, isolation. |
| Subnet, route table, explicit security list, NSG | New | Normally no direct charge; confirm current pricing. |
| Object Storage network path | Existing Internet Gateway to regional public TLS endpoints | The tenancy has zero Service Gateway quota. Storage, requests, and transfer usage can still charge outside current allowances. |
| Object Storage buckets | Two private Standard buckets | Export usage and every retained ledger version consume quota and can charge. No cross-region copy is configured. |
| IAM roles | Four users, groups, memberships, policies | No direct charge expected; tenancy identity limits still apply. |
| `VM.Standard.A1.Flex` | 2 OCPU, 12 GB | Intended for Always Free, but capacity and eligibility are not guaranteed. Never substitute a paid shape. |
| Preserved boot volume | 100 GB, OCI-managed encryption, in-transit encryption | Counts against tenancy-wide block storage; console deletion and overage remain possible. |
| Boot-volume backups | Daily incremental, two-day retention | Can transiently occupy three of five documented Always Free backup slots, leaving two for reviewed manual/drill backups. Approximate RPO is 24 hours. |
| Reserved public IPv4 | One | Required for stable DNS; recheck current pricing and limits. |
| OCI DNS | Disabled | Existing-provider A records are preferred; OCI zones/queries may charge. |

Oracle currently documents 1,500 A1 OCPU-hours and 9,000 A1 GB-hours per
month for an Always-Free-only tenancy in its home region, shared across A1 VM,
bare-metal, and Container Instances. One continuously running 2-OCPU, 12-GB
instance consumes 1,488 OCPU-hours and 8,928 GB-hours in a 31-day month,
leaving only 12 OCPU-hours and 72 GB-hours of margin. Before applying, prove
that `us-ashburn-1` is the tenancy home region. Do not overlap another A1
allocation, including during recovery, unless the live usage and billing model
prove that the combined allocation remains free.

Free Tier is a billing program, not a Terraform property. If the requirement is
Free-Tier-only, stop on quota, capacity, or pricing uncertainty. Oracle may
reclaim an idle Always Free A1 instance when the published seven-day
95th-percentile CPU, network, and memory thresholds are each below 20%; monitor
recovery readiness, but do not generate artificial load to evade that policy.

## Prerequisites before any plan

1. The owner explicitly accepts the non-HA pilot and billing policy. The owner
   supplied that confirmation on 2026-08-17 for the exact synthetic-only,
   single-node, Free-Tier-only scope; reconfirm it if the scope changes.
2. The owned base domain is `nourishing.app`. The planned release origins are
   `https://api.nourishing.app` and `https://app.nourishing.app`; neither is
   live or trusted until the post-apply DNS, ACME, and readiness checks pass.
3. Create one Ed25519 SSH keypair. Only the public key (maximum 512 characters)
   enters `terraform.tfvars`.
4. Supply four distinct, monitored primary emails for the non-console Object
   Storage IAM users. OCI identity domains require uniqueness. A mailbox that
   supports plus addressing can route four role-tagged addresses to one inbox.
5. Record the operator's current public `/32` for SSH and every synthetic
   reviewer's current public egress CIDR. The owner designated the same single
   current operator `/32` for both roles on 2026-08-17; revalidate it immediately
   before planning and host start. SSH from `0.0.0.0/0` is rejected.
6. Recheck limits, pricing, active A1 capacity, reserved IPv4, block storage,
   backups, Object Storage, IAM-user/key quotas, and the namespace in
   `us-ashburn-1`; create a budget alert outside this module.
7. Download Oracle's current `public_ip_ranges.json`, verify its full-file hash,
   and review the sorted `OBJECT_STORAGE` CIDRs for `us-ashburn-1` against
   `object-storage-public-ranges.lock.json`. The lock review must be no more
   than 168 hours old when planning. Oracle recommends polling at least weekly.
8. Re-read the GRAD695 VCN, enabled Internet Gateway, and every live subnet.
9. Pin a reviewed Oracle Linux 9 Arm image OCID.
10. Publish immutable `linux/arm64` images for API, web, worker, migrator, Caddy,
   PostgreSQL, and the patched Meilisearch derivative from one reviewed container
   supply-chain workflow commit. Record all seven digest-qualified GHCR references. Make those packages public
   or install a narrowly scoped read-only pull credential in root's Docker
   credential store. Never use an Actions job token.
11. Install Terraform 1.5.7, OCI provider 7.32.0, external provider 2.3.5, and
   Python 3 with standard-library `lzma` on the planning workstation.

Refresh the personal security-token session, then verify the selected network.
Replace every example OCID and do not use a corporate tenancy profile.

```sh
oci session refresh --profile CRONOMETER_DEPLOY
oci network vcn get --profile CRONOMETER_DEPLOY --auth security_token \
  --vcn-id ocid1.vcn.oc1.iad.replace
oci network internet-gateway get --profile CRONOMETER_DEPLOY \
  --auth security_token --ig-id ocid1.internetgateway.oc1.iad.replace
oci network subnet list --profile CRONOMETER_DEPLOY --auth security_token \
  --compartment-id ocid1.tenancy.oc1..replace \
  --vcn-id ocid1.vcn.oc1.iad.replace --all
```

## Terraform workflow

Authentication comes from the OCI CLI profile. Never add private keys, session
tokens, passwords, Customer Secret Keys, or application secrets to `.tfvars`.

```sh
cd infra/oci
cp terraform.tfvars.example terraform.tfvars
# Replace every marker; keep the acknowledgement false during review.
terraform init -lockfile=readonly
terraform fmt -check -recursive
terraform validate
```

Only after every hard blocker and prerequisite is independently closed may an
authorized operator set `acknowledge_non_ha_and_possible_charges = true` and
produce a saved plan:

```sh
terraform plan -out=cronometer-gold-beta.tfplan
terraform show cronometer-gold-beta.tfplan
```

The plan must create no second VCN or Internet Gateway, Service Gateway, NAT
Gateway, load balancer, WAF, managed database, Vault key, DNS zone, or paid
shape. It must create two private buckets with the versioning settings above,
four least-privilege IAM role sets, one 100 GB encrypted boot volume, and one
same-region two-day daily backup policy. It must not contain
Customer Secret Keys, API private keys, or changes to existing resources. Only
then may an authorized operator apply the saved plan. If A1 capacity is absent,
try a reviewed availability-domain index; never change the shape.

## Host bootstrap

Cloud-init installs pinned Docker CE 29.7.2, containerd 2.3.3, Buildx 0.36.1,
and Compose 5.4.0 from the signature-checked Docker repository. It leaves the
application disabled. Oracle Linux firewalld remains enabled; HTTP/HTTPS are
added without flushing SSH or OCI platform rules, then the Docker egress service
installs the fail-closed object bridge chain.

Terraform packs reviewed non-secret files into one SHA-256-checked XZ bundle
with Base85 transport.
The unpacker accepts only reviewed absolute paths and modes and deletes the
bundle. A lifecycle precondition caps encoded cloud-init, the public SSH key,
and fixed overhead at 30,000 bytes, below OCI's cumulative 32,000-byte metadata
limit.

After SSH, verify bootstrap before installing secrets:

```sh
sudo cloud-init status --wait
sudo systemctl status nutrition-container-runtime-bootstrap.service
sudo systemctl status nutrition-object-egress-firewall.service
sudo systemctl status nutrition-object-egress-firewall-watchdog.timer
docker version
docker compose version
sudo firewall-cmd --list-services
sudo iptables -S FORWARD
sudo iptables -S NUTRITION-OCI-EGRESS
sudo /usr/local/sbin/nutrition-assert-object-egress-firewall
```

Prepare and verify the private internal CA. It signs PostgreSQL (`postgres`) and
Meilisearch (`meili.internal`) leaves only; Object Storage uses public HTTPS.
The private CA never enters Terraform state. A daily timer rotates 90-day leaves
30 days before expiry, and startup refuses leaves with fewer than 14 days left.

```sh
sudo /usr/local/sbin/nutrition-prepare-internal-pki init
sudo /usr/local/sbin/nutrition-prepare-internal-pki verify 14
```

Install the initial internally consistent secret files using the exact full Git
commit represented by all seven repository-owned runtime images:

```sh
sudo /usr/local/sbin/nutrition-install-initial-secrets \
  0123456789abcdef0123456789abcdef01234567
```

The root-only installer creates root-owned mode-`0600` `runtime.env`,
`database.env`, `api.env`, `worker.env`, `meili.env`, and `restore.env`, plus a
fresh restore epoch. It uses the OS CSPRNG for database, status, device,
encryption, locator, and search secrets; prints no values; and refuses to
overwrite any managed target. Only scoped Meilisearch and OCI credential markers
remain for their dedicated installers.

Complete `deploy.env` from its example with the real domains, ACME email,
reviewer allowlist, and all seven repository image digests—including the patched
Meilisearch derivative—from the exact `SERVICE_VERSION` workflow run. The
upstream Meilisearch lock is build provenance and must never appear in
`deploy.env`. Local
image IDs are not deployment evidence. Install a root-owned
mode-`0600` `backup-restore-evidence.json` containing the assigned policy, an
`AVAILABLE` boot-volume backup OCID, the exact `SERVICE_VERSION`, and a successful
restore drill no older than 30 days. The JSON is operator-attested; preserve the
OCI CLI evidence and require second-person review.

Preflight also requires at least 48 GiB available on the 100 GB boot volume. The
gate covers the 20 GiB authenticated-read reservation, 10 GiB export spool,
2 GiB search spool, transient database snapshot, persistent stores, images, and
operating margin. Monitor continuously:

```sh
df -B1 --output=size,used,avail,pcent /var/lib/nutrition-tracker
```

## Offline Object Storage credential installation and rotation

Run this only after DNS, PKI, images, environment files, backup evidence, and
restore evidence are ready: a successful credential install starts the guarded
systemd release service. The operator workstation needs OCI CLI, OpenSSL,
Python 3, and SSH. The script refuses shell tracing, stages secrets in a
mode-`0700` temporary directory, stops all online and stale one-shot containers,
and never prints secret values.

Capture only the nonsecret Terraform outputs in a secure local directory:

```sh
terraform output -json object_storage_iam_user_ids \
  > /secure/path/object-storage-users.json
terraform output -json object_storage \
  > /secure/path/object-storage.json
```

From `infra/oci`, create or rotate four OCI Customer Secret Keys and the
ledger-restore RSA API signing key outside Terraform state, run the operator
permission/version canary, atomically install the environment credentials and
UID/GID `1000:1000` mode-`0400` restore private key, then start the guarded
release:

```sh
./files/provision-object-storage-credentials.sh \
  CRONOMETER_DEPLOY opc@<reserved-public-ip> \
  /secure/path/object-storage-users.json \
  /secure/path/object-storage.json
```

OCI permits two Customer Secret Keys per user and three API signing keys. The
procedure requires one free slot, creates the replacement while the prior set
still works, and rolls back newly created cloud keys if failure occurs before
host installation. It intentionally does not revoke the prior working set.
After recorded readiness, list the four users' keys and explicitly delete only
the retired keys under two-person review. Never delete both generations at once.

The provisioner holds one exclusive host-side rotation lock from before its key
slot checks and service stop through cloud-key creation, atomic installation,
and guarded startup. Concurrent operators fail before creating a key. The host
installer accepts a bounded JSON bundle only on stdin, proves its secret
admission token matches that held lock, verifies the API private key
fingerprint, preserves exact file ownership/modes, atomically replaces all
credential fields and the key, fsyncs both parent directories, and rolls back
on failure. The start orchestrator accepts the one-use admission only while the
same lock remains held. The private key is mounted only into offline Object
Storage canary and restore-attestation operations, never API, web, or the normal
worker.

To retain metadata headroom, the credential installer, deployment preflight,
image-admission helper, and Meilisearch bootstrap helper are transferred during
this offline procedure, not cloud-init. Terraform embeds their exact source
SHA-256 values in a root-owned manifest. The provisioner refuses a local
checkout whose bytes differ, verifies each transfer before an atomic root-owned
install, and full preflight rehashes all three persistent helpers before every
start. The one-shot credential installer is removed from `/run` immediately
after use.

## Guarded release order

The systemd unit is the only supported starter. Application containers use
`restart: "no"`, preventing Docker from publishing copied application
containers before restore admission.

At each start the orchestrator:

1. Stops API, web, worker, and any stale migration/canary/restore/readiness
   one-shot containers, then proves they are absent.
2. Verifies the current OCI instance identity and admitted restore epoch.
3. Resolves the two Object Storage hosts on the host, proves every answer is in
   one of the two reviewed public Object Storage CIDRs, rejects bridge overlap,
   and pins the host map.
4. Runs early preflight, including exact firewall, credential/keyring, storage,
   backup, PKI, runtime-image admission, platform, and Compose checks.
5. Starts Caddy, PostgreSQL, and Meilisearch and bootstraps scoped Meilisearch
   keys, then repeats full preflight.
6. Proves an arbitrary direct-IP HTTPS connection from the object bridge is
   rejected.
7. Runs `node dist/object-storage-credential-canary.js` from the exact worker
   image with all four scoped principals. This exercises the application's
   S3 signer and native OCI version resolver, cross-role denials, ledger
   version inventory, and exact-version retrieval against the live buckets.
8. Runs migrations once to apply and a second time as an idempotent replay
   proof.
9. Replays and attests the external erasure ledger offline, then runs the
   database readiness probe.
10. Starts API, web, and worker with bounded resources and `compose --wait`,
    then requires public-certificate HTTPS `/ready` through Caddy.

Any failure leaves application services stopped. Never weaken
`NODE_ENV=production`, `DATABASE_SSL_MODE=verify-full`, the HTTPS endpoints,
`EXPORT_ARTIFACT_DELETE_VERSION_POLICY=latest`, the native version-list
provider, or offline replay to force a green deployment. The web container
shares the API network namespace so its permitted internal URL remains
`http://127.0.0.1:4000`.

After a successful start, test API/web from one allowlisted and one unallowlisted
address, certificate chains, security headers, synthetic registration/login,
payload-free logs, export creation/deletion, and erasure replay. Set the mobile
release's `EXPO_PUBLIC_API_URL` only after those checks pass.

## Restored boot-volume admission

A restored boot volume contains old environment credentials and a still-valid
OCI API private key. Treat that as compromised/copyable state; a copied epoch
or database attestation is not sufficient.

1. Boot the restored volume on an isolated instance with no public IP and no
   inbound NSG. Do not move public DNS or the reserved IP.
2. Confirm the instance-identity gate fails and no API, web, worker, or one-shot
   operation is running.
3. Set a fresh 32-plus-character `DATABASE_RESTORE_EPOCH` while offline.
4. Run the credential provisioning procedure against the isolated host so all
   four Customer Secret Keys and the restore API key are replaced. Revoke the
   copied generations only after the new keys and recovery are proven.
5. Read the new OCI v2 instance OCID and explicitly admit exactly that instance:

   ```sh
   sudo /usr/local/sbin/nutrition-instance-identity admit-restored \
     ADMIT-RESTORED-INSTANCE:ocid1.instance.oc1.iad.replace
   ```

6. Start the guarded service. It must still pass the live Object Storage
   canaries, both migrations, exact-version ledger replay/attestation, database
   readiness, and HTTPS readiness before application containers start.
7. Keep drills isolated. Attach public traffic only after recovery evidence,
   synthetic-data admission, reviewer CIDRs, and retired-key revocation are
   independently reviewed.

## Remaining release blockers

This pilot has no HA, cross-region ledger/backup copy, tested automated VM
replacement, external monitoring/paging, central secret manager, WAF/load
balancer, autoscaling, managed database, or automatic deployment promotion.
The boot-volume policy is same-region and short-lived. Ledger versions are
append-only but region-local and grow without automatic deletion. Terraform
`prevent_destroy` cannot stop an authorized console/API operator from deleting
resources, credentials, versions, or buckets. The single VM remains an
availability bottleneck even though ledger durability is off-host.

Do not call this production. Keep real data blocked until recovery objectives,
privacy review, key/certificate rotation drills, least-privilege evidence,
monitoring, deployment promotion, and incident response are approved.

## Primary OCI references

- [Object Storage bucket Terraform resource](https://docs.oracle.com/en-us/iaas/tools/terraform-provider-oci/latest/docs/r/objectstorage_bucket.html)
- [S3 compatibility API and dedicated endpoints](https://docs.oracle.com/en-us/iaas/Content/Object/Tasks/s3compatibleapi.htm)
- [Object Storage IAM permissions and policy conditions](https://docs.oracle.com/en-us/iaas/Content/Identity/Reference/objectstoragepolicyreference.htm)
- [Managing OCI network sources](https://docs.oracle.com/en-us/iaas/Content/Identity/Tasks/managingnetworksources.htm)
- [OCI Terraform network-source resource](https://docs.oracle.com/en-us/iaas/tools/terraform-provider-oci/latest/docs/r/identity_network_source.html)
- [OCI public IP ranges](https://docs.oracle.com/en-us/iaas/Content/General/Concepts/addressranges.htm)
- [Public-IP Internet Gateway requirements](https://docs.oracle.com/en-us/iaas/Content/Network/Tasks/managingpublicIPs.htm)
- [Customer Secret Key lifecycle and limits](https://docs.oracle.com/en-us/iaas/Content/Identity/access/working-with-customer-secret-keys.htm)
- [API signing keys](https://docs.oracle.com/en-us/iaas/Content/API/Concepts/apisigningkey.htm)
- [Always Free resource limits](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)
- [Scheduled volume backups](https://docs.oracle.com/en-us/iaas/Content/Block/Tasks/schedulingvolumebackups.htm)
