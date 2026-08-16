import { createHash, randomBytes } from "node:crypto";

import type {
  AuthenticatedAccount,
  RegisterAccountRequest,
  SessionCreatedResponse,
} from "@nutrition-tracker/contracts";
import { canonicalIanaTimeZone } from "@nutrition-tracker/domain";

import {
  hashPassword,
  PASSWORD_SCRYPT_PARAMETERS,
  PasswordWorkQueue,
  PasswordWorkQueueFullError,
  verifyPassword,
} from "./password.js";
import { BoundedAuthRateLimiter } from "./rate-limiter.js";

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
  }): Promise<void>;
  findActiveSession(tokenHash: string, now: Date): Promise<AuthenticatedAccount | null>;
  revokeSession(input: { readonly userId: string; readonly tokenHash: string }): Promise<boolean>;
}

export interface AuthPrincipal {
  readonly userId: string;
  readonly account: AuthenticatedAccount;
}

export interface AuthService {
  register(input: RegisterAccountRequest): Promise<SessionCreatedResponse>;
  login(email: string, password: string): Promise<SessionCreatedResponse>;
  authenticate(authorizationHeader: string | undefined): Promise<AuthPrincipal | null>;
  logout(authorizationHeader: string | undefined, userId: string): Promise<void>;
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
  readonly #dummySalt = randomBytes(16).toString("base64url");
  readonly #dummyHash = randomBytes(PASSWORD_SCRYPT_PARAMETERS.keyLength).toString("base64url");

  constructor(options: {
    repository: AuthRepository;
    queue?: PasswordWorkQueue;
    limiter?: BoundedAuthRateLimiter;
    sessionTtlMs?: number;
    clock?: () => Date;
  }) {
    this.#repository = options.repository;
    this.#queue = options.queue ?? new PasswordWorkQueue();
    this.#limiter = options.limiter ?? new BoundedAuthRateLimiter();
    this.#sessionTtlMs = options.sessionTtlMs ?? 30 * 24 * 60 * 60_000;
    this.#clock = options.clock ?? (() => new Date());
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
    this.#limiter.reset(key);
    return this.#createSession(account);
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

    this.#limiter.reset(key);
    return this.#createSession(credential.account);
  }

  async authenticate(authorizationHeader: string | undefined): Promise<AuthPrincipal | null> {
    const token = bearerToken(authorizationHeader);
    if (!token) return null;
    const account = await this.#repository.findActiveSession(sha256(token), this.#clock());
    return account ? { userId: account.user.id, account } : null;
  }

  async logout(authorizationHeader: string | undefined, userId: string): Promise<void> {
    const token = bearerToken(authorizationHeader);
    if (!token) return;
    await this.#repository.revokeSession({ userId, tokenHash: sha256(token) });
  }

  async #createSession(account: AuthenticatedAccount): Promise<SessionCreatedResponse> {
    const accessToken = randomBytes(32).toString("base64url");
    const expiresAt = new Date(this.#clock().getTime() + this.#sessionTtlMs);
    await this.#repository.createSession({
      userId: account.user.id,
      tokenHash: sha256(accessToken),
      expiresAt,
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
