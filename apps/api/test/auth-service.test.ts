import { createHash, randomBytes } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  AuthRateLimitedError,
  type AuthRepository,
  EmailVerificationTokenInvalidError,
  EmailVerificationUnavailableError,
  SecureAuthService,
} from "../src/modules/auth/auth-service.js";
import type {
  EmailVerificationDelivery,
  PasswordRecoveryDelivery,
} from "../src/modules/auth/email-delivery.js";
import {
  hashPassword,
  PASSWORD_SCRYPT_PARAMETERS,
  PasswordWorkQueue,
} from "../src/modules/auth/password.js";
import { BoundedAuthRateLimiter } from "../src/modules/auth/rate-limiter.js";
import { account } from "./fixtures.js";

function repositoryStub(overrides: Partial<AuthRepository> = {}): AuthRepository {
  return {
    confirmEmailVerificationToken: vi.fn(async () => undefined),
    confirmPasswordRecoveryToken: vi.fn(async () => undefined),
    createReauthenticationProof: vi.fn(async () => undefined),
    register: vi.fn(async () => account),
    findPasswordCredential: vi.fn(async () => null),
    createSession: vi.fn(async () => undefined),
    findActiveSession: vi.fn(async () => account),
    findPendingErasureRecoverySession: vi.fn(async () => null),
    issueEmailVerificationToken: vi.fn(async (input) => {
      await input.deliver();
      return "issued" as const;
    }),
    issuePasswordRecoveryToken: vi.fn(async (input) => {
      await input.deliver();
      return "issued" as const;
    }),
    revokeSession: vi.fn(async () => true),
    ...overrides,
  };
}

describe("secure auth service", () => {
  it("persists only fixed-parameter password material and a SHA-256 session digest", {
    timeout: 15_000,
  }, async () => {
    const repository = repositoryStub();
    const service = new SecureAuthService({
      repository,
      queue: new PasswordWorkQueue({ maxConcurrent: 1, maxPending: 1 }),
      clock: () => new Date("2026-08-15T00:00:00.000Z"),
    });
    const password = "correct horse battery staple";
    const result = await service.register({
      email: " ADA@EXAMPLE.COM ",
      password,
      timeZone: "America/Chicago",
    });

    const registration = vi.mocked(repository.register).mock.calls[0]?.[0];
    expect(registration).toMatchObject({
      email: "ada@example.com",
      timeZone: "America/Chicago",
      passwordParameters: {
        algorithm: "scrypt",
        N: 32768,
        r: 8,
        p: 3,
        keyLength: 64,
      },
    });
    expect(JSON.stringify(registration)).not.toContain(password);
    expect(registration?.passwordHash).not.toBe(password);
    expect(registration?.passwordSalt).not.toBe(password);

    const session = vi.mocked(repository.createSession).mock.calls[0]?.[0];
    expect(result.data.accessToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(session?.tokenHash).toBe(
      createHash("sha256").update(result.data.accessToken).digest("hex"),
    );
    expect(session?.tokenHash).not.toBe(result.data.accessToken);
    expect(session?.expectedPasswordHash).toBe(registration?.passwordHash);
  });

  it("does not clear registration capacity when credential-fenced session issuance fails", {
    timeout: 15_000,
  }, async () => {
    const repository = repositoryStub({
      createSession: vi.fn(async () => Promise.reject(new Error("stale credential"))),
    });
    const service = new SecureAuthService({
      limiter: new BoundedAuthRateLimiter({ maximumAttempts: 1, windowMs: 60_000 }),
      queue: new PasswordWorkQueue({ maxConcurrent: 1, maxPending: 1 }),
      repository,
    });
    const input = {
      email: "capacity@example.com",
      password: "correct horse battery staple",
      timeZone: "America/Chicago",
    } as const;

    await expect(service.register(input)).rejects.toThrow("stale credential");
    await expect(service.register(input)).rejects.toBeInstanceOf(AuthRateLimitedError);
    expect(repository.register).toHaveBeenCalledTimes(1);
    expect(repository.createSession).toHaveBeenCalledTimes(1);
  });

  it("hashes bearer tokens before every persistence lookup", async () => {
    const repository = repositoryStub();
    const service = new SecureAuthService({ repository });
    const token = "a".repeat(43);
    const principal = await service.authenticate(`Bearer ${token}`);

    expect(principal?.userId).toBe(account.user.id);
    expect(repository.findActiveSession).toHaveBeenCalledWith(
      createHash("sha256").update(token).digest("hex"),
      expect.any(Date),
    );
    expect(repository.findActiveSession).not.toHaveBeenCalledWith(token, expect.anything());
  });

  it("binds a password-login session to the verified credential version", {
    timeout: 15_000,
  }, async () => {
    const password = "correct horse battery staple";
    const salt = randomBytes(16);
    const queue = new PasswordWorkQueue({ maxConcurrent: 1, maxPending: 1 });
    const passwordHash = await hashPassword(password, salt, queue);
    const repository = repositoryStub({
      findPasswordCredential: vi.fn(async () => ({
        account,
        passwordHash,
        passwordParameters: PASSWORD_SCRYPT_PARAMETERS,
        passwordSalt: salt.toString("base64url"),
      })),
    });
    const service = new SecureAuthService({ queue, repository });

    await expect(service.login(account.user.email, password)).resolves.toMatchObject({
      data: { user: account.user },
    });
    expect(repository.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedPasswordHash: passwordHash,
        userId: account.user.id,
      }),
    );
  });

  it("binds a reauthentication proof to the verified credential version", {
    timeout: 15_000,
  }, async () => {
    const password = "correct horse battery staple";
    const salt = randomBytes(16);
    const queue = new PasswordWorkQueue({ maxConcurrent: 1, maxPending: 1 });
    const passwordHash = await hashPassword(password, salt, queue);
    const repository = repositoryStub({
      findPasswordCredential: vi.fn(async () => ({
        account,
        passwordHash,
        passwordParameters: PASSWORD_SCRYPT_PARAMETERS,
        passwordSalt: salt.toString("base64url"),
      })),
    });
    const service = new SecureAuthService({ queue, repository });
    const sessionTokenHash = "e".repeat(64);

    await expect(
      service.reauthenticate(
        account.user.id,
        sessionTokenHash,
        account.user.email,
        password,
        "account_export",
      ),
    ).resolves.toMatchObject({ data: { reauthenticationToken: expect.any(String) } });
    expect(repository.createReauthenticationProof).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedPasswordHash: passwordHash,
        sessionTokenHash,
        userId: account.user.id,
      }),
    );
  });

  it("rejects malformed bearer values without touching persistence", async () => {
    const repository = repositoryStub();
    const service = new SecureAuthService({ repository });
    await expect(service.authenticate("Bearer too-short")).resolves.toBeNull();
    expect(repository.findActiveSession).not.toHaveBeenCalled();
  });

  it.each(["   ", "🫐".repeat(76)])(
    "rejects an invalid normalized display name before persistence",
    async (displayName) => {
      const repository = repositoryStub();
      const service = new SecureAuthService({ repository });
      await expect(
        service.register({
          displayName,
          email: "ada@example.com",
          password: "correct horse battery staple",
          timeZone: "America/Chicago",
        }),
      ).rejects.toBeInstanceOf(RangeError);
      expect(repository.register).not.toHaveBeenCalled();
    },
  );

  it("issues a 24-hour email-bound digest and delivers only the raw fragment URL", async () => {
    const repository = repositoryStub();
    const delivery: EmailVerificationDelivery = {
      sendVerificationEmail: vi.fn(async () => undefined),
    };
    const now = new Date("2026-08-15T00:00:00.000Z");
    const service = new SecureAuthService({
      clock: () => now,
      emailVerificationDelivery: delivery,
      emailVerificationPublicOrigin: "http://127.0.0.1:3000",
      repository,
    });

    await expect(service.requestEmailVerification(account)).resolves.toEqual({
      data: { status: "accepted" },
    });

    const issuance = vi.mocked(repository.issueEmailVerificationToken).mock.calls[0]?.[0];
    const message = vi.mocked(delivery.sendVerificationEmail).mock.calls[0]?.[0];
    expect(message).toMatchObject({
      expiresAt: new Date("2026-08-16T00:00:00.000Z"),
      recipient: "ada@example.com",
    });
    const verificationUrl = new URL(message?.verificationUrl ?? "invalid:");
    const token = verificationUrl.hash.replace(/^#token=/u, "");
    expect(verificationUrl.pathname).toBe("/verify-email");
    expect(verificationUrl.search).toBe("");
    expect(token).toMatch(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u);
    expect(issuance).toEqual({
      deliver: expect.any(Function),
      emailHash: createHash("sha256").update(account.user.email).digest("hex"),
      expiresAt: new Date("2026-08-16T00:00:00.000Z"),
      issuedAt: now,
      tokenHash: createHash("sha256").update(token).digest("hex"),
      userId: account.user.id,
    });
    expect(JSON.stringify(issuance)).not.toContain(token);
  });

  it("preserves the current digest when bounded delivery fails", async () => {
    const priorDigest = "1".repeat(64);
    let activeDigest = priorDigest;
    const repository = repositoryStub({
      issueEmailVerificationToken: vi.fn(async (input) => {
        await input.deliver();
        activeDigest = input.tokenHash;
        return "issued" as const;
      }),
    });
    const delivery: EmailVerificationDelivery = {
      sendVerificationEmail: vi.fn(async () => Promise.reject(new Error("private SMTP error"))),
    };
    const service = new SecureAuthService({
      emailVerificationDelivery: delivery,
      emailVerificationPublicOrigin: "http://127.0.0.1:3000",
      repository,
    });

    await expect(service.requestEmailVerification(account)).rejects.toBeInstanceOf(
      EmailVerificationUnavailableError,
    );
    expect(activeDigest).toBe(priorDigest);
  });

  it("keeps delivery inside the repository serialization boundary", async () => {
    let activeDigest = "1".repeat(64);
    let serialization = Promise.resolve();
    const issue = vi.fn((input: Parameters<AuthRepository["issueEmailVerificationToken"]>[0]) => {
      const operation = serialization.then(async () => {
        await input.deliver();
        activeDigest = input.tokenHash;
        return "issued" as const;
      });
      serialization = operation.then(
        () => undefined,
        () => undefined,
      );
      return operation;
    });
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const verificationUrls: string[] = [];
    const delivery: EmailVerificationDelivery = {
      sendVerificationEmail: vi.fn(async (input) => {
        verificationUrls.push(input.verificationUrl);
        if (verificationUrls.length === 1) {
          firstStarted.resolve();
          await releaseFirst.promise;
        }
      }),
    };
    const service = new SecureAuthService({
      clock: () => new Date("2026-08-15T00:00:00.000Z"),
      emailVerificationDelivery: delivery,
      emailVerificationPublicOrigin: "http://127.0.0.1:3000",
      repository: repositoryStub({ issueEmailVerificationToken: issue }),
    });

    const first = service.requestEmailVerification(account);
    await firstStarted.promise;
    const second = service.requestEmailVerification(account);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(delivery.sendVerificationEmail).toHaveBeenCalledTimes(1);
    releaseFirst.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { data: { status: "accepted" } },
      { data: { status: "accepted" } },
    ]);

    const lastToken = new URL(verificationUrls[1] ?? "invalid:").hash.replace(/^#token=/u, "");
    expect(activeDigest).toBe(createHash("sha256").update(lastToken).digest("hex"));
    expect(issue).toHaveBeenCalledTimes(2);
  });

  it("returns the same accepted response without issuance for an already-verified account", async () => {
    const repository = repositoryStub();
    const delivery: EmailVerificationDelivery = {
      sendVerificationEmail: vi.fn(async () => undefined),
    };
    const service = new SecureAuthService({
      emailVerificationDelivery: delivery,
      emailVerificationPublicOrigin: "http://127.0.0.1:3000",
      repository,
    });

    await expect(
      service.requestEmailVerification({
        ...account,
        user: { ...account.user, emailVerified: true },
      }),
    ).resolves.toEqual({ data: { status: "accepted" } });
    expect(repository.issueEmailVerificationToken).not.toHaveBeenCalled();
    expect(delivery.sendVerificationEmail).not.toHaveBeenCalled();
  });

  it("limits successful resend requests to five in a fixed 15-minute window", async () => {
    const repository = repositoryStub();
    const delivery: EmailVerificationDelivery = {
      sendVerificationEmail: vi.fn(async () => undefined),
    };
    const service = new SecureAuthService({
      clock: () => new Date("2026-08-15T00:00:00.000Z"),
      emailVerificationDelivery: delivery,
      emailVerificationPublicOrigin: "http://127.0.0.1:3000",
      repository,
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(service.requestEmailVerification(account)).resolves.toEqual({
        data: { status: "accepted" },
      });
    }
    await expect(service.requestEmailVerification(account)).rejects.toBeInstanceOf(
      AuthRateLimitedError,
    );
    expect(delivery.sendVerificationEmail).toHaveBeenCalledTimes(5);
  });

  it("hashes a well-formed confirmation token and rejects malformed values before persistence", async () => {
    const repository = repositoryStub();
    const confirmedAt = new Date("2026-08-15T00:00:00.000Z");
    const service = new SecureAuthService({ clock: () => confirmedAt, repository });
    const token = `${"v".repeat(42)}A`;

    await expect(service.confirmEmailVerification(token, "request-1")).resolves.toEqual({
      data: { verified: true },
    });
    expect(repository.confirmEmailVerificationToken).toHaveBeenCalledWith({
      confirmedAt,
      requestId: "request-1",
      tokenHash: createHash("sha256").update(token).digest("hex"),
    });
    await expect(service.confirmEmailVerification("too-short", "request-2")).rejects.toBeInstanceOf(
      EmailVerificationTokenInvalidError,
    );
    expect(repository.confirmEmailVerificationToken).toHaveBeenCalledTimes(1);
  });

  it("issues a one-hour digest-only recovery credential and a fragment-only link", async () => {
    const repository = repositoryStub();
    const delivery: PasswordRecoveryDelivery = {
      sendPasswordRecoveryEmail: vi.fn(async () => undefined),
    };
    const issuedAt = new Date("2026-08-15T00:00:00.000Z");
    const service = new SecureAuthService({
      clock: () => issuedAt,
      passwordRecoveryDelivery: delivery,
      passwordRecoveryPublicOrigin: "http://127.0.0.1:3000",
      repository,
    });

    await expect(service.requestPasswordRecovery(" ADA@EXAMPLE.COM ")).resolves.toEqual({
      data: { status: "accepted" },
    });
    const message = vi.mocked(delivery.sendPasswordRecoveryEmail).mock.calls[0]?.[0];
    const recoveryUrl = new URL(message?.recoveryUrl ?? "invalid:");
    const token = recoveryUrl.hash.replace(/^#token=/u, "");
    expect(message).toMatchObject({
      expiresAt: new Date("2026-08-15T01:00:00.000Z"),
      recipient: "ada@example.com",
    });
    expect(recoveryUrl.pathname).toBe("/reset-password");
    expect(recoveryUrl.search).toBe("");
    expect(token).toMatch(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u);
    expect(repository.issuePasswordRecoveryToken).toHaveBeenCalledWith({
      deliver: expect.any(Function),
      emailHash: createHash("sha256").update("ada@example.com").digest("hex"),
      expiresAt: new Date("2026-08-15T01:00:00.000Z"),
      issuedAt,
      normalizedEmail: "ada@example.com",
      tokenHash: createHash("sha256").update(token).digest("hex"),
    });
    expect(
      JSON.stringify(vi.mocked(repository.issuePasswordRecoveryToken).mock.calls),
    ).not.toContain(token);
  });

  it("keeps every target-dependent recovery request outcome indistinguishable", async () => {
    const delivery: PasswordRecoveryDelivery = {
      sendPasswordRecoveryEmail: vi.fn(async () => Promise.reject(new Error("private SMTP"))),
    };
    const failingRepository = repositoryStub({
      issuePasswordRecoveryToken: vi.fn(async (input) => {
        await input.deliver();
        return "issued" as const;
      }),
    });
    const service = new SecureAuthService({
      clock: () => new Date("2026-08-15T00:00:00.000Z"),
      passwordRecoveryDelivery: delivery,
      passwordRecoveryPublicOrigin: "http://127.0.0.1:3000",
      repository: failingRepository,
    });

    for (let attempt = 0; attempt < 7; attempt += 1) {
      await expect(service.requestPasswordRecovery("nobody@example.com")).resolves.toEqual({
        data: { status: "accepted" },
      });
    }
    expect(failingRepository.issuePasswordRecoveryToken).toHaveBeenCalledTimes(5);

    const unconfigured = new SecureAuthService({ repository: repositoryStub() });
    await expect(unconfigured.requestPasswordRecovery("nobody@example.com")).resolves.toEqual({
      data: { status: "accepted" },
    });
  });

  it("hashes a new recovery password with fresh parameters and creates no session", {
    timeout: 15_000,
  }, async () => {
    const repository = repositoryStub();
    const confirmedAt = new Date("2026-08-15T00:00:00.000Z");
    const service = new SecureAuthService({
      clock: () => confirmedAt,
      queue: new PasswordWorkQueue({ maxConcurrent: 1, maxPending: 1 }),
      repository,
    });
    const token = `${"r".repeat(42)}A`;
    const newPassword = "a different horse battery staple";

    await expect(
      service.confirmPasswordRecovery(token, newPassword, "request-reset"),
    ).resolves.toEqual({ data: { passwordReset: true } });
    const confirmation = vi.mocked(repository.confirmPasswordRecoveryToken).mock.calls[0]?.[0];
    expect(confirmation).toMatchObject({
      confirmedAt,
      passwordParameters: {
        algorithm: "scrypt",
        N: 32768,
        r: 8,
        p: 3,
        keyLength: 64,
      },
      requestId: "request-reset",
      tokenHash: createHash("sha256").update(token).digest("hex"),
    });
    expect(confirmation?.passwordHash).not.toBe(newPassword);
    expect(confirmation?.passwordSalt).not.toBe(newPassword);
    expect(JSON.stringify(confirmation)).not.toContain(newPassword);
    expect(repository.createSession).not.toHaveBeenCalled();

    await expect(
      service.confirmPasswordRecovery("too-short", newPassword, "request-invalid"),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      service.confirmPasswordRecovery(token, "🫐".repeat(129), "request-password"),
    ).rejects.toBeInstanceOf(RangeError);
    expect(repository.confirmPasswordRecoveryToken).toHaveBeenCalledTimes(1);
  });
});

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
