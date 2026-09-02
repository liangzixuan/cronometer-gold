import { createHash, randomBytes } from "node:crypto";

import type {
  AuthenticatedAccount,
  EmailVerificationConfirmResponse,
  EmailVerificationRequestResponse,
  PasswordRecoveryConfirmResponse,
  PasswordRecoveryRequestResponse,
  ReauthenticationResponse,
  RegisterAccountRequest,
  SessionCreatedResponse,
} from "@nutrition-tracker/contracts";
import { canonicalIanaTimeZone } from "@nutrition-tracker/domain";
import type { EmailVerificationDelivery, PasswordRecoveryDelivery } from "./email-delivery.js";
import {
  hashPassword,
  PASSWORD_SCRYPT_PARAMETERS,
  PasswordWorkQueue,
  PasswordWorkQueueFullError,
  verifyPassword,
} from "./password.js";
import { BoundedAuthRateLimiter } from "./rate-limiter.js";

export const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60_000;
export const PASSWORD_RECOVERY_TTL_MS = 60 * 60_000;

export interface PasswordCredential {
  readonly account: AuthenticatedAccount;
  readonly passwordHash: string;
  readonly passwordSalt: string;
  readonly passwordParameters: Readonly<Record<string, unknown>>;
}

export interface AuthRepository {
  register(input: {
    readonly email: string;
    readonly passwordHash: string;
    readonly passwordSalt: string;
    readonly passwordParameters: Readonly<Record<string, unknown>>;
    readonly timeZone: string;
    readonly displayName?: string;
  }): Promise<AuthenticatedAccount>;
  findPasswordCredential(normalizedEmail: string): Promise<PasswordCredential | null>;
  createSession(input: {
    readonly userId: string;
    readonly tokenHash: string;
    readonly expiresAt: Date;
    readonly expectedPasswordHash?: string;
  }): Promise<void>;
  findActiveSession(tokenHash: string, now: Date): Promise<AuthenticatedAccount | null>;
  findPendingErasureRecoverySession(
    tokenHash: string,
    now: Date,
  ): Promise<{
    readonly account: AuthenticatedAccount;
    readonly erasureJobId: string;
    readonly executeAfter: Date;
  } | null>;
  revokeSession(input: { readonly userId: string; readonly tokenHash: string }): Promise<boolean>;
  createReauthenticationProof(input: {
    readonly userId: string;
    readonly sessionTokenHash: string;
    readonly purpose: "account_export" | "account_erasure";
    readonly tokenHash: string;
    readonly expiresAt: Date;
    readonly expectedPasswordHash: string;
  }): Promise<void>;
  issueEmailVerificationToken(input: {
    readonly userId: string;
    readonly tokenHash: string;
    readonly emailHash: string;
    readonly issuedAt: Date;
    readonly expiresAt: Date;
    readonly deliver: () => Promise<void>;
  }): Promise<"already_verified" | "issued">;
  confirmEmailVerificationToken(input: {
    readonly tokenHash: string;
    readonly confirmedAt: Date;
    readonly requestId: string;
  }): Promise<void>;
  issuePasswordRecoveryToken(input: {
    readonly normalizedEmail: string;
    readonly tokenHash: string;
    readonly emailHash: string;
    readonly issuedAt: Date;
    readonly expiresAt: Date;
    readonly deliver: () => Promise<void>;
  }): Promise<"ineligible" | "issued">;
  confirmPasswordRecoveryToken(input: {
    readonly tokenHash: string;
    readonly passwordHash: string;
    readonly passwordSalt: string;
    readonly passwordParameters: Readonly<Record<string, unknown>>;
    readonly confirmedAt: Date;
    readonly requestId: string;
  }): Promise<void>;
}

export interface AuthPrincipal {
  readonly userId: string;
  readonly account: AuthenticatedAccount;
  readonly sessionTokenHash: string;
}

export interface ErasureRecoveryPrincipal extends AuthPrincipal {
  readonly erasureJobId: string;
  readonly executeAfter: Date;
}

export interface AuthService {
  register(input: RegisterAccountRequest): Promise<SessionCreatedResponse>;
  login(email: string, password: string): Promise<SessionCreatedResponse>;
  authenticate(authorizationHeader: string | undefined): Promise<AuthPrincipal | null>;
  /** Accepted only by the exact account-erasure POST replay route. */
  authenticateErasureRecovery(
    authorizationHeader: string | undefined,
  ): Promise<ErasureRecoveryPrincipal | null>;
  logout(authorizationHeader: string | undefined, userId: string): Promise<void>;
  reauthenticate(
    userId: string,
    sessionTokenHash: string,
    normalizedEmail: string,
    password: string,
    purpose: "account_export" | "account_erasure",
  ): Promise<ReauthenticationResponse>;
  requestEmailVerification(
    account: AuthenticatedAccount,
  ): Promise<EmailVerificationRequestResponse>;
  confirmEmailVerification(
    token: string,
    requestId: string,
  ): Promise<EmailVerificationConfirmResponse>;
  requestPasswordRecovery(email: string): Promise<PasswordRecoveryRequestResponse>;
  confirmPasswordRecovery(
    token: string,
    newPassword: string,
    requestId: string,
  ): Promise<PasswordRecoveryConfirmResponse>;
}

export class InvalidCredentialsError extends Error {
  constructor() {
    super("Invalid credentials");
    this.name = "InvalidCredentialsError";
  }
}

export class AuthRateLimitedError extends Error {
  constructor() {
    super("Authentication rate limit exceeded");
    this.name = "AuthRateLimitedError";
  }
}

export class AccountAlreadyExistsError extends Error {
  constructor() {
    super("Account already exists");
    this.name = "AccountAlreadyExistsError";
  }
}

export class EmailVerificationUnavailableError extends Error {
  constructor() {
    super("Email verification is unavailable");
    this.name = "EmailVerificationUnavailableError";
  }
}

export class EmailVerificationTokenInvalidError extends Error {
  constructor() {
    super("Email verification token is invalid");
    this.name = "EmailVerificationTokenInvalidError";
  }
}

export class EmailVerificationTokenExpiredError extends Error {
  constructor() {
    super("Email verification token is expired");
    this.name = "EmailVerificationTokenExpiredError";
  }
}

export class PasswordRecoveryTokenInvalidError extends Error {
  constructor() {
    super("Password recovery token is invalid");
    this.name = "PasswordRecoveryTokenInvalidError";
  }
}

export class PasswordRecoveryTokenExpiredError extends Error {
  constructor() {
    super("Password recovery token is expired");
    this.name = "PasswordRecoveryTokenExpiredError";
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function normalizeEmail(email: string): string {
  return email.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

export function canonicalizeTimeZone(value: string): string {
  try {
    return canonicalIanaTimeZone(value.normalize("NFKC"));
  } catch {
    throw new RangeError("Invalid time zone");
  }
}

function validatePassword(password: string): void {
  const length = [...password].length;
  if (length < 12 || length > 128 || Buffer.byteLength(password, "utf8") > 512) {
    throw new RangeError("Invalid password length");
  }
}

function validatedEmail(emailInput: string): string {
  const email = normalizeEmail(emailInput);
  if (
    email.length < 3 ||
    email.length > 254 ||
    !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/u.test(
      email,
    )
  ) {
    throw new RangeError("Invalid email");
  }
  return email;
}

function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer ([A-Za-z0-9_-]{43,128})$/.exec(header);
  return match?.[1] ?? null;
}

export class SecureAuthService implements AuthService {
  readonly #repository: AuthRepository;
  readonly #queue: PasswordWorkQueue;
  readonly #limiter: BoundedAuthRateLimiter;
  readonly #sessionTtlMs: number;
  readonly #clock: () => Date;
  readonly #reauthenticationTtlMs: number;
  readonly #emailVerificationDelivery: EmailVerificationDelivery | null;
  readonly #emailVerificationPublicOrigin: string | null;
  readonly #emailVerificationTtlMs: number;
  readonly #emailVerificationLimiter: BoundedAuthRateLimiter;
  readonly #passwordRecoveryDelivery: PasswordRecoveryDelivery | null;
  readonly #passwordRecoveryPublicOrigin: string | null;
  readonly #passwordRecoveryTtlMs: number;
  readonly #passwordRecoveryRequestLimiter: BoundedAuthRateLimiter;
  readonly #passwordRecoveryConfirmLimiter: BoundedAuthRateLimiter;
  readonly #dummySalt = randomBytes(16).toString("base64url");
  readonly #dummyHash = randomBytes(PASSWORD_SCRYPT_PARAMETERS.keyLength).toString("base64url");

  constructor(options: {
    repository: AuthRepository;
    queue?: PasswordWorkQueue;
    limiter?: BoundedAuthRateLimiter;
    sessionTtlMs?: number;
    clock?: () => Date;
    reauthenticationTtlMs?: number;
    emailVerificationDelivery?: EmailVerificationDelivery;
    emailVerificationPublicOrigin?: string;
    emailVerificationTtlMs?: number;
    emailVerificationLimiter?: BoundedAuthRateLimiter;
    passwordRecoveryDelivery?: PasswordRecoveryDelivery;
    passwordRecoveryPublicOrigin?: string;
    passwordRecoveryTtlMs?: number;
    passwordRecoveryRequestLimiter?: BoundedAuthRateLimiter;
    passwordRecoveryConfirmLimiter?: BoundedAuthRateLimiter;
  }) {
    this.#repository = options.repository;
    this.#queue = options.queue ?? new PasswordWorkQueue();
    this.#limiter = options.limiter ?? new BoundedAuthRateLimiter();
    this.#sessionTtlMs = options.sessionTtlMs ?? 30 * 24 * 60 * 60_000;
    this.#clock = options.clock ?? (() => new Date());
    this.#reauthenticationTtlMs = options.reauthenticationTtlMs ?? 10 * 60_000;
    this.#emailVerificationDelivery = options.emailVerificationDelivery ?? null;
    this.#emailVerificationPublicOrigin = options.emailVerificationPublicOrigin ?? null;
    this.#emailVerificationTtlMs = options.emailVerificationTtlMs ?? EMAIL_VERIFICATION_TTL_MS;
    this.#emailVerificationLimiter =
      options.emailVerificationLimiter ??
      new BoundedAuthRateLimiter({ maximumAttempts: 5, windowMs: 15 * 60_000 });
    this.#passwordRecoveryDelivery = options.passwordRecoveryDelivery ?? null;
    this.#passwordRecoveryPublicOrigin = options.passwordRecoveryPublicOrigin ?? null;
    this.#passwordRecoveryTtlMs = options.passwordRecoveryTtlMs ?? PASSWORD_RECOVERY_TTL_MS;
    this.#passwordRecoveryRequestLimiter =
      options.passwordRecoveryRequestLimiter ??
      new BoundedAuthRateLimiter({ maximumAttempts: 5, windowMs: 15 * 60_000 });
    this.#passwordRecoveryConfirmLimiter =
      options.passwordRecoveryConfirmLimiter ??
      new BoundedAuthRateLimiter({ maximumAttempts: 10, windowMs: 15 * 60_000 });
  }

  async register(input: RegisterAccountRequest): Promise<SessionCreatedResponse> {
    validatePassword(input.password);
    const email = normalizeEmail(input.email);
    const timeZone = canonicalizeTimeZone(input.timeZone);
    const displayName = input.displayName?.normalize("NFKC").trim();
    if (
      displayName !== undefined &&
      (displayName.length === 0 || Buffer.byteLength(displayName, "utf8") > 300)
    ) {
      throw new RangeError("Invalid display name");
    }
    const key = `register:${sha256(email)}`;
    if (!this.#limiter.consume(key, this.#clock().getTime())) throw new AuthRateLimitedError();

    const salt = randomBytes(16);
    const passwordHash = await this.#runPasswordWork(() =>
      hashPassword(input.password, salt, this.#queue),
    );
    const account = await this.#repository.register({
      email,
      passwordHash,
      passwordSalt: salt.toString("base64url"),
      passwordParameters: PASSWORD_SCRYPT_PARAMETERS,
      timeZone,
      ...(displayName === undefined ? {} : { displayName }),
    });
    const session = await this.#createSession(account, passwordHash);
    this.#limiter.reset(key);
    return session;
  }

  async login(emailInput: string, password: string): Promise<SessionCreatedResponse> {
    validatePassword(password);
    const email = normalizeEmail(emailInput);
    const key = `login:${sha256(email)}`;
    if (!this.#limiter.consume(key, this.#clock().getTime())) throw new AuthRateLimitedError();

    const credential = await this.#repository.findPasswordCredential(email);
    const valid = await this.#runPasswordWork(() =>
      verifyPassword(
        password,
        credential?.passwordSalt ?? this.#dummySalt,
        credential?.passwordHash ?? this.#dummyHash,
        credential?.passwordParameters ?? PASSWORD_SCRYPT_PARAMETERS,
        this.#queue,
      ),
    );
    if (!credential || !valid) throw new InvalidCredentialsError();

    const session = await this.#createSession(credential.account, credential.passwordHash);
    this.#limiter.reset(key);
    return session;
  }

  async authenticate(authorizationHeader: string | undefined): Promise<AuthPrincipal | null> {
    const token = bearerToken(authorizationHeader);
    if (!token) return null;
    const account = await this.#repository.findActiveSession(sha256(token), this.#clock());
    const sessionTokenHash = sha256(token);
    return account ? { userId: account.user.id, account, sessionTokenHash } : null;
  }

  async authenticateErasureRecovery(
    authorizationHeader: string | undefined,
  ): Promise<ErasureRecoveryPrincipal | null> {
    const token = bearerToken(authorizationHeader);
    if (!token) return null;
    const sessionTokenHash = sha256(token);
    const recovery = await this.#repository.findPendingErasureRecoverySession(
      sessionTokenHash,
      this.#clock(),
    );
    return recovery
      ? {
          account: recovery.account,
          erasureJobId: recovery.erasureJobId,
          executeAfter: recovery.executeAfter,
          sessionTokenHash,
          userId: recovery.account.user.id,
        }
      : null;
  }

  async logout(authorizationHeader: string | undefined, userId: string): Promise<void> {
    const token = bearerToken(authorizationHeader);
    if (!token) return;
    await this.#repository.revokeSession({ userId, tokenHash: sha256(token) });
  }

  async reauthenticate(
    userId: string,
    sessionTokenHash: string,
    normalizedEmail: string,
    password: string,
    purpose: "account_export" | "account_erasure",
  ): Promise<ReauthenticationResponse> {
    validatePassword(password);
    const email = normalizeEmail(normalizedEmail);
    const key = `reauthenticate:${sha256(userId)}`;
    if (!this.#limiter.consume(key, this.#clock().getTime())) throw new AuthRateLimitedError();
    const credential = await this.#repository.findPasswordCredential(email);
    const valid = await this.#runPasswordWork(() =>
      verifyPassword(
        password,
        credential?.passwordSalt ?? this.#dummySalt,
        credential?.passwordHash ?? this.#dummyHash,
        credential?.passwordParameters ?? PASSWORD_SCRYPT_PARAMETERS,
        this.#queue,
      ),
    );
    if (!credential || credential.account.user.id !== userId || !valid) {
      throw new InvalidCredentialsError();
    }
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(this.#clock().getTime() + this.#reauthenticationTtlMs);
    await this.#repository.createReauthenticationProof({
      userId,
      sessionTokenHash,
      purpose,
      tokenHash: sha256(token),
      expiresAt,
      expectedPasswordHash: credential.passwordHash,
    });
    this.#limiter.reset(key);
    return { data: { reauthenticationToken: token, expiresAt: expiresAt.toISOString() } };
  }

  async requestEmailVerification(
    account: AuthenticatedAccount,
  ): Promise<EmailVerificationRequestResponse> {
    if (account.user.emailVerified) return { data: { status: "accepted" } };
    if (!this.#emailVerificationDelivery || !this.#emailVerificationPublicOrigin) {
      throw new EmailVerificationUnavailableError();
    }
    const limiterKey = `email-verification-request:${sha256(account.user.id)}`;
    const issuedAt = this.#clock();
    if (!this.#emailVerificationLimiter.consume(limiterKey, issuedAt.getTime())) {
      throw new AuthRateLimitedError();
    }

    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(issuedAt.getTime() + this.#emailVerificationTtlMs);
    const email = normalizeEmail(account.user.email);
    const verificationUrl = new URL("/verify-email", this.#emailVerificationPublicOrigin);
    verificationUrl.hash = `token=${token}`;
    try {
      await this.#repository.issueEmailVerificationToken({
        deliver: () =>
          this.#emailVerificationDelivery?.sendVerificationEmail({
            expiresAt,
            recipient: email,
            verificationUrl: verificationUrl.toString(),
          }) ?? Promise.reject(new EmailVerificationUnavailableError()),
        emailHash: sha256(email),
        expiresAt,
        issuedAt,
        tokenHash: sha256(token),
        userId: account.user.id,
      });
    } catch {
      throw new EmailVerificationUnavailableError();
    }
    return { data: { status: "accepted" } };
  }

  async confirmEmailVerification(
    token: string,
    requestId: string,
  ): Promise<EmailVerificationConfirmResponse> {
    if (!/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u.test(token)) {
      throw new EmailVerificationTokenInvalidError();
    }
    await this.#repository.confirmEmailVerificationToken({
      confirmedAt: this.#clock(),
      requestId,
      tokenHash: sha256(token),
    });
    return { data: { verified: true } };
  }

  async requestPasswordRecovery(emailInput: string): Promise<PasswordRecoveryRequestResponse> {
    const email = validatedEmail(emailInput);
    const issuedAt = this.#clock();
    const limiterKey = `password-recovery-request:${sha256(email)}`;
    if (!this.#passwordRecoveryRequestLimiter.consume(limiterKey, issuedAt.getTime())) {
      return { data: { status: "accepted" } };
    }
    if (!this.#passwordRecoveryDelivery || !this.#passwordRecoveryPublicOrigin) {
      return { data: { status: "accepted" } };
    }

    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(issuedAt.getTime() + this.#passwordRecoveryTtlMs);
    const recoveryUrl = new URL("/reset-password", this.#passwordRecoveryPublicOrigin);
    recoveryUrl.hash = `token=${token}`;
    try {
      await this.#repository.issuePasswordRecoveryToken({
        deliver: () =>
          this.#passwordRecoveryDelivery?.sendPasswordRecoveryEmail({
            expiresAt,
            recipient: email,
            recoveryUrl: recoveryUrl.toString(),
          }) ?? Promise.reject(new Error("Password recovery delivery is unavailable")),
        emailHash: sha256(email),
        expiresAt,
        issuedAt,
        normalizedEmail: email,
        tokenHash: sha256(token),
      });
    } catch {
      // Every target-dependent outcome retains the same public acknowledgement.
    }
    return { data: { status: "accepted" } };
  }

  async confirmPasswordRecovery(
    token: string,
    newPassword: string,
    requestId: string,
  ): Promise<PasswordRecoveryConfirmResponse> {
    if (!/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u.test(token)) {
      throw new RangeError("Invalid password recovery token");
    }
    validatePassword(newPassword);
    const tokenHash = sha256(token);
    const limiterKey = `password-recovery-confirm:${tokenHash}`;
    if (!this.#passwordRecoveryConfirmLimiter.consume(limiterKey, this.#clock().getTime())) {
      throw new AuthRateLimitedError();
    }
    const salt = randomBytes(16);
    const passwordHash = await this.#runPasswordWork(() =>
      hashPassword(newPassword, salt, this.#queue),
    );
    await this.#repository.confirmPasswordRecoveryToken({
      confirmedAt: this.#clock(),
      passwordHash,
      passwordParameters: PASSWORD_SCRYPT_PARAMETERS,
      passwordSalt: salt.toString("base64url"),
      requestId,
      tokenHash,
    });
    this.#passwordRecoveryConfirmLimiter.reset(limiterKey);
    return { data: { passwordReset: true } };
  }

  async #createSession(
    account: AuthenticatedAccount,
    expectedPasswordHash?: string,
  ): Promise<SessionCreatedResponse> {
    const accessToken = randomBytes(32).toString("base64url");
    const expiresAt = new Date(this.#clock().getTime() + this.#sessionTtlMs);
    await this.#repository.createSession({
      userId: account.user.id,
      tokenHash: sha256(accessToken),
      expiresAt,
      ...(expectedPasswordHash ? { expectedPasswordHash } : {}),
    });
    return { data: { accessToken, expiresAt: expiresAt.toISOString(), ...account } };
  }

  async #runPasswordWork<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof PasswordWorkQueueFullError) throw new AuthRateLimitedError();
      throw error;
    }
  }
}
