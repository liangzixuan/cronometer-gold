import Link from "next/link";

const principles = [
  {
    eyebrow: "Fast logging",
    title: "Your foods rise first",
    body: "Recent foods, saved portions, and repeat actions are designed into ranking—not bolted on later.",
  },
  {
    eyebrow: "Auditable nutrition",
    title: "Unknown never means zero",
    body: "Every nutrient value keeps its source, release, measurement basis, and completeness status.",
  },
  {
    eyebrow: "Stable history",
    title: "Yesterday stays true",
    body: "Diary entries snapshot nutrition so database or recipe edits cannot silently rewrite the past.",
  },
] as const;

export default function HomePage() {
  return (
    <main>
      <section className="hero">
        <nav className="nav" aria-label="Primary navigation">
          <Link className="brand" href="/">
            nutrition<span>/ledger</span>
          </Link>
          <Link className="navLink" href="/dashboard">
            Open foundation
          </Link>
        </nav>

        <div className="heroCopy">
          <p className="kicker">A trustworthy food record</p>
          <h1>See what you ate—without pretending the data is perfect.</h1>
          <p className="lede">
            Track calories, macros, and micronutrients with fast repeat logging and visible data
            provenance. Built independently from public and properly licensed sources.
          </p>
          <div className="heroActions">
            <Link className="primaryButton" href="/dashboard">
              View the product shell
            </Link>
            <a className="textLink" href="#principles">
              Read the principles
            </a>
          </div>
        </div>

        <section className="trustBar" aria-label="Foundation status">
          <div>
            <strong>FDC + CNF</strong>
            <span>planned canonical sources</span>
          </div>
          <div>
            <strong>Immutable</strong>
            <span>diary nutrition snapshots</span>
          </div>
          <div>
            <strong>Explicit</strong>
            <span>missingness and serving basis</span>
          </div>
        </section>
      </section>

      <section className="principles" id="principles" aria-labelledby="principles-title">
        <p className="kicker">Product foundation</p>
        <h2 id="principles-title">Accuracy is a system, not a marketing claim.</h2>
        <div className="cardGrid">
          {principles.map((principle, index) => (
            <article className="principleCard" key={principle.title}>
              <span className="cardNumber">0{index + 1}</span>
              <p className="cardEyebrow">{principle.eyebrow}</p>
              <h3>{principle.title}</h3>
              <p>{principle.body}</p>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
