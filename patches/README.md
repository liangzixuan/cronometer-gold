# Dependency patches

## node-forge 1.4.0

`node-forge@1.4.0.patch` backports the nested DigestAlgorithm element-count
check from [digitalbazaar/forge PR #1152](https://github.com/digitalbazaar/forge/pull/1152),
head `ceba34402e329f0365134f23fe19898756527d65`. The proposal was open when
reviewed on October 21, 2026. This is a local backport, not an upstream release.

The pnpm workspace entry and lockfile bind the patch to both Expo consumers.
The package version, registry integrity and upstream license remain unchanged.
The patch changes only `lib/rsa.js` and retains the existing outer element check.

Run `node --test scripts/node-forge-rsa.test.mjs` after a frozen install.
It uses the installed Expo CLI and signing-certificate dependencies with public
verification vectors from the upstream test. The malformed signature must fail
with normal padding checks. Valid SHA-256 signatures with NULL and absent
parameters must pass. No private key is stored or required.

This verifies the reproduced nested-element defect. It does not qualify all RSA
or ASN.1 behavior, including the pre-existing treatment of NULL parameter
contents. The audit can still flag version 1.4.0. Audit results and release
requirements remain in force. Remove the backport only after a maintained
release passes the regression and affected Expo checks.

## braces 3.0.3

`braces@3.0.3.patch` adds a fixed limit of 128 nested brace or parenthesis
containers to the existing parser. The original library overflows its stack when
compiling or expanding a 9,999-character nested pattern, within its existing
10,000-character allowance. The guard rejects excess nesting with `SyntaxError`
before recursive processing. Flat patterns retain the full character allowance.
This is a local bounded repair, not an upstream release or general protection
against expensive glob expressions.

Run `node --test scripts/braces-depth.test.mjs` after a frozen install. It checks
the installed Metro/micromatch path, compile/expand/stringify, the depth boundary,
and ordinary alternatives/ranges. The limit applies to parsed string input;
arbitrary hand-built AST objects are outside this repair. The original version
and license remain unchanged, and the audit may still report version 3.0.3.
