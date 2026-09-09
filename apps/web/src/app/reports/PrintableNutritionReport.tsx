import {
  type NutritionReport,
  type NutritionReportSeriesPoint,
  reportAmountText,
  reportComparisonText,
  reportPointCoverageText,
  targetSnapshotForPoint,
} from "../../lib/nutrition-reports";
import styles from "./printable-nutrition-report.module.css";

interface PrintableNutritionReportProps {
  readonly report: NutritionReport;
  readonly nutrientId: string;
}

function goalLabel(report: NutritionReport, versionId: string | null): string {
  if (versionId === null) return "No saved goal";
  const index = report.goalVersions.findIndex((goal) => goal.versionId === versionId);
  return index < 0 ? "Unavailable goal evidence" : `Goal ${index + 1}`;
}

function contributionEvidence(point: NutritionReportSeriesPoint): string | null {
  const aggregate = point.aggregate;
  if (!aggregate) return null;
  const reasons = aggregate.unknownReasonCounts;
  return `${aggregate.contributorCount} contributions: ${aggregate.quantifiedCount} quantified, ${aggregate.traceCount} trace, ${aggregate.unknownCount} unknown. Unknown reasons: ${reasons.not_reported} not reported; ${reasons.not_analyzed} not analyzed; ${reasons.not_applicable} not applicable; ${reasons.withheld} withheld.`;
}

/** Authorization and the captured snapshot's lifetime belong to ReportsClient. */
export function PrintableNutritionReport({ report, nutrientId }: PrintableNutritionReportProps) {
  const series = report.series.find((candidate) => candidate.nutrient.id === nutrientId);
  if (!series) return null;
  const { nutrient, summary } = series;

  return (
    <article className={styles.report} aria-label="Printable nutrition report">
      <header className={styles.header}>
        <p className={styles.eyebrow}>nutrition / ledger</p>
        <h1>Nutrition report</h1>
        <p className={styles.subtitle}>
          {nutrient.name} ({nutrient.unit}) · {report.from} through {report.to}
        </p>
        <p>
          {report.days.length} profile-local {report.days.length === 1 ? "day" : "days"} in{" "}
          <strong>{report.timeZone}</strong>. Captured at{" "}
          <time dateTime={report.snapshotAt}>{report.snapshotAt}</time> (exact instant).
        </p>
        <p>{report.notice}</p>
      </header>

      <section aria-labelledby="print-coverage-heading">
        <h2 id="print-coverage-heading">Coverage of logged intake</h2>
        <dl className={styles.summary}>
          {[
            ["Diary days", summary.diaryDays],
            ["Complete days", summary.completeDays],
            ["Exact days", summary.exactDays],
            ["Partial days", summary.partialDays],
            ["Unknown days", summary.unknownDays],
            ["Trace days", summary.traceDays],
            ["Missing days", summary.missingDays],
          ].map(([label, count]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{count}</dd>
            </div>
          ))}
        </dl>
        <p>
          “At least” is a known lower bound. Quantified zero remains zero. Trace and unknown
          contributions are not quantified zero. A missing day has no diary entries. Complete
          coverage describes logged contributions only; these counts may overlap.
        </p>
      </section>

      <section aria-labelledby="print-daily-heading">
        <h2 id="print-daily-heading">Daily {nutrient.name} evidence</h2>
        <p>
          Bars show the known amount on a {series.scaleMaximum} {nutrient.unit} scale. Exact amounts
          and saved comparisons are written below; saved thresholds are not recommendations. Full
          saved thresholds and their evidence follow this table.
        </p>
        <table className={styles.dailyTable}>
          <colgroup>
            <col className={styles.dayColumn} />
            <col className={styles.amountColumn} />
            <col className={styles.coverageColumn} />
            <col className={styles.comparisonColumn} />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">Day / entries</th>
              <th scope="col">Logged amount ({nutrient.unit})</th>
              <th scope="col">Coverage and contributions</th>
              <th scope="col">Saved comparison</th>
            </tr>
          </thead>
          <tbody>
            {series.points.map((point, index) => (
              <tr key={point.localDate}>
                <th scope="row">
                  <time dateTime={point.localDate}>{point.localDate}</time>
                  <span className={styles.detail}>
                    {report.days[index]?.entryCount ?? 0} entries
                  </span>
                </th>
                <td>
                  <strong>{reportAmountText(point, nutrient.unit)}</strong>
                  {point.knownPercentOfScale !== null ? (
                    <span className={styles.barTrack} aria-hidden="true">
                      <span
                        className={styles.bar}
                        style={{ width: `${point.knownPercentOfScale}%` }}
                      />
                    </span>
                  ) : null}
                </td>
                <td>
                  <p>{reportPointCoverageText(point)}</p>
                  {point.aggregate ? (
                    <p className={styles.detail}>{contributionEvidence(point)}</p>
                  ) : null}
                </td>
                <td>
                  <p>{reportComparisonText(point)}</p>
                  <p className={styles.detail}>{goalLabel(report, point.goalVersionId)}</p>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section aria-labelledby="print-periods-heading">
        <h2 id="print-periods-heading">Saved target periods</h2>
        <p>
          Each inclusive report period pins the goal version current when this snapshot was read. It
          is not a reconstruction of an older goal revision.
        </p>
        <table>
          <thead>
            <tr>
              <th scope="col">From</th>
              <th scope="col">Through (inclusive)</th>
              <th scope="col">Saved goal evidence</th>
            </tr>
          </thead>
          <tbody>
            {report.targetSegments.map((segment) => (
              <tr key={`${segment.from}/${segment.to}`}>
                <td>{segment.from}</td>
                <td>{segment.to}</td>
                <td>{goalLabel(report, segment.goalVersionId)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {report.goalVersions.map((goal, index) => {
          const target = targetSnapshotForPoint(report, nutrientId, goal.versionId);
          return (
            <div className={styles.goalEvidence} key={goal.versionId}>
              <h3>
                Goal {index + 1} · revision {goal.revision}
              </h3>
              <p>
                Saved goal applies from {goal.effectiveFrom} (inclusive)
                {goal.effectiveTo === null
                  ? "; no saved end date."
                  : ` until ${goal.effectiveTo} (exclusive).`}
              </p>
              <dl className={styles.evidence}>
                <div>
                  <dt>Goal ID</dt>
                  <dd>{goal.goalId}</dd>
                </div>
                <div>
                  <dt>Full version ID</dt>
                  <dd>{goal.versionId}</dd>
                </div>
                {target ? (
                  <>
                    <div>
                      <dt>Saved minimum</dt>
                      <dd>
                        {target.minimumAmount === null
                          ? "Not saved"
                          : `${target.minimumAmount} ${nutrient.unit}`}
                      </dd>
                    </div>
                    <div>
                      <dt>Saved target</dt>
                      <dd>
                        {target.targetAmount === null
                          ? "Not saved"
                          : `${target.targetAmount} ${nutrient.unit}`}
                      </dd>
                    </div>
                    <div>
                      <dt>Saved maximum</dt>
                      <dd>
                        {target.maximumAmount === null
                          ? "Not saved"
                          : `${target.maximumAmount} ${nutrient.unit}`}
                      </dd>
                    </div>
                    <div>
                      <dt>Source label</dt>
                      <dd>{target.source.label}</dd>
                    </div>
                    <div>
                      <dt>Source version</dt>
                      <dd>{target.source.version ?? "Not supplied"}</dd>
                    </div>
                    <div>
                      <dt>Saved rationale</dt>
                      <dd className={styles.preserveLines}>{target.rationale ?? "Not supplied"}</dd>
                    </div>
                  </>
                ) : (
                  <div>
                    <dt>{nutrient.name} threshold</dt>
                    <dd>No saved threshold for this nutrient.</dd>
                  </div>
                )}
                {goal.reference ? (
                  <>
                    <div>
                      <dt>Reference template</dt>
                      <dd>{goal.reference.templateCode}</dd>
                    </div>
                    <div>
                      <dt>Template version</dt>
                      <dd>{goal.reference.templateVersion}</dd>
                    </div>
                    <div>
                      <dt>Reference group</dt>
                      <dd>{goal.reference.groupCode}</dd>
                    </div>
                    <div>
                      <dt>Policy digest</dt>
                      <dd>{goal.reference.policyDigest}</dd>
                    </div>
                    <div>
                      <dt>Reference expiry</dt>
                      <dd>
                        Reference eligibility ends on {goal.reference.eligibleThroughExclusive}{" "}
                        (exclusive). It does not apply on or after that date; saved historical
                        evidence is retained.
                      </dd>
                    </div>
                  </>
                ) : (
                  <div>
                    <dt>Reference policy</dt>
                    <dd>No reference template attached.</dd>
                  </div>
                )}
              </dl>
            </div>
          );
        })}
      </section>

      <section aria-labelledby="print-source-heading">
        <h2 id="print-source-heading">Day boundaries and source diaries</h2>
        <p>
          Start instants are inclusive and end instants exclusive. Source diary dates and time zones
          preserve the original evidence even when the current profile uses another zone.
        </p>
        <table className={styles.sourceTable}>
          <colgroup>
            <col className={styles.sourceDayColumn} />
            <col className={styles.sourceBoundaryColumn} />
            <col className={styles.sourceDiaryColumn} />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">Report day</th>
              <th scope="col">Exact day boundaries</th>
              <th scope="col">Source evidence</th>
            </tr>
          </thead>
          <tbody>
            {report.days.map((day) => (
              <tr key={day.localDate}>
                <th scope="row">{day.localDate}</th>
                <td>
                  <p>Start: {day.startsAt}</p>
                  <p>End: {day.endsAt}</p>
                </td>
                <td>
                  <p>
                    Time zones:{" "}
                    {day.sourceTimeZones.length
                      ? day.sourceTimeZones.join(", ")
                      : "None; no source diaries."}
                  </p>
                  {day.sourceDiaries.map((diary) => (
                    <p key={diary.id}>
                      Diary {diary.id} · original date {diary.localDate} · revision {diary.revision}
                    </p>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <footer className={styles.footer}>
        <h2>Snapshot evidence</h2>
        <dl className={styles.evidence}>
          <div>
            <dt>Captured at (exact)</dt>
            <dd>{report.snapshotAt}</dd>
          </div>
          <div>
            <dt>Profile time zone</dt>
            <dd>{report.timeZone}</dd>
          </div>
          <div>
            <dt>Profile revision</dt>
            <dd>{report.profileRevision}</dd>
          </div>
          <div>
            <dt>Data watermark</dt>
            <dd>{report.watermarkRevision}</dd>
          </div>
          <div>
            <dt>Selected nutrient</dt>
            <dd>
              {nutrient.name} · {nutrient.code} · ID {nutrient.id} · {nutrient.unit} ·{" "}
              {nutrient.category}
            </dd>
          </div>
          <div>
            <dt>Date grouping basis</dt>
            <dd>{report.dateBasis}</dd>
          </div>
          <div>
            <dt>Goal version basis</dt>
            <dd>{report.goalVersionBasis}</dd>
          </div>
          <div>
            <dt>Chart scale policy</dt>
            <dd>{series.scalePolicy}</dd>
          </div>
        </dl>
        <p>{report.notice}</p>
      </footer>
    </article>
  );
}
