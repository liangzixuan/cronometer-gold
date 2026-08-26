# ADR 0010: Add an attended persistent LocalStack development profile

- Status: Accepted for local implementation; not a deployment target
- Date: 2026-08-25
- Scope: synthetic development state and physical-device API development only

## Context

ADR 0009 added a deliberately ephemeral LocalStack S3/IAM/STS compatibility
fixture. That fixture is appropriate for isolated tests, but it removes its
container and credentials after every run. The API and worker therefore cannot
use it during an ordinary development session, and a retained PostgreSQL
database could otherwise point at artifact state that disappeared on restart.

LocalStack still cannot provide a public beta, a publicly trusted API origin,
off-laptop durability, production storage evidence, or a route from a physical
phone to the API. The default MinIO integration lane also remains necessary
because LocalStack does not validate the supplied secret-access-key value.

## Decision

Add a separate, opt-in LocalStack development Compose project and a guarded
wrapper with these constraints:

1. run the same digest-pinned LocalStack image and only S3, IAM, and STS, with
   hard IAM enforcement and a single gateway published on literal
   `127.0.0.1`;
2. keep no Docker socket, host directory, privileged mode, host network, public
   port, automatic restart, or emulated service outside the application
   dependency set;
3. persist only synthetic emulator state in one dedicated Docker named volume;
   normal shutdown removes the token-bearing container but retains the volume,
   and no convenience command deletes the volume; derive both project and
   volume names from a stable hash of the canonical checkout path so another
   checkout cannot attach to the retained state;
4. require a Developer Auth Token only when starting the service, accept it
   from the environment or a non-echoing interactive prompt, never accept it on
   the command line, and never write it to a repository file, generated runtime
   file, or log;
5. retain the local-Unix-socket, isolated-Docker-configuration, ambient-cloud-
   credential stripping, strict port validation, bounded subprocess, and
   exact-container checks from the ephemeral fixture; use the isolated Docker
   configuration for Compose too, and remove/prove absence of the exact
   token-bearing container after every failed or ambiguous start; require exact
   Compose working-directory/configuration-file labels before container
   mutation and translate TERM/HUP into catchable, signal-masked cleanup;
6. create or verify exactly two private buckets with the existing export and
   erasure-ledger versioning topology and exactly four IAM users with the
   checked-in least-privilege policy documents, except for a LocalStack-only
   restore policy whose sole structural delta removes the `s3:prefix` condition
   from bucket-scoped version listing because the pinned emulator denies the
   conditioned request despite simulating it as allowed; keep object reads
   prefix-scoped and keep the shared production/MinIO policy unchanged;
7. write only the retained gateway port, generated application credentials, and
   loopback service coordinates to mode-`0600` files below a mode-`0700`,
   already ignored `.local-data/localstack` directory; keep restore credentials
   in a separate file that the API and worker development command does not
   load, and reject any conflicting explicit port on later commands;
8. fail closed on unexpected buckets, users, access keys, policy drift,
   version-history drift, missing one-time credential material, symlinks,
   unsafe file modes, cloud/proxy controls in the root `.env`, or an unproven
   IAM rollback instead of repairing or deleting ambiguous state; make status
   an entirely read-only exact-state verification; and
9. keep ADR 0009's one-shot fixture, the MinIO CI lane, and all real-provider
   admission canaries unchanged.

The API and worker continue to run on the host and use the generated loopback
endpoint. The physical phone connects only to an independently authenticated,
publicly trusted HTTPS route whose sole upstream is the API on
`127.0.0.1:4000`. LocalStack, PostgreSQL, Meilisearch, MinIO, and Mailpit are
never routed to the phone. A Metro tunnel is not an API tunnel.

Signed mobile builds still require the checked-in, confirmed real deployment
origin. A local HTTPS relay and this emulator are development aids and cannot
confirm the mobile release deployment record.

## Consequences

- API/worker retention flows can use AWS-style IAM principals over the existing
  hand-written path-style S3 boundary during an attended development session.
- Restarting or recreating the container can retain synthetic encrypted objects
  and IAM state, while normal `down` removes container metadata containing the
  Developer Auth Token.
- Trusted users of the same Docker engine can inspect the running container's
  environment and named volume. The profile is therefore unsuitable for shared
  Docker hosts, real health data, production credentials, or synced backups.
- The generated IAM secret values remain local-only compatibility inputs.
  LocalStack's lack of secret-value validation means MinIO remains the
  authenticated-secret test authority.
- LocalStack license activation and the documented service-side license records
  remain external communications even with client event publishing disabled.

## Alternatives considered

- **Replace MinIO:** rejected because it would remove authenticated-secret
  evidence and silently broaden ADR 0009.
- **Expose LocalStack or the API on the LAN:** rejected because the phone needs
  only a reviewed HTTPS API route and no dependency port.
- **Use ephemeral state for ordinary development:** rejected because retained
  database records could refer to vanished artifact objects after a restart.
- **Store a token in `.env`:** rejected because Compose and application
  processes would retain and inherit a long-lived licensing credential.
- **Add a reset command:** rejected because deleting a named volume is
  destructive and is not necessary for normal operation.

## Review triggers

Review this decision before using non-synthetic data, adding another service,
changing the image pin, enabling automatic restart, changing the loopback bind,
sharing or backing up the volume, accepting a token through another channel,
adding live CI, changing the IAM topology, or treating emulator/relay success as
deployment or signed-release evidence.
