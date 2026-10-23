# Native release configuration

Mandatory human reviews and signatures were permanently removed on October 23,
2026. No independent person or enrolled reviewer key is required.

`release-numbering.json` records the package-identifier history and actual native
build versions. Confirm the real App Store and Google Play identifiers and
version history before using them. This is a platform ownership requirement.

`release-deployment.json` remains an unconfirmed production template. Supply the
actual managed deployment and activation observations through the existing
private evidence input. Deployment uses schema v9. The same operator can record
the measurements. Keep canonical JSON, actual timestamps, clean source identity,
exact active Site/deployment IDs, build/runtime and access/restore results.

Native health evidence uses schema v7 with `executedBy`, `executedAt` and
`recordedAt`. It binds all four physical-device/production iOS/Android artifacts
to their actual EAS builds, binary hashes, source, native versions and platform
signing identities. Physical phones, the health matrix, relay and P0 smoke
measurements remain required. Relay and smoke reports use the
`source-and-artifact-bound-measurement` contract.

Human review code and public keys are preserved under
`docs/history/retired-human-review-20261023/`. They are inactive history and must
never be reinstated as release prerequisites. Never store private signing keys,
tokens or health payloads in these files.
