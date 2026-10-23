> Current policy, October 23, 2026: Mandatory human reviews, third-person
> approvals and human signatures are permanently revoked. One authorized operator
> can complete the workflow. Older review instructions below are historical and
> cannot block work. Keep automated functional, integrity, provenance, recovery
> and device checks, software/platform signatures, consent, spending limits,
> credential custody, deployment permissions and automatic tool approval.

# Installed staging backend

This path connects a new empty Azure Arm64 host to the existing application. It
uses Ubuntu packages, LUKS2, systemd and Docker Compose. It does not use the finite
development controller or the retired OCI deployment profile. Installation source
and a parsed Compose graph do not establish a working hosted service.

## One operational scope

Before running anything on a host, obtain one complete applicable scope covering
fresh Azure allowance/region/capacity checks, the exact resource set and source,
existing-credit costs with zero out-of-pocket charges, duration and shutdown,
blank-disk formatting, package versions, key/credential custody, network and DNS
changes, image qualification, service operation, recovery and cleanup. The existing
empty-host Terraform plan and its shutdown rule are not permission for these
steps. Do not extend a consumed approval or leave the VM beyond its approved time.
Existing release, provenance, reviewer, backup and Appwrite admission gates apply.

## First installation

Use a newly provisioned Canada Central host with its separately approved Ubuntu
Arm64 image and blank 64-GiB LUN0 data disk. The source checkout must be the clean
committed revision under review. The installer archives only tracked source into
an immutable host directory; it copies no checkout caches or machine state.

The operator supplies a root-owned mode0700 bundle. Every input file is a regular,
non-symlink, single-link root:root mode0600 file. It contains:

- `packages.env`: exact `DOCKER_IO_VERSION`, `COMPOSE_VERSION`,
  `CRYPTSETUP_VERSION` and `NFTABLES_VERSION` selected from the configured signed
  Ubuntu repositories. Compose must support `!override` (2.24.4 or later).
- `compose.env`: `RUNTIME_ROOT=/var/lib/nourishing/runtime`,
  `RUNTIME_SOURCE=/opt/nourishing/current`,
  `RUNTIME_PROJECT=nourishing-hosted-staging`, the exact `RUNTIME_REVISION`, one
  `RUNTIME_OWNER` UUID, `ACME_EMAIL`, one public `ADMIN_IPV4_CIDR` /32 and the scoped
  `DEPLOYMENT_READINESS_TOKEN`. It also contains the seven existing image variables.
  Each image uses a qualified immutable digest. Mailpit uses its maintained upstream
  `docker.io/axllent/mailpit` or `ghcr.io/axllent/mailpit`; no runtime fork is needed.
- `config/`: `runtime.env`, `database.env`, `api.env`, `worker.env`, `postgres.env`,
  `meili.env`, `migrate.env`, `restore.env`, `scoped-meili.env`, `canary.env` and
  `database-bootstrap.sql`, using the maintained database/credential preparation
  contracts. The SQL contains only the intended new database and reviewed roles.
- `pki/`: public `ca.crt`, and `postgres`, `meili` and `capture` certificate/key
  pairs. The issuing CA private key stays under its separate custody controls.
- `mail/`: distinct `send.htpasswd` and `review.htpasswd` role files.
- `network.nft`: the separately reviewed native policy for the fixed Compose
  bridges and exact Azure destinations. It must retain private dependencies,
  administrator-only SSH, public application HTTPS and the required ACME/DNS
  access. The old finite one-IP client policy cannot serve Appwrite traffic.

Place the separately approved 64-byte random volume key in the root-only tmpfs
file `/run/nourishing-volume.key`. Establish its off-host recovery custody first.
Do not reuse or read any preserved historical private material. The installer does not generate SSH or application/CA credentials, or copy the CA
private key or cloud authentication caches. LUKS2 creates its encryption metadata
using the separately supplied unlock key.

After the full operation is authorized, run as root:

```sh
bash TRACKED_SOURCE/infra/development/azure/hosted/install-host.sh \
  TRACKED_SOURCE PRIVATE_BUNDLE EXPECTED_LUN0_SERIAL SOURCE_REVISION
```

The installer refuses existing installation paths, an active Docker daemon,
changed tracked source, redirected Compose coordinates, unsafe input files and
any disk that has a signature, a child device, a mount or a different identity.
It masks Docker and its socket across package installation and partial-install
reboots, suppresses package-triggered startup, installs the four exact Ubuntu
packages, rechecks the disk, creates LUKS2/ext4, installs the private configuration
and sets Docker data on the encrypted volume. Failures retain their partial state;
do not rerun against it or delete it to make the next attempt pass. Docker stays
masked on failure; it is unmasked only after its required configuration and units
exist, with failed verification restoring the inhibition.

The application remains stopped. No public listener, image download, provider
operation, SSH/CA key creation, DNS change or application activation is performed by
this installation command. The supplied network policy is syntax-checked and is
applied by its required systemd unit before Docker can start.

## Commission and start

Within the same accepted operation, complete the existing image/provenance and
configuration admission, acquire the exact images, verify private TLS and distinct
Mailpit privileges, and complete the original-database bootstrap/recovery and
catalogue or explicit synthetic-fixture initialization. Preserve their actual
outputs. An empty catalogue or successful mocked restore is not this acceptance.
Keep restore-reader credentials in `restore.env`; API and worker retain their
separate database/storage roles. Both auth link origins must be exactly
`https://staging.nourishing.app`, with development HTTPS capture selected. The
worker uses production validation; both applications require the same admitted
restore epoch and verified database TLS.

For a database that has the maintained synthetic runtime grants, supply the same
independently held `runtimePrincipals: { api, worker }` mapping in both backup and
restore operator settings. Recovery validates the exact shared permission profile,
keeps the complete source ACL fingerprint in the encrypted backup, and reapplies
those table and column grants on the new fenced target before comparison. It does
not grant runtime database CONNECT. Omitting the mapping retains the strict
catalogue-only policy and rejects runtime ACLs. This profile is for development
and staging; production does not accept it.

Start the installed backend only after the applicable release admission:

```sh
systemctl enable nourishing-hosted.service
systemctl start nourishing-hosted.service
```

On each start, systemd waits for the private dependencies, runs the maintained
migrator, verifies the existing scoped Meilisearch keys and runs Azure erasure
replay/attestation. It then waits for both applications to become healthy before
starting public Caddy. The foreground Compose process detects an application exit;
systemd repeats admission on restart, subject to its bounded failure burst.
Container restart policies remain disabled. `/ready` keeps the existing /32 or
readiness-token policy; public application routes retain API authentication.

Use `systemctl stop nourishing-hosted.service` before the approved shutdown
reserve, and verify stopped services. Stop retains data and logs. Follow the
approved resource cleanup/recovery plan separately; no `down -v`, key deletion,
resource deletion, lifetime extension or automatic provisioning is included.
A full host reboot requires the separately controlled LUKS unlock before Docker
can start. This source does not implement unattended key release.

## Product acceptance

Create/configure the existing Appwrite project's staging Site through the maintained
release path, using `https://staging-api.nourishing.app` as its HTTPS upstream and
`https://staging.nourishing.app` as its web origin. Preserve the existing signed
prepare/activate gates. Prove sign-in, search or creation of a food, logging, edit
and reload, then restart the backend and read the same diary through Appwrite
while the PC is disconnected. Also finish the required cross-owner, dependency
privacy and downloaded encrypted-backup restore checks. Until those operations
pass, neither this source nor successful static checks mean the hosted product
is available or admitted for personal data.

Compose [startup conditions](https://docs.docker.com/compose/how-tos/startup-order/)
and [foreground lifecycle options](https://docs.docker.com/reference/cli/docker/compose/up/)
provide the ordering. The [systemd service](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html)
supervises the process; this path adds no custom runtime controller.
