# ADR 0008: Pivot the synthetic beta to an on-demand Azure Arm VM

- Status: Accepted for implementation; cloud deployment is not yet authorized
- Date: 2026-08-20
- Scope: synthetic-data-only controlled beta

## Context

The reviewed Oracle Cloud Infrastructure deployment targeted one Always Free
`VM.Standard.A1.Flex` instance (2 OCPU and 12 GB). Three controlled launch
attempts, one in each Ashburn availability domain, failed only with
`Out of host capacity`. Each attempt was reconciled to no instance, boot volume,
VNIC, reserved public IP, or backup-policy-assignment residue. Continuing to
poll OCI has no bounded completion time and is no longer the primary deployment
strategy.

The existing runtime is a single-host Docker Compose system. Its signed release
images are `linux/arm64`; its steady services intentionally oversubscribe CPU
but reserve about 7.75 GiB of container memory before host overhead. It also
depends on persistent PostgreSQL, Meilisearch, protected work spools, Caddy
state, and version-aware encrypted object storage.

The available GitHub Student benefits do not make every advertised platform an
equivalent host:

- Azure for Students provides a finite $100 credit, not a perpetual free VM.
- Heroku's $13 monthly credit cannot cover the current web, API, worker,
  PostgreSQL, Meilisearch, and object-storage topology, and its Cedar container
  runtime is x86-64 with an ephemeral filesystem.
- LocalStack is an AWS API emulator for development. It does not provide a
  continuously reachable public host, DNS, TLS, or off-laptop durability.
- Azure Container Apps accepts `linux/amd64`, so it cannot consume the existing
  reviewed ARM64 artifacts without a new multi-architecture supply-chain
  release. Its scale-to-zero model also conflicts with the continuously running
  worker and search projection.

## Decision

The next controlled-beta target is one **on-demand Azure ARM64 VM** in East US 2,
using `Standard_E2ps_v5` (2 vCPU, 16 GiB) and an exact, reviewed Ubuntu 24.04
ARM64 image version. This size preserves the existing single-host topology and
avoids putting a managed PostgreSQL administrator secret into Terraform state.

The Azure deployment must:

1. remain synthetic-only, single-node, non-HA, and without an SLA;
2. use SSH public-key authentication only and admit SSH from one current `/32`;
3. expose ports 80 and 443 only to Caddy, which retains the application reviewer
   allowlist and returns `404` to other callers;
4. allocate one static public IPv4 but create **no DNS records**;
   protect that address against deletion because it becomes the OCI network-
   source trust anchor, and revoke every OCI key before ever releasing it;
5. preserve a separate encrypted 64-GiB data disk across VM replacement;
6. bound the first empty-host session to four hours, retain recurring daily
   auto-shutdown at that UTC time, and configure no automatic startup;
7. create a monthly budget with operator notifications, while treating the
   Azure for Students spending limit—not the budget—as the billing backstop;
8. reject Spot VMs, reservations, paid capacity fallbacks, other regions or VM
   sizes, load balancers, NAT gateways, managed databases, and Marketplace
   products in the first deployment;
9. keep Name.com records unchanged through host bootstrap, internal readiness,
   restore replay, reviewer-policy validation, and confirmation that Caddy is
   ready on ports 80/443. Then use a separately reviewed two-phase DNS cutover:
   point the exact A records to Azure, let Caddy obtain public certificates, run
   external TLS/allowlist tests, and roll back the records if those checks fail.

Azure replaces the unavailable OCI **compute** layer only. The first Azure
runtime retains the already-created, reviewed OCI Object Storage buckets and
four role-scoped IAM identities as its off-host encrypted-artifact boundary.
The worker continues to use OCI's native version inventory for restore replay;
ledger versioning, exact-version reads, and the live credential canary remain
mandatory. This cross-cloud HTTPS dependency is deliberate: it avoids a second
storage migration while solving the A1 host-capacity blocker.

The restore library is generalized to support an explicitly selected, strict
S3-compatible version inventory for future providers. Generic production
admission is still blocked: the live canary must first prove export-bucket
versioning state and exact cleanup without leaving a sensitive prior version.
It is not the first Azure runtime's selected path.

A self-hosted MinIO design was investigated and rejected. The latest official
ARM64 binary that could be authenticated through MinIO's Minisign release path
failed the 2026-08-20 no-ignore Trivy gate with 4 critical and 51 high findings;
the matching `mc` client had 2 critical and 41 high findings. Those results
include findings without a current fixed release. Wrapping either binary in a
repository image would conceal neither the vulnerable code nor its risk.

A complete OCI exit requires an Azure Blob adapter with version inventory,
managed identity/RBAC, immutability controls, and equivalent canaries. That is a
separate migration required before the retained OCI storage boundary can be
removed, and before real or production data can be considered.

Bootstrap is deliberately phased. A separately authorized infrastructure apply
may create only the empty VM and its static public IP; it cannot start the
application. The assigned IP is then used to restrict OCI credentials to an
OCI network source and to finish the endpoint-only host/container egress review.
Only after credential canaries, positive OCI storage/request headroom evidence,
an off-host database backup/restore drill, image
admission, and internal readiness pass may the application be considered for
start and the later DNS cutover. The locked data disk improves replacement
recovery but is not, by itself, a database backup.

The existing OCI prerequisites are retained but receive no more compute retry
automation. They are not destroyed until the Azure replacement is healthy and
their cleanup has its own reviewed, zero-surprise plan.

## Cost and operating model

At the 2026-08-24 East US 2 retail rates observed during this review,
`Standard_E2ps_v5` is approximately $0.101/hour (about $73.73 for 730 hours), a
Standard static IPv4 is about $3.65/month, and two 64-GiB E6 Standard SSDs total
about $9.60/month before disk operations, snapshots, tax, cross-cloud transfer,
or other egress. The roughly $86.98/month idle-to-steady baseline would consume
the $100 student credit in about five weeks. Therefore the approved model is
attended/on-demand testing with daily deallocation—not a 24/7 beta.

A 30-day month at four attended VM hours per day is approximately $25.37 before
disk operations and transfer. Standard SSD LRS operations are metered
separately (currently $0.002 per 10,000 transaction units); deallocation stops
VM compute billing but not the two provisioned disks or retained static IPv4.

Before any Azure plan or apply, the operator must independently confirm that:

- the active subscription is **Azure for Students**;
- its spending limit remains enabled and no payment upgrade is accepted;
- remaining credit and expiry are visible in Azure Portal **Education >
  Overview > Student offer details**; a generic billing Benefits blade that
  shows no credits is not authoritative for this offer;
- credit expiry is at least seven days beyond plan and apply;
- the exact SKU, both regional and Epsv5-family quota, ARM64 image, Trusted
  Launch support, active image state, and image terms are available in East US 2;
- the monthly budget start date and notification address are current; and
- the saved plan contains only the reviewed resources and no billable fallback.

Azure budget alerts are delayed notifications and are not hard caps. Deallocating
the VM stops compute billing, but the public IP and disks can continue to incur
charges.

### Dated subscription eligibility result

The read-only 2026-08-24 check is discovery evidence, not permission to deploy
and not a substitute for the four-hour pre-plan refresh. The authenticated
Education Hub showed the full $100 credit, $0.00 current-month usage, and an
August 24, 2027 expiry; the subscription was enabled with its spending limit on.
However, Azure returned `NotAvailableForSubscription` for
`Standard_E2ps_v5` in East US 2 and every zone, marked that Arm64 SKU
`TrustedLaunchDisabled`, and returned no usable regional/family quota records
while `Microsoft.Compute`, `Microsoft.Network`, and `Microsoft.DevTestLab`
were unregistered. No provider was registered and no resource was created.

That same check found no unrestricted Arm64 VM SKU or B-series SKU in East US
2. The closest unrestricted x64 capacity match was `Standard_E2as_v7` (2 vCPU,
16 GiB), but its modeled 24/7 total with the selected disks and static IPv4 was
approximately $100.12/month and it would require a separately reviewed
amd64/multi-architecture rebuild. It is therefore not an automatic fallback.
The next safe account gate is explicit authorization to register only the
minimum required providers, followed by a fresh Arm64 restriction and quota
check; the design must stop if either remains unavailable.

On 2026-08-25 the user explicitly authorized registration of only
`Microsoft.Compute`, `Microsoft.Network`, and `Microsoft.DevTestLab`; all three
reached `Registered`. The immediate read-only recheck still returned
`NotAvailableForSubscription` for `Standard_E2ps_v5` in East US 2 and zones
1/2/3, zero unrestricted Arm64 VM SKUs, 0 of 6 regional vCPUs in use, and an
EPSv5-family limit of 0 vCPUs. Azure resource inventory remained exactly zero.
Therefore registration did not close the compute gate: do not create a plan,
request a paid quota increase, or substitute x64 without a new decision.

## Consequences

- Existing ARM64 application image digests can remain the source artifacts;
  there is no new storage container image to trust or publish.
- Oracle-specific instance identity, firewall range locks, credential
  provisioning, and backup orchestration cannot be copied into the Azure
  compute runtime unchanged. The narrowly scoped Object Storage credentials and
  native version-inventory canary are intentionally retained.
- The OCI credential policies should be restricted to the Azure static egress
  IP before credentials are installed. Releasing that IP requires revoking the
  corresponding keys first, verifying denial, and removing the network-source
  bindings before the Azure public-IP lock can be removed.
- Synthetic export/read/spool limits are reduced to 256/512-MiB-class bounds,
  but application admission still requires current OCI bucket/version/request
  usage and explicit ledger/backup headroom; an Azure budget cannot see OCI.
- The preferred beta database recovery design is a client-side-encrypted,
  compressed logical PostgreSQL backup to a dedicated OCI bucket or prefix with
  unique object keys, short retention, separate create-only writer and offline
  restore identities, strict byte caps, and a clean-database restore drill. It
  remains unimplemented and requires separate OCI cost/IAM review; Azure disk
  snapshots alone are not sufficient logical-restore evidence.
- The mobile release ledger is provider-neutral and remains unconfirmed until
  `https://api.nourishing.app` is actually verified on Azure.
- Public ACME issuance cannot precede DNS cutover. The pre-cutover review proves
  local readiness and challenge reachability; certificate issuance and public
  verification are post-cutover gates before the deployment ledger can change.
- LocalStack was subsequently adopted for ephemeral S3/IAM compatibility tests
  by [ADR 0009](./0009-ephemeral-localstack-s3-iam-fixture.md). The existing
  development-only MinIO Compose fixture remains useful for local S3 contract
  tests but is neither the Azure storage boundary nor a public host.
- A later always-on design should reconsider managed PostgreSQL and Azure Blob,
  but that is a separate cost and security decision.

## Alternatives considered

- **Keep retrying OCI A1:** rejected as the primary plan because all three
  Ashburn availability domains returned physical host-capacity failures and
  Oracle exposes no reservation or bounded wait time inside Always Free.
- **Azure B2ps_v2 plus managed PostgreSQL:** a plausible later optimization for
  an always-on first year, but 8 GiB is tight, the managed database introduces a
  separate secret/network/restore design, and the free meter must be proven in
  the actual subscription.
- **Azure Container Apps:** rejected for the current release because it accepts
  AMD64 images while the reviewed artifacts are ARM64, and the stateful worker
  and search services do not benefit from scale-to-zero.
- **Heroku:** rejected because the education credit is below the minimum
  multi-process/add-on cost, the filesystem is ephemeral, the current image
  architecture is unsupported, and the `/32` edge contract would be weakened.
- **LocalStack or Codespaces as the beta:** rejected because they are attended
  development environments rather than durable public hosting. LocalStack
  remains useful for future AWS API/IAM tests.
- **AWS Free Plan:** retained as a fallback only if the user is a genuinely new
  AWS customer. Its no-charge Free Plan is bounded to six months or credit
  exhaustion and therefore does not improve the long-term operating model.
- **Azure Blob immediately:** deferred. It is the preferred Azure-native
  durability boundary, but requires a new versioned raw-artifact adapter,
  restore resolver, RBAC model, and live canary rather than a configuration
  substitution.
- **Self-hosted MinIO on the Azure data disk:** rejected after the reviewed
  ARM64 release failed the strict no-ignore vulnerability gate. It would also
  put compute and artifact durability back into one VM failure domain.

## References

- [GitHub Student Developer Pack](https://education.github.com/pack)
- [Azure for Students](https://azure.microsoft.com/en-us/free/students/)
- [Azure Bpsv2 Arm VM sizes](https://learn.microsoft.com/en-us/azure/virtual-machines/sizes/general-purpose/bpsv2-series)
- [Azure Epsv5 Arm VM sizes](https://learn.microsoft.com/en-us/azure/virtual-machines/sizes/memory-optimized/epsv5-series)
- [Azure Container Apps container requirements](https://learn.microsoft.com/en-us/azure/container-apps/containers)
- [Azure spending limits](https://learn.microsoft.com/en-us/azure/cost-management-billing/manage/spending-limit)
- [Heroku container runtime limitations](https://devcenter.heroku.com/articles/container-registry-and-runtime)
- [LocalStack licensing and Student plan](https://docs.localstack.cloud/aws/licensing/)
- [AWS Free Tier plans](https://aws.amazon.com/free/)
