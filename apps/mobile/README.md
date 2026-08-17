# Mobile client

The development client chooses a platform-safe loopback API address when
`EXPO_PUBLIC_API_URL` is unset: Android Emulator uses `10.0.2.2:4000`, while iOS
Simulator uses `127.0.0.1:4000`. Do not put either loopback value in the shared
root `.env`, because an explicit value overrides that platform selection.

A distributable build must provide a credential-free, non-loopback HTTPS origin
and use the release script:

```sh
EXPO_PUBLIC_API_URL="$DEPLOYED_OCI_API_ORIGIN" pnpm --filter @nutrition-tracker/mobile build:release
```

Set `DEPLOYED_OCI_API_ORIGIN` from the verified deployment output; do not use a
documentation or loopback hostname.

`release:check` performs the same configuration preflight without exporting the
native bundles. Local HTTP is supported only by the development runtime; a
release never falls back to loopback.

## Signed EAS releases

The app is linked to the personal EAS project
[`@zixuanliang/nutrition-tracker`](https://expo.dev/accounts/zixuanliang/projects/nutrition-tracker).
Run EAS commands from this directory. `eas.json` pins EAS CLI 22.0.0, Node
22.13.0, pnpm 11.19.0, source-controlled app versions, and the production store
outputs: an iOS device IPA and an Android app bundle.

The production profile deliberately contains no API placeholder. After the OCI
origin exists and passes its release checks, set
`config/release-deployment.json` to `ociDeploymentConfirmed: true` and record its
canonical HTTPS origin. Then create a **plaintext**, project-level
`EXPO_PUBLIC_API_URL` variable in the EAS `production` environment with that
exact value. The value is public client configuration, not a secret. A mandatory
EAS post-install hook runs `release:check`; an absent, unsafe, or mismatched
origin therefore stops the job before native compilation.

CI reads the same public origin from the GitHub repository variable
`EXPO_PUBLIC_API_URL`. While identifier history is unconfirmed, CI instead
requires the release check to fail at that exact gate. If numbering is confirmed
first, it requires the exact unconfirmed-deployment blocker instead. Only after
both records are confirmed does the CI step require the real variable, verify it
equals the checked-in OCI origin, and run the full release preflight and export;
it has no placeholder or bypass origin.

Before starting a paid or quota-consuming build, validate the linked profile:

```sh
eas config --platform ios --profile production
eas config --platform android --profile production
```

Do not run `eas build` until the package identifiers and existing Apple/Google
signing history have been confirmed. `config/release-numbering.json` records
that decision and remains false with null build numbers by default. The release
check requires the confirmation to be true and requires explicit
`ios.buildNumber` and `android.versionCode` values in `app.json` that exactly
match the record; implicit toolchain defaults cannot reach a signed build. The
checked-in health-reviewer public key authenticates independent physical-device
evidence; it is not an app-signing credential.
