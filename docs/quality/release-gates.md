# Release Gates

No environment is promoted because a date arrived. A release needs evidence for
every applicable gate and an owner who records the decision.

## Every pull request

- Formatting, lint, workspace-boundary, type, and unit checks pass.
- No committed secret or unreviewed high/critical production dependency advisory.
- Production dependency licenses are on the approved permissive allowlist or
  have a version-bounded exception in `config/license-policy.json` linked to
  `THIRD_PARTY_NOTICES.md`.
- Migrations are forward-only, transactional where PostgreSQL permits it, and
  include a recovery note.
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
- A source cannot publish directly into the active catalogue. Staging, diff,
  approval, atomic activation, and rollback are proven.
- The product renders unknown, trace, imputed, and label-rounded values distinctly.

## Controlled beta

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
- Export, account deletion, backup restore, and search reindex drills pass.
- Signed Android and iOS preview binaries compile from clean native projects and
  pass a device smoke test; a Metro export alone is not native-build evidence.
- Browser and installed-device smoke tests render, navigate, and exercise the
  authenticated and unauthenticated states of every P0 client flow.
- Store identifiers, icons, splash assets, signing ownership, and disclosure
  contact are approved before the first TestFlight/Play upload.
- VoiceOver, TalkBack, keyboard, reduced-motion, and contrast reviews cover every
  P0 flow.
- A dietitian/scientific reviewer signs the equation, DRI, unit, and claims set;
  counsel signs the selected food-data and privacy model.
