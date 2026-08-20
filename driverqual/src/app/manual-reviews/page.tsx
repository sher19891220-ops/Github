import { getDb } from '@/db';
import { dashboardRows, getStoredEvaluation } from '@/db/repo';
import { DecisionBadge } from '@/components/Badge';

export const dynamic = 'force-dynamic';

export default async function ManualReviewsPage() {
  const db = await getDb();
  const allRows = await dashboardRows(db);
  const rows = allRows.filter((row) => row.overall === 'Manual Review');

  // Resolve each row's stored coverages up front; a server component cannot
  // await inside the JSX it returns.
  const detailed = await Promise.all(
    rows.map(async (row) => ({
      row,
      stored: await getStoredEvaluation(db, row.applicant.id, row.applicant.companyId),
    })),
  );

  return (
    <>
      <h1 className="page-title">Manual reviews</h1>
      <p className="page-sub">
        Drivers whose evidence is missing, stale, unclear or awaiting an approved guideline. Nothing
        here is a rejection.
      </p>

      {rows.length === 0 ? (
        <div className="empty">
          <h3>Nothing awaiting review</h3>
          <p>Applicants appear here when their evidence cannot decide a guideline’s criteria.</p>
        </div>
      ) : (
        detailed.map(({ row, stored }) => {
          const auto = stored.coverages.find((c) => c.coverageType === 'Auto Liability');
          return (
            <div className="card" key={row.applicant.id} style={{ marginBottom: 14 }}>
              <div className="spread">
                <h2 style={{ margin: 0, fontSize: 16 }}>
                  {row.applicant.firstName} {row.applicant.lastName}
                  <span className="muted"> — {row.companyName}</span>
                </h2>
                <DecisionBadge decision={row.overall} />
              </div>
              <p style={{ marginBottom: 6 }}>{row.overallReason}</p>
              {auto && auto.dataGaps.length > 0 && (
                <>
                  <p className="stat-label">Data gaps</p>
                  <ul className="reasons">
                    {auto.dataGaps.map((gap) => (
                      <li key={gap}>{gap}</li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          );
        })
      )}
    </>
  );
}
