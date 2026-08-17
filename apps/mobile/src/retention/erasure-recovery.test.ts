import { describe, expect, it, vi } from "vitest";

import { submitPendingErasure } from "./erasure-recovery";
import { ACCOUNT_ERASURE_SERIALIZED_BODY } from "./pending-erasure";

const pending = {
  version: 1 as const,
  operationId: "018f6f58-4e2c-4b62-8f0b-3d75491713b5",
  serializedBody: ACCOUNT_ERASURE_SERIALIZED_BODY,
  reauthenticationToken: "r".repeat(43),
  createdAt: "2026-08-16T12:00:00.000Z",
} as const;

const responseBody = {
  data: {
    replayed: true,
    erasure: {
      id: "118f6f58-4e2c-7b62-8f0b-3d75491713b5",
      status: "queued",
      requestedAt: "2026-08-16T12:00:00.000Z",
      startedAt: null,
      completedAt: null,
      executeAfter: "2026-08-17T12:00:00.000Z",
      recentAuthenticationSatisfied: true,
      consequences: [
        "ACCOUNT_ACCESS_REVOKED",
        "PRIVATE_HEALTH_DATA_DELETED",
        "EXPORT_LINKS_REVOKED",
      ],
      failureCode: null,
    },
    statusCapability: {
      token: "s".repeat(43),
      expiresAt: "2026-09-16T12:00:00.000Z",
    },
  },
};

describe("account-erasure lost-response recovery", () => {
  it("replays byte-identical proof and operation identity after a process restart", async () => {
    const requests: Array<{ readonly body: unknown; readonly headers: Headers }> = [];
    const fetcher = vi
      .fn<(url: string, init?: RequestInit) => Promise<Response>>()
      .mockImplementationOnce(async (_url, init) => {
        requests.push({ body: init?.body, headers: new Headers(init?.headers) });
        throw new TypeError("response-lost-after-commit");
      })
      .mockImplementationOnce(async (_url, init) => {
        requests.push({ body: init?.body, headers: new Headers(init?.headers) });
        return Response.json(responseBody);
      });
    await expect(
      submitPendingErasure(
        {
          apiBase: new URL("https://api.example.test"),
          accessToken: "revoked-session-proof",
          pending,
        },
        fetcher,
      ),
    ).rejects.toThrow(/not received/u);
    const recovered = await submitPendingErasure(
      {
        apiBase: new URL("https://api.example.test"),
        accessToken: "revoked-session-proof",
        pending,
      },
      fetcher,
    );
    expect(recovered.statusCapability?.token).toBe("s".repeat(43));
    expect(requests).toHaveLength(2);
    expect(requests[0]?.body).toBe(ACCOUNT_ERASURE_SERIALIZED_BODY);
    expect(requests[1]?.body).toBe(requests[0]?.body);
    expect(requests[1]?.headers.get("idempotency-key")).toBe(
      requests[0]?.headers.get("idempotency-key"),
    );
    expect(requests[1]?.headers.get("x-reauthentication-token")).toBe(
      requests[0]?.headers.get("x-reauthentication-token"),
    );
  });
});
