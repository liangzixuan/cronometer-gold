import Link from "next/link";
import { AppNavigation } from "../ui/AppNavigation";
import { Icon } from "../ui/Icon";
import { FoodSearchClient } from "./FoodSearchClient";

export const dynamic = "force-dynamic";

interface FoodsPageProps {
  readonly searchParams: Promise<{ readonly date?: string | readonly string[] }>;
}

export default async function FoodsPage({ searchParams }: FoodsPageProps) {
  const { date } = await searchParams;
  return (
    <main className="shell">
      <aside className="sidebar">
        <Link className="brand brandDark" href="/">
          <Icon name="leaf" /> Nourishing
        </Link>
        <AppNavigation active="foods" date={typeof date === "string" ? date : undefined} />
        <details className="ledgerAccount">
          <summary>Account</summary>
          <div className="ledgerAccountPanel">
            <Link
              href={
                typeof date === "string"
                  ? `/dashboard?date=${encodeURIComponent(date)}`
                  : "/dashboard"
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
