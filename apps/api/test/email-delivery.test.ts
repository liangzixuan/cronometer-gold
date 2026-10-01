import { createHash } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import {
  HOSTED_DEVELOPMENT_PROFILE,
  HOSTED_DEVELOPMENT_WEB_ORIGIN,
} from "@nutrition-tracker/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadApiDependencyConfig } from "../src/config.js";
import { type AuthRepository, SecureAuthService } from "../src/modules/auth/auth-service.js";
import {
  EmailDeliveryConfigurationError,
  EmailDeliveryError,
  LocalMailpitEmailDelivery,
  sendSmtpMail,
} from "../src/modules/auth/email-delivery.js";
import { account } from "./fixtures.js";

const servers: Server[] = [];
const sockets = new Set<Socket>();

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all(
    servers
      .splice(0)
      .map((server) =>
        server.listening
          ? new Promise<void>((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve())),
            )
          : Promise.resolve(),
      ),
  );
});

async function listen(connection: (socket: Socket) => void, port = 0): Promise<number> {
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.setTimeout(2_000, () => socket.destroy());
    connection(socket);
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port, host: "127.0.0.1", exclusive: true }, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP fixture port");
  return address.port;
}

async function closedLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP fixture port");
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

function successfulFixture(
  messages: string[],
  options: { readonly closeAfterAcceptance?: boolean } = {},
): (socket: Socket) => void {
  return (socket) => {
    socket.setEncoding("utf8");
    socket.write("220 mailpit.local ESMTP\r\n");
    let commandBuffer = "";
    let messageBuffer = "";
    let readingMessage = false;
    socket.on("data", (chunk: string) => {
      if (socket.writableEnded) return;
      if (readingMessage) {
        messageBuffer += chunk;
        const terminator = messageBuffer.indexOf("\r\n.\r\n");
        if (terminator >= 0) {
          messages.push(messageBuffer.slice(0, terminator));
          readingMessage = false;
          commandBuffer += messageBuffer.slice(terminator + 5);
          messageBuffer = "";
          if (options.closeAfterAcceptance) {
            commandBuffer = "";
            socket.end("250 queued\r\n");
            return;
          }
          socket.write("250 queued\r\n");
        }
      } else {
        commandBuffer += chunk;
      }
      while (!readingMessage) {
        const newline = commandBuffer.indexOf("\r\n");
        if (newline < 0) break;
        const command = commandBuffer.slice(0, newline);
        commandBuffer = commandBuffer.slice(newline + 2);
        if (command.startsWith("EHLO ")) socket.write("250-mailpit.local\r\n250 8BITMIME\r\n");
        else if (command.startsWith("MAIL FROM:")) socket.write("250 sender ok\r\n");
        else if (command.startsWith("RCPT TO:")) socket.write("250 recipient ok\r\n");
        else if (command === "DATA") {
          readingMessage = true;
          socket.write("354 send content\r\n");
          if (commandBuffer.length > 0) {
            messageBuffer = commandBuffer;
            commandBuffer = "";
          }
        } else if (command === "QUIT") {
          socket.end("221 bye\r\n");
        }
      }
    });
  };
}

describe("captured email profile boundaries", () => {
  const options = {
    from: "Nourishing Development <no-reply@example.invalid>",
    host: "127.0.0.1",
    nodeEnv: "development" as const,
    port: 1025,
    profile: HOSTED_DEVELOPMENT_PROFILE,
    timeoutMs: 1_000,
  } as const;

  it.each(["production", "test"] as const)("rejects a selected profile in %s mode", (nodeEnv) => {
    expect(() => new LocalMailpitEmailDelivery({ ...options, nodeEnv })).toThrow(
      EmailDeliveryConfigurationError,
    );
  });

  it.each(["", "production", "hosted-development "])("rejects unknown profile %s", (profile) => {
    expect(
      () =>
        new LocalMailpitEmailDelivery({
          ...options,
          profile: profile as typeof HOSTED_DEVELOPMENT_PROFILE,
        }),
    ).toThrow(EmailDeliveryConfigurationError);
  });

  it("rejects inherited profile selection", () => {
    const { profile, ...input } = options;
    Object.setPrototypeOf(input, { profile });
    expect(() => new LocalMailpitEmailDelivery(input)).toThrow(EmailDeliveryConfigurationError);
  });

  it.each([{ host: "localhost" }, { host: "mailpit" }, { host: "192.0.2.1" }, { port: 2525 }])(
    "preserves loopback SMTP admission for %j",
    (override) => {
      expect(() => new LocalMailpitEmailDelivery({ ...options, ...override })).toThrow(
        EmailDeliveryConfigurationError,
      );
    },
  );

  it("rejects malformed or foreign links in either flow before SMTP connection", async () => {
    const delivery = new LocalMailpitEmailDelivery(options);
    const token = `${"a".repeat(42)}A`;
    for (const path of ["/verify-email", "/reset-password"]) {
      const urls = [
        ...[
          "http://localhost:3443",
          "https://127.0.0.1:3443",
          "https://localhost:3444",
          "https://localhost",
          "https://LOCALHOST:3443",
          "https://user:password@localhost:3443",
          "http://127.0.0.1:3000",
        ].map((origin) => `${origin}${path}#token=${token}`),
        `${HOSTED_DEVELOPMENT_WEB_ORIGIN}/wrong#token=${token}`,
        `${HOSTED_DEVELOPMENT_WEB_ORIGIN}${path}?next=/diary#token=${token}`,
        `${HOSTED_DEVELOPMENT_WEB_ORIGIN}${path}#token=${token}&next=/diary`,
        `${HOSTED_DEVELOPMENT_WEB_ORIGIN}${path}#token=${"a".repeat(42)}`,
      ];
      for (const url of urls) {
        const common = { recipient: "capture@example.invalid", expiresAt: new Date("2030-01-01") };
        await expect(
          path === "/verify-email"
            ? delivery.sendVerificationEmail({ ...common, verificationUrl: url })
            : delivery.sendPasswordRecoveryEmail({ ...common, recoveryUrl: url }),
        ).rejects.toBeInstanceOf(EmailDeliveryConfigurationError);
      }
    }
  });

  it.each([
    ["hosted development", HOSTED_DEVELOPMENT_PROFILE, HOSTED_DEVELOPMENT_WEB_ORIGIN],
    ["ordinary loopback", undefined, "http://127.0.0.1:3000"],
  ] as const)(
    "captures actual auth-generated links for %s",
    { timeout: 15_000 },
    async (_label, profile, origin) => {
      const messages: string[] = [];
      await listen(successfulFixture(messages), 1025);
      const email = loadApiDependencyConfig({
        DATABASE_URL: "postgresql://synthetic.invalid/nutrition",
        ...(profile === undefined ? {} : { NOURISHING_API_PROFILE: profile }),
        NODE_ENV: "development",
        SMTP_HOST: "127.0.0.1",
        SMTP_PORT: "1025",
        SMTP_FROM: options.from,
        SMTP_TIMEOUT_MS: "1000",
        EMAIL_VERIFICATION_PUBLIC_ORIGIN: origin,
        PASSWORD_RECOVERY_PUBLIC_ORIGIN: origin,
      }).emailVerification;
      if (!email) throw new Error("Expected selected captured email");
      const delivery = new LocalMailpitEmailDelivery(email);
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
        emailVerificationPublicOrigin: email.publicOrigin,
        passwordRecoveryDelivery: delivery,
        passwordRecoveryPublicOrigin: email.passwordRecoveryPublicOrigin,
        clock: () => new Date("2030-01-01T00:00:00Z"),
      });
      const syntheticAccount = {
        ...account,
        user: { ...account.user, email: "capture@example.invalid", emailVerified: false },
      };
      await expect(service.requestEmailVerification(syntheticAccount)).resolves.toEqual({
        data: { status: "accepted" },
      });
      await expect(service.requestPasswordRecovery(syntheticAccount.user.email)).resolves.toEqual({
        data: { status: "accepted" },
      });
      expect(messages).toHaveLength(2);
      const issued = [
        vi.mocked(repository.issueEmailVerificationToken).mock.calls[0]?.[0],
        vi.mocked(repository.issuePasswordRecoveryToken).mock.calls[0]?.[0],
      ];
      for (const [index, path] of ["/verify-email", "/reset-password"].entries()) {
        const link = messages[index]?.split("\r\n").find((line) => line.startsWith(origin));
        if (!link) throw new Error("Missing captured generated link");
        const url = new URL(link);
        expect(url.origin).toBe(origin);
        expect(url.pathname).toBe(path);
        expect(url.search).toBe("");
        expect(url.hash).toMatch(/^#token=[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u);
        const token = url.hash.slice("#token=".length);
        expect(issued[index]?.tokenHash).toBe(createHash("sha256").update(token).digest("hex"));
        expect(JSON.stringify(issued[index])).not.toContain(token);
      }
    },
  );
});

describe("local Mailpit SMTP delivery", () => {
  it("parses multiline replies and dot-stuffs message content", async () => {
    const messages: string[] = [];
    const port = await listen(successfulFixture(messages));

    await sendSmtpMail({
      body: "first line\r\n.dot-prefixed",
      from: "Nutrition Tracker <no-reply@nutrition.local>",
      host: "127.0.0.1",
      port,
      recipient: "ada@example.com",
      subject: "Verify email",
      timeoutMs: 1_000,
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("\r\n..dot-prefixed");
    expect(messages[0]).toContain("Content-Type: text/plain; charset=utf-8");
  });

  it("treats post-DATA acceptance as success when the server closes before QUIT", async () => {
    const messages: string[] = [];
    const port = await listen(successfulFixture(messages, { closeAfterAcceptance: true }));

    await expect(
      sendSmtpMail({
        body: "accepted body",
        from: "no-reply@nutrition.local",
        host: "127.0.0.1",
        port,
        recipient: "ada@example.com",
        subject: "Verify email",
        timeoutMs: 1_000,
      }),
    ).resolves.toBeUndefined();
    expect(messages).toHaveLength(1);
  });

  it("delivers recovery mail to a 254-character contract-valid recipient", async () => {
    const messages: string[] = [];
    const port = await listen(successfulFixture(messages));
    const recipient = `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`;
    expect(recipient).toHaveLength(254);

    await expect(
      sendSmtpMail({
        body: "Open the one-time password-recovery link.",
        from: "no-reply@nutrition.local",
        host: "127.0.0.1",
        port,
        recipient,
        subject: "Reset your Nutrition Tracker password",
        timeoutMs: 1_000,
      }),
    ).resolves.toBeUndefined();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain(`To: ${recipient}`);

    await expect(
      sendSmtpMail({
        body: "safe",
        from: "no-reply@nutrition.local",
        host: "127.0.0.1",
        port,
        recipient: `b${recipient}`,
        subject: "Reset your Nutrition Tracker password",
        timeoutMs: 1_000,
      }),
    ).rejects.toBeInstanceOf(EmailDeliveryConfigurationError);
  });

  it("fails closed on connection errors, timeout, and oversized replies", async () => {
    const refusedPort = await closedLoopbackPort();
    await expect(
      sendSmtpMail({
        body: "private-token-refused",
        from: "no-reply@nutrition.local",
        host: "127.0.0.1",
        port: refusedPort,
        recipient: "ada@example.com",
        subject: "Verify email",
        timeoutMs: 1_000,
      }),
    ).rejects.toEqual(new EmailDeliveryError());

    const timeoutPort = await listen(() => undefined);
    await expect(
      sendSmtpMail({
        body: "private-token-timeout",
        from: "no-reply@nutrition.local",
        host: "127.0.0.1",
        port: timeoutPort,
        recipient: "ada@example.com",
        subject: "Verify email",
        timeoutMs: 100,
      }),
    ).rejects.toEqual(new EmailDeliveryError());

    const privateReply = `private-token-${"x".repeat(70 * 1_024)}`;
    const oversizedPort = await listen((socket) => {
      socket.end(`220-${privateReply}\r\n220 ready\r\n`);
    });
    try {
      await sendSmtpMail({
        body: "safe",
        from: "no-reply@nutrition.local",
        host: "127.0.0.1",
        port: oversizedPort,
        recipient: "ada@example.com",
        subject: "Verify email",
        timeoutMs: 1_000,
      });
      throw new Error("Expected oversized SMTP reply to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(EmailDeliveryError);
      expect((error as Error).message).not.toContain(privateReply.slice(0, 100));
    }
  });

  it("enforces an overall deadline for a never-final multiline reply", async () => {
    const privateReply = "private-token-trickle";
    const tricklePort = await listen((socket) => {
      socket.setEncoding("utf8");
      socket.write("220 mailpit.local ESMTP\r\n");
      let interval: NodeJS.Timeout | undefined;
      socket.once("data", () => {
        interval = setInterval(() => {
          socket.write(`250-${privateReply}\r\n`);
        }, 25);
      });
      const stop = () => {
        if (interval) clearInterval(interval);
      };
      socket.once("close", stop);
      socket.once("error", stop);
    });
    const startedAt = Date.now();
    try {
      await sendSmtpMail({
        body: "safe",
        from: "no-reply@nutrition.local",
        host: "127.0.0.1",
        port: tricklePort,
        recipient: "ada@example.com",
        subject: "Verify email",
        timeoutMs: 150,
      });
      throw new Error("Expected trickle SMTP reply to time out");
    } catch (error) {
      expect(error).toBeInstanceOf(EmailDeliveryError);
      expect((error as Error).message).not.toContain(privateReply);
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    }
  });

  it("rejects header injection and oversized serialized messages before connecting", async () => {
    await expect(
      sendSmtpMail({
        body: "safe",
        from: "no-reply@nutrition.local\r\nBcc: private@example.com",
        host: "127.0.0.1",
        port: 1025,
        recipient: "ada@example.com",
        subject: "Verify email",
      }),
    ).rejects.toBeInstanceOf(EmailDeliveryConfigurationError);
    await expect(
      sendSmtpMail({
        body: "x".repeat(33 * 1_024),
        from: "no-reply@nutrition.local",
        host: "127.0.0.1",
        port: 1025,
        recipient: "ada@example.com",
        subject: "Verify email",
      }),
    ).rejects.toBeInstanceOf(EmailDeliveryConfigurationError);
  });

  it("rejects noncanonical verification URLs before connecting", async () => {
    const delivery = new LocalMailpitEmailDelivery({
      from: "no-reply@nutrition.local",
      host: "127.0.0.1",
      nodeEnv: "test",
      port: 1025,
    });
    const token = `${"a".repeat(42)}A`;
    const invalidUrls = [
      `http://127.0.0.1:3000/wrong#token=${token}`,
      `http://127.0.0.1:3000/verify-email?next=diary#token=${token}`,
      `http://127.0.0.1:3000/verify-email#token=${"a".repeat(42)}`,
      `http://127.0.0.1:3000/verify-email#token=${token}&next=diary`,
    ];

    for (const verificationUrl of invalidUrls) {
      await expect(
        delivery.sendVerificationEmail({
          expiresAt: new Date("2030-01-01T00:00:00.000Z"),
          recipient: "ada@example.com",
          verificationUrl,
        }),
      ).rejects.toBeInstanceOf(EmailDeliveryConfigurationError);
    }
  });

  it("rejects noncanonical password-recovery URLs before connecting", async () => {
    const delivery = new LocalMailpitEmailDelivery({
      from: "no-reply@nutrition.local",
      host: "127.0.0.1",
      nodeEnv: "test",
      port: 1025,
    });
    const token = `${"a".repeat(42)}A`;
    const invalidUrls = [
      `https://127.0.0.1:3000/reset-password#token=${token}`,
      `http://localhost:3000/reset-password#token=${token}`,
      `http://127.0.0.1:3000/wrong#token=${token}`,
      `http://127.0.0.1:3000/reset-password?next=login#token=${token}`,
      `http://127.0.0.1:3000/reset-password#token=${"a".repeat(42)}`,
      `http://127.0.0.1:3000/reset-password#token=${token}&next=login`,
    ];

    for (const recoveryUrl of invalidUrls) {
      await expect(
        delivery.sendPasswordRecoveryEmail({
          expiresAt: new Date("2030-01-01T00:00:00.000Z"),
          recipient: "ada@example.com",
          recoveryUrl,
        }),
      ).rejects.toBeInstanceOf(EmailDeliveryConfigurationError);
    }
  });
});
