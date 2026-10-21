import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

// Public verification vectors derived from digitalbazaar/forge PR #1152.
// No private key or live credential is needed to test the installed consumers.
const vector = JSON.parse(
  readFileSync(new URL("./fixtures/node-forge-rsa-verification.json", import.meta.url), "utf8"),
);
const mobile = createRequire(new URL("../apps/mobile/package.json", import.meta.url));
const expo = createRequire(mobile.resolve("expo/package.json"));
const cli = createRequire(expo.resolve("@expo/cli/package.json"));
const certificates = createRequire(cli.resolve("@expo/code-signing-certificates/package.json"));

for (const [consumer, require] of [
  ["Expo CLI", cli],
  ["Expo signing certificates", certificates],
]) {
  const forge = require("node-forge");
  const key = forge.pki.rsa.setPublicKey(
    new forge.jsbn.BigInteger(vector.publicModulusHex, 16),
    new forge.jsbn.BigInteger(vector.publicExponent),
  );
  function verify(signature) {
    const digest = forge.md.sha256.create();
    digest.update(vector.message);
    return key.verify(digest.digest().getBytes(), forge.util.hexToBytes(signature));
  }
  test(`${consumer} rejects extra nested DigestAlgorithm elements`, () => {
    assert.throws(() => verify(vector.signatureHex), /valid RSASSA-PKCS1-v1_5 DigestInfo/);
  });
  for (const control of vector.validControls) {
    test(`${consumer} accepts ${control.name}`, () => {
      assert.equal(verify(control.signatureHex), true);
    });
  }
}
