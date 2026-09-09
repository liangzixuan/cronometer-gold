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
          <Link href={`/dashboard${dateQuery}`}>Today</Link>
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
            <p className="kicker">Search milestone</p>
            <h1>Foods</h1>
          </div>
          <span className="statusPill">Public catalogue</span>
        </header>
        <p className="foodPageIntro">
          Search generic and branded foods from promoted, source-attributed catalogue releases.
          Results never invent missing serving data.
        </p>
        <FoodSearchClient />
      </section>
    </main>
  );
}
