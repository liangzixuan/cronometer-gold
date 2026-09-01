import { describe, expect, it, vi } from "vitest";

import {
  acceptEmailVerificationSessionUpdate,
  createEmailVerificationActionFence,
  type EmailVerificationFetch,
  EmailVerificationUnauthorizedError,
  loadEmailVerificationSession,
  requestAndReconcileEmailVerification,
  requestEmailVerification,
} from "./email-verification";

const apiBase = new URL("https://api.example.test");
const accessToken = "a".repeat(43);
const profile = {
  displayName: "Ada",
  locale: "en-US",
  timeZone: "America/Chicago",
  unitSystem: "metric",
  revision: "1",
};

describe("mobile email verification", () => {
  it("single-flights resend and status refresh behind one action fence", async () => {
    const fence = createEmailVerificationActionFence();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const firstAction = vi.fn(async () => gate);
    const racingAction = vi.fn(async () => undefined);

    const first = fence.run(firstAction);
    const racing = fence.run(racingAction);
    await Promise.resolve();
    expect(fence.busy()).toBe(true);
    expect(racing).toBe(first);
    expect(firstAction).toHaveBeenCalledOnce();
    expect(racingAction).not.toHaveBeenCalled();

    release?.();
    await first;
    expect(fence.busy()).toBe(false);
    await fence.run(racingAction);
    expect(racingAction).toHaveBeenCalledOnce();
  });

  it("releases the action fence after a synchronous throw", async () => {
    const fence = createEmailVerificationActionFence();
    await expect(
      fence.run(() => {
        throw new Error("synchronous failure");
      }),
    ).rejects.toThrow("synchronous failure");
    expect(fence.busy()).toBe(false);

    const recovery = vi.fn(async () => undefined);
    await fence.run(recovery);
    expect(recovery).toHaveBeenCalledOnce();
  });

  it("requests a verification email with authentication and no token or request body", async () => {
    const fetcher = vi.fn<EmailVerificationFetch>(async () =>
      Response.json({ data: { status: "accepted" } }, { status: 202 }),
    );
    const controller = new AbortController();
    await requestEmailVerification(apiBase, accessToken, {
      fetcher,
      signal: controller.signal,
    });

    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe("https://api.example.test/v1/auth/email-verification/request");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${accessToken}`);
    expect(init?.body).toBeUndefined();
    expect(init?.signal).toBe(controller.signal);
  });

  it("rejects malformed request acknowledgements", async () => {
    const fetcher = vi.fn<EmailVerificationFetch>(async () =>
      Response.json({ data: { status: "accepted", token: "must-not-appear" } }, { status: 202 }),
    );
    await expect(requestEmailVerification(apiBase, accessToken, { fetcher })).rejects.toThrow(
      /invalid verification response/u,
    );
  });

  it("rejects an otherwise-valid acknowledgement with the wrong success status", async () => {
    const fetcher = vi.fn<EmailVerificationFetch>(async () =>
      Response.json({ data: { status: "accepted" } }, { status: 200 }),
    );
    await expect(requestEmailVerification(apiBase, accessToken, { fetcher })).rejects.toThrow(
      /invalid verification status/u,
    );
  });

  it("reconciles an accepted no-mail request to an already-verified session", async () => {
    const fetcher = vi
      .fn<EmailVerificationFetch>()
      .mockResolvedValueOnce(Response.json({ data: { status: "accepted" } }, { status: 202 }))
      .mockResolvedValueOnce(
        Response.json({
          data: {
            user: {
              id: "96aac405-c107-4776-923e-a40ca5014975",
              email: "ada@example.test",
              emailVerified: true,
            },
            profile,
          },
        }),
      );

    await expect(
      requestAndReconcileEmailVerification(apiBase, accessToken, { fetcher }),
    ).resolves.toMatchObject({
      kind: "verified",
      session: { user: { emailVerified: true } },
    });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      "https://api.example.test/v1/auth/email-verification/request",
      "https://api.example.test/v1/auth/me",
    ]);
  });

  it("keeps an accepted request truthful when the status refresh fails transiently", async () => {
    const fetcher = vi
      .fn<EmailVerificationFetch>()
      .mockResolvedValueOnce(Response.json({ data: { status: "accepted" } }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ detail: "Try again later." }, { status: 503 }));

    await expect(
      requestAndReconcileEmailVerification(apiBase, accessToken, { fetcher }),
    ).resolves.toEqual({ kind: "unknown" });
  });

  it("does not treat a wrong current-session success status as verified", async () => {
    const fetcher = vi
      .fn<EmailVerificationFetch>()
      .mockResolvedValueOnce(Response.json({ data: { status: "accepted" } }, { status: 202 }))
      .mockResolvedValueOnce(
        Response.json(
          {
            data: {
              user: {
                id: "96aac405-c107-4776-923e-a40ca5014975",
                email: "ada@example.test",
                emailVerified: true,
              },
              profile,
            },
          },
          { status: 201 },
        ),
      );

    await expect(
      requestAndReconcileEmailVerification(apiBase, accessToken, { fetcher }),
    ).resolves.toEqual({ kind: "unknown" });
  });

  it("reports verified only from a fresh authenticated session response", async () => {
    const fetcher = vi.fn<EmailVerificationFetch>(async () =>
      Response.json({
        data: {
          user: {
            id: "96aac405-c107-4776-923e-a40ca5014975",
            email: "ada@example.test",
            emailVerified: true,
          },
          profile,
        },
      }),
    );
    const session = await loadEmailVerificationSession(apiBase, accessToken, { fetcher });

    expect(session.user.emailVerified).toBe(true);
    expect(fetcher).toHaveBeenCalledWith("https://api.example.test/v1/auth/me", {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${accessToken}`,
      },
    });
  });

  it("distinguishes terminal unauthorized from transient refresh failures", async () => {
    const unauthorized = vi.fn<EmailVerificationFetch>(async () =>
      Response.json({ code: "UNAUTHORIZED", detail: "Authentication expired." }, { status: 401 }),
    );
    await expect(
      loadEmailVerificationSession(apiBase, accessToken, { fetcher: unauthorized }),
    ).rejects.toBeInstanceOf(EmailVerificationUnauthorizedError);

    const transient = vi.fn<EmailVerificationFetch>(async () =>
      Response.json({ detail: "Try again later." }, { status: 503 }),
    );
    await expect(
      loadEmailVerificationSession(apiBase, accessToken, { fetcher: transient }),
    ).rejects.toThrow("Try again later.");
  });

  it("rejects terminal unauthorized before attempting to read an untrusted body", async () => {
    const json = vi.fn(async () => ({ detail: "must not be read" }));
    const fetcher = vi.fn<EmailVerificationFetch>(
      async () => ({ status: 401, ok: false, json }) as unknown as Response,
    );

    await expect(
      loadEmailVerificationSession(apiBase, accessToken, { fetcher }),
    ).rejects.toBeInstanceOf(EmailVerificationUnauthorizedError);
    expect(json).not.toHaveBeenCalled();
  });

  it("ignores a delayed refresh from an earlier account and session epoch", async () => {
    let release: ((response: Response) => void) | undefined;
    const delayed = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const fetcher = vi.fn<EmailVerificationFetch>(async () => delayed);
    const pending = loadEmailVerificationSession(apiBase, accessToken, { fetcher });
    const currentSession = {
      user: {
        id: "83566f88-0c81-4e26-b5c7-e66321c161d8",
        email: "grace@example.test",
        emailVerified: false,
      },
      profile: { ...profile, displayName: "Grace", timeZone: "UTC", revision: "2" },
    };

    release?.(
      Response.json({
        data: {
          user: {
            id: "96aac405-c107-4776-923e-a40ca5014975",
            email: "ada@example.test",
            emailVerified: true,
          },
          profile,
        },
      }),
    );
    const staleSession = await pending;
    const accepted = acceptEmailVerificationSessionUpdate(currentSession, 2, {
      initiatingSessionEpoch: 1,
      initiatingUserId: staleSession.user.id,
      session: staleSession,
    });

    expect(accepted).toBe(currentSession);
    expect(accepted?.user.email).toBe("grace@example.test");
  });
});
