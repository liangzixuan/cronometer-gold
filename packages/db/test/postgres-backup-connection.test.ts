import { rootCertificates } from "node:tls";
import { afterEach, expect, it, vi } from "vitest";

import {
  normalizePostgresBackupConnection,
  type PostgresBackupConnection,
  type PostgresBackupConnectionInput,
  postgresBackupClientConfig,
  postgresBackupLibpqEnvironment,
  postgresBackupPasswordFile,
} from "../src/postgres-backup-connection.js";

const ca = rootCertificates[0] ?? "";
const input = {
  connectionString: "postgresql://backup:synthetic@database.test/nutrition",
  caCertificate: ca,
};
afterEach(() => vi.unstubAllEnvs());

it("uses one frozen connection for explicit pg and libpq settings", () => {
  vi.stubEnv("PGHOST", "ambient.invalid");
  vi.stubEnv("PGPORT", "not-a-port");
  vi.stubEnv("PGPASSWORD", "ambient");
  vi.stubEnv("PGSERVICE", "ambient");
  vi.stubEnv("OPENSSL_CONF", "/ambient");
  const connection = normalizePostgresBackupConnection(input);
  expect(Object.isFrozen(connection)).toBe(true);
  const pg = postgresBackupClientConfig(connection);
  const env = postgresBackupLibpqEnvironment(connection, "/private/backup");
  expect(pg).toMatchObject({
    host: "database.test",
    port: 5432,
    database: "nutrition",
    user: "backup",
    password: "synthetic",
    ssl: { ca: connection.caCertificate, rejectUnauthorized: true },
  });
  expect(pg).not.toHaveProperty("connectionString");
  expect(env).toMatchObject({
    PGHOST: pg.host,
    PGPORT: String(pg.port),
    PGUSER: pg.user,
    PGDATABASE: pg.database,
    PGSSLMODE: "verify-full",
    PGGSSENCMODE: "disable",
    PGSSLROOTCERT: "/private/backup/root.crt",
    HOME: "/private/backup",
    PGSSLCERT: "/private/backup/no-client.crt",
  });
  expect(env).not.toHaveProperty("PGPASSWORD");
  expect(env).not.toHaveProperty("PGSERVICE");
  expect(env).not.toHaveProperty("OPENSSL_CONF");
  expect(env).not.toHaveProperty("SSL_CERT_FILE");
  expect(connection.caCertificate).toBe(ca.trim() + "\n");
});

it("decodes once and escapes colon and backslash in pgpass without changing credentials", () => {
  const connection = normalizePostgresBackupConnection({
    ...input,
    connectionString: "postgresql://back%3Aup:p%3Aa%5Css%25word@database.test:5544/nutrition",
  });
  expect(postgresBackupClientConfig(connection)).toMatchObject({
    user: "back:up",
    password: "p:a\\ss%word",
    port: 5544,
  });
  expect(postgresBackupPasswordFile(connection)).toBe(
    "database.test:5544:nutrition:back\\:up:p\\:a\\\\ss%word\n",
  );
});

for (const host of ["127.0.0.1", "[::1]", "[0:0:0:0:0:0:0:1]"]) {
  it("permits explicit loopback-only disabled TLS " + host, () => {
    const value = normalizePostgresBackupConnection({
      connectionString: "postgresql://backup:synthetic@" + host + "/nutrition",
      sslMode: "disable",
    });
    expect(postgresBackupClientConfig(value).ssl).toBe(false);
    expect(postgresBackupLibpqEnvironment(value, "/private").PGSSLMODE).toBe("disable");
  });
}

for (const connectionString of [
  "not a URL",
  "https://backup:synthetic@database.test/nutrition",
  "postgresql://backup:synthetic@database.test/nutrition?",
  "postgresql://backup:synthetic@database.test/nutrition#",
  "postgresql://backup:synthetic@database.test/nutrition?sslmode=disable",
  "postgresql://backup:synthetic@/nutrition",
  "postgresql://backup:synthetic@%2fvar%2frun/nutrition",
  "postgresql://backup:synthetic@host1,host2/nutrition",
  "postgresql://backup:synthetic@127.1/nutrition",
  "postgresql://backup:synthetic@2130706433/nutrition",
  "postgresql://backup:synthetic@database.test:0/nutrition",
  "postgresql://backup:synthetic@database.test:65536/nutrition",
  "postgresql://backup:synthetic@database.test/nutrition/other",
  "postgresql://backup:synthetic@database.test/nutrition%2Fother",
  "postgresql://backup:synthetic@database.test/nutrition%00",
  "postgresql://backup:%00@database.test/nutrition",
  "postgresql://backup:%0a@database.test/nutrition",
  "postgresql://backup:%0d@database.test/nutrition",
  "postgresql://backup:%zz@database.test/nutrition",
  "postgresql://backup:%C0%AF@database.test/nutrition",
  "postgresql://backup@database.test/nutrition",
  "postgresql://:synthetic@database.test/nutrition",
  " postgres://backup:synthetic@database.test/nutrition",
]) {
  it("rejects ambiguous or unsafe connection " + connectionString, () => {
    expect(() => normalizePostgresBackupConnection({ ...input, connectionString })).toThrow(
      "Invalid PostgreSQL backup connection",
    );
  });
}

for (const change of [
  { caCertificate: undefined },
  { caCertificate: "" },
  { caCertificate: "not PEM" },
  { caCertificate: ca + " trailing content" },
  { caCertificate: ca.repeat(100) },
  { caCertificate: ca.replace("M", "!") },
  { sslMode: "require" },
  { sslMode: "disable" },
  { ssl: { rejectUnauthorized: false } },
]) {
  it("rejects missing or ambiguous TLS material " + Object.keys(change).join(","), () => {
    expect(() =>
      normalizePostgresBackupConnection({ ...input, ...change } as PostgresBackupConnectionInput),
    ).toThrow("Invalid PostgreSQL backup connection");
  });
}

it("rejects fabricated or copied admission records", () => {
  const actual = normalizePostgresBackupConnection(input);
  expect(() => postgresBackupClientConfig({ ...actual })).toThrow();
  expect(() => postgresBackupClientConfig({} as PostgresBackupConnection)).toThrow();
});

it("rejects process-wide TLS disablement at normalization and at use", () => {
  const actual = normalizePostgresBackupConnection(input);
  vi.stubEnv("NODE_TLS_REJECT_UNAUTHORIZED", "0");
  expect(() => normalizePostgresBackupConnection(input)).toThrow();
  expect(() => postgresBackupClientConfig(actual)).toThrow();
});

for (const host of ["192.0.2.1", "127.0.0.1", "[2001:db8::1]", "[::1]"]) {
  it("rejects literal IP verified TLS identity " + host, () => {
    expect(() =>
      normalizePostgresBackupConnection({
        ...input,
        connectionString: "postgresql://backup:synthetic@" + host + "/nutrition",
      }),
    ).toThrow("Invalid PostgreSQL backup connection");
  });
}
