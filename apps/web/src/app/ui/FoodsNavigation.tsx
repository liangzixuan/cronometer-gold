import Link from "next/link";
import { isLocalDate, mealSlots } from "../../lib/diary";

export default function FoodsNavigation({
  active,
  date,
  meal,
}: {
  readonly active: "catalogue" | "custom";
  readonly date?: string | undefined;
  readonly meal?: string | undefined;
}) {
  const params = new URLSearchParams();
  if (date && isLocalDate(date)) params.set("date", date);
  const selectedMeal = mealSlots.find((slot) => slot === meal);
  if (selectedMeal) params.set("meal", selectedMeal);
  const query = params.size ? `?${params.toString()}` : "";
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
