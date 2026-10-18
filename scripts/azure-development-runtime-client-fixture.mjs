import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { rootCertificates } from "node:tls";

// Unsigned parser fixture derived solely from a bundled public key. It has no private key,
// valid signature, chain or trust authority and must never be used by a native TLS service.
const der = (tag, ...items) => {
  const value = Buffer.concat(items);
  const size =
    value.length < 128
      ? Buffer.from([value.length])
      : value.length < 256
        ? Buffer.from([0x81, value.length])
        : Buffer.from([0x82, value.length >> 8, value.length & 255]);
  return Buffer.concat([Buffer.from([tag]), size, value]);
};
export function clientCertificateFixture(options = {}) {
  const publicRoot = rootCertificates
    .map((pem) => new X509Certificate(pem))
    .find((certificate) => certificate.publicKey.asymmetricKeyType === "rsa");
  assert(publicRoot);
  const algorithm = Buffer.from("300d06092a864886f70d01010b0500", "hex");
  const name = (text) =>
    der(0x30, der(0x31, der(0x30, Buffer.from("0603550403", "hex"), der(0x0c, Buffer.from(text)))));
  const host = options.host ?? "dev-api.nourishing.app";
  const tbs = der(
    0x30,
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, Buffer.from([1])),
    algorithm,
    name("Unsigned source parser fixture"),
    der(
      0x30,
      der(0x17, Buffer.from(options.notBefore ?? "260101000000Z")),
      der(0x17, Buffer.from(options.notAfter ?? "360101000000Z")),
    ),
    name(host),
    publicRoot.publicKey.export({ type: "spki", format: "der" }),
    der(
      0xa3,
      der(
        0x30,
        der(
          0x30,
          Buffer.from("0603551d11", "hex"),
          der(0x04, der(0x30, der(0x82, Buffer.from(host)))),
        ),
      ),
    ),
  );
  const raw = der(0x30, tbs, algorithm, der(0x03, Buffer.alloc(257)));
  const pem = `-----BEGIN CERTIFICATE-----\n${raw
    .toString("base64")
    .match(/.{1,64}/gu)
    .join("\n")}\n-----END CERTIFICATE-----\n`;
  const certificate = new X509Certificate(pem);
  assert.equal(certificate.verify(publicRoot.publicKey), false);
  assert.equal(certificate.ca, false);
  return pem;
}
