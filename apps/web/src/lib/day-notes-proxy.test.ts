import { afterEach, describe, expect, it, vi } from "vitest";

import { GET, PUT } from "../app/api/diary/day-notes/[date]/route";
import { GET as PROFILE } from "../app/api/diary/day-notes/profile/route";
import { prepareDayNoteOperation } from "./day-notes";
import {
  mutationFixture,
  noteDate,
  noteFixture,
  noteOwner,
  noteResponse,
  noteSession,
  otherNoteOwner,
} from "./day-notes.test-fixtures";
import { SESSION_COOKIE } from "./private-api";

const context = () => ({ params: Promise.resolve({ date: noteDate }) });
const operation = () => {
  const result = prepareDayNoteOperation(
    noteFixture("before", "4"),
    "  e\u0301\r\n😀  ",
    "America/Chicago",
  );
  if (!result) throw new Error("operation missing");
  return result;
};
const request = (method = "GET", headers: Record<string, string> = {}, body?: string, query = "") =>
  new Request(`https://app.example.test/api/diary/day-notes/${noteDate}${query}`, {
    method,
    headers: {
      cookie: `${SESSION_COOKIE}=${"t".repeat(43)}`,
      origin: "https://app.example.test",
      "x-expected-owner-user-id": noteOwner,
      ...headers,
    },
    ...(body === undefined ? {} : { body }),
  });
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe("web private day-note BFF", () => {
  it("forwards guarded owner/date GET and preserves strong ETag/no-store", async () => {
    const fetch = vi.fn(async () => noteResponse(noteFixture()));
    vi.stubGlobal("fetch", fetch);
    const response = await GET(request(), context());
    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe('"0"');
    expect(response.headers.get("cache-control")).toContain("no-store");
    const [url, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.href).toBe(`http://127.0.0.1:4000/v1/diary/day-notes/${noteDate}`);
    expect(init.headers).toMatchObject({
      authorization: `Bearer ${"t".repeat(43)}`,
      "x-expected-owner-user-id": noteOwner,
    });
    expect(init.cache).toBe("no-store");
  });
  it("validates and relays exact PUT text, preconditions and a complete receipt", async () => {
    const op = operation();
    const expected = mutationFixture(op, true);
    const fetch = vi.fn(async () => Response.json(expected, { headers: { etag: '"5"' } }));
    vi.stubGlobal("fetch", fetch);
    const response = await PUT(request("PUT", { ...op.headers }, op.serializedBody), context());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expected);
    const [, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(init.body).toBe(op.serializedBody);
    expect(init.headers).toMatchObject(op.headers);
  });
  it.each([
    { origin: "https://evil.example.test" },
    { "sec-fetch-site": "cross-site" },
    { "x-expected-owner-user-id": "bad" },
    { "idempotency-key": "bad" },
    { "if-match": 'W/"4"' },
    { "if-match": '"04"' },
    { "if-match": '"9223372036854775808"' },
    { "x-expected-profile-time-zone": "US/Central" },
    { "x-expected-profile-time-zone": "invalid" },
  ])("rejects invalid origin or guards before contacting the API: %j", async (headers) => {
    const op = operation();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const response = await PUT(
      request("PUT", { ...op.headers, ...headers }, op.serializedBody),
      context(),
    );
    expect([400, 403]).toContain(response.status);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["?extra=1", "?date=2026-09-15"])("rejects unexpected query keys %s", async (query) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect((await GET(request("GET", {}, undefined, query), context())).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    "{}",
    '{"note":"x","extra":1}',
    '{"note":2}',
    '{"note":""}',
    JSON.stringify({ note: "x".repeat(2001) }),
    JSON.stringify({ note: "\ud800" }),
  ])("rejects invalid strict bodies before forwarding", async (body) => {
    const op = operation();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect([400, 422]).toContain(
      (await PUT(request("PUT", { ...op.headers }, body), context())).status,
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it("requires content type, bounded bytes, authentication and If-Match", async () => {
    const op = operation();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(
      (
        await PUT(
          request("PUT", { ...op.headers, "content-type": "text/plain" }, op.serializedBody),
          context(),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await PUT(
          request("PUT", { ...op.headers, "content-length": "30000" }, op.serializedBody),
          context(),
        )
      ).status,
    ).toBe(400);
    expect((await GET(request("GET", { cookie: "" }), context())).status).toBe(401);
    const missing = { ...op.headers };
    delete missing["if-match"];
    expect((await PUT(request("PUT", missing, op.serializedBody), context())).status).toBe(428);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["owner", "date", "etag", "shape", "status"])(
    "rejects invalid successful read %s",
    async (kind) => {
      const note = noteFixture();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          Response.json(
            {
              data: {
                ...note,
                ...(kind === "owner" ? { ownerUserId: otherNoteOwner } : {}),
                ...(kind === "date" ? { localDate: "2026-09-16" } : {}),
                ...(kind === "shape" ? { extra: 1 } : {}),
              },
            },
            {
              status: kind === "status" ? 201 : 200,
              headers: { etag: kind === "etag" ? 'W/"0"' : '"0"' },
            },
          ),
        ),
      );
      expect((await GET(request(), context())).status).toBe(502);
    },
  );
  it("rejects a mismatched successful receipt rather than acknowledging a write", async () => {
    const op = operation();
    const value = mutationFixture(op);
    value.data.receipt.operationId = "00000000-0000-4000-8000-000000000001";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(value, { headers: { etag: '"5"' } })),
    );
    expect(
      (await PUT(request("PUT", { ...op.headers }, op.serializedBody), context())).status,
    ).toBe(502);
  });
  it("does not clear a newer login cookie when an older pending request returns401", async () => {
    let resolve!: (value: Response) => void;
    const fetch = vi.fn(async (_url: URL, _init: RequestInit) => noteResponse(noteFixture()));
    fetch.mockImplementationOnce(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const pending = GET(request(), context());
    await new Promise((done) => setTimeout(done, 0));
    const newer = await GET(
      request("GET", { cookie: `${SESSION_COOKIE}=${"n".repeat(43)}` }),
      context(),
    );
    expect(newer.status).toBe(200);
    expect(fetch.mock.calls[1]?.[1].headers).toMatchObject({
      authorization: `Bearer ${"n".repeat(43)}`,
    });
    resolve(
      Response.json(
        { code: "AUTH_REQUIRED", detail: "Sign in." },
        { status: 401, headers: { "set-cookie": `${SESSION_COOKIE}=; Max-Age=0` } },
      ),
    );
    const response = await pending;
    expect(response.status).toBe(401);
    expect(response.headers.has("set-cookie")).toBe(false);
  });
  it("verifies note-owned profile reads and never propagates401 cookie clearing or raw details", async () => {
    const fetch = vi.fn(async () => Response.json(noteSession()));
    vi.stubGlobal("fetch", fetch);
    const response = await PROFILE(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect((await response.json()).data.user.id).toBe(noteOwner);
    fetch.mockResolvedValueOnce(Response.json(noteSession(otherNoteOwner)));
    const mismatch = await PROFILE(request());
    expect(mismatch.status).toBe(409);
    expect((await mismatch.json()).code).toBe("DAY_NOTE_OWNER_CHANGED");
    fetch.mockResolvedValueOnce(
      Response.json({ detail: "raw private text", code: "AUTH_REQUIRED" }, { status: 401 }),
    );
    const expired = await PROFILE(request());
    expect(expired.status).toBe(401);
    expect(expired.headers.has("set-cookie")).toBe(false);
    expect(await expired.text()).not.toContain("raw private text");
    const before = fetch.mock.calls.length;
    expect((await PROFILE(request("GET", { "x-expected-owner-user-id": "bad" }))).status).toBe(400);
    expect(fetch.mock.calls.length).toBe(before);
  });
  it("does not reflect private upstream note detail in its error response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ detail: "raw private text", code: "DAY_NOTE_VALIDATION" }, { status: 422 }),
      ),
    );
    const response = await GET(request(), context());
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: "The day note service is unavailable.",
      code: "DAY_NOTE_VALIDATION",
    });
  });
});
