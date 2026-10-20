import {
  HOSTED_DEVELOPMENT_PROFILE,
  HOSTED_DEVELOPMENT_WEB_ORIGIN,
} from "@nutrition-tracker/contracts";
import { MAX_PRIVACY_EXPORT_SNAPSHOT_BYTES } from "@nutrition-tracker/db";
import { describe, expect, it } from "vitest";
import { ConfigValidationError, loadApiDependencyConfig, loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("applies safe local defaults", () => {
    expect(loadConfig({})).toEqual({
      apiHost: "127.0.0.1",
      apiPort: 3_001,
      logLevel: "info",
      nodeEnv: "development",
      readinessTimeoutMs: 2_000,
      shutdownGraceMs: 10_000,
    });
  });

  it("coerces validated numeric environment values", () => {
    expect(
      loadConfig({
        API_PORT: "4100",
        READINESS_TIMEOUT_MS: "1500",
        SHUTDOWN_GRACE_MS: "25000",
      }),
    ).toMatchObject({
      apiPort: 4_100,
      readinessTimeoutMs: 1_500,
      shutdownGraceMs: 25_000,
    });
  });

  it("fails fast without including invalid values in the error message", () => {
    const invalidPort = "not-a-port-that-must-not-leak";

    expect(() => loadConfig({ API_PORT: invalidPort })).toThrow(ConfigValidationError);

    try {
      loadConfig({ API_PORT: invalidPort });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect((error as ConfigValidationError).issues).toEqual([
        expect.objectContaining({ field: "API_PORT" }),
      ]);
      expect((error as Error).message).not.toContain(invalidPort);
    }
  });
});

describe("hosted development captured email", () => {
  const environment: NodeJS.ProcessEnv = {
    DATABASE_URL: "postgresql://synthetic.invalid/nutrition",
    NOURISHING_API_PROFILE: HOSTED_DEVELOPMENT_PROFILE,
    NODE_ENV: "development",
    SMTP_FROM: "Nourishing Development <no-reply@example.invalid>",
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: "1025",
    EMAIL_VERIFICATION_PUBLIC_ORIGIN: HOSTED_DEVELOPMENT_WEB_ORIGIN,
    PASSWORD_RECOVERY_PUBLIC_ORIGIN: HOSTED_DEVELOPMENT_WEB_ORIGIN,
  };

  it("selects the exact HTTPS origin while retaining loopback captured SMTP", () => {
    expect(loadApiDependencyConfig(environment).emailVerification).toEqual({
      transport: "smtp",
      profile: HOSTED_DEVELOPMENT_PROFILE,
      from: environment.SMTP_FROM,
      host: "127.0.0.1",
      nodeEnv: "development",
      port: 1025,
      publicOrigin: HOSTED_DEVELOPMENT_WEB_ORIGIN,
      passwordRecoveryPublicOrigin: HOSTED_DEVELOPMENT_WEB_ORIGIN,
      timeoutMs: 5_000,
    });
  });

  it.each<[string, NodeJS.ProcessEnv]>([
    ["unknown profile", { NOURISHING_API_PROFILE: "production" }],
    ["blank profile", { NOURISHING_API_PROFILE: "" }],
    ["unselected HTTPS origins", { NOURISHING_API_PROFILE: undefined }],
    ["production mode", { NODE_ENV: "production" }],
    ["test mode", { NODE_ENV: "test" }],
    ["missing mode", { NODE_ENV: undefined }],
    ["private SMTP hostname", { SMTP_HOST: "mailpit" }],
    ["localhost SMTP hostname", { SMTP_HOST: "localhost" }],
    ["foreign SMTP port", { SMTP_PORT: "2525" }],
    ["unsafe sender", { SMTP_FROM: "safe@example.invalid\r\nBcc: other@example.invalid" }],
    ["short timeout", { SMTP_TIMEOUT_MS: "99" }],
    ["long timeout", { SMTP_TIMEOUT_MS: "10001" }],
  ])("rejects %s", (_label, overrides) => {
    expect(() => loadApiDependencyConfig({ ...environment, ...overrides })).toThrow(
      ConfigValidationError,
    );
  });

  it.each([
    "NOURISHING_API_PROFILE",
    "NODE_ENV",
    "SMTP_HOST",
    "SMTP_PORT",
    "SMTP_FROM",
    "EMAIL_VERIFICATION_PUBLIC_ORIGIN",
    "PASSWORD_RECOVERY_PUBLIC_ORIGIN",
  ])("rejects an inherited %s", (field) => {
    const input = { ...environment };
    delete input[field];
    Object.setPrototypeOf(input, { [field]: environment[field] });
    expect(() => loadApiDependencyConfig(input)).toThrow(ConfigValidationError);
  });

  it.each([
    "SMTP_HOST",
    "SMTP_PORT",
    "SMTP_FROM",
    "EMAIL_VERIFICATION_PUBLIC_ORIGIN",
    "PASSWORD_RECOVERY_PUBLIC_ORIGIN",
  ])("requires explicit %s", (field) => {
    const input = { ...environment };
    delete input[field];
    expect(() => loadApiDependencyConfig(input)).toThrow(ConfigValidationError);
  });

  it.each([
    "",
    "http://localhost:3443",
    "https://127.0.0.1:3443",
    "https://localhost",
    "https://localhost:3444",
    "https://localhost:3443/",
    "https://localhost:3443/verify-email",
    "https://localhost:3443?next=/diary",
    "https://localhost:3443#token=invalid",
    "https://user:password@localhost:3443",
    "https://LOCALHOST:3443",
    "https://localhost:3443.example.invalid",
  ])("rejects a nonexact origin %s for either flow", (origin) => {
    for (const field of ["EMAIL_VERIFICATION_PUBLIC_ORIGIN", "PASSWORD_RECOVERY_PUBLIC_ORIGIN"]) {
      expect(() => loadApiDependencyConfig({ ...environment, [field]: origin })).toThrow(
        ConfigValidationError,
      );
    }
  });

  it("does not silently disable email when only the hosted profile is selected", () => {
    expect(() =>
      loadApiDependencyConfig({
        DATABASE_URL: environment.DATABASE_URL,
        NOURISHING_API_PROFILE: HOSTED_DEVELOPMENT_PROFILE,
        NODE_ENV: "development",
      }),
    ).toThrow(ConfigValidationError);
  });
});

describe("loadApiDependencyConfig", () => {
  it("uses loopback search defaults only outside production", () => {
    expect(
      loadApiDependencyConfig({
        DATABASE_URL: "postgresql://local.invalid/nutrition",
        NODE_ENV: "development",
      }),
    ).toMatchObject({
      databaseRestoreEpoch: null,
      databaseUrl: "postgresql://local.invalid/nutrition",
      meiliUrl: "http://127.0.0.1:7700",
      referenceTargetsEnabled: false,
      searchDatabaseMaxConcurrency: 4,
      searchDatabaseMaxQueue: 16,
      searchRequestTimeoutMs: 5_000,
    });
  });

  it("enables reference targets only from the exact non-production opt-in", () => {
    const base = {
      DATABASE_URL: "postgresql://local.invalid/nutrition",
      NODE_ENV: "test",
    } as const;
    expect(
      loadApiDependencyConfig({ ...base, REFERENCE_TARGETS_ENABLED: "true" })
        .referenceTargetsEnabled,
    ).toBe(true);
    expect(() => loadApiDependencyConfig({ ...base, REFERENCE_TARGETS_ENABLED: "TRUE" })).toThrow(
      ConfigValidationError,
    );
  });

  it("bounds the process-local search database bulkhead configuration", () => {
    expect(
      loadApiDependencyConfig({
        DATABASE_URL: "postgresql://local.invalid/nutrition",
        NODE_ENV: "development",
        SEARCH_DB_MAX_CONCURRENCY: "2",
        SEARCH_DB_MAX_QUEUE: "3",
      }),
    ).toMatchObject({
      searchDatabaseMaxConcurrency: 2,
      searchDatabaseMaxQueue: 3,
    });

    expect(() =>
      loadApiDependencyConfig({
        DATABASE_URL: "postgresql://local.invalid/nutrition",
        SEARCH_DB_MAX_CONCURRENCY: "0",
      }),
    ).toThrow(ConfigValidationError);
  });

  it("permits only the exact non-production loopback Mailpit fixture", () => {
    expect(
      loadApiDependencyConfig({
        DATABASE_URL: "postgresql://local.invalid/nutrition",
        EMAIL_VERIFICATION_PUBLIC_ORIGIN: "http://127.0.0.1:3000",
        PASSWORD_RECOVERY_PUBLIC_ORIGIN: "http://127.0.0.1:3000",
        NODE_ENV: "development",
        SMTP_FROM: "Nutrition Tracker Local <no-reply@nutrition.local>",
        SMTP_HOST: "127.0.0.1",
        SMTP_PORT: "1025",
      }).emailVerification,
    ).toEqual({
      transport: "smtp",
      from: "Nutrition Tracker Local <no-reply@nutrition.local>",
      host: "127.0.0.1",
      nodeEnv: "development",
      passwordRecoveryPublicOrigin: "http://127.0.0.1:3000",
      port: 1025,
      publicOrigin: "http://127.0.0.1:3000",
      timeoutMs: 5_000,
    });

    for (const overrides of [
      { SMTP_HOST: "localhost" },
      { SMTP_PORT: "2525" },
      { EMAIL_VERIFICATION_PUBLIC_ORIGIN: "https://example.invalid" },
      { PASSWORD_RECOVERY_PUBLIC_ORIGIN: "http://localhost:3000" },
      { SMTP_FROM: "safe@example.invalid\r\nBcc: private@example.invalid" },
    ]) {
      expect(() =>
        loadApiDependencyConfig({
          DATABASE_URL: "postgresql://local.invalid/nutrition",
          NODE_ENV: "test",
          SMTP_FROM: "no-reply@nutrition.local",
          SMTP_HOST: "127.0.0.1",
          SMTP_PORT: "1025",
          ...overrides,
        }),
      ).toThrow(ConfigValidationError);
    }
  });

  it("leaves mail disabled by default and rejects an unapproved production SMTP provider", () => {
    expect(
      loadApiDependencyConfig({
        DATABASE_URL: "postgresql://local.invalid/nutrition",
        NODE_ENV: "test",
      }).emailVerification,
    ).toBeNull();

    try {
      loadApiDependencyConfig({
        DATABASE_URL: "postgresql://production.invalid/nutrition",
        NODE_ENV: "production",
        SMTP_FROM: "no-reply@nutrition.example",
        SMTP_HOST: "smtp.production.example",
        SMTP_PORT: "465",
      });
      throw new Error("expected production SMTP configuration to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect((error as ConfigValidationError).issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ field: "SMTP_HOST" })]),
      );
      expect((error as Error).message).not.toContain("smtp.production.example");
    }
  });

  it("requires a scoped key, cursor secret, and verified database/search TLS in production", () => {
    try {
      loadApiDependencyConfig({
        DATABASE_URL: "postgresql://production.invalid/nutrition",
        MEILI_URL: "http://search.internal:7700",
        NODE_ENV: "production",
        REFERENCE_TARGETS_ENABLED: "true",
      });
      throw new Error("expected production dependency configuration to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect((error as ConfigValidationError).issues.map((issue) => issue.field)).toEqual([
        "SEARCH_CURSOR_SECRET",
        "DATABASE_RESTORE_EPOCH",
        "DATABASE_SSL_MODE",
        "MEILI_SEARCH_KEY",
        "MEILI_URL",
        "REFERENCE_TARGETS_ENABLED",
        "RETENTION_FEATURES_ENABLED",
      ]);
    }

    expect(
      loadApiDependencyConfig({
        DATABASE_SSL_MODE: "verify-full",
        DATABASE_RESTORE_EPOCH: "production-restore-epoch-2026-08-16-v1",
        DATABASE_URL: "postgresql://production.invalid/nutrition",
        DEVICE_CHALLENGE_HMAC_KEY: Buffer.alloc(32, 4).toString("base64"),
        MEILI_SEARCH_KEY: "scoped-production-search-key",
        MEILI_URL: "https://search.internal",
        NODE_ENV: "production",
        RETENTION_FEATURES_ENABLED: "true",
        SEARCH_CURSOR_SECRET: "production-cursor-secret-at-least-32-bytes",
        EXPORT_ARTIFACT_STORE: "s3",
        EXPORT_ARTIFACT_ENDPOINT: "https://objects.internal.example",
        EXPORT_ARTIFACT_REGION: "us-east-1",
        EXPORT_ARTIFACT_BUCKET: "nutrition-private-exports",
        EXPORT_ARTIFACT_CURRENT_KEY_ID: "export-v1",
        EXPORT_ARTIFACT_ENCRYPTION_KEYS: JSON.stringify({
          "export-v1": Buffer.alloc(32, 1).toString("base64"),
        }),
        EXPORT_ARTIFACT_READ_ACCESS_KEY_ID: "export-reader",
        EXPORT_ARTIFACT_READ_SECRET_ACCESS_KEY: "export-reader-secret",
        EXPORT_ARTIFACT_READ_SPOOL_DIR: "/var/run/nutrition-tracker/export-read-spool",
        EXPORT_ARTIFACT_READ_SPOOL_PROTECTION: "encrypted_volume",
        ERASURE_REPLAY_LEDGER_LOCATOR_CURRENT_KEY_ID: "locator-v1",
        ERASURE_REPLAY_LEDGER_LOCATOR_HMAC_KEYS: JSON.stringify({
          "locator-v1": Buffer.alloc(32, 2).toString("base64"),
        }),
        ERASURE_STATUS_CAPABILITY_HMAC_KEY: Buffer.alloc(32, 3).toString("base64"),
      }),
    ).toMatchObject({
      databaseUrl: "postgresql://production.invalid/nutrition",
      databaseRestoreEpoch: "production-restore-epoch-2026-08-16-v1",
      requireDatabaseRestoreAttestation: true,
      retention: {
        artifactStore: "s3",
        artifactReadMaximumConcurrency: 2,
      },
    });
  });

  it("bounds authenticated download spools and rejects root or overcommitted paths", () => {
    const base = {
      DATABASE_URL: "postgresql://local.invalid/nutrition",
      DEVICE_CHALLENGE_HMAC_KEY: Buffer.alloc(32, 4).toString("base64"),
      RETENTION_FEATURES_ENABLED: "true",
      EXPORT_ARTIFACT_CURRENT_KEY_ID: "export-v1",
      EXPORT_ARTIFACT_ENCRYPTION_KEYS: JSON.stringify({
        "export-v1": Buffer.alloc(32, 1).toString("base64"),
      }),
      ERASURE_REPLAY_LEDGER_LOCATOR_CURRENT_KEY_ID: "locator-v1",
      ERASURE_REPLAY_LEDGER_LOCATOR_HMAC_KEYS: JSON.stringify({
        "locator-v1": Buffer.alloc(32, 2).toString("base64"),
      }),
      ERASURE_STATUS_CAPABILITY_HMAC_KEY: Buffer.alloc(32, 3).toString("base64"),
    };
    expect(() => loadApiDependencyConfig({ ...base, EXPORT_ARTIFACT_READ_SPOOL_DIR: "/" })).toThrow(
      ConfigValidationError,
    );
    expect(() =>
      loadApiDependencyConfig({
        ...base,
        EXPORT_ARTIFACT_READ_MAX_ARTIFACT_BYTES: String(MAX_PRIVACY_EXPORT_SNAPSHOT_BYTES + 1),
      }),
    ).toThrow(ConfigValidationError);
    expect(() =>
      loadApiDependencyConfig({
        ...base,
        EXPORT_ARTIFACT_READ_MAX_ARTIFACT_BYTES: "104857600",
      }),
    ).toThrow(ConfigValidationError);
    expect(
      loadApiDependencyConfig({
        ...base,
        EXPORT_ARTIFACT_READ_MAX_ARTIFACT_BYTES: String(MAX_PRIVACY_EXPORT_SNAPSHOT_BYTES),
      }).retention?.artifactReadMaximumArtifactBytes,
    ).toBe(MAX_PRIVACY_EXPORT_SNAPSHOT_BYTES);
  });

  it("requires an explicit protected plaintext spool contract in production", () => {
    const production = {
      DATABASE_SSL_MODE: "verify-full",
      DATABASE_RESTORE_EPOCH: "production-restore-epoch-2026-08-16-v1",
      DATABASE_URL: "postgresql://production.invalid/nutrition",
      DEVICE_CHALLENGE_HMAC_KEY: Buffer.alloc(32, 4).toString("base64"),
      MEILI_SEARCH_KEY: "scoped-production-search-key",
      MEILI_URL: "https://search.internal",
      NODE_ENV: "production",
      RETENTION_FEATURES_ENABLED: "true",
      SEARCH_CURSOR_SECRET: "production-cursor-secret-at-least-32-bytes",
      EXPORT_ARTIFACT_STORE: "s3",
      EXPORT_ARTIFACT_ENDPOINT: "https://objects.internal.example",
      EXPORT_ARTIFACT_REGION: "us-east-1",
      EXPORT_ARTIFACT_BUCKET: "nutrition-private-exports",
      EXPORT_ARTIFACT_CURRENT_KEY_ID: "export-v1",
      EXPORT_ARTIFACT_ENCRYPTION_KEYS: JSON.stringify({
        "export-v1": Buffer.alloc(32, 1).toString("base64"),
      }),
      EXPORT_ARTIFACT_READ_ACCESS_KEY_ID: "export-reader",
      EXPORT_ARTIFACT_READ_SECRET_ACCESS_KEY: "export-reader-secret",
      EXPORT_ARTIFACT_READ_SPOOL_DIR: "/var/run/nutrition-tracker/export-read-spool",
      ERASURE_REPLAY_LEDGER_LOCATOR_CURRENT_KEY_ID: "locator-v1",
      ERASURE_REPLAY_LEDGER_LOCATOR_HMAC_KEYS: JSON.stringify({
        "locator-v1": Buffer.alloc(32, 2).toString("base64"),
      }),
      ERASURE_STATUS_CAPABILITY_HMAC_KEY: Buffer.alloc(32, 3).toString("base64"),
    } as const;
    expect(() => loadApiDependencyConfig(production)).toThrowError(
      expect.objectContaining({
        issues: expect.arrayContaining([
          expect.objectContaining({
            field: "EXPORT_ARTIFACT_READ_SPOOL_PROTECTION",
          }),
        ]),
      }),
    );
  });
});

describe("hosted development HTTPS capture configuration", () => {
  const captureCA =
    "-----BEGIN CERTIFICATE-----\nMIIDNTCCAh2gAwIBAgIUfhGNwiFK+WISIjNgIwuS6PE1nHIwDQYJKoZIhvcNAQEL\nBQAwKjEoMCYGA1UEAwwfTm91cmlzaGluZy1TeW50aGV0aWMtQ2FwdHVyZS1DQTAe\nFw0yNjEwMDkwNjQzNTRaFw0yNjEwMTAwNjQzNTRaMCoxKDAmBgNVBAMMH05vdXJp\nc2hpbmctU3ludGhldGljLUNhcHR1cmUtQ0EwggEiMA0GCSqGSIb3DQEBAQUAA4IB\nDwAwggEKAoIBAQCbRVy+5ToKMriZSKAo7Ch4sikx06eNU6WMY8xDYmLt32zyDnlY\n8mnAG3jewra45Ea1Si6a7QciE5eC8Rzk2JV+hzbQiTIlL5Ejnp/LdT+b1WbpCz3U\nuZQaG7fMyEjzUdj0DhHfBJ+CF5Abg3iv1U4Zg0BfhkH+w9QgtNBtmbDRScfkUje7\n4k7lnFrHAIJkHPuhQjJvGhUuAJCrjQP2RTLlkKcWPS218Pt/4hWpfwlii+6HEYmA\n3KJ9ff4PV2FhUcIQzT6py8KpIuNlsWVegRvFSKHEoPmFpFLkf+9mqOb9duM8r+FV\nbKaGepfItHkVk/hf+xxBs6I4npBqmxEw72OtAgMBAAGjUzBRMB0GA1UdDgQWBBRN\nss4zzgKX3/G9hCeLdoLrSF/CdTAfBgNVHSMEGDAWgBRNss4zzgKX3/G9hCeLdoLr\nSF/CdTAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQBswJHuTrRI\nftcr2Mscper809Mx+5+YmP8wFJkx4CJkcX3JqkbBpO06+XszYnB3kWZjzRUv83xW\nlY3SF020kDHqD9RVZQIlsRPhNDgnXqmTNE4b0pVpF5F7qySKIYjy0lWeXS2DQWpn\nW0i38lTd84DuUxpl03w+fID2mBH70q0M1msWWvf+8/g1Fi7uN0FcPXmWcs5UtFIb\nK0Lbcc0eBuhe4Pzs7r2ogsw70ZzC3CyX/hz6ng0qM0GRegVA0rP7nUOyzYBBd+av\ntdlWPpUmhva+nINSDIycXFiKBK7o8kLzJNCFZAOugDbBhWx3vzTqXc5Yxggax1GP\nKs7AegrIAInt\n-----END CERTIFICATE-----\n";
  const environment: NodeJS.ProcessEnv = {
    DATABASE_URL: "postgresql://synthetic.invalid/nutrition",
    NOURISHING_API_PROFILE: HOSTED_DEVELOPMENT_PROFILE,
    NODE_ENV: "development",
    EMAIL_DELIVERY_TRANSPORT: "https-capture",
    EMAIL_CAPTURE_URL: "https://mail-capture:8025/api/v1/send",
    EMAIL_CAPTURE_CA: captureCA,
    EMAIL_CAPTURE_USERNAME: "capture-send",
    EMAIL_CAPTURE_PASSWORD: "synthetic-send-secret-0123456789abcdef",
    EMAIL_CAPTURE_FROM: "Nourishing Development <no-reply@example.invalid>",
    EMAIL_CAPTURE_TIMEOUT_MS: "1000",
    EMAIL_VERIFICATION_PUBLIC_ORIGIN: HOSTED_DEVELOPMENT_WEB_ORIGIN,
    PASSWORD_RECOVERY_PUBLIC_ORIGIN: HOSTED_DEVELOPMENT_WEB_ORIGIN,
  };

  it("selects explicit HTTPS capture without loopback SMTP", () => {
    expect(loadApiDependencyConfig(environment).emailVerification).toEqual({
      transport: "https-capture",
      profile: HOSTED_DEVELOPMENT_PROFILE,
      nodeEnv: "development",
      captureUrl: environment.EMAIL_CAPTURE_URL,
      ca: captureCA,
      username: environment.EMAIL_CAPTURE_USERNAME,
      password: environment.EMAIL_CAPTURE_PASSWORD,
      from: environment.EMAIL_CAPTURE_FROM,
      timeoutMs: 1000,
      publicOrigin: HOSTED_DEVELOPMENT_WEB_ORIGIN,
      passwordRecoveryPublicOrigin: HOSTED_DEVELOPMENT_WEB_ORIGIN,
    });
  });

  it("selects the Appwrite staging origin for both captured auth flows", () => {
    const publicOrigin = "https://staging.nourishing.app";
    const config = loadApiDependencyConfig({
      ...environment,
      DATABASE_RESTORE_EPOCH: "staging-restore-epoch-0123456789abcdef",
      DATABASE_SSL_MODE: "verify-full",
      EMAIL_VERIFICATION_PUBLIC_ORIGIN: publicOrigin,
      PASSWORD_RECOVERY_PUBLIC_ORIGIN: publicOrigin,
    });
    expect(config.requireDatabaseRestoreAttestation).toBe(true);
    expect(config.emailVerification).toMatchObject({
      transport: "https-capture",
      publicOrigin,
      passwordRecoveryPublicOrigin: publicOrigin,
    });
  });

  it.each([
    { DATABASE_RESTORE_EPOCH: undefined, DATABASE_SSL_MODE: "verify-full" },
    {
      DATABASE_RESTORE_EPOCH: "staging-restore-epoch-0123456789abcdef",
      DATABASE_SSL_MODE: "disable",
    },
  ])("requires restore admission and verified database TLS for staging %#", (database) => {
    expect(() =>
      loadApiDependencyConfig({
        ...environment,
        ...database,
        EMAIL_VERIFICATION_PUBLIC_ORIGIN: "https://staging.nourishing.app",
        PASSWORD_RECOVERY_PUBLIC_ORIGIN: "https://staging.nourishing.app",
      }),
    ).toThrow(ConfigValidationError);
  });

  it.each([
    "NOURISHING_API_PROFILE",
    "NODE_ENV",
    "EMAIL_DELIVERY_TRANSPORT",
    "EMAIL_CAPTURE_URL",
    "EMAIL_CAPTURE_CA",
    "EMAIL_CAPTURE_USERNAME",
    "EMAIL_CAPTURE_PASSWORD",
    "EMAIL_CAPTURE_FROM",
    "EMAIL_CAPTURE_TIMEOUT_MS",
    "EMAIL_VERIFICATION_PUBLIC_ORIGIN",
    "PASSWORD_RECOVERY_PUBLIC_ORIGIN",
  ])("requires owned explicit %s", (field) => {
    const missing = { ...environment };
    delete missing[field];
    expect(() => loadApiDependencyConfig(missing)).toThrow(ConfigValidationError);
    Object.setPrototypeOf(missing, { [field]: environment[field] });
    expect(() => loadApiDependencyConfig(missing)).toThrow(ConfigValidationError);
  });

  it.each<NodeJS.ProcessEnv>([
    { NODE_ENV: "production" },
    { NODE_ENV: "test" },
    { NOURISHING_API_PROFILE: "other" },
    { EMAIL_DELIVERY_TRANSPORT: "smtp" },
    { EMAIL_CAPTURE_URL: "http://mail-capture:8025/api/v1/send" },
    { EMAIL_CAPTURE_URL: "https://mail-capture:8025/api/v1/send/" },
    { EMAIL_CAPTURE_URL: "https://other.invalid:8025/api/v1/send" },
    {
      EMAIL_CAPTURE_URL: "https://mail-capture:8025/api/v1/send?secret=hidden",
    },
    { EMAIL_CAPTURE_CA: "" },
    { EMAIL_CAPTURE_CA: "private-ca-value-must-not-leak" },
    { EMAIL_CAPTURE_USERNAME: "send:read" },
    { EMAIL_CAPTURE_USERNAME: "send\r\nAuthorization: invalid" },
    { EMAIL_CAPTURE_PASSWORD: "" },
    { EMAIL_CAPTURE_PASSWORD: "short" },
    { EMAIL_CAPTURE_PASSWORD: "x".repeat(257) },
    {
      EMAIL_CAPTURE_FROM: "no-reply@example.invalid\r\nBcc: other@example.invalid",
    },
    { EMAIL_CAPTURE_TIMEOUT_MS: "99" },
    { EMAIL_CAPTURE_TIMEOUT_MS: "10001" },
    { EMAIL_VERIFICATION_PUBLIC_ORIGIN: "https://localhost:3443/" },
    { PASSWORD_RECOVERY_PUBLIC_ORIGIN: "https://other.invalid" },
    { EMAIL_VERIFICATION_PUBLIC_ORIGIN: "https://staging.nourishing.app" },
    {
      EMAIL_VERIFICATION_PUBLIC_ORIGIN: "https://nourishing.app",
      PASSWORD_RECOVERY_PUBLIC_ORIGIN: "https://nourishing.app",
    },
    { SMTP_HOST: "127.0.0.1" },
    { SMTP_PORT: "1025" },
    { SMTP_FROM: "no-reply@example.invalid" },
    { SMTP_TIMEOUT_MS: "1000" },
  ])("rejects unsafe or mixed capture configuration %#", (overrides) => {
    expect(() => loadApiDependencyConfig({ ...environment, ...overrides })).toThrow(
      ConfigValidationError,
    );
  });

  it("reports only configuration field names, excluding private inputs", () => {
    const privateValue = "private-ca-value-must-not-leak";
    try {
      loadApiDependencyConfig({
        ...environment,
        EMAIL_CAPTURE_CA: privateValue,
      });
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect(JSON.stringify(error)).not.toContain(privateValue);
      expect((error as Error).message).not.toContain(environment.EMAIL_CAPTURE_PASSWORD);
    }
  });
});
