# Temporary Security Risk Acceptances

Exceptions are narrow, dated, and removable. They do not permit ignoring a
different advisory with the same package or severity.

## Metro `image-size` denial of service

- **Advisories:** GHSA-w3rx-r6r6-pgpr and GHSA-5p2g-fcmc-qvqq
- **Observed:** 2026-08-15
- **Review/expiry:** 2026-09-15 or immediately when a compatible patched release
  is available
- **Path:** Expo 57 / React Native 0.86.2 → Metro 0.84.4 → `image-size` 1.2.1
- **Reason a direct upgrade is unavailable:** the advisory declares 2.0.3 as the
  first patched version, but the public npm registry's newest release was 2.0.2
  at review time. Metro also requests the 1.x API.
- **Exposure:** Metro reads developer-controlled repository assets during a
  client build. The parser is not reachable from the production API or from
  user-uploaded content.
- **Controls:** only reviewed repository assets enter Metro; CI build jobs have
  a 20-minute timeout; food images and user uploads never enter the application
  source tree; dependency audit ignores only the two advisory IDs above; the
  exception is reviewed on each Expo/Metro update.
- **Exit:** upgrade Expo/Metro to a compatible release that resolves to a patched
  `image-size`, remove this entry, and restore a clean audit without the
  unfixable exception.

The audit command names these two GHSAs explicitly because the registry has no
compatible patched artifact today. Every other high or critical advisory still
fails the release gate.
