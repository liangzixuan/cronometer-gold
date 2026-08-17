import { constants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, parse, resolve } from "node:path";
import process from "node:process";
import { TextDecoder } from "node:util";

const MAX_OCI_API_PRIVATE_KEY_BYTES = 16_384;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

function safeAbsoluteFilePath(value: string): string {
  if (!isAbsolute(value) || resolve(value) !== value || value === parse(value).root) {
    throw new Error("OCI API signing key path must be a safe absolute file path");
  }
  return value;
}

function assertPrivateKeyFileMetadata(details: Stats): void {
  const currentUid = process.getuid?.();
  const permissions = details.mode & 0o777;
  if (
    !details.isFile() ||
    details.isSymbolicLink() ||
    (details.uid !== 0 && (currentUid === undefined || details.uid !== currentUid)) ||
    (permissions !== 0o400 && permissions !== 0o600) ||
    details.size < 1 ||
    details.size > MAX_OCI_API_PRIVATE_KEY_BYTES
  ) {
    throw new Error("OCI API signing key file is not a bounded owner-only regular file");
  }
}

/** Reads the restore-only OCI API key without following the final path component. */
export async function loadOciApiSigningPrivateKey(path: string): Promise<string> {
  const safePath = safeAbsoluteFilePath(path);
  const pathDetails = await lstat(safePath);
  assertPrivateKeyFileMetadata(pathDetails);
  const handle = await open(safePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const openedDetails = await handle.stat();
    assertPrivateKeyFileMetadata(openedDetails);
    if (openedDetails.dev !== pathDetails.dev || openedDetails.ino !== pathDetails.ino) {
      throw new Error("OCI API signing key file changed while it was opened");
    }
    const bytes = await handle.readFile();
    const finalDetails = await handle.stat();
    assertPrivateKeyFileMetadata(finalDetails);
    if (
      finalDetails.dev !== openedDetails.dev ||
      finalDetails.ino !== openedDetails.ino ||
      finalDetails.size !== openedDetails.size ||
      bytes.byteLength !== finalDetails.size
    ) {
      throw new Error("OCI API signing key file changed while it was read");
    }
    try {
      return UTF8_DECODER.decode(bytes);
    } catch {
      throw new Error("OCI API signing key file is not valid UTF-8");
    }
  } finally {
    await handle.close();
  }
}
