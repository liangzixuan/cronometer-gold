# Release Gates

No environment is promoted because a date arrived. A release needs evidence for
every applicable gate and an owner who records the decision.

## Every pull request

- Formatting, lint, workspace-boundary, type, and unit checks pass.
- Every checked-in food-source candidate/example compiles under the strict
  JSON Schema gate, agrees with the ingestion runtime parser, and remains an
  intentionally non-import-ready template.
- No committed secret or unreviewed high/critical production dependency advisory.
- Production dependency licenses are on the approved permissive allowlist or
  have a version-bounded exception in `config/license-policy.json` linked to
  `THIRD_PARTY_NOTICES.md`.
- Migrations are forward-only, transactional where PostgreSQL permits it, and
  include a recovery note.
- Runtime readiness fails closed when the database migration ledger is missing a
  bundled migration or its SHA-256 disagrees; connectivity alone is not schema
  readiness.
- Logs and telemetry contain no food diary, biometric, token, or free-text note
  payload.

The AST workspace-boundary check is a fast convention guard, not a security
sandbox. It detects direct forbidden imports and direct environment/network
global access; review still rejects alias-based or computed attempts to bypass
package boundaries.

## Food-data release

- Source manifest has URL, release identifier, retrieval timestamp, checksum,
  rights classification, attribution, and reviewer.
- Import from the pinned raw artifact is deterministic and reports accepted,
  rejected, quarantined, and missing-nutrient counts.
- A source cannot publish directly into the active catalogue. Staging, validation,
  three-role digest-bound approval, atomic activation, and pointer-only rollback
  are proven by the PostgreSQL integration gate, including an unchanged historical
  diary nutrient snapshot.
- The product renders unknown, trace, imputed, and label-rounded values distinctly.

## Controlled beta

- API, worker, migrator, web, Caddy, and PostgreSQL `linux/arm64` images are built
  from the release commit, pass the fail-closed HIGH/CRITICAL vulnerability gate,
  carry SBOM and provenance attestations, and are deployed by recorded digest.
  The independently locked Meilisearch image must pass the same current scan and
  its upstream-signature gate, as described in
  [the container supply-chain runbook](./container-supply-chain.md).
- The reviewer-signed deployment record binds distinct exact canonical reports,
  not opaque result hashes. The external report proves fresh public-chain,
  hostname, certificate-lifetime, and exact `/ready` routing for the signed
  origin/commit. The access report carries the independent reviewer's signed
  assertion that the sensitive live policy contained exactly one globally
  routable unicast IPv4 `/32`, plus the canonical policy-artifact digest claimed
  unchanged across approved-readiness and blocked-unapproved-source probes. The
  redacted report stores neither source address; the verifier validates the exact
  assertion and signature but cannot derive routability from the redacted data.
- Every profile, diary, biometric, report, and integration route enforces a
  server-side session/ownership check; unauthenticated and cross-user access
  tests fail closed.
- Authenticated web routes use a nonce- or hash-based Content Security Policy;
  the foundation shell's temporary `script-src 'unsafe-inline'` policy is not a
  sufficient XSS boundary for personal data.
- At least 1,000 reviewed query-country relevance cases pass the agreed top-five
  threshold, with a 200-case set running on every ranking change.
- Each launch market has a stratified sample of at least 1,000 known GTINs; exact
  match is at least 85%, with the Wilson lower bound at least 82%.
- Core generic foods meet the agreed nutrient-completeness definition at least
  90% of the time.
- Offline mutation retry/reorder simulations create no duplicate diary entry.
- Recipe revisions preserve exact food/nested-recipe dependencies, reject cycles
  and depth overflow, and retain source attribution plus trace/unknown coverage
  through an exact diary log.
- Recipe and goal retries reuse the same operation ID and canonical request;
  ambiguous responses, concurrent revisions, and profile changes cannot create a
  duplicate or silently select a newer version.
- Derived energy targets reproduce the reviewed Mifflin–St Jeor and PAL golden
  cases, fail closed outside the supported adult/profile boundary, identify
  every input and source, and never add ordinary exercise twice.
- Goal progress proves lower-bound semantics with incomplete nutrient panels and
  never labels an unknown contribution as measured zero or exact completion.
- Export, account deletion, backup restore, and search reindex drills pass.
- Signed internal Android APK and iOS IPA binaries compile from one clean commit
  and pass the physical-device matrix. A reviewer-signed manifest separately
  binds the exact production Android AAB and iOS IPA from that commit by EAS
  build ID, native version, signing identity, and SHA-256; same-source binaries
  are not presumed byte-equivalent. All four paths, actual digests, and available
  filesystem identities are distinct, with symbolic links rejected. The
  manifest app version and both platforms' native build versions exactly match
  the source-controlled app config and confirmed release-numbering record;
  unconfirmed package-identifier history cannot clear signed-device evidence.
  The
  independent reviewer compares claimed build/signing metadata with EAS and
  platform-tool output because archive hashing alone does not extract it; a
  Metro export is not native evidence.
- Every signed EAS binary is produced by the pinned Expo project on the EAS
  cloud runner. Post-install checks reject absent or malformed build IDs,
  platforms, profiles, and commit hashes before invoking a release script; a
  local EAS build cannot substitute for this provenance.
- The signed physical-device manifest pins the exact private `.ts.net` API
  origin and exact canonical relay-report bytes. That report proves attended
  first-connect Shields Up, empty initial Serve/Funnel, verified identities and
  policy-before-access sequencing, foreground Serve on HTTPS/443 to
  `127.0.0.1:4000`, Funnel disabled, one tested two-phone policy with no
  overlapping grant, both alias/EAS-build-bound `/ready` probes, all inventoried
  non-443 listeners blocked, unapproved/off-tailnet denial, and timed clean
  teardown/disconnect. A generic public HTTPS URL or opaque report hash does not
  clear this gate.
- Browser and installed-device smoke tests render, navigate, and exercise the
  authenticated and unauthenticated states of every P0 client flow.
- Store identifiers, icons, splash assets, signing ownership, and disclosure
  contact are approved before the first TestFlight/Play upload.
- VoiceOver, TalkBack, keyboard, reduced-motion, and contrast reviews cover every
  P0 flow.
- A dietitian/scientific reviewer signs the equation, DRI, unit, and claims set;
  counsel signs the selected food-data and privacy model.
