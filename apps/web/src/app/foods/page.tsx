import Link from "next/link";

import { FoodSearchClient } from "./FoodSearchClient";

export const dynamic = "force-dynamic";

export default function FoodsPage() {
  return (
    <main className="shell">
      <aside className="sidebar">
        <Link className="brand brandDark" href="/">
          nutrition<span>/ledger</span>
        </Link>
        <nav aria-label="Application navigation">
          <Link href="/dashboard">Today</Link>
          <Link aria-current="page" href="/foods">
            Foods
          </Link>
          <span aria-disabled="true">Recipes · soon</span>
          <span aria-disabled="true">Trends · soon</span>
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
