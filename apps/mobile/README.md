# Mobile client

The development client chooses a platform-safe loopback API address when
`EXPO_PUBLIC_API_URL` is unset: Android Emulator uses `10.0.2.2:4000`, while iOS
Simulator uses `127.0.0.1:4000`. Do not put either loopback value in the shared
root `.env`, because an explicit value overrides that platform selection.

A distributable build must provide a credential-free, non-loopback HTTPS origin
and use the release script:

```sh
EXPO_PUBLIC_API_URL=https://api.example.com pnpm --filter @nutrition-tracker/mobile build:release
```

`release:check` performs the same configuration preflight without exporting the
native bundles. Local HTTP is supported only by the development runtime; a
release never falls back to loopback.
