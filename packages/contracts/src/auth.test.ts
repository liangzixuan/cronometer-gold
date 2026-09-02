import { Ajv, type AnySchema } from "ajv";
import * as addFormatsModule from "ajv-formats";
import { describe, expect, it } from "vitest";

import {
  emailVerificationConfirmRequestSchema,
  emailVerificationConfirmResponseSchema,
  emailVerificationRequestResponseSchema,
  passwordRecoveryConfirmRequestSchema,
  passwordRecoveryConfirmResponseSchema,
  passwordRecoveryRequestResponseSchema,
  passwordRecoveryRequestSchema,
} from "./auth.js";

const addFormats = addFormatsModule.default as unknown as (ajv: Ajv) => Ajv;

function validator(schema: AnySchema) {
  const ajv = new Ajv({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

describe("email-verification contract schemas", () => {
  it("accepts only an exact 32-byte base64url token representation", () => {
    const validate = validator(emailVerificationConfirmRequestSchema);
    expect(validate({ token: `${"a".repeat(42)}A` })).toBe(true);
    expect(validate({ token: "a".repeat(42) })).toBe(false);
    expect(validate({ token: "a".repeat(43) })).toBe(false);
    expect(validate({ token: `${"a".repeat(42)}=` })).toBe(false);
    expect(validate({ token: `${"a".repeat(42)}A`, email: "private@example.com" })).toBe(false);
  });

  it("keeps request and confirmation success responses closed", () => {
    const validateRequest = validator(emailVerificationRequestResponseSchema);
    const validateConfirm = validator(emailVerificationConfirmResponseSchema);
    expect(validateRequest({ data: { status: "accepted" } })).toBe(true);
    expect(validateRequest({ data: { status: "sent" } })).toBe(false);
    expect(validateConfirm({ data: { verified: true } })).toBe(true);
    expect(validateConfirm({ data: { verified: false } })).toBe(false);
  });
});

describe("password-recovery contract schemas", () => {
  it("keeps public request and confirmation bodies closed and bounded", () => {
    const validateRequest = validator(passwordRecoveryRequestSchema);
    const validateConfirm = validator(passwordRecoveryConfirmRequestSchema);
    const token = `${"r".repeat(42)}A`;

    expect(validateRequest({ email: "ada@example.com" })).toBe(true);
    expect(validateRequest({ email: "ada@example.com", accountId: "private" })).toBe(false);
    expect(validateConfirm({ newPassword: "new recovery password", token })).toBe(true);
    expect(validateConfirm({ newPassword: "too short", token })).toBe(false);
    expect(validateConfirm({ newPassword: "new recovery password", token: "r".repeat(43) })).toBe(
      false,
    );
    expect(
      validateConfirm({
        newPassword: "new recovery password",
        token,
        email: "private@example.com",
      }),
    ).toBe(false);
  });

  it("keeps request and confirmation success responses exact", () => {
    const validateRequest = validator(passwordRecoveryRequestResponseSchema);
    const validateConfirm = validator(passwordRecoveryConfirmResponseSchema);

    expect(validateRequest({ data: { status: "accepted" } })).toBe(true);
    expect(validateRequest({ data: { status: "sent" } })).toBe(false);
    expect(validateConfirm({ data: { passwordReset: true } })).toBe(true);
    expect(validateConfirm({ data: { passwordReset: false } })).toBe(false);
    expect(validateConfirm({ data: { passwordReset: true, accessToken: "secret" } })).toBe(false);
  });
});
