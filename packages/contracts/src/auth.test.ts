import { Ajv, type AnySchema } from "ajv";
import { describe, expect, it } from "vitest";

import {
  emailVerificationConfirmRequestSchema,
  emailVerificationConfirmResponseSchema,
  emailVerificationRequestResponseSchema,
} from "./auth.js";

function validator(schema: AnySchema) {
  return new Ajv({ allErrors: true, strict: true }).compile(schema);
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
