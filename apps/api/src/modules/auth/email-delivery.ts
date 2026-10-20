import { X509Certificate } from "node:crypto";
import type { ClientRequest, IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import {
  HOSTED_DEVELOPMENT_PROFILE,
  HOSTED_DEVELOPMENT_WEB_ORIGIN,
} from "@nutrition-tracker/contracts";

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
  readonly profile?: typeof HOSTED_DEVELOPMENT_PROFILE;
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
  readonly #profile: typeof HOSTED_DEVELOPMENT_PROFILE | undefined;
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
    if (
      options.profile !== undefined &&
      (!Object.hasOwn(options, "profile") ||
        options.profile !== HOSTED_DEVELOPMENT_PROFILE ||
        options.nodeEnv !== "development")
    ) {
      throw new EmailDeliveryConfigurationError("Invalid hosted development email profile");
    }
    this.#profile = options.profile;
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
    await sendSmtpMail({
      ...prepareAuthMail(
        input.recipient,
        input.verificationUrl,
        input.expiresAt,
        "verification",
        this.#profile,
      ),
      from: this.#from,
      host: this.#host,
      port: this.#port,
      timeoutMs: this.#timeoutMs,
    });
  }

  async sendPasswordRecoveryEmail(input: {
    readonly recipient: string;
    readonly recoveryUrl: string;
    readonly expiresAt: Date;
  }): Promise<void> {
    await sendSmtpMail({
      ...prepareAuthMail(
        input.recipient,
        input.recoveryUrl,
        input.expiresAt,
        "recovery",
        this.#profile,
      ),
      from: this.#from,
      host: this.#host,
      port: this.#port,
      timeoutMs: this.#timeoutMs,
    });
  }
}

export const HOSTED_MAILPIT_WEB_ORIGINS = [
  HOSTED_DEVELOPMENT_WEB_ORIGIN,
  "https://staging.nourishing.app",
] as const;

export interface HostedMailpitEmailDeliveryOptions {
  readonly profile: typeof HOSTED_DEVELOPMENT_PROFILE;
  readonly nodeEnv: "development" | "test" | "production";
  readonly publicOrigin: (typeof HOSTED_MAILPIT_WEB_ORIGINS)[number];
  readonly captureUrl: string;
  readonly ca: string;
  readonly username: string;
  readonly password: string;
  readonly from: string;
  readonly timeoutMs: number;
}

/** This validates values only; runtime admission owns CA and send-only credential custody. */
export function validateHostedMailpitEmailDeliveryOptions(
  options: HostedMailpitEmailDeliveryOptions,
): void {
  if (options.nodeEnv === "production") {
    throw new EmailDeliveryConfigurationError("Production email provider is not approved");
  }
  if (
    ![
      "profile",
      "nodeEnv",
      "publicOrigin",
      "captureUrl",
      "ca",
      "username",
      "password",
      "from",
      "timeoutMs",
    ].every((field) => Object.hasOwn(options, field)) ||
    options.profile !== HOSTED_DEVELOPMENT_PROFILE ||
    options.nodeEnv !== "development" ||
    !HOSTED_MAILPIT_WEB_ORIGINS.some((origin) => origin === options.publicOrigin) ||
    options.captureUrl !== "https://mail-capture:8025/api/v1/send" ||
    !/^[A-Za-z0-9._-]{1,128}$/u.test(options.username) ||
    !/^[A-Za-z0-9_-]{32,256}$/u.test(options.password)
  ) {
    throw new EmailDeliveryConfigurationError("Invalid hosted development capture configuration");
  }
  boundedTimeout(options.timeoutMs);
  assertHeaderValue(options.from, "from");
  envelopeAddress(options.from);
  try {
    if (
      Buffer.byteLength(options.ca, "utf8") > 64 * 1_024 ||
      !/^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\r?\n?$/u.test(
        options.ca,
      ) ||
      !new X509Certificate(options.ca).ca
    ) {
      throw new Error("Invalid CA");
    }
  } catch {
    throw new EmailDeliveryConfigurationError("Capture CA certificate is invalid");
  }
}

/** One private HTTPS capture request; no SMTP fallback or ambiguous-delivery retry. */
export class HostedMailpitEmailDelivery
  implements EmailVerificationDelivery, PasswordRecoveryDelivery
{
  readonly #publicOrigin: string;
  readonly #ca: string;
  readonly #authorization: string;
  readonly #from: string;
  readonly #timeoutMs: number;

  constructor(options: HostedMailpitEmailDeliveryOptions) {
    validateHostedMailpitEmailDeliveryOptions(options);
    this.#publicOrigin = options.publicOrigin;
    this.#ca = options.ca;
    this.#authorization = `Basic ${Buffer.from(`${options.username}:${options.password}`, "utf8").toString("base64")}`;
    this.#from = envelopeAddress(options.from);
    this.#timeoutMs = options.timeoutMs;
  }

  async sendVerificationEmail(input: {
    readonly recipient: string;
    readonly verificationUrl: string;
    readonly expiresAt: Date;
  }): Promise<void> {
    await this.#send(
      prepareAuthMail(
        input.recipient,
        input.verificationUrl,
        input.expiresAt,
        "verification",
        HOSTED_DEVELOPMENT_PROFILE,
        this.#publicOrigin,
      ),
    );
  }

  async sendPasswordRecoveryEmail(input: {
    readonly recipient: string;
    readonly recoveryUrl: string;
    readonly expiresAt: Date;
  }): Promise<void> {
    await this.#send(
      prepareAuthMail(
        input.recipient,
        input.recoveryUrl,
        input.expiresAt,
        "recovery",
        HOSTED_DEVELOPMENT_PROFILE,
        this.#publicOrigin,
      ),
    );
  }

  async #send(mail: AuthMail): Promise<void> {
    const body = Buffer.from(
      JSON.stringify({
        From: { Email: this.#from },
        To: [{ Email: mail.recipient }],
        Subject: mail.subject,
        Text: mail.body,
      }),
      "utf8",
    );
    if (body.length > MAX_SMTP_MESSAGE_BYTES) {
      throw new EmailDeliveryConfigurationError("Capture message is too large");
    }
    await new Promise<void>((resolve, reject) => {
      let request: ClientRequest | undefined;
      let response: IncomingMessage | undefined;
      let settled = false;
      const finish = (accepted: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        response?.destroy();
        request?.destroy();
        if (accepted) resolve();
        else reject(new EmailDeliveryError());
      };
      const deadline = setTimeout(() => finish(false), this.#timeoutMs);
      try {
        request = httpsRequest(
          "https://mail-capture:8025/api/v1/send",
          {
            agent: false,
            ca: this.#ca,
            rejectUnauthorized: true,
            servername: "mail-capture",
            maxHeaderSize: 8 * 1_024,
            method: "POST",
            headers: {
              accept: "application/json",
              "accept-encoding": "identity",
              authorization: this.#authorization,
              "content-type": "application/json",
              "content-length": body.length,
            },
          },
          (incoming) => {
            if (settled) {
              incoming.destroy();
              return;
            }
            response = incoming;
            response.once("error", () => finish(false));
            response.once("aborted", () => finish(false));
            response.once("close", () => {
              if (!response?.complete) finish(false);
            });
            if (
              response.statusCode !== 200 ||
              !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(
                String(response.headers["content-type"] ?? ""),
              ) ||
              (response.headers["content-encoding"] !== undefined &&
                response.headers["content-encoding"] !== "identity")
            ) {
              finish(false);
              return;
            }
            const chunks: Buffer[] = [];
            let bytes = 0;
            response.on("data", (chunk: Buffer) => {
              if (settled) return;
              bytes += chunk.length;
              if (bytes > 4 * 1_024) {
                finish(false);
                return;
              }
              chunks.push(chunk);
            });
            response.once("end", () => {
              if (settled) return;
              try {
                const text = new TextDecoder("utf-8", { fatal: true }).decode(
                  Buffer.concat(chunks),
                );
                // One string member is required before JSON.parse can discard duplicate names.
                if (!/^\s*\{\s*"(?:[^"\\]|\\.)*"\s*:\s*"(?:[^"\\]|\\.)*"\s*\}\s*$/u.test(text)) {
                  finish(false);
                  return;
                }
                const decoded: unknown = JSON.parse(text);
                finish(
                  response?.complete === true &&
                    decoded !== null &&
                    typeof decoded === "object" &&
                    Object.keys(decoded).length === 1 &&
                    Object.hasOwn(decoded, "ID") &&
                    typeof (decoded as { ID: unknown }).ID === "string" &&
                    /^[A-Za-z0-9]{22}$/u.test((decoded as { ID: string }).ID),
                );
              } catch {
                finish(false);
              }
            });
          },
        );
        request.once("error", () => finish(false));
        request.end(body);
      } catch {
        finish(false);
      }
    });
  }
}

interface AuthMail {
  readonly recipient: string;
  readonly subject: string;
  readonly body: string;
}

function prepareAuthMail(
  recipient: string,
  link: string,
  expiresAt: Date,
  kind: "verification" | "recovery",
  profile?: typeof HOSTED_DEVELOPMENT_PROFILE,
  publicOrigin: string = HOSTED_DEVELOPMENT_WEB_ORIGIN,
): AuthMail {
  assertEmail(recipient, "recipient");
  if (!Number.isFinite(expiresAt.getTime())) {
    throw new EmailDeliveryConfigurationError(
      kind === "verification" ? "Verification expiry is invalid" : "Recovery expiry is invalid",
    );
  }
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw new EmailDeliveryConfigurationError("Local email URL is invalid");
  }
  const validOrigin =
    profile === HOSTED_DEVELOPMENT_PROFILE
      ? url.origin === publicOrigin && url.href === link
      : url.protocol === "http:" && url.hostname === "127.0.0.1";
  if (
    !validOrigin ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== (kind === "verification" ? "/verify-email" : "/reset-password") ||
    url.search !== "" ||
    !/^#token=[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u.test(url.hash)
  ) {
    throw new EmailDeliveryConfigurationError(
      kind === "verification"
        ? "Local verification URL is invalid"
        : "Local recovery URL is invalid",
    );
  }
  return {
    recipient,
    subject:
      kind === "verification"
        ? "Verify your Nutrition Tracker email"
        : "Reset your Nutrition Tracker password",
    body: [
      kind === "verification"
        ? "Confirm your Nutrition Tracker email address by opening this link:"
        : "Reset your Nutrition Tracker password by opening this one-time link:",
      "",
      url.toString(),
      "",
      `This link expires at ${expiresAt.toISOString()}.`,
      "If you did not request this message, you can ignore it.",
    ].join("\r\n"),
  };
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
