# Local S3 fixture

SeaweedFS 4.47 replaces the unavailable MinIO fixture only in local development
and CI. Production storage adapters, policy permissions, encrypted formats and
retained history are unchanged. The four policy JSON files are the existing
role contract, relocated without semantic changes.

The upstream image is exactly
`ghcr.io/chrislusf/seaweedfs:4.47@sha256:ce9e796f1fe6f06968f4c04bdaf8f678dad9c8acdfef3d244133d71bfa6bf882`.
Its bundled gRPC version fails the required vulnerability scan. It remains the
authenticated build input and the unchanged local Compose pin; it is not accepted
for new execution. Local AMD64 qualification needs separate approval.

The native ARM64 CI build uses exact SeaweedFS 4.47 source with the reviewed gRPC
fix, preserving the upstream runtime files and replacing only `/usr/bin/weed`.
The module inputs under `infra/docker/object-store.*` are immutable build inputs.
Go must verify their checksums and build without changing the reviewed graph.
The separate build evidence retains the resolved graph, sums and binary identity.
The reviewed dependency notices accompany both that evidence and the derived
image under `/usr/share/licenses/nourishing-object-store/NOTICES.txt`.

The resulting project image needs its own exact digest, signature, source-bound
provenance and SBOM. The upstream signature authenticates only the original base.
The trusted container workflow builds and qualifies the derivative independently
of pull-request tests. After that job succeeds, a reviewed follow-up must pin its
immutable digest and original build identity in CI. Until that pin is delivered,
the existing database scan remains blocked by the upstream vulnerability. The
consumer must independently verify and scan the derivative before starting it;
its Compose override may change only the image. The zero-HIGH/zero-CRITICAL scan uses an empty
ignore policy. The mandatory S3 permission, versioning, privacy, immutable ledger
and full restore tests remain required. A build or offline test pass does not
qualify the image. No production storage or running preview changes here.

`node scripts/local-object-store.mjs prepare` creates private generated state;
`OBJECT_STORE_PORT` selects the initial loopback port (default 9000). It refuses
invalid or inconsistent existing state instead of rotating credentials.
`pnpm infra:up` calls this preparation only after validating the exact rendered
Compose boundary. After the service becomes healthy, the host helper runs
`node scripts/local-object-store.mjs bootstrap`. Curl must support `--aws-sigv4`
(7.75.0 or later); Ubuntu 24.04's curl 8.5.0 provides it. Requests disable curlrc
and proxies, use bounded timeouts and pass generated admin credentials on stdin.
No shell evaluates runtime.env and no credentials appear in arguments or logs.

The S3 configuration attaches explicit policies to all five identities and has
no anonymous identity or legacy coarse grants. The service disables telemetry and uses the image's
normal privilege drop. The host config file is mode 0444 in an owner-only 0700
directory; only that file is mounted read-only. The environment overlay is
0600 and is never mounted. Existing bucket versioning must exactly match:
exports Suspended, erasure ledger Enabled. Bootstrap never rewrites an existing
bucket's versioning or deletes data.

For CI/test commands, load `.local-data/object-store/runtime.env` with the
installed `dotenv-cli` using `-o --no-expand`; normal development uses its guarded
in-process loader. Generated values include all four role pairs, the separate
`ARTIFACT_STORE_ADMIN_ACCESS_KEY_ID` / `ARTIFACT_STORE_ADMIN_SECRET_ACCESS_KEY`,
S3 endpoint, region, bucket names and `EXPORT_ARTIFACT_DELETE_VERSION_POLICY`.

After the owned fixture container has stopped, CI may run
`node scripts/local-object-store.mjs cleanup`. It removes only the two known
owned, single-link generated files and their private directory; any extra entry
or unsafe metadata aborts cleanup. It never contacts Docker or removes a volume.
CI attempts removal of its owned project volumes and cleans generated files even
if that removal fails. Local shutdown retains state; normal local instructions never call cleanup or delete volumes.

Tagged implementation references:
[static IAM schema](https://github.com/seaweedfs/seaweedfs/blob/4.47/weed/pb/iam.proto),
[attached-policy evaluation](https://github.com/seaweedfs/seaweedfs/blob/4.47/weed/s3api/auth_credentials.go),
[server options](https://github.com/seaweedfs/seaweedfs/blob/4.47/weed/command/server.go),
[image entrypoint](https://github.com/seaweedfs/seaweedfs/blob/4.47/docker/entrypoint.sh).
