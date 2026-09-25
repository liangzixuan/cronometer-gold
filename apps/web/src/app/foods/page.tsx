import Link from "next/link";
import { isLocalDate } from "../../lib/diary";
import { Icon } from "../ui/Icon";
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
          <Icon name="leaf" /> Nourishing
        </Link>
        <nav aria-label="Application navigation">
          <Link href={`/overview${dateQuery}`}>
            <Icon name="dashboard" /> Dashboard
          </Link>
          <Link href={`/dashboard${dateQuery}`}>
            <Icon name="diary" /> Diary
          </Link>
          <Link aria-current="page" href={`/foods${dateQuery}`}>
            <Icon name="foods" /> Foods
          </Link>
          <Link href={`/recipes${dateQuery}`}>
            <Icon name="recipes" /> Recipes
          </Link>
          <Link href={`/goals${dateQuery}`}>
            <Icon name="goals" /> Goals
          </Link>
          <Link href={`/hydration${dateQuery}`}>
            <Icon name="water" /> Hydration
          </Link>
          <Link href={`/activities${dateQuery}`}>
            <Icon name="activity" /> Activity
          </Link>
          <Link href={reportHref}>
            <Icon name="reports" /> Reports
          </Link>
          <Link href="/health">
            <Icon name="privacy" /> Health & privacy
          </Link>
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
