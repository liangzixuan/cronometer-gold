# Azure ARM runtime artifacts (review-only)

This directory is the bounded host-runtime design for the synthetic-data beta.
It is **not deployable yet** and nothing here starts automatically. The Azure
VM replaces compute only; the already-reviewed off-host Object Storage buckets,
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
  profile is the only service with public port bindings. It retains the exact
  reviewer `/32` application allowlist and returns `404` to other callers.
  Automatic HTTP redirects are disabled: Caddy may still serve its internal
  ACME challenge route, while every non-challenge HTTP request is an explicit
  `404` and never reaches the application.
- PostgreSQL and Meilisearch keep their internal TLS, read-only containers,
  non-root identities, persistent paths, and existing resource caps.
- API, worker, and offline restore services retain distinct Object Storage
  credentials. Restore explicitly uses `oci_native` version inventory and the
  API signing key is mounted only into the two offline operations.
- The provider-neutral admission helper verifies the exact repositories,
  immutable digests, unique reviewed ARM64 child, image provenance labels,
  process identities, runtime contracts, and the external-image vulnerability
  lock. The preflight never pulls an image.
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

## Hard blockers

`deployment-preflight.py` always ends with a hard failure until all gaps below
have reviewed implementations. The four `BLOCKED_NOT_IMPLEMENTED` values are
stop conditions, not acknowledgements that an operator may edit around.

1. **Endpoint-only egress on Ubuntu is missing.** The `object_egress` bridge,
   loopback DNS setting, and frozen host mappings do not by themselves stop a
   compromised container from dialing an arbitrary IP address. The Azure host
   still needs a fail-closed, reboot-persistent rule set that permits TCP/443
   only to the frozen S3-compatibility/native endpoints, rejects all other
   IPv4/IPv6 forwarding from that bridge, continuously detects drift, and
   passes both positive and negative canaries. The existing host firewall is
   platform-specific and is not copied here. Host and Caddy outbound traffic
   also remain unrestricted by this layer.
2. **Credential installation/rotation on the Azure host is missing.** No
   Customer Secret Key or restore API key was ever installed because the
   original compute instance never existed. The existing provisioner assumes a
   different host user, a separately installed helper manifest, and its own
   service lifecycle. A new root-only installer must accept the four generated
   credential roles without argv/stdout exposure, atomically publish root-owned
   mode-0600 environment files and a UID/GID 1000 mode-0400 offline restore key,
   preserve rollback/rotation locks, and run the full read/write/deny/version
   canary before either application process can start. Do not generate or
   rotate credentials until that workflow is reviewed.
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

## Review and staging contract

The intended host paths are:

| Repository artifact | Host path | Owner/mode |
| --- | --- | --- |
| `compose.yaml`, `Caddyfile`, `Caddyfile.internal` | `/opt/nutrition-tracker/` | `root:root 0644` |
| `deployment-preflight.py` | `/usr/local/sbin/nutrition-azure-preflight` | `root:root 0750` |
| `prepare-storage.sh`, `prepare-internal-pki.sh` | `/usr/local/sbin/` | `root:root 0750` |
| each `*.env.example` | `/etc/nutrition-tracker/` | `root:root 0600` |
| rendered `*.env` | `/etc/nutrition-tracker/` | `root:root 0600` |
| reviewed image admission + external lock | `/opt/nutrition-tracker/` | `0750`, `0644` |
| reviewed Object Storage coordinates | `/etc/nutrition-tracker/object-storage-coordinates.json` | `root:root 0644` |
| 168-hour reviewed public-range lock | `/opt/nutrition-tracker/object-storage-public-ranges.lock.json` | `root:root 0644` |
| Terraform-reviewed shared SSH/beta `/32` | `/etc/nutrition-tracker/expected-reviewer-cidr` | `root:root 0644` |
| reviewed `data-disk-identity.env` rendered from the example | `/etc/nutrition-tracker/data-disk-identity.env` | `root:root 0644` |
| fresh exact host map | `/run/nutrition-tracker/object-storage-hosts.env` | `root:root 0600` |
| offline restore API key | `/etc/nutrition-tracker/oci/restore-private-key.pem` | `1000:1000 0400` |

The image admission files are the provider-neutral portions currently located
at `infra/oci/files/image-admission.py` and
`infra/oci/external-images.lock.json`; the preflight pins their reviewed source
hashes. Do not copy compute, instance-identity, DNS, firewall, or systemd files.

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
   attestation, and database readiness operations while API/web/worker remain
   stopped;
5. start the `application` profile and prove internal readiness without changing
   DNS; the `edge` profile must still be stopped, so no public hostname block can
   request a certificate;
6. in a separate reviewed change, point only the `api.nourishing.app` and
   `app.nourishing.app` Name.com A records at the admitted static IPv4;
7. start only the `edge` profile, wait for Caddy to complete public certificate
   issuance, then verify external TLS, the reviewer `/32` allow path, and the
   non-reviewer `404` path; and
8. restore the previous A records immediately if issuance or either external
   check fails, then stop/deallocate the beta host.

No command in this directory performs that sequence today. This prevents a
review artifact from being mistaken for authorization to spend credit, alter
DNS, install credentials, or expose the beta.
