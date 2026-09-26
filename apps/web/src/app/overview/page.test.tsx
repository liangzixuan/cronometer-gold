import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ hasSession: true, requestedCookie: vi.fn() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    has: (name: string) => {
      auth.requestedCookie(name);
      return auth.hasSession;
    },
  }),
}));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`Redirect ${path}`);
  },
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams("date=2026-11-01"),
}));

import { SESSION_COOKIE } from "../../lib/private-api";
import { DiaryClient } from "../dashboard/DiaryClient";
import OverviewPage, { dynamic } from "./page";

afterEach(() => {
  auth.hasSession = true;
  vi.clearAllMocks();
});

describe("overview route", () => {
  it("requires the same host-only session cookie as the diary", async () => {
    auth.hasSession = false;
    await expect(OverviewPage()).rejects.toThrow("Redirect /login");
    expect(auth.requestedCookie).toHaveBeenCalledWith(SESSION_COOKIE);
    expect(dynamic).toBe("force-dynamic");
  });

  it("renders the compact dashboard with same-date actions and one active navigation link", async () => {
    const markup = renderToStaticMarkup(await OverviewPage());
    expect(markup).toContain("<h1>Your day at a glance</h1>");
    expect(markup).toContain('aria-label="Dashboard actions"');
    expect(markup).toContain('href="/foods?date=2026-11-01"');
    expect(markup).toContain("Add food</a>");
    expect(markup).toContain('href="/dashboard?date=2026-11-01">Open diary</a>');
    expect(markup).toContain('href="/reports?to=2026-11-01">Nutrition report</a>');
    expect(markup).toContain('aria-current="page" href="/overview?date=2026-11-01"');
    expect(markup.match(/aria-current="page"/gu)).toHaveLength(1);
    expect(markup).not.toContain("Customize diary groups");
    expect(markup).not.toContain('id="diary-entry-groups"');
    expect(markup).toContain('value="2026-11-01"');
    expect(markup).toContain('role="status"');
  });

  it("keeps the existing default view as Diary", () => {
    const markup = renderToStaticMarkup(<DiaryClient />);
    expect(markup).toContain('aria-current="page" href="/dashboard?date=2026-11-01"');
    expect(markup).toContain("<h1>Diary</h1>");
    expect(markup).toContain("Customize diary groups");
    expect(markup).not.toContain('aria-label="Dashboard actions"');
  });
});
