# Azure ARM runtime artifacts (review-only)

This directory is the bounded host-runtime design for the synthetic-data beta.
It is **not deployable yet** and nothing here starts automatically. Appwrite Cloud
hosts the web application under the approved managed-runtime profile. The Azure
VM hosts the six qualified backend components; the already-reviewed off-host Object Storage buckets,
IAM roles, S3 compatibility endpoint, native version inventory, and restore
signing key contract remain in use.

Name.com remains the DNS authority. These files contain no DNS API integration,
and the records stay unchanged during this implementation. Public HTTP-01 or
TLS-ALPN certificate issuance cannot be proved before the A-record cutover: the
pre-DNS decision gate is a healthy bootstrapped host, internal application
readiness, and ports 80/443 prepared for Caddy—not a public certificate.

## Safety posture

- Every Compose service has an explicit profile and `restart: "no"`; plain
  `docker compose up` starts no service and a VM reboot does not resume one.
- The `core` profile contains only an internal Caddy instance for Meilisearch
  TLS; it has no host port and no public hostname block. The separate `edge`
  profile is the only service with public port bindings. It forwards only the
  explicit application method/path list in `Caddyfile`; unlisted paths return
  `404`. The API retains account/session ownership and erasure-capability checks.
  Readiness accepts only `GET /ready` from the reviewed administrative `/32` or
  with the separate readiness bearer credential. The API health check remains
  local to its container.
  Automatic HTTP redirects are disabled: Caddy may still serve its internal
  ACME challenge route, while every non-challenge HTTP request is an explicit
  `404` and never reaches the application.
- PostgreSQL and Meilisearch keep their internal TLS, read-only containers,
  non-root identities, persistent paths, and existing resource caps.
- API, worker, and offline restore services retain distinct Object Storage
  credentials. Restore explicitly uses `oci_native` version inventory and the
  API signing key is mounted only into the two offline operations.
- The provider-neutral admission helper verifies the exact repositories,
  immutable digests, ARM64 platform, image provenance labels, process identities,
  and runtime contracts for exactly six repository-owned backend images through
  the fixed `appwrite-cloud-azure-v1` profile. That profile rejects `WEB_IMAGE`
  and any extra image reference; it does not change the historical OCI profile. The
  signed upstream Meilisearch lock is CI-only bootstrap evidence and is never a
  host authorization file. The preflight never pulls an image.
- The data directories must live on the separately mounted preserved data disk;
  both storage helpers require that mount to resolve through Azure's LUN-0 data
  link and match a separately reviewed filesystem UUID and disk serial. Neither
  helper formats or mounts a filesystem.
- Every preflight child runs in its own bounded process group. Caddy validation
  uses `--pull=never` and exact per-run names/labels; timeout, TERM, HUP, or
  validation failure triggers signal-masked reconciliation of only that exact
  validator container.

The design deliberately does not include MinIO. The candidate server/client
artifacts failed the repository's zero-HIGH/CRITICAL admission policy. The
provider-neutral strict S3 path remains in the application for future work, but
this compute-only runtime selects the previously reviewed native restore path.

## Public application admission

`Caddyfile` has no backend web listener. Appwrite's server-side proxy and native
clients use the public API over verified HTTPS. The edge forwards only reviewed
methods and paths, applies a 1 MB request-body cap, and strips caller-supplied
forwarding headers. Fastify keeps `trustProxy: false`; neither a claimed source
address nor the presence of an Authorization header creates an authenticated
principal. User session validation and owner checks remain in the API handlers.

Anonymous account endpoints share a process-wide limit of 30 attempts per minute
and two active requests. Search, autocomplete and barcode lookup share 180
attempts per minute and four active requests. These fixed buckets reuse the
existing bounded limiter and apply even when the caller varies an IP address or
sends an unverified bearer token. Existing account-specific auth limits,
password-work bounds, query/result bounds and database-operation admission remain.
A slot stays occupied until its handler settles; disconnecting a caller cannot
admit replacement work while the original operation remains pending. Stalled
operations can exhaust admission and require diagnosis; the limiter does not
claim to cancel a backend that ignores cancellation.

The initial profile permits one API process. Compose fixes the API container
name and `deploy.replicas: 1`; preflight parses the rendered configuration and
rejects scaling, a backend web service, changed API resource caps or published
dependency ports. Actual host/container identity and singleton execution still
need independent deployment evidence. Multiple API processes require shared
abuse limiting before qualification.

`DEPLOYMENT_READINESS_TOKEN` is a separate 256-bit lowercase hex credential in
root-owned mode-0600 `deploy.env`, projected only into edge Caddy. Generate it
under the separately approved credential workflow; never put its value in a
release report, command line or log. The validator uses a fixed synthetic token
for configuration syntax. The real token is removed before Caddy forwards an
authorized readiness request. The edge also requires its configured token to
match the full 64-character lowercase hex shape; an empty environment cannot
turn a bare bearer header into readiness admission. This credential authorizes only `GET /ready` and
cannot authenticate an application account. `/ready` checks the API's existing
migration and restore state; it does not qualify worker, search or storage health.

Local hook and route-policy tests do not establish Caddy parsing, TLS routing,
provider access, rate limiting through an actual BFF/native connection, or a
release decision. The existing no-network Caddy configuration validator remains
mandatory on a qualified host before exposure. Its command requires separately
authorized owned container execution; source work does not run it implicitly.

## Deployment targets and data isolation

`DEPLOYMENT_TARGET=staging` selects only `staging-api.nourishing.app`;
`production` selects only `api.nourishing.app`. Any other pairing fails preflight.
The example selects staging. Each target needs its own host, configuration root,
data disk, database, search indexes, storage buckets, credential keys and
readiness token. These artifacts define one target per host; they do not install
two targets into a shared root or certify that provisioning kept them separate.
The credential/provisioning review must bind those distinct identities before
promotion. Staging evidence cannot qualify the production backend.

Both targets remain synthetic-only in this source layer. The original
`SYNTHETIC_ONLY_ACKNOWLEDGEMENT` and `BETA_DATA_CLASSIFICATION=synthetic-only`
checks protect personal, nutrition and health data until the existing integration
and formal release gates are satisfied. Selecting `production` is a hostname
selection, not personal-data admission. A reviewed personal-data profile and its
actual restore, privacy, credential and isolation evidence remain prerequisites.

## Hard blockers

`deployment-preflight.py` always ends with a hard failure until all gaps below
have reviewed implementations. The four `BLOCKED_NOT_IMPLEMENTED` values are
stop conditions, not acknowledgements that an operator may edit around.

1. **Live endpoint-only egress qualification remains missing.** The controller
   below implements the owned firewall rules and drift response. Local tests
   do not prove kernel enforcement, reboot ordering, Docker peer isolation or
   positive/negative canaries on the actual host. The egress admission value
   remains `BLOCKED_NOT_IMPLEMENTED` until the complete host evidence and
   admission path are reviewed. Host and Caddy outbound traffic remain outside
   this layer.
2. **Host credential qualification remains missing.** The local installer below
   publishes and recovers credential files, but has not run on an Azure host.
   The complete read/write/deny/native-version canary, reviewed four-role cloud
   identity, credential generation and revocation procedure, and independently
   reviewed host evidence remain required. The credential admission value stays
   `BLOCKED_NOT_IMPLEMENTED`; a completed local transaction never permits an
   application or canary to start.
3. **Positive OCI usage/headroom admission is missing.** Before any service can
   start, capture live bucket bytes, every retained object version, and current
   monthly request usage. Reserve reviewed headroom for the append-only ledger
   and the selected PostgreSQL backup; stop on uncertain or potentially
   billable consumption. The fixed synthetic limits—256 MiB per export/spool,
   one concurrent read, and 512 MiB per read window/search spool—contain blast
   radius but do not prove that the OCI allowance still has capacity.
4. **A preserved data disk is not a backup.** VM deletion locks and a separately
   attached disk reduce accidental deletion risk but do not protect against
   corruption, operator error, or regional loss. Application start requires a
   separately reviewed off-host PostgreSQL backup with an approximately 24-hour
   RPO, retention and encryption controls, plus fresh manual restore-drill
   evidence bound to the deployed source commit. This layer does not silently
   enable paid backup, snapshots, vaults, or replication.

## Object-storage network enforcement

`object-egress.py` controls only the `inet nourishing_object_egress` nftables
table. Its fixed network is `nutrition-ledger-azure-beta-object-egress`, bridge
`nourishing-obj`, subnet `172.31.255.0/28` and gateway `172.31.255.1`. Compose
disables IPv6 and inter-container communication on this bridge. Preflight checks
that rendered network and rejects alternate attachments, unreviewed clients,
privileged execution, added capabilities and device mappings that could bypass
it. The API, worker and restore operation also use the internal backend network;
the credential canary uses only the storage network. Live verification inspects
only the observed client IDs and a projection of their identity, network and
security fields; it does not retrieve container environment variables or mounts.

All four client names are fixed in Compose. Future approved one-off operations
must also pass the corresponding explicit `--name` to `docker compose run --rm`:
`nutrition-ledger-azure-beta-object-storage-live-canary` or
`nutrition-ledger-azure-beta-erasure-restore-attestation`. Random one-off names
are rejected. The private backend network must retain its Compose identity,
internal routing and disabled IPv6.

The fixed-path controller supports `quarantine`, `install`, `verify` and
`watchdog`. Quarantine denies bridge-originated host input and forwarding, plus
forwarding into the bridge. Host-originated output is outside this policy. It
requires neither Docker nor endpoint resolution. Install validates the reviewed
schema-3 coordinates, source-pinned public-range lock no older than 168 hours,
exact frozen host mapping and actual Docker network identity. It then atomically
replaces only its own table. It permits IPv4 TCP/443 to the two frozen endpoint
addresses and their established replies. Other destinations, IPv6, host input
and traffic between storage-bridge peers are denied. No rule grants the whole
provider address range. DNS refresh and widening destinations are separate
reviewed changes.

Verify reads the current network and rules and fails if either differs. The
watchdog verifies the same contract and quarantines on drift or invalid input;
it never reinstalls a permissive policy or restarts a workload. It emits no
start-admission marker. The preflight requires its installed source digest and
successful verification, then retains every remaining live admission condition.
An independent root command can change the host firewall between observations;
this mechanism does not provide protection against a hostile root administrator.

The unit files are inert source artifacts. A future approved host installation
must install the root-owned controller and units, enable the boot unit's required
Docker dependency and watchdog timer, and verify the resulting systemd dependency
graph before starting Docker. The boot unit starts in quarantine. Only a separate
reviewed install operation may permit the frozen endpoints. No local test in this
slice installs units, changes a firewall, starts Docker or runs a network probe.

Host acceptance requires the actual nftables/Docker versions, live rule and
network identity, reboot and failure behavior, and bridged-peer isolation. Use a
working positive control plus attributable negative probes and rule counters;
each verdict has an anonymous packet/byte counter, whose location and shape
remain part of verification. An arbitrary network error is insufficient evidence
of a firewall denial. The host bridge must have exactly the reviewed IPv4
address and no IPv6 address; validate the actual Docker/host IPv6 configuration
before qualification.
Credentials, actual storage access, capacity, backup/restore and signed release
review remain separate requirements. The saved August public-range review is
stale and must be renewed through the existing review process before host use.

## Local credential installation and recovery

`install-object-storage-credentials.py` is a root-only, fixed-path host helper.
Its source and the filesystem regressions are implemented; host installation and
execution need separate approval. It does not create cloud credentials, contact
OCI, start containers or write a start-admission marker. The existing four fatal
preflight conditions remain in force.

The `install` command accepts at most 65,536 bytes of JSON on stdin within 30
seconds. Version 1 has exactly `schemaVersion`, `deploymentTarget`, `sourceCommit`,
`exportReader`, `exportWriter`, `ledgerWriter`, `ledgerRestore` and `restoreApi`.
Each role contains `accessKeyId` and `secretAccessKey`; `restoreApi` contains
`privateKeyPem` and `fingerprint`. Role access identifiers and secrets must use the safe unquoted environment
alphabet; quotes, backslashes, dollar signs, whitespace and control characters
are rejected. All four access identifiers and secrets must be distinct. Keep
this bundle in a separately reviewed private credential channel, never argv,
source control or logs.

The helper binds the bundle to the current source and staging/production target
in root-owned mode-0600 configuration. It preserves the configured restore
namespace, tenancy and user identity, and all unrelated environment lines. It
checks one unencrypted RSA PEM with OpenSSL's private-key consistency check,
requires at least 2048 bits, and compares the supplied fingerprint with MD5 of
public DER. These checks establish local key consistency; they do not prove the
key was registered to the configured OCI principal or has the intended policy.

Only `api.env`, `worker.env`, `restore.env` and
`oci/restore-private-key.pem` can change. Environment files are root-owned 0600;
the offline key is UID/GID 1000 mode 0400 under a root-owned 0700 `oci` directory.
The helper rejects unsafe parents, symlinks, hardlinks, modes and ownership. It
holds `.credential-transaction.lock` throughout the operation. Preflight loads
only the pinned, root-owned helper and holds that same lock before any child
process and throughout its existing checks. Every container in the exact
`nutrition-ledger-azure-beta` Compose project must be absent, `created` or
`exited`. Unknown, running, paused or restarting state fails. Bounded Docker
queries run before publication and again before completion; they do not inspect
container environments. This cooperative lock cannot prevent an unrelated root
operator from invoking Docker directly. Keep the whole project stopped and
preserve the separate fatal start-admission controls.

The private mode-0700 `credential-transactions` directory retains rollback files
and mode-0600 journals. File and directory synchronization precedes publication.
Each individual target replacement is atomic; a multi-file installation can be
interrupted. Its durable pending journal blocks preflight until recovery or
completion. An `installed` journal means only that the local bytes, owner and
mode were verified. Previous completed transactions and rollback copies remain
private for reviewed retention; no automatic pruning occurs.

The explicit `recover` command uses the current fixed journal. Before changing
any target it checks all source, parent, original/new file and rollback-stage
identities. It rechecks each target immediately before replacement or removal.
Foreign changes block recovery and preserve evidence, including when an offline
key was originally absent. Recovery may itself be interrupted and resumed from
its durable journal; successful recovery is idempotent. A crash before a complete
journal or between writing a rollback stage and journaling its identity leaves
an unknown orphan. That case fails closed and requires separately reviewed
manual recovery. Do not delete journals or unknown files to bypass the guard.

A new source/image configuration requires an explicit new installation whose
bundle matches that configuration. It may reuse a completed prior transaction
only when the host target, restore principal and prior credential file/parent
identities still match. Recovery of an earlier transaction remains bound to that
transaction's exact original configuration. A target change requires a separate
host/configuration root; it cannot reuse the staging transaction history.

The focused tests use real private temporary files, interruption and I/O-error
injection, a killed test child and ephemeral synthetic OpenSSL keys. They mock
Docker stopped-state probes and use ordinary-runner ownership in the test root.
They do not establish root ownership on a deployed host, crash durability under
actual power loss, live least privilege, native object-version behavior or host
qualification. Run the existing canary and host review only under their separate
authorization; local receipt success cannot replace them.

## Review and staging contract

The intended host paths are:

| Repository artifact | Host path | Owner/mode |
| --- | --- | --- |
| `compose.yaml`, `Caddyfile`, `Caddyfile.internal` | `/opt/nutrition-tracker/` | `root:root 0644` |
| `install-object-storage-credentials.py` | `/opt/nutrition-tracker/install-object-storage-credentials.py` | `root:root 0750` |
| `object-egress.py` | `/opt/nutrition-tracker/object-egress.py` | `root:root 0750` |
| `nutrition-azure-object-egress*.service`, `nutrition-azure-object-egress*.timer` | `/etc/systemd/system/` | `root:root 0644` |
| `deployment-preflight.py` | `/usr/local/sbin/nutrition-azure-preflight` | `root:root 0750` |
| `prepare-storage.sh`, `prepare-internal-pki.sh` | `/usr/local/sbin/` | `root:root 0750` |
| each `*.env.example` | `/etc/nutrition-tracker/` | `root:root 0600` |
| rendered `*.env` | `/etc/nutrition-tracker/` | `root:root 0600` |
| reviewed image-admission helper | `/opt/nutrition-tracker/image-admission.py` | `root:root 0750` |
| reviewed Object Storage coordinates | `/etc/nutrition-tracker/object-storage-coordinates.json` | `root:root 0644` |
| 168-hour reviewed public-range lock | `/opt/nutrition-tracker/object-storage-public-ranges.lock.json` | `root:root 0644` |
| Terraform-reviewed administrative/readiness `/32` | `/etc/nutrition-tracker/expected-reviewer-cidr` | `root:root 0644` |
| reviewed `data-disk-identity.env` rendered from the example | `/etc/nutrition-tracker/data-disk-identity.env` | `root:root 0644` |
| fresh exact host map | `/run/nutrition-tracker/object-storage-hosts.env` | `root:root 0600` |
| offline restore API key | `/etc/nutrition-tracker/oci/restore-private-key.pem` | `1000:1000 0400` |

The provider-neutral image-admission source is currently located at
`infra/oci/files/image-admission.py`; the preflight pins its reviewed source
hash. Do not install `infra/oci/external-images.lock.json` on the host—it
explicitly withholds direct deployment approval. Do not copy compute,
instance-identity, DNS, firewall, or systemd files.

The operator must identify the Terraform-attached data disk through
`/dev/disk/azure/data/by-lun/0` or `/dev/disk/azure/scsi1/lun0`, partition and
format only an empty disk under a separate reviewed procedure, and mount its
filesystem exactly at `/var/lib/nutrition-tracker` as `ext4` or `xfs` with
`rw,nodev,nosuid`. Record the mounted filesystem UUID and the LUN-0 whole-disk
`lsblk` serial in `data-disk-identity.env`; an independent review must approve
those exact values before installing the root-owned mode-`0644` file. Both
`prepare-storage.sh` and every later preflight fail if the mount moves off LUN
0 or either identity changes. Only then run `prepare-storage.sh`.
`prepare-internal-pki.sh init` creates only the Postgres
and `meili.internal` leaves; `verify 14` is the renewal guard. These helpers do
not install Docker and do not start a container.

After the four blockers have actual reviewed implementations, the intended gate
sequence is:

1. install fresh root-owned configuration and credentials without logging
   values;
2. run `nutrition-azure-preflight early` (only the two scoped Meilisearch-key
   markers may remain);
3. start only the `core` profile, create the two scoped Meilisearch keys, and
   rerun the `full` preflight;
4. run the Object Storage credential canary, migration twice, native restore
   attestation, and database readiness operations while API/worker remain
   stopped;
5. start the `application` profile and prove internal readiness without changing
   DNS; the `edge` profile must still be stopped, so no public hostname block can
   request a certificate;
6. in a separate reviewed change, point only the selected `staging-api.nourishing.app` or `api.nourishing.app`
   Name.com A record at the admitted static IPv4; Appwrite web DNS needs its own
   reviewed provider configuration;
7. start only the `edge` profile, wait for Caddy to complete public certificate
   issuance, then verify external TLS, every approved application route, denied
   private operations, readiness authorization, and cross-account rejection; and
8. restore the previous A records immediately if issuance or either external
   check fails, then stop/deallocate the beta host.

No command in this directory performs that sequence today. This prevents a
review artifact from being mistaken for authorization to spend credit, alter
DNS, install credentials, or expose the beta.
