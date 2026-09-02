import { describe, expect, it, vi } from "vitest";

import {
  normalizePasswordRecoveryEmail,
  PASSWORD_RECOVERY_ACCEPTED_MESSAGE,
  type PasswordRecoveryFetch,
  PasswordRecoveryRequestError,
  requestPasswordRecovery,
} from "./password-recovery";

const apiBase = new URL("https://api.example.test");

describe("mobile password-recovery request", () => {
  it("sends only the normalized public email with no authentication or recovery capability", async () => {
    const fetcher = vi.fn<PasswordRecoveryFetch>(async () =>
      Response.json({ data: { status: "accepted" } }, { status: 202 }),
    );
    const controller = new AbortController();

    await requestPasswordRecovery(apiBase, "  ADA@Example.Test  ", {
      fetcher,
      signal: controller.signal,
    });

    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe("https://api.example.test/v1/auth/password-recovery/request");
    expect(init?.method).toBe("POST");
    expect(init?.signal).toBe(controller.signal);
    const headers = new Headers(init?.headers);
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.has("authorization")).toBe(false);
    expect(init).not.toHaveProperty("credentials");
    expect(JSON.parse(String(init?.body))).toEqual({ email: "ada@example.test" });
    expect(String(init?.body)).not.toMatch(/token|password|session/iu);
  });

  it("rejects invalid email locally without making a network request", async () => {
    const fetcher = vi.fn<PasswordRecoveryFetch>();
    await expect(requestPasswordRecovery(apiBase, "not-an-email", { fetcher })).rejects.toThrow(
      "Enter a valid email address.",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("normalizes compatibility characters before validating the exact address", () => {
    expect(normalizePasswordRecoveryEmail(" ＡＤＡ@example.test ")).toBe("ada@example.test");
  });

  it("requires the exact closed 202 acknowledgement", async () => {
    const extraField = vi.fn<PasswordRecoveryFetch>(async () =>
      Response.json({ data: { status: "accepted", token: "must-not-appear" } }, { status: 202 }),
    );
    await expect(
      requestPasswordRecovery(apiBase, "ada@example.test", { fetcher: extraField }),
    ).rejects.toBeInstanceOf(PasswordRecoveryRequestError);

    const wrongStatus = vi.fn<PasswordRecoveryFetch>(async () =>
      Response.json({ data: { status: "accepted" } }, { status: 200 }),
    );
    await expect(
      requestPasswordRecovery(apiBase, "ada@example.test", { fetcher: wrongStatus }),
    ).rejects.toBeInstanceOf(PasswordRecoveryRequestError);
  });

  it("does not expose account-dependent upstream error details", async () => {
    const fetcher = vi.fn<PasswordRecoveryFetch>(async () =>
      Response.json({ detail: "The account exists but SMTP delivery failed." }, { status: 503 }),
    );
    const caught = await requestPasswordRecovery(apiBase, "ada@example.test", { fetcher }).catch(
      (error: unknown) => error,
    );
    expect(caught).toBeInstanceOf(PasswordRecoveryRequestError);
    expect((caught as Error).message).toBe(
      "Password recovery could not be requested. Please try again.",
    );
    expect((caught as Error).message).not.toMatch(/exists|SMTP/iu);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("rejects a declared response larger than 4 KiB without reading it", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
      start() {
        // The declared length rejects before a read is requested.
      },
    });
    const fetcher = vi.fn<PasswordRecoveryFetch>(
      async () => new Response(stream, { headers: { "content-length": "4097" }, status: 202 }),
    );

    await expect(
      requestPasswordRecovery(apiBase, "ada@example.test", { fetcher }),
    ).rejects.toBeInstanceOf(PasswordRecoveryRequestError);
    await vi.waitFor(() => expect(cancelled).toBe(true));
  });

  it("cancels a chunked response as soon as it crosses the 4 KiB limit", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
      start(controller) {
        controller.enqueue(new Uint8Array(4_097));
      },
    });
    const fetcher = vi.fn<PasswordRecoveryFetch>(async () => new Response(stream, { status: 202 }));

    await expect(
      requestPasswordRecovery(apiBase, "ada@example.test", { fetcher }),
    ).rejects.toBeInstanceOf(PasswordRecoveryRequestError);
    expect(cancelled).toBe(true);
  });

  it("uses copy that never confirms whether an account exists", () => {
    expect(PASSWORD_RECOVERY_ACCEPTED_MESSAGE).toMatch(/if the email belongs/iu);
    expect(PASSWORD_RECOVERY_ACCEPTED_MESSAGE).not.toMatch(/account exists|email sent/iu);
  });
});
