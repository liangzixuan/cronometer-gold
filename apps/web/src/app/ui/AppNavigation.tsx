import Link from "next/link";
import { isLocalDate } from "../../lib/diary";
import { Icon } from "./Icon";

type Destination =
  | "dashboard"
  | "diary"
  | "foods"
  | "recipes"
  | "reports"
  | "goals"
  | "water"
  | "activity"
  | "privacy";

export function AppNavigation({
  date,
  active,
  reportHref,
}: {
  readonly date?: string | undefined;
  readonly active: Destination;
  readonly reportHref?: string;
}) {
  const query = date && isLocalDate(date) ? `?date=${encodeURIComponent(date)}` : "";
  const report =
    reportHref ??
    (date && isLocalDate(date) ? `/reports?to=${encodeURIComponent(date)}` : "/reports");
  const primary = [
    ["dashboard", "Dashboard", `/overview${query}`],
    ["diary", "Diary", `/dashboard${query}`],
    ["foods", "Foods", `/foods${query}`],
    ["recipes", "Recipes", `/recipes${query}`],
    ["reports", "Reports", report],
  ] as const;
  const secondary = [
    ["goals", "Goals", `/goals${query}`],
    ["water", "Hydration", `/hydration${query}`],
    ["activity", "Activity", `/activities${query}`],
    ["privacy", "Health & privacy", "/health"],
  ] as const;
  return (
    <nav aria-label="Application navigation" className="appNavigation">
      <div className="appNavPrimary">
        {primary.map(([name, label, href]) => (
          <Link key={name} href={href} aria-current={active === name ? "page" : undefined}>
            <Icon name={name} />
            {label}
          </Link>
        ))}
      </div>
      <details className="appNavMore">
        <summary
          className={secondary.some(([name]) => active === name) ? "appNavMoreActive" : undefined}
        >
          <Icon name="more" /> More
        </summary>
        <div className="appNavMorePanel">
          {secondary.map(([name, label, href]) => (
            <Link key={name} href={href} aria-current={active === name ? "page" : undefined}>
              <Icon name={name} />
              {label}
            </Link>
          ))}
        </div>
      </details>
    </nav>
  );
}
