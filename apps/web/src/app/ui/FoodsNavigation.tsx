import Link from "next/link";
import { isLocalDate } from "../../lib/diary";

export default function FoodsNavigation({
  active,
  date,
}: {
  readonly active: "catalogue" | "custom";
  readonly date?: string | undefined;
}) {
  const query = date && isLocalDate(date) ? `?date=${encodeURIComponent(date)}` : "";
  return (
    <nav aria-label="Foods navigation" className="foodsNavigation">
      <Link
        className="foodsNavigationLink"
        href={`/foods${query}`}
        aria-current={active === "catalogue" ? "page" : undefined}
      >
        Catalogue
      </Link>
      <Link
        className="foodsNavigationLink"
        href={`/foods/custom${query}`}
        aria-current={active === "custom" ? "page" : undefined}
      >
        My foods
      </Link>
    </nav>
  );
}
