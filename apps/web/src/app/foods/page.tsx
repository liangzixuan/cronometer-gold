import Link from "next/link";

import { isLocalDate } from "../../lib/diary";
import { FoodSearchClient } from "./FoodSearchClient";

export const dynamic = "force-dynamic";

interface FoodsPageProps {
  readonly searchParams: Promise<{ readonly date?: string | readonly string[] }>;
}

export default async function FoodsPage({ searchParams }: FoodsPageProps) {
  const { date } = await searchParams;
  const dateQuery = typeof date === "string" && isLocalDate(date) ? `?date=${date}` : "";
  const reportHref =
    typeof date === "string" && isLocalDate(date)
      ? `/reports?to=${encodeURIComponent(date)}`
      : "/reports";
  return (
    <main className="shell">
      <aside className="sidebar">
        <Link className="brand brandDark" href="/">
          nutrition<span>/ledger</span>
        </Link>
        <nav aria-label="Application navigation">
          <Link href={`/overview${dateQuery}`}>Dashboard</Link>
          <Link href={`/dashboard${dateQuery}`}>Diary</Link>
          <Link aria-current="page" href={`/foods${dateQuery}`}>
            Foods
          </Link>
          <Link href={`/recipes${dateQuery}`}>Recipes</Link>
          <Link href={`/goals${dateQuery}`}>Goals</Link>
          <Link href={`/hydration${dateQuery}`}>Hydration</Link>
          <Link href={`/activities${dateQuery}`}>Activity</Link>
          <Link href={reportHref}>Reports</Link>
          <Link href="/health">Health & privacy</Link>
        </nav>
        <p className="wellnessNote">Wellness information only—not medical advice.</p>
      </aside>

      <section className="dashboard foodDashboard">
        <header className="dashboardHeader foodPageHeader">
          <div>
            <p className="kicker">Food search</p>
            <h1>Foods</h1>
          </div>
          <span className="statusPill">Generic & branded</span>
        </header>
        <p className="foodPageIntro">
          Find generic and branded foods, review their serving information, and add them to your
          diary. Missing serving data stays unknown.
        </p>
        <FoodSearchClient />
      </section>
    </main>
  );
}
