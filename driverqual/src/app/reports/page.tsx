import { getDb } from '@/db';
import { dashboardRows, dashboardStats, listCompanyCards, listExpirationAlerts } from '@/db/repo';

export const dynamic = 'force-dynamic';

export default async function ReportsPage() {
  const db = await getDb();
  const stats = await dashboardStats(db);
  const rows = await dashboardRows(db);
  const companies = await listCompanyCards(db);
  const alerts = await listExpirationAlerts(db);

  const byCompany = companies.map((company) => {
    const companyRows = rows.filter((r) => r.applicant.companyId === company.id);
    return {
      company,
      total: companyRows.length,
      qualified: companyRows.filter((r) => r.overall === 'Qualified').length,
      manualReview: companyRows.filter((r) => r.overall === 'Manual Review').length,
      notQualified: companyRows.filter((r) => r.overall === 'Not Qualified').length,
    };
  });

  return (
    <>
      <h1 className="page-title">Reports</h1>
      <p className="page-sub">Qualification outcomes by company, and open coverage alerts.</p>

      <div className="grid grid-stats">
        <div className="card">
          <p className="stat-label">Applicants</p>
          <p className="stat-value">{stats.totalApplicants}</p>
        </div>
        <div className="card">
          <p className="stat-label">Qualified</p>
          <p className="stat-value">{stats.qualified}</p>
        </div>
        <div className="card">
          <p className="stat-label">Manual review</p>
          <p className="stat-value">{stats.manualReview}</p>
        </div>
        <div className="card">
          <p className="stat-label">Not qualified</p>
          <p className="stat-value">{stats.notQualified}</p>
        </div>
      </div>

      <h2 className="section">By company</h2>
      {byCompany.length === 0 ? (
        <div className="empty">
          <h3>Nothing to report yet</h3>
          <p>Add a company and evaluate an applicant to populate this report.</p>
        </div>
      ) : (
        <div className="card">
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th className="driver-cell">Company</th>
                  <th>Applicants</th>
                  <th>Qualified</th>
                  <th>Manual review</th>
                  <th>Not qualified</th>
                  <th>Active guidelines</th>
                </tr>
              </thead>
              <tbody>
                {byCompany.map((entry) => (
                  <tr key={entry.company.id}>
                    <td className="driver-cell">{entry.company.name}</td>
                    <td>{entry.total}</td>
                    <td>{entry.qualified}</td>
                    <td>{entry.manualReview}</td>
                    <td>{entry.notQualified}</td>
                    <td>{entry.company.guidelineCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <h2 className="section">Coverage alerts</h2>
      {alerts.length === 0 ? (
        <p className="muted">No policies are expired or expiring within 90 days.</p>
      ) : (
        <ul className="reasons">
          {alerts.map((alert) => (
            <li key={alert.id}>{alert.message}</li>
          ))}
        </ul>
      )}
    </>
  );
}
