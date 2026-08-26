# ADR 0009: Adopt an ephemeral LocalStack S3/IAM development fixture

- Status: Accepted for local implementation; not a deployment target
- Date: 2026-08-25
- Scope: synthetic development and compatibility testing only

## Context

OCI Always Free A1 compute remained unavailable after one controlled attempt in
each Ashburn availability domain. The Azure Student subscription is active, but
provider registration did not remove the East US 2 ARM64 SKU restriction or the
zero EPSv5-family quota. Neither cloud currently offers the reviewed ARM64
compute path needed for the controlled beta.

LocalStack is available through the GitHub Student Developer Pack. Its Student
plan includes S3, IAM, STS, IAM policy enforcement, and CI testing, but no Cloud
Sandbox previews or hosted ephemeral instances. It can therefore improve local
AWS-API compatibility evidence; it cannot solve compute capacity or host a
public beta.

The repository already has a strong MinIO integration lane. It proves encrypted
artifact behavior, versioned erasure-ledger restore, split credentials, and
negative permissions. The runtime uses a hand-written path-style SigV4 S3
client and has no Lambda, SQS, DynamoDB, KMS, EC2, or AWS Terraform dependency.

## Decision

Add an opt-in `pnpm test:localstack` fixture with these constraints:

1. run only S3, IAM, and STS in one container from a multi-architecture image
   pinned by exact calendar tag and index digest, natively on ARM64 or AMD64;
2. require a runtime-injected LocalStack Developer Auth Token, never write it to
   repository files, Docker configuration, or logs, restrict Docker-engine
   access to trusted local users, and promptly remove the ephemeral container
   metadata that carries it; use a separate protected CI Auth Token before
   enabling the live fixture in GitHub Actions;
3. bind only to `127.0.0.1`, use ephemeral state, mount no Docker socket or
   volume, stop the complete application-test process group on timeout, and
   remove only the uniquely named and labeled test container after a bounded
   delayed-launch reconciliation window;
4. use a mode-0700 temporary Docker configuration with no credential helper so
   pulls cannot trigger the macOS Keychain credential-helper prompt;
5. reject remote Docker contexts and arbitrary service endpoints; strip
   inherited AWS, LocalStack, proxy, profile, and role credential sources from
   every child; point the application test at fresh empty AWS config/credential
   files; and disable EC2 metadata credential discovery;
6. create exactly the versioning-suspended private export bucket and versioned
   private erasure-ledger bucket;
7. enable hard IAM enforcement, generate four ephemeral users/access keys, prove
   default denial, attach the existing MinIO policy documents, and reuse the
   encrypted artifact integration suite, including cross-role and cross-bucket
   denial canaries; round-trip export lifecycle configuration without treating
   emulator scheduling as expiry evidence; and
8. retain the MinIO lane and every real-provider admission canary unchanged.

LocalStack explicitly ignores secret-access-key values. The fixture therefore
does not claim AWS SigV4 secret-validation parity; its value is access-key
identity, IAM policy decisions, path-style S3 requests, conditional writes,
version inventory, and exact-version reads. MinIO remains the complementary
authenticated-secret implementation test.

No LocalStack live job enters CI until a dedicated CI token is configured and
fork-secret exposure is prevented. Static fixture contracts are admitted to CI
immediately.

## Consequences

- Developers can keep S3/IAM integration work moving while cloud compute is
  blocked, using synthetic bytes and deterministic empty state.
- LocalStack is not a beta host and changes no Name.com DNS, OCI/Azure resource,
  public IP allowlist, production storage, backup, or mobile-release state. Its
  local DNS/TLS features provide neither public DNS delegation nor publicly
  trusted TLS for this loopback HTTP fixture.
- The emulator still contacts LocalStack for license activation. Student-plan
  telemetry defaults on. Disabling client event publishing does not prevent
  LocalStack from recording license activation timestamps and licensing
  credentials server-side.
- Emulator success is not evidence of real AWS billing, durability, TLS, IAM
  completeness, lifecycle timing, or service availability.
- Cloud Pods are outside this decision because real health data is prohibited,
  Student Cloud Pod storage is bounded, and end-to-end Cloud Pod encryption is
  not a Student-plan feature.

## Alternatives considered

- **Replace MinIO with LocalStack:** rejected because LocalStack does not
  validate secret-access-key values and would weaken existing evidence.
- **Use LocalStack as the public beta:** rejected because the Student plan has no
  hosted sandbox and the local emulator supplies no durable public compute,
  public DNS delegation, or publicly trusted TLS.
- **Emulate more AWS services now:** rejected because the repository has no
  executable dependency on them. Service scope expands only with an accepted
  application or infrastructure decision.
- **Enable a live CI job with the Developer token:** rejected. CI requires a
  separate CI token and protected secret handling.
- **Continue with MinIO alone:** viable but misses AWS-style IAM principal and
  policy-engine behavior that the Student entitlement can exercise.

## Review triggers

Review this decision before adding another emulated service, enabling CI,
persisting emulator state, using Cloud Pods, changing the image pin, targeting
real AWS, or treating an emulator result as deployment evidence. Recheck the
Student plan and authentication terms on every image upgrade.

## References

- [LocalStack plans and Student entitlements](https://docs.localstack.cloud/aws/licensing/)
- [LocalStack Auth Tokens](https://docs.localstack.cloud/aws/getting-started/auth-token/)
- [LocalStack CI integration](https://docs.localstack.cloud/aws/getting-started/ci-cd/)
- [IAM policy enforcement](https://docs.localstack.cloud/aws/developer-tools/security-testing/iam-policy-enforcement/)
- [Credential behavior](https://docs.localstack.cloud/aws/connecting/credentials/)
- [S3 service behavior](https://docs.localstack.cloud/aws/services/s3/)
- [ARM64 support](https://docs.localstack.cloud/aws/customization/advanced/arm64-support/)
- [Usage tracking and `DISABLE_EVENTS`](https://docs.localstack.cloud/aws/customization/advanced/usage-tracking/)
