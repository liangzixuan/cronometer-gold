import { type UserProfile, userProfileSchema } from "./profile.js";

export interface AuthUser {
  readonly id: string;
  readonly email: string;
  readonly emailVerified: boolean;
}

export interface AuthSession {
  /** Opaque bearer token. This field is returned only when a session is created. */
  readonly accessToken: string;
  readonly expiresAt: string;
}

export interface AuthenticatedAccount {
  readonly user: AuthUser;
  readonly profile: UserProfile;
}

export interface SessionCreatedResponse {
  readonly data: AuthenticatedAccount & AuthSession;
}

export interface CurrentAccountResponse {
  readonly data: AuthenticatedAccount;
}

export interface AuthCredentialsRequest {
  readonly email: string;
  readonly password: string;
}

export interface RegisterAccountRequest extends AuthCredentialsRequest {
  readonly timeZone: string;
  readonly displayName?: string;
}

export interface EmailVerificationConfirmRequest {
  readonly token: string;
}

export interface EmailVerificationRequestResponse {
  readonly data: {
    readonly status: "accepted";
  };
}

export interface EmailVerificationConfirmResponse {
  readonly data: {
    readonly verified: true;
  };
}

const uuidSchema = {
  type: "string",
  pattern:
    "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
} as const;

const emailSchema = {
  type: "string",
  minLength: 3,
  maxLength: 254,
  format: "email",
} as const;

export const authCredentialsRequestSchema = {
  $id: "AuthCredentialsRequest",
  type: "object",
  additionalProperties: false,
  required: ["email", "password"],
  properties: {
    email: emailSchema,
    password: { type: "string", minLength: 12, maxLength: 128 },
  },
} as const;

export const registerAccountRequestSchema = {
  $id: "RegisterAccountRequest",
  type: "object",
  additionalProperties: false,
  required: ["email", "password", "timeZone"],
  properties: {
    email: emailSchema,
    password: { type: "string", minLength: 12, maxLength: 128 },
    timeZone: { type: "string", minLength: 1, maxLength: 63 },
    displayName: { type: "string", minLength: 1, maxLength: 100 },
  },
} as const;

export const emailVerificationConfirmRequestSchema = {
  $id: "EmailVerificationConfirmRequest",
  type: "object",
  additionalProperties: false,
  required: ["token"],
  properties: {
    token: {
      type: "string",
      minLength: 43,
      maxLength: 43,
      pattern: "^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$",
    },
  },
} as const;

export const emailVerificationRequestResponseSchema = {
  $id: "EmailVerificationRequestResponse",
  type: "object",
  additionalProperties: false,
  required: ["data"],
  properties: {
    data: {
      type: "object",
      additionalProperties: false,
      required: ["status"],
      properties: {
        status: { type: "string", const: "accepted" },
      },
    },
  },
} as const;

export const emailVerificationConfirmResponseSchema = {
  $id: "EmailVerificationConfirmResponse",
  type: "object",
  additionalProperties: false,
  required: ["data"],
  properties: {
    data: {
      type: "object",
      additionalProperties: false,
      required: ["verified"],
      properties: {
        verified: { type: "boolean", const: true },
      },
    },
  },
} as const;

export const authUserSchema = {
  $id: "AuthUser",
  type: "object",
  additionalProperties: false,
  required: ["id", "email", "emailVerified"],
  properties: {
    id: uuidSchema,
    email: emailSchema,
    emailVerified: { type: "boolean" },
  },
} as const;

export const sessionCreatedResponseSchema = {
  $id: "SessionCreatedResponse",
  type: "object",
  additionalProperties: false,
  required: ["data"],
  properties: {
    data: {
      type: "object",
      additionalProperties: false,
      required: ["accessToken", "expiresAt", "user", "profile"],
      properties: {
        accessToken: {
          type: "string",
          minLength: 43,
          maxLength: 128,
          pattern: "^[A-Za-z0-9_-]+$",
        },
        expiresAt: { type: "string", format: "date-time" },
        user: authUserSchema,
        profile: userProfileSchema,
      },
    },
  },
} as const;

export const currentAccountResponseSchema = {
  $id: "CurrentAccountResponse",
  type: "object",
  additionalProperties: false,
  required: ["data"],
  properties: {
    data: {
      type: "object",
      additionalProperties: false,
      required: ["user", "profile"],
      properties: {
        user: authUserSchema,
        profile: userProfileSchema,
      },
    },
  },
} as const;
