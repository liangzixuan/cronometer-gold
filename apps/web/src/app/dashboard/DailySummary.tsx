import { type DiaryNutrient, nutrientDisplay } from "../../lib/diary";

const summaryNutrients = [
  { code: "energy", label: "Energy" },
  { code: "protein", label: "Protein" },
  { code: "carbohydrate", label: "Carbs" },
  { code: "fat", label: "Fat" },
] as const;

interface DailySummaryProps {
  readonly totals: readonly DiaryNutrient[];
  readonly totalEntries: number;
}

export function DailySummary({ totals, totalEntries }: DailySummaryProps) {
  return (
    <section aria-labelledby="daily-summary-title" className="dailySummary">
      <div className="dailySummaryHeading">
        <h2 id="daily-summary-title">Daily nutrition</h2>
        <p>
          {totalEntries} {totalEntries === 1 ? "entry" : "entries"} logged
        </p>
      </div>
      <dl className="dailySummaryGrid">
        {summaryNutrients.map(({ code, label }) => {
          const nutrient = totals.find((candidate) => candidate.code === code);
          const display = nutrient
            ? nutrientDisplay(nutrient)
            : {
                amount: "Unknown",
                qualification: "No nutrient total available",
              };
          return (
            <div className="dailySummaryCard" data-nutrient={code} key={code}>
              <dt>{label}</dt>
              <dd>
                <strong className="dailySummaryValue">{display.amount}</strong>
                <small className="dailySummaryQualification">{display.qualification}</small>
              </dd>
            </div>
          );
        })}
      </dl>
      <p className="dailySummaryNote">
        Totals cover all {totalEntries} diary {totalEntries === 1 ? "entry" : "entries"} for this
        day. Partial totals are lower bounds. Unknown values are never counted as zero.
      </p>
    </section>
  );
}
