import Link from "next/link";

import { foundationMilestones } from "../../lib/foundation";

// Disable caching for this data-free prototype. Add a server-side authorization
// guard before this route renders profile, diary, or other user-owned data.
export const dynamic = "force-dynamic";

export default function DashboardPage() {
  return (
    <main className="shell">
      <aside className="sidebar">
        <Link className="brand brandDark" href="/">
          nutrition<span>/ledger</span>
        </Link>
        <nav aria-label="Application navigation">
          <a aria-current="page" href="#today">
            Today
          </a>
          <span aria-disabled="true">Foods · soon</span>
          <span aria-disabled="true">Recipes · soon</span>
          <span aria-disabled="true">Trends · soon</span>
        </nav>
        <p className="wellnessNote">Wellness information only—not medical advice.</p>
      </aside>

      <section className="dashboard" id="today">
        <header className="dashboardHeader">
          <div>
            <p className="kicker">Foundation build</p>
            <h1>Today</h1>
          </div>
          <span className="statusPill">Local prototype</span>
        </header>

        <section className="emptyDiary" aria-labelledby="diary-title">
          <div>
            <p className="kicker">Sample day · no entries</p>
            <h2 id="diary-title">Your diary is ready for honest data.</h2>
            <p>
              Food search and persistence arrive after the nutrient ontology and source manifests
              pass review. This shell deliberately does not fabricate nutrition totals.
            </p>
          </div>
          <button type="button" disabled title="Food ingestion is not connected yet">
            Add food soon
          </button>
        </section>

        <section aria-labelledby="build-title">
          <div className="sectionHeading">
            <p className="kicker">Build ledger</p>
            <h2 id="build-title">What this foundation proves</h2>
          </div>
          <ol className="milestoneList">
            {foundationMilestones.map((milestone) => (
              <li key={milestone.title}>
                <span className={`milestoneState milestoneState--${milestone.state}`}>
                  {milestone.state}
                </span>
                <div>
                  <h3>{milestone.title}</h3>
                  <p>{milestone.description}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>
      </section>
    </main>
  );
}
