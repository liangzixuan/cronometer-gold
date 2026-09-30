import { X509Certificate } from "node:crypto";
import { isIP } from "node:net";

import type { ClientConfig } from "pg";

export interface PostgresBackupConnectionInput {
  readonly connectionString: string;
  readonly sslMode?: "verify-full" | "disable";
  readonly caCertificate?: string;
}

export interface PostgresBackupConnection {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: string;
  readonly sslMode: "verify-full" | "disable";
  readonly caCertificate: string;
}

export class PostgresBackupConnectionError extends Error {
  constructor() {
    super("Invalid PostgreSQL backup connection");
    this.name = "PostgresBackupConnectionError";
  }
}

const admitted = new WeakSet<PostgresBackupConnection>();
const invalid = () => new PostgresBackupConnectionError();
function hasControl(value: string, includeSpace = true): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= (includeSpace ? 32 : 31) || (code >= 127 && code <= 159)) return true;
  }
  return false;
}

function certificateBundle(value: unknown): string {
  if (typeof value !== "string" || Buffer.byteLength(value) > 65_536) throw invalid();
  const pattern = /-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----/gu;
  const certificates = [...value.matchAll(pattern)].map((match) => match[0]);
  if (
    certificates.length < 1 ||
    certificates.length > 16 ||
    value.replace(pattern, "").trim() !== ""
  )
    throw invalid();
  try {
    for (const certificate of certificates) {
      if (!new X509Certificate(certificate).ca) throw invalid();
    }
  } catch {
    throw invalid();
  }
  return certificates.map((value) => value.replaceAll("\r\n", "\n") + "\n").join("");
}

export function normalizePostgresBackupConnection(
  input: PostgresBackupConnectionInput,
): PostgresBackupConnection {
  if (
    !input ||
    typeof input !== "object" ||
    Object.keys(input).some(
      (key) => !["connectionString", "sslMode", "caCertificate"].includes(key),
    ) ||
    typeof input.connectionString !== "string" ||
    input.connectionString.length > 8192 ||
    hasControl(input.connectionString) ||
    /%(?![0-9a-f]{2})/iu.test(input.connectionString) ||
    process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0"
  )
    throw invalid();
  let url: URL;
  let user: string, password: string, database: string;
  try {
    url = new URL(input.connectionString);
    user = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
    database = decodeURIComponent(url.pathname.slice(1));
  } catch {
    throw invalid();
  }
  const host = url.hostname.startsWith("[")
    ? new URL("http://" + url.hostname).hostname.slice(1, -1)
    : url.hostname.toLowerCase();
  const port = url.port === "" ? 5432 : Number(url.port);
  const dns =
    /^(?=.{1,253}$)(?=.*[a-z])[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/u;
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    url.search !== "" ||
    url.hash !== "" ||
    input.connectionString.includes("?") ||
    input.connectionString.includes("#") ||
    (!isIP(host) && !dns.test(host)) ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !/^[a-z_][a-z0-9_]{0,62}$/u.test(database) ||
    user.length === 0 ||
    Buffer.byteLength(user) > 63 ||
    hasControl(user) ||
    password.length === 0 ||
    Buffer.byteLength(password) > 1024 ||
    hasControl(password, false)
  )
    throw invalid();
  const sslMode = input.sslMode ?? "verify-full";
  if (sslMode !== "verify-full" && !(sslMode === "disable" && ["127.0.0.1", "::1"].includes(host)))
    throw invalid();
  if (sslMode === "verify-full" && isIP(host)) throw invalid();
  const caCertificate = sslMode === "verify-full" ? certificateBundle(input.caCertificate) : "";
  if (sslMode === "disable" && input.caCertificate !== undefined) throw invalid();
  const value = Object.freeze({ host, port, database, user, password, sslMode, caCertificate });
  admitted.add(value);
  return value;
}

/** Admission means normalized input only; it is not host/runtime qualification. */
export function postgresBackupClientConfig(connection: PostgresBackupConnection): ClientConfig {
  if (!admitted.has(connection) || process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0")
    throw invalid();
  return {
    host: connection.host,
    port: connection.port,
    database: connection.database,
    user: connection.user,
    password: connection.password,
    ssl:
      connection.sslMode === "verify-full"
        ? {
            ca: connection.caCertificate,
            rejectUnauthorized: true,
            minVersion: "TLSv1.2",
            maxVersion: "TLSv1.3",
          }
        : false,
  };
}

export function postgresBackupPasswordFile(connection: PostgresBackupConnection): string {
  postgresBackupClientConfig(connection);
  const escapeField = (value: string) => value.replaceAll("\\", "\\\\").replaceAll(":", "\\:");
  return (
    [
      connection.host,
      String(connection.port),
      connection.database,
      connection.user,
      connection.password,
    ]
      .map(escapeField)
      .join(":") + "\n"
  );
}

/** Creates the entire environment; no ambient process variables are copied. */
export function postgresBackupLibpqEnvironment(
  connection: PostgresBackupConnection,
  privateDirectory: string,
): Readonly<Record<string, string>> {
  postgresBackupClientConfig(connection);
  if (!privateDirectory.startsWith("/") || hasControl(privateDirectory, false)) throw invalid();
  return Object.freeze({
    PATH: "/usr/bin:/bin",
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
    HOME: privateDirectory,
    TMPDIR: privateDirectory,
    PGHOST: connection.host,
    PGPORT: String(connection.port),
    PGDATABASE: connection.database,
    PGUSER: connection.user,
    PGPASSFILE: privateDirectory + "/pgpass",
    PGSSLMODE: connection.sslMode,
    PGSSLROOTCERT: privateDirectory + "/root.crt",
    PGSSLCERT: privateDirectory + "/no-client.crt",
    PGSSLKEY: privateDirectory + "/no-client.key",
    PGGSSENCMODE: "disable",
    PGSSLMINPROTOCOLVERSION: "TLSv1.2",
    PGSSLMAXPROTOCOLVERSION: "TLSv1.3",
    PGCONNECT_TIMEOUT: "5",
    PGAPPNAME: "nutrition-postgres-backup",
    PGCLIENTENCODING: "UTF8",
  });
}
