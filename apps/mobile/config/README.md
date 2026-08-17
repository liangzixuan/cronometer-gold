# Signed-device reviewer trust

`health-release-reviewers.json` is the production trust root for the external
physical-device evidence gate. It is populated only through reviewed public-key
changes, so no build can self-assert release readiness.

Key rotation is a reviewed code change: add the new Ed25519 SPKI public key with
a non-overlapping key ID and bounded validity interval, obtain independent
approval, then remove the old key only after every manifest signed during its
validity window has expired. Never store a private key, test result, health
sample, device identifier, cursor, token, or signature fixture in this folder.
The release manifest is signed outside ordinary CI and pins separate IPA and AAB
digests and build IDs to one Git commit.
