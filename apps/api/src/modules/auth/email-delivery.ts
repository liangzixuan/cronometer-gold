import { createConnection } from "node:net";
import { createInterface } from "node:readline";

const MAX_SMTP_REPLY_BYTES = 64 * 1_024;
const MAX_SMTP_MESSAGE_BYTES = 32 * 1_024;
const DEFAULT_SMTP_TIMEOUT_MS = 5_000;
const EMAIL_PATTERN =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/u;

export interface EmailVerificationDelivery {
  sendVerificationEmail(input: {
    readonly recipient: string;
    readonly verificationUrl: string;
    readonly expiresAt: Date;
  }): Promise<void>;
}

export interface PasswordRecoveryDelivery {
  sendPasswordRecoveryEmail(input: {
    readonly recipient: string;
    readonly recoveryUrl: string;
    readonly expiresAt: Date;
  }): Promise<void>;
}

export class EmailDeliveryConfigurationError extends Error {
  override readonly name = "EmailDeliveryConfigurationError";
}

export class EmailDeliveryError extends Error {
  constructor() {
    super("Local email delivery failed");
    this.name = "EmailDeliveryError";
  }
}

export interface LocalMailpitEmailDeliveryOptions {
  readonly from: string;
  readonly host: string;
  readonly nodeEnv: "development" | "test" | "production";
  readonly port: number;
  readonly timeoutMs?: number;
}

/** Plaintext SMTP is accepted only for the exact loopback Mailpit fixture. */
export class LocalMailpitEmailDelivery
  implements EmailVerificationDelivery, PasswordRecoveryDelivery
{
  readonly #from: string;
  readonly #host: "127.0.0.1";
  readonly #port: 1025;
  readonly #timeoutMs: number;

  constructor(options: LocalMailpitEmailDeliveryOptions) {
    if (options.nodeEnv === "production") {
      throw new EmailDeliveryConfigurationError("Production email provider is not approved");
    }
    if (options.host !== "127.0.0.1" || options.port !== 1025) {
      throw new EmailDeliveryConfigurationError("Local email delivery must use loopback Mailpit");
    }
    assertHeaderValue(options.from, "from");
    envelopeAddress(options.from);
    this.#from = options.from;
    this.#host = options.host;
    this.#port = options.port;
    this.#timeoutMs = boundedTimeout(options.timeoutMs ?? DEFAULT_SMTP_TIMEOUT_MS);
  }

  async sendVerificationEmail(input: {
    readonly recipient: string;
    readonly verificationUrl: string;
    readonly expiresAt: Date;
  }): Promise<void> {
    assertEmail(input.recipient, "recipient");
    if (!Number.isFinite(input.expiresAt.getTime())) {
      throw new EmailDeliveryConfigurationError("Verification expiry is invalid");
    }
    const url = new URL(input.verificationUrl);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/verify-email" ||
      url.search !== "" ||
      !/^#token=[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u.test(url.hash)
    ) {
      throw new EmailDeliveryConfigurationError("Local verification URL is invalid");
    }
    const body = [
      "Confirm your Nutrition Tracker email address by opening this link:",
      "",
      url.toString(),
      "",
      `This link expires at ${input.expiresAt.toISOString()}.`,
      "If you did not request this message, you can ignore it.",
    ].join("\r\n");

    await sendSmtpMail({
      body,
      from: this.#from,
      host: this.#host,
      port: this.#port,
      recipient: input.recipient,
      subject: "Verify your Nutrition Tracker email",
      timeoutMs: this.#timeoutMs,
    });
  }

  async sendPasswordRecoveryEmail(input: {
    readonly recipient: string;
    readonly recoveryUrl: string;
    readonly expiresAt: Date;
  }): Promise<void> {
    assertEmail(input.recipient, "recipient");
    if (!Number.isFinite(input.expiresAt.getTime())) {
      throw new EmailDeliveryConfigurationError("Recovery expiry is invalid");
    }
    const url = new URL(input.recoveryUrl);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/reset-password" ||
      url.search !== "" ||
      !/^#token=[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u.test(url.hash)
    ) {
      throw new EmailDeliveryConfigurationError("Local recovery URL is invalid");
    }
    const body = [
      "Reset your Nutrition Tracker password by opening this one-time link:",
      "",
      url.toString(),
      "",
      `This link expires at ${input.expiresAt.toISOString()}.`,
      "If you did not request this message, you can ignore it.",
    ].join("\r\n");

    await sendSmtpMail({
      body,
      from: this.#from,
      host: this.#host,
      port: this.#port,
      recipient: input.recipient,
      subject: "Reset your Nutrition Tracker password",
      timeoutMs: this.#timeoutMs,
    });
  }
}

interface SmtpMailInput {
  readonly body: string;
  readonly from: string;
  readonly host: string;
  readonly port: number;
  readonly recipient: string;
  readonly subject: string;
  readonly timeoutMs?: number;
}

/** Exported for a loopback protocol test; callers should use the delivery class. */
export async function sendSmtpMail(input: SmtpMailInput): Promise<void> {
  assertHeaderValue(input.from, "from");
  assertHeaderValue(input.subject, "subject");
  assertEmail(input.recipient, "recipient");
  if (input.host !== "127.0.0.1") {
    throw new EmailDeliveryConfigurationError("SMTP host must be exact loopback");
  }
  if (!Number.isSafeInteger(input.port) || input.port < 1 || input.port > 65_535) {
    throw new EmailDeliveryConfigurationError("SMTP port is invalid");
  }
  const timeoutMs = boundedTimeout(input.timeoutMs ?? DEFAULT_SMTP_TIMEOUT_MS);
  const envelopeFrom = envelopeAddress(input.from);
  const message = serializeMessage(input);
  if (Buffer.byteLength(message, "utf8") > MAX_SMTP_MESSAGE_BYTES) {
    throw new EmailDeliveryConfigurationError("Email message exceeds the bounded size");
  }
  const socket = createConnection({ host: input.host, port: input.port });
  socket.setEncoding("utf8");
  let transportFailed = false;
  let rejectTransport: (error: Error) => void = () => undefined;
  const transportFailure = new Promise<never>((_resolve, reject) => {
    rejectTransport = reject;
  });
  const failTransport = () => {
    if (transportFailed) return;
    transportFailed = true;
    rejectTransport(new Error("SMTP transport failed"));
    socket.destroy();
  };
  socket.on("error", failTransport);
  let replyBytes = 0;
  socket.on("data", (chunk: string) => {
    replyBytes += Buffer.byteLength(chunk, "utf8");
    if (replyBytes > MAX_SMTP_REPLY_BYTES) failTransport();
  });
  socket.setTimeout(timeoutMs, failTransport);
  const deadline = setTimeout(failTransport, timeoutMs);
  const lines = createInterface({ input: socket, crlfDelay: Number.POSITIVE_INFINITY });
  const iterator = lines[Symbol.asyncIterator]();

  try {
    const acceptance = (async () => {
      await expectReply(iterator, [220]);
      await writeCommand(socket, "EHLO nutrition-tracker.local\r\n");
      await expectReply(iterator, [250]);
      await writeCommand(socket, `MAIL FROM:<${envelopeFrom}>\r\n`);
      await expectReply(iterator, [250]);
      await writeCommand(socket, `RCPT TO:<${input.recipient}>\r\n`);
      await expectReply(iterator, [250, 251]);
      await writeCommand(socket, "DATA\r\n");
      await expectReply(iterator, [354]);
      await writeCommand(socket, `${message}\r\n.\r\n`);
      await expectReply(iterator, [250]);
    })();
    try {
      await Promise.race([acceptance, transportFailure]);
    } catch {
      throw new EmailDeliveryError();
    }

    // The post-DATA 250 is the SMTP acceptance boundary. QUIT is courteous but
    // cannot turn an already accepted message into an application failure.
    try {
      const quit = (async () => {
        await writeCommand(socket, "QUIT\r\n");
        await expectReply(iterator, [221]);
      })();
      await Promise.race([quit, transportFailure]);
    } catch {
      // Best effort after acceptance.
    }
  } finally {
    clearTimeout(deadline);
    lines.close();
    socket.destroy();
  }
}

function serializeMessage(input: SmtpMailInput): string {
  const normalizedBody = input.body.replace(/\r?\n/gu, "\n");
  if (normalizedBody.includes("\r")) {
    throw new EmailDeliveryConfigurationError("Email body contains invalid line endings");
  }
  const dotStuffedBody = normalizedBody
    .split("\n")
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join("\r\n");
  return [
    `From: ${input.from}`,
    `To: ${input.recipient}`,
    `Subject: ${input.subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    dotStuffedBody,
  ].join("\r\n");
}

async function expectReply(
  iterator: AsyncIterator<string>,
  expectedCodes: readonly number[],
): Promise<void> {
  let responseCode: number | null = null;
  for (;;) {
    const next = await iterator.next();
    if (next.done) throw new Error("SMTP connection ended");
    const match = /^(?<code>[0-9]{3})(?<separator>[ -])/.exec(next.value);
    if (!match?.groups) throw new Error("Malformed SMTP reply");
    const code = Number(match.groups.code);
    responseCode ??= code;
    if (responseCode !== code) throw new Error("Inconsistent SMTP reply");
    if (match.groups.separator === "-") continue;
    if (!expectedCodes.includes(code)) throw new Error("Unexpected SMTP reply");
    return;
  }
}

async function writeCommand(
  socket: ReturnType<typeof createConnection>,
  command: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.write(command, "utf8", (error?: Error | null) => (error ? reject(error) : resolve()));
  });
}

function assertHeaderValue(value: string, field: string, maximumLength = 200): void {
  if (
    value.length < 1 ||
    value.length > maximumLength ||
    /[\r\n]/u.test(value) ||
    !/^[\x20-\x7e]+$/u.test(value)
  ) {
    throw new EmailDeliveryConfigurationError(`${field} header is invalid`);
  }
}

function assertEmail(value: string, field: string): void {
  assertHeaderValue(value, field, 254);
  if (value.length > 254 || !EMAIL_PATTERN.test(value)) {
    throw new EmailDeliveryConfigurationError(`${field} address is invalid`);
  }
}

function envelopeAddress(from: string): string {
  const bracketed = /<(?<address>[^<>]+)>$/u.exec(from)?.groups?.address;
  const address = bracketed ?? from;
  assertEmail(address, "from");
  return address;
}

function boundedTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 100 || value > 10_000) {
    throw new EmailDeliveryConfigurationError("SMTP timeout is invalid");
  }
  return value;
}
