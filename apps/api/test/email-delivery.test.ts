import { createServer, type Server, type Socket } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  EmailDeliveryConfigurationError,
  EmailDeliveryError,
  LocalMailpitEmailDelivery,
  sendSmtpMail,
} from "../src/modules/auth/email-delivery.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );
});

async function listen(connection: (socket: Socket) => void): Promise<number> {
  const server = createServer(connection);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
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
});
