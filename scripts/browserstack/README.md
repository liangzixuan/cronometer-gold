# BrowserStack checks and Appwrite CLI

The `browserstack-web` workflow builds the checked-out commit and tests a temporary synthetic Nourishing stack through BrowserStack Local. It runs on pushes to `codex/retention-features` in `liangzixuan/cronometer-gold`. Forks and pull requests do not receive its secrets. Repository concurrency permits one running session, without cancelling it or retrying a browser session.

One Windows 11 Chrome session signs in normally, searches the real Meilisearch-backed catalogue, adds 1.5 synthetic blueberry servings, reloads the saved diary, checks its 135 kcal entry and the report's entry count, then checks the diary at 390 px. These checks use the real API and PostgreSQL. They do not establish native Android/iOS, full catalogue coverage, accessibility or release acceptance.

## Repository setup

Store `BROWSERSTACK_USERNAME` and `BROWSERSTACK_ACCESS_KEY` as repository Actions secrets. The repository owner confirmed both ready on September 29, 2026; their names were verified without reading values. Secrets enter only the session step, after source/build, image admission and Local binary checks.

The workflow uses GitHub-hosted Ubuntu 24.04 ARM64 and the repository's qualified PostgreSQL and Meilisearch digest pins. It verifies the original image provenance and runs fresh HIGH/CRITICAL scans with an empty ignore file before starting a container. The launcher independently checks the actual digest, architecture, user and runtime contract. Its explicit `ci-qualified-arm64` profile leaves ordinary local image defaults unchanged.

`project.json` pins the official Local ARM archive and executable by size and SHA256. Redirects, changed bytes, extra archive members and the wrong ELF architecture fail. Native version 8.9 and required options must pass before a tunnel starts. The mutable vendor URL is intentional: a future binary change requires a reviewed pin update, never automatic acceptance. No vendor signature or independent binary SBOM verification is claimed.

The BrowserStack native App Automate CLI and BrowserStack Local are different tools. Native CLI 3.0.1 is installed on the development Windows machine; this workflow uses Local for a browser tunnel. It does not build or upload a native app.

## Execution and evidence

The helper records the complete tracked source hashes/modes, Git commit/tree, lockfile hash and Node/pnpm versions. The forced build covers web, API, worker and their dependency closure. The worker supplies the synthetic catalogue search rebuild. Its eight tasks exclude mobile export; the main CI keeps its full build and mobile release checks. The receipt requires every output root in this closure, including worker output, plus the Next build ID. The launcher checks the output digest again before starting services. The public receipt requires all journey assertions, one session, no retries, the actual terminal vendor result and successful owned cleanup. Partial evidence never passes.

Only `127.0.0.1:3287` is exposed through the uniquely named tunnel. API, database and search ports stay outside it. Secure cookies, origin checks and TLS validation remain enabled. Login uses the generated synthetic account; cookies and storage state are not injected or retrieved. Authenticated reload proves persistence, while existing BFF tests cover cookie attributes. The smoke does not claim separate runtime cookie-attribute inspection.

Video, screenshots, network, console and Playwright capture are requested off. Unavoidable vendor command logs use documented `sendType` masking for synthetic credentials. No private nutrition data is involved. Keys and raw output remain in private runner files; errors, capabilities, signed log URLs and credentials are not printed or uploaded. The receipt records artifact URL presence only. Presence is not proof of capture or masking behavior: verify the first actual session in the BrowserStack dashboard before accepting that part of the integration.

Cleanup stops the named tunnel and uses recorded executable/UID/start ticks plus a pidfd for any necessary fallback. The existing launcher stops only its owned applications and containers. Volumes remain until the disposable GitHub runner is destroyed. A missing or failed cleanup receipt fails the job; runner disappearance alone is not cleanup acceptance.

A focused test resolves the actual workflow command with installed Turbo in JSON dry-run mode and checks its tasks and dependency edges against the workspace manifests. Missing or changed worker output and weakened build commands fail. Focused offline contracts run in normal `pnpm check` through `scripts/browserstack.test.mjs`. They cover source/session mismatches, incomplete assertions, private-field redaction, terminal failures, cancellation, ownership and vendor artifacts. The nested Node runner clears `NODE_TEST_CONTEXT` and requires actual test counts, preventing a skipped nested runner from appearing green.

## Appwrite project binding

Root `appwrite.config.json` contains only the public Nourishing project binding. The existing Appwrite CLI 28.1.0 login was verified read-only against project `6abac02e002f10c31ac2`, name Nourishing, NYC endpoint, team `6abac017929bb96d268a`. The September 29 query returned zero Sites. No deployment is implied by this config.

From a directory with the config, use:

```text
appwrite --version
appwrite project get --project-id 6abac02e002f10c31ac2
appwrite sites list
```

Alternatively pass `--config-file` with an accessible copy of this public JSON. On Windows, Appwrite is installed at `C:/Users/zixua/AppData/Roaming/npm/appwrite.cmd`; its existing native credential-store context is required. Do not copy credential files into WSL or the repository. A sandbox credential-store error does not by itself mean the account needs another login.

The native BrowserStack CLI uses `browserstack version` and `browserstack app-automate --help`; it does not support `--version`. Do not run its authenticate or upload commands merely to check installation.

Appwrite hosting integration still requires the real backend and hosting acceptance. This browser workflow does not deploy to Appwrite, change DNS, provision PostgreSQL or consume EAS builds. A decorative Appwrite cloud-read job would not verify the application.

## References

Vendor behavior checked September 29, 2026: [Playwright direct connection](https://www.browserstack.com/docs/automate/playwright/getting-started/nodejs/integrate-your-tests-legacy), [Local options](https://www.browserstack.com/docs/local-testing/binary-params), [credential masking](https://www.browserstack.com/docs/automate/playwright/hide-sensitive-data), [session API](https://www.browserstack.com/docs/automate/api-reference/selenium/session), [Appwrite Next.js hosting](https://appwrite.io/docs/products/sites/quick-start/nextjs). Existing repository image policy and source-specific CI/privacy/restore evidence remain independently required.
