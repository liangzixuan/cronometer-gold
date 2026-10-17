import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import {
  HOSTED_DEVELOPMENT_PROFILE,
  HOSTED_DEVELOPMENT_WEB_ORIGIN,
} from "@nutrition-tracker/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthRepository } from "../src/modules/auth/auth-service.js";
import { SecureAuthService } from "../src/modules/auth/auth-service.js";
import {
  EmailDeliveryConfigurationError,
  EmailDeliveryError,
  HostedMailpitEmailDelivery,
  type HostedMailpitEmailDeliveryOptions,
} from "../src/modules/auth/email-delivery.js";
import { account } from "./fixtures.js";

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("node:https", () => ({ request: mocks.request }));

// Public synthetic CA only. Requests and responses below are controlled objects, not TLS evidence.
const ca =
  "-----BEGIN CERTIFICATE-----\nMIIDNTCCAh2gAwIBAgIUfhGNwiFK+WISIjNgIwuS6PE1nHIwDQYJKoZIhvcNAQEL\nBQAwKjEoMCYGA1UEAwwfTm91cmlzaGluZy1TeW50aGV0aWMtQ2FwdHVyZS1DQTAe\nFw0yNjEwMDkwNjQzNTRaFw0yNjEwMTAwNjQzNTRaMCoxKDAmBgNVBAMMH05vdXJp\nc2hpbmctU3ludGhldGljLUNhcHR1cmUtQ0EwggEiMA0GCSqGSIb3DQEBAQUAA4IB\nDwAwggEKAoIBAQCbRVy+5ToKMriZSKAo7Ch4sikx06eNU6WMY8xDYmLt32zyDnlY\n8mnAG3jewra45Ea1Si6a7QciE5eC8Rzk2JV+hzbQiTIlL5Ejnp/LdT+b1WbpCz3U\nuZQaG7fMyEjzUdj0DhHfBJ+CF5Abg3iv1U4Zg0BfhkH+w9QgtNBtmbDRScfkUje7\n4k7lnFrHAIJkHPuhQjJvGhUuAJCrjQP2RTLlkKcWPS218Pt/4hWpfwlii+6HEYmA\n3KJ9ff4PV2FhUcIQzT6py8KpIuNlsWVegRvFSKHEoPmFpFLkf+9mqOb9duM8r+FV\nbKaGepfItHkVk/hf+xxBs6I4npBqmxEw72OtAgMBAAGjUzBRMB0GA1UdDgQWBBRN\nss4zzgKX3/G9hCeLdoLrSF/CdTAfBgNVHSMEGDAWgBRNss4zzgKX3/G9hCeLdoLr\nSF/CdTAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQBswJHuTrRI\nftcr2Mscper809Mx+5+YmP8wFJkx4CJkcX3JqkbBpO06+XszYnB3kWZjzRUv83xW\nlY3SF020kDHqD9RVZQIlsRPhNDgnXqmTNE4b0pVpF5F7qySKIYjy0lWeXS2DQWpn\nW0i38lTd84DuUxpl03w+fID2mBH70q0M1msWWvf+8/g1Fi7uN0FcPXmWcs5UtFIb\nK0Lbcc0eBuhe4Pzs7r2ogsw70ZzC3CyX/hz6ng0qM0GRegVA0rP7nUOyzYBBd+av\ntdlWPpUmhva+nINSDIycXFiKBK7o8kLzJNCFZAOugDbBhWx3vzTqXc5Yxggax1GP\nKs7AegrIAInt\n-----END CERTIFICATE-----\n";
const options: HostedMailpitEmailDeliveryOptions = {
  profile: HOSTED_DEVELOPMENT_PROFILE,
  nodeEnv: "development" as const,
  captureUrl: "https://mail-capture:8025/api/v1/send",
  ca,
  username: "capture-send",
  password: "synthetic-send-secret-0123456789abcdef",
  from: "Nourishing Development <no-reply@example.invalid>",
  timeoutMs: 100,
};
const token = "A".repeat(43);
const verification = {
  recipient: "capture@example.invalid",
  verificationUrl: `${HOSTED_DEVELOPMENT_WEB_ORIGIN}/verify-email#token=${token}`,
  expiresAt: new Date("2030-01-01T00:30:00Z"),
};
const recovery = {
  recipient: verification.recipient,
  recoveryUrl: `${HOSTED_DEVELOPMENT_WEB_ORIGIN}/reset-password#token=${token}`,
  expiresAt: verification.expiresAt,
};
type Exchange = {
  request: EventEmitter & { end: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> };
  response: EventEmitter & {
    complete: boolean;
    statusCode: number;
    headers: Record<string, string>;
    destroy: ReturnType<typeof vi.fn>;
  };
  url: string;
  options: RequestOptions;
  payload?: Buffer;
};
const exchanges: Exchange[] = [];

function fixture(
  input: {
    status?: number;
    body?: Buffer | string;
    contentType?: string;
    encoding?: string;
    incomplete?: boolean;
    abort?: boolean;
    error?: string;
    noResponse?: boolean;
    stallBody?: boolean;
    closeEarly?: boolean;
  } = {},
) {
  mocks.request.mockImplementation(
    (
      url: string,
      requestOptions: RequestOptions,
      callback: (response: IncomingMessage) => void,
    ) => {
      const response = Object.assign(new EventEmitter(), {
        complete: false,
        statusCode: input.status ?? 200,
        headers: {
          "content-type": input.contentType ?? "application/json",
          ...(input.encoding === undefined ? {} : { "content-encoding": input.encoding }),
        },
        destroy: vi.fn(),
      });
      const request = Object.assign(new EventEmitter(), {
        destroy: vi.fn(),
        end: vi.fn((payload: Buffer) => {
          exchange.payload = payload;
          queueMicrotask(() => {
            if (input.error) {
              request.emit("error", new Error(input.error));
              return;
            }
            if (input.noResponse) return;
            callback(response as unknown as IncomingMessage);
            if (input.abort) {
              response.emit("aborted");
              return;
            }
            if (input.closeEarly) {
              response.emit("close");
              return;
            }
            if (input.stallBody) return;
            response.emit("data", Buffer.from(input.body ?? '{"ID":"AbCdEf0123456789GhIjKl"}'));
            response.complete = !input.incomplete;
            response.emit("end");
            response.emit("close");
          });
        }),
      });
      const exchange: Exchange = { request, response, url, options: requestOptions };
      exchanges.push(exchange);
      return request as unknown as ClientRequest;
    },
  );
}
beforeEach(() => {
  mocks.request.mockReset();
  exchanges.length = 0;
  fixture();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("hosted-development HTTPS Mailpit delivery", () => {
  it("sends both messages to the exact endpoint with minimal payload and verified TLS options", async () => {
    const delivery = new HostedMailpitEmailDelivery(options);
    await delivery.sendVerificationEmail(verification);
    await delivery.sendPasswordRecoveryEmail(recovery);
    expect(mocks.request).toHaveBeenCalledTimes(2);
    for (const [index, exchange] of exchanges.entries()) {
      expect(exchange.url).toBe(options.captureUrl);
      expect(exchange.options).toEqual({
        agent: false,
        ca,
        rejectUnauthorized: true,
        servername: "mail-capture",
        maxHeaderSize: 8192,
        method: "POST",
        headers: {
          accept: "application/json",
          "accept-encoding": "identity",
          authorization: `Basic ${Buffer.from(`${options.username}:${options.password}`).toString("base64")}`,
          "content-type": "application/json",
          "content-length": exchange.payload?.length,
        },
      });
      const payload = JSON.parse(exchange.payload?.toString("utf8") ?? "");
      expect(Object.keys(payload).sort()).toEqual(["From", "Subject", "Text", "To"]);
      expect(payload.From).toEqual({ Email: "no-reply@example.invalid" });
      expect(payload.To).toEqual([{ Email: verification.recipient }]);
      expect(payload.Subject).toBe(
        index === 0
          ? "Verify your Nutrition Tracker email"
          : "Reset your Nutrition Tracker password",
      );
      expect(payload.Text).toContain(
        index === 0 ? verification.verificationUrl : recovery.recoveryUrl,
      );
      expect(payload.Text).toContain(verification.expiresAt.toISOString());
      expect(exchange.request.end).toHaveBeenCalledTimes(1);
      expect(exchange.request.destroy).toHaveBeenCalledTimes(1);
      expect(exchange.response.destroy).toHaveBeenCalledTimes(1);
    }
  });

  it("captures actual auth-generated verification and recovery fragments", async () => {
    const delivery = new HostedMailpitEmailDelivery(options);
    const repository: AuthRepository = {
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
    };
    const service = new SecureAuthService({
      repository,
      emailVerificationDelivery: delivery,
      passwordRecoveryDelivery: delivery,
      emailVerificationPublicOrigin: HOSTED_DEVELOPMENT_WEB_ORIGIN,
      passwordRecoveryPublicOrigin: HOSTED_DEVELOPMENT_WEB_ORIGIN,
      clock: () => new Date("2030-01-01T00:00:00Z"),
    });
    const syntheticAccount = {
      ...account,
      user: { ...account.user, email: verification.recipient, emailVerified: false },
    };
    await expect(service.requestEmailVerification(syntheticAccount)).resolves.toEqual({
      data: { status: "accepted" },
    });
    await expect(service.requestPasswordRecovery(verification.recipient)).resolves.toEqual({
      data: { status: "accepted" },
    });
    const issued = [
      vi.mocked(repository.issueEmailVerificationToken).mock.calls[0]?.[0],
      vi.mocked(repository.issuePasswordRecoveryToken).mock.calls[0]?.[0],
    ];
    for (const [index, path] of ["/verify-email", "/reset-password"].entries()) {
      const payload = JSON.parse(exchanges[index]?.payload?.toString("utf8") ?? "");
      const link = payload.Text.split("\r\n").find((line: string) =>
        line.startsWith(HOSTED_DEVELOPMENT_WEB_ORIGIN),
      );
      const url = new URL(link);
      expect(url.origin).toBe(HOSTED_DEVELOPMENT_WEB_ORIGIN);
      expect(url.pathname).toBe(path);
      expect(url.search).toBe("");
      expect(url.hash).toMatch(/^#token=[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u);
      const generatedToken = url.hash.slice(7);
      expect(issued[index]?.tokenHash).toBe(
        createHash("sha256").update(generatedToken).digest("hex"),
      );
      expect(JSON.stringify(issued[index])).not.toContain(generatedToken);
    }
  });

  it.each([
    ' \n { "ID" : "AbCdEf0123456789GhIjKl" } \r\n ',
    '{"\\u0049D":"\\u0041bCdEf0123456789GhIjKl"}',
  ])("accepts a single string acknowledgement with valid JSON representation %#", async (body) => {
    fixture({ body });
    await expect(
      new HostedMailpitEmailDelivery(options).sendVerificationEmail(verification),
    ).resolves.toBeUndefined();
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(exchanges[0]?.request.destroy).toHaveBeenCalledTimes(1);
    expect(exchanges[0]?.response.destroy).toHaveBeenCalledTimes(1);
  });

  it.each([
    { body: '{"ID":"bad","ID":"AbCdEf0123456789GhIjKl"}' },
    { body: '{"ID":"AbCdEf0123456789GhIjKl","ID":"AbCdEf0123456789GhIjKl"}' },
    { body: '{"ID":"bad","\\u0049D":"AbCdEf0123456789GhIjKl"}' },
    { status: 301 },
    { status: 401 },
    { status: 403 },
    { status: 413 },
    { status: 503 },
    { body: "" },
    { body: "{}" },
    { body: "private-server-error" },
    { body: '{"ID":""}' },
    { body: '{"ID":"short"}' },
    { body: '{"ID":"AbCdEf0123456789GhIjKl","secret":"private"}' },
    { body: Buffer.from([0xff]) },
    { body: "x".repeat(4097) },
    { incomplete: true },
    { abort: true },
    { closeEarly: true },
    { contentType: "text/html" },
    { encoding: "gzip" },
    { error: "TLS private credential token-link must-not-leak" },
  ])("fails safely without retry for uncertain response %#", async (scenario) => {
    fixture(scenario);
    const delivery = new HostedMailpitEmailDelivery(options);
    await expect(delivery.sendVerificationEmail(verification)).rejects.toEqual(
      new EmailDeliveryError(),
    );
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(exchanges[0]?.request.destroy).toHaveBeenCalledTimes(1);
    if (!scenario.error) expect(exchanges[0]?.response.destroy).toHaveBeenCalledTimes(1);
  });

  it.each([{ noResponse: true }, { stallBody: true }])(
    "bounds total DNS/TLS/response elapsed time %#",
    async (scenario) => {
      vi.useFakeTimers();
      fixture(scenario);
      const delivery = new HostedMailpitEmailDelivery(options);
      const send = expect(delivery.sendVerificationEmail(verification)).rejects.toEqual(
        new EmailDeliveryError(),
      );
      await vi.advanceTimersByTimeAsync(100);
      await send;
      expect(mocks.request).toHaveBeenCalledTimes(1);
      expect(exchanges[0]?.request.destroy).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("redacts synchronous HTTPS client errors and clears the deadline", async () => {
    vi.useFakeTimers();
    mocks.request.mockImplementation(() => {
      throw new Error(options.password);
    });
    await expect(
      new HostedMailpitEmailDelivery(options).sendVerificationEmail(verification),
    ).rejects.toEqual(new EmailDeliveryError());
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { recipient: "capture@example.invalid\r\nBcc: other@example.invalid" },
    { verificationUrl: `https://other.invalid/verify-email#token=${token}` },
    { verificationUrl: `${HOSTED_DEVELOPMENT_WEB_ORIGIN}/verify-email?token=${token}` },
    { verificationUrl: `${HOSTED_DEVELOPMENT_WEB_ORIGIN}/reset-password#token=${token}` },
    { verificationUrl: `${HOSTED_DEVELOPMENT_WEB_ORIGIN}/verify-email#token=short` },
    { verificationUrl: "private-invalid-url" },
    { expiresAt: new Date(Number.NaN) },
  ])("rejects invalid verification input before any request %#", async (overrides) => {
    await expect(
      new HostedMailpitEmailDelivery(options).sendVerificationEmail({
        ...verification,
        ...overrides,
      }),
    ).rejects.toBeInstanceOf(EmailDeliveryConfigurationError);
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("rejects an invalid recovery path before any request", async () => {
    await expect(
      new HostedMailpitEmailDelivery(options).sendPasswordRecoveryEmail({
        ...recovery,
        recoveryUrl: verification.verificationUrl,
      }),
    ).rejects.toBeInstanceOf(EmailDeliveryConfigurationError);
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it.each([
    { nodeEnv: "production" as const },
    { nodeEnv: "test" as const },
    { captureUrl: "https://other.invalid/api/v1/send" },
    { ca: "private-invalid-ca" },
    { username: "ui:read" },
    { password: "short" },
    { from: "invalid\r\nheader" },
    { timeoutMs: 99 },
    { timeoutMs: 10001 },
  ])("rejects invalid adapter custody inputs before any request %#", (overrides) => {
    expect(() => new HostedMailpitEmailDelivery({ ...options, ...overrides })).toThrow(
      EmailDeliveryConfigurationError,
    );
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("requires owned adapter options and rejects inherited selection", () => {
    const input = { ...options };
    Reflect.deleteProperty(input, "profile");
    Object.setPrototypeOf(input, { profile: options.profile });
    expect(() => new HostedMailpitEmailDelivery(input)).toThrow(EmailDeliveryConfigurationError);
  });
});
