import Link from "next/link";
import { isLocalDate, mealSlots } from "../../lib/diary";
import { AppNavigation } from "../ui/AppNavigation";
import FoodsNavigation from "../ui/FoodsNavigation";
import { Icon } from "../ui/Icon";
import { FoodSearchClient } from "./FoodSearchClient";

export const dynamic = "force-dynamic";

interface FoodsPageProps {
  readonly searchParams: Promise<{
    readonly date?: string | readonly string[];
    readonly meal?: string | readonly string[];
  }>;
}

export default async function FoodsPage({ searchParams }: FoodsPageProps) {
  const { date, meal } = await searchParams;
  const selectedDate = typeof date === "string" && isLocalDate(date) ? date : undefined;
  const selectedMeal = mealSlots.find((slot) => slot === meal);
  return (
    <main className="shell">
      <aside className="sidebar">
        <Link className="brand brandDark" href="/">
          <Icon name="leaf" /> Nourishing
        </Link>
        <AppNavigation active="foods" date={selectedDate} />
        <details className="ledgerAccount">
          <summary>Account</summary>
          <div className="ledgerAccountPanel">
            <Link
              href={
                selectedDate ? `/dashboard?date=${encodeURIComponent(selectedDate)}` : "/dashboard"
              }
            >
              Open diary
            </Link>
            <p className="wellnessNote">Wellness information only—not medical advice.</p>
          </div>
        </details>
      </aside>

      <section className="dashboard foodDashboard">
        <header className="dashboardHeader foodPageHeader">
          <div>
            <p className="kicker">Your food library</p>
            <h1>Foods</h1>
          </div>
          <span className="statusPill">Generic & branded</span>
        </header>
        <FoodsNavigation active="catalogue" date={selectedDate} meal={selectedMeal} />
        <p className="foodPageIntro">
          Find generic and branded foods, review their serving information, and add them to your
          diary. Missing serving data stays unknown.
        </p>
        <FoodSearchClient />
      </section>
    </main>
  );
}
