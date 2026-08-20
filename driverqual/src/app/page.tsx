import { getDb } from '@/db';
import { dashboardStats, listExpirationAlerts, refreshExpirationAlerts } from '@/db/repo';
import { ApplicantsView } from '@/components/ApplicantsView';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const db = await getDb();
  await refreshExpirationAlerts(db);
  const stats = await dashboardStats(db);
  const alerts = await listExpirationAlerts(db);

  const tiles = [
    { label: 'Total applicants', value: stats.totalApplicants },
    { label: 'Qualified', value: stats.qualified },
    { label: 'Manual review', value: stats.manualReview },
    { label: 'Not qualified', value: stats.notQualified },
    { label: 'Documents needing review', value: stats.documentsNeedingReview },
    { label: '90-day coverage alerts', value: stats.coverageAlerts },
  ];

  return (
    <>
      <div className="grid grid-stats" data-testid="dashboard-stats">
        {tiles.map((tile) => (
          <div className="card" key={tile.label}>
            <p className="stat-label">{tile.label}</p>
            <p className="stat-value">{tile.value}</p>
          </div>
        ))}
      </div>

      {alerts.length > 0 && (
        <div className="alert alert-warn" style={{ marginTop: 18 }} data-testid="coverage-alerts">
          <strong>Coverage attention needed</strong>
          <ul className="reasons">
            {alerts.map((alert) => (
              <li key={alert.id}>{alert.message}</li>
            ))}
          </ul>
        </div>
      )}

      <div style={{ marginTop: 24 }}>
        <ApplicantsView
          title="Recent applicants"
          subtitle="Each driver is evaluated against their applying company’s own guidelines. Auto Liability alone controls the overall decision."
        />
      </div>
    </>
  );
}
