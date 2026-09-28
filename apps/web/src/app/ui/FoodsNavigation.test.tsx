import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import FoodsNavigation from "./FoodsNavigation";

const meals = ["breakfast", "lunch", "dinner", "snacks"] as const;

function links(markup: string): string[] {
  return [...markup.matchAll(/href="([^"]+)"/gu)].map((match) =>
    (match[1] ?? "").replaceAll("&amp;", "&"),
  );
}

describe.each(["catalogue", "custom"] as const)("Foods navigation from %s", (active) => {
  it.each(meals)("preserves the selected date and %s identity in both food tabs", (meal) => {
    const markup = renderToStaticMarkup(
      <FoodsNavigation active={active} date="2026-09-28" meal={meal} />,
    );
    expect(links(markup)).toEqual([
      `/foods?date=2026-09-28&meal=${meal}`,
      `/foods/custom?date=2026-09-28&meal=${meal}`,
    ]);
    expect(markup).toContain('aria-label="Foods navigation"');
    expect(markup).toContain(">Catalogue</a>");
    expect(markup).toContain(">My foods</a>");
    const currentLinks = [...markup.matchAll(/<a\b[^>]*aria-current="page"[^>]*>/gu)];
    expect(currentLinks).toHaveLength(1);
    expect(currentLinks[0]?.[0]).toContain(
      `href="${active === "catalogue" ? "/foods" : "/foods/custom"}?date=2026-09-28&amp;meal=${meal}"`,
    );
  });

  it.each([undefined, "", "2026-02-29", "2026-9-28", "2026-09-28&meal=lunch"])(
    "preserves a valid meal independently of the date %j",
    (date) => {
      const markup = renderToStaticMarkup(
        <FoodsNavigation active={active} date={date} meal="dinner" />,
      );
      expect(links(markup)).toEqual(["/foods?meal=dinner", "/foods/custom?meal=dinner"]);
    },
  );

  it.each([
    undefined,
    "",
    "Breakfast",
    " breakfast",
    "Early meal",
    "lunch,dinner",
    "dinner&date=2026-10-01",
    "<script>alert(1)</script>",
  ])("preserves a valid date while discarding the meal %j", (meal) => {
    const markup = renderToStaticMarkup(
      <FoodsNavigation active={active} date="2026-09-28" meal={meal} />,
    );
    expect(links(markup)).toEqual(["/foods?date=2026-09-28", "/foods/custom?date=2026-09-28"]);
  });

  it("uses the plain tab destinations when neither value is supplied", () => {
    expect(links(renderToStaticMarkup(<FoodsNavigation active={active} />))).toEqual([
      "/foods",
      "/foods/custom",
    ]);
  });
});
