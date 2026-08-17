import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { type AuthRepository, SecureAuthService } from "../src/modules/auth/auth-service.js";
import { PasswordWorkQueue } from "../src/modules/auth/password.js";
import { account } from "./fixtures.js";

function repositoryStub(overrides: Partial<AuthRepository> = {}): AuthRepository {
  return {
    createReauthenticationProof: vi.fn(async () => undefined),
    register: vi.fn(async () => account),
    findPasswordCredential: vi.fn(async () => null),
    createSession: vi.fn(async () => undefined),
    findActiveSession: vi.fn(async () => account),
    findPendingErasureRecoverySession: vi.fn(async () => null),
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
});
