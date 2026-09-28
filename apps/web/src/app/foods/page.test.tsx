import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const route = vi.hoisted(() => ({ query: "" }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(route.query),
}));

import FoodsPage, { dynamic } from "./page";

type Query = Readonly<Record<string, string | readonly string[]>>;

async function renderPage(query: Query = {}) {
  const clientQuery = new URLSearchParams();
  for (const [name, values] of Object.entries(query)) {
    for (const value of typeof values === "string" ? [values] : values) {
      clientQuery.append(name, value);
    }
  }
  route.query = clientQuery.toString();
  return renderToStaticMarkup(await FoodsPage({ searchParams: Promise.resolve(query) }));
}

function foodLinks(markup: string): string[] {
  const navigation = markup.match(/<nav aria-label="Foods navigation"[^>]*>(.*?)<\/nav>/u)?.[1];
  expect(navigation).toBeDefined();
  return [...(navigation ?? "").matchAll(/href="([^"]+)"/gu)].map((match) =>
    (match[1] ?? "").replaceAll("&amp;", "&"),
  );
}

afterEach(() => {
  route.query = "";
});

describe("Foods route meal destination", () => {
  it.each(["breakfast", "lunch", "dinner", "snacks"])(
    "passes the selected date and %s identity through the actual page navigation",
    async (meal) => {
      const markup = await renderPage({ date: "2026-09-28", meal });
      expect(foodLinks(markup)).toEqual([
        `/foods?date=2026-09-28&meal=${meal}`,
        `/foods/custom?date=2026-09-28&meal=${meal}`,
      ]);
      expect(markup).toContain("<h1>Foods</h1>");
      expect(markup).toContain('href="/dashboard?date=2026-09-28">Open diary</a>');
      expect(dynamic).toBe("force-dynamic");
    },
  );

  const invalidDates: readonly { label: string; query: Query }[] = [
    { label: "absent", query: {} },
    { label: "empty", query: { date: "" } },
    { label: "invalid calendar day", query: { date: "2026-02-29" } },
    { label: "noncanonical", query: { date: "2026-9-28" } },
    { label: "duplicate", query: { date: ["2026-09-28", "2026-09-29"] } },
    { label: "repeated", query: { date: ["2026-09-28", "2026-09-28"] } },
    { label: "single array", query: { date: ["2026-09-28"] } },
    { label: "injected query", query: { date: "2026-09-28&meal=lunch" } },
  ];
  it.each(invalidDates)("keeps a valid meal when the date is $label", async ({ query }) => {
    const markup = await renderPage({ ...query, meal: "lunch" });
    expect(foodLinks(markup)).toEqual(["/foods?meal=lunch", "/foods/custom?meal=lunch"]);
    expect(markup).toContain('href="/dashboard">Open diary</a>');
  });

  const invalidMeals: readonly { label: string; query: Query }[] = [
    { label: "absent", query: {} },
    { label: "empty", query: { meal: "" } },
    { label: "wrong case", query: { meal: "Breakfast" } },
    { label: "whitespace", query: { meal: "breakfast " } },
    { label: "custom label", query: { meal: "Early meal" } },
    { label: "unknown identity", query: { meal: "brunch" } },
    { label: "duplicate identities", query: { meal: ["breakfast", "dinner"] } },
    { label: "repeated identity", query: { meal: ["lunch", "lunch"] } },
    { label: "single array", query: { meal: ["snacks"] } },
    { label: "injected query", query: { meal: "dinner&date=2026-10-01" } },
  ];
  it.each(invalidMeals)("keeps a valid date when the meal is $label", async ({ query }) => {
    const markup = await renderPage({ date: "2026-09-28", ...query });
    expect(foodLinks(markup)).toEqual(["/foods?date=2026-09-28", "/foods/custom?date=2026-09-28"]);
    expect(markup).toContain('href="/dashboard?date=2026-09-28">Open diary</a>');
  });

  it("keeps plain tab destinations when both parameters are absent or invalid", async () => {
    expect(foodLinks(await renderPage())).toEqual(["/foods", "/foods/custom"]);
    expect(foodLinks(await renderPage({ date: ["2026-09-28"], meal: ["dinner"] }))).toEqual([
      "/foods",
      "/foods/custom",
    ]);
    expect(foodLinks(await renderPage({ date: "not-a-date", meal: "Late supper" }))).toEqual([
      "/foods",
      "/foods/custom",
    ]);
  });

  it("forwards only the validated date and meal into food-tab links", async () => {
    const markup = await renderPage({
      date: "2026-09-28",
      meal: "snacks",
      returnTo: "https://unrelated.invalid/path",
      ownerId: "another-owner",
      label: "Custom meal name",
      q: "private query text",
    });
    expect(foodLinks(markup)).toEqual([
      "/foods?date=2026-09-28&meal=snacks",
      "/foods/custom?date=2026-09-28&meal=snacks",
    ]);
    expect(markup).not.toContain("unrelated.invalid");
    expect(markup).not.toContain("another-owner");
    expect(markup).not.toContain("Custom meal name");
    expect(markup).not.toContain("private query text");
  });
});
