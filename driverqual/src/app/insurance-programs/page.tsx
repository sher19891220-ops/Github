import { getDb } from '@/db';
import { listCompanies, listCoverages, listExpirationAlerts, refreshExpirationAlerts } from '@/db/repo';

export const dynamic = 'force-dynamic';

export default function InsuranceProgramsPage() {
  const db = getDb();
  refreshExpirationAlerts(db);
  const companies = new Map(listCompanies(db).map((c) => [c.id, c.name]));
  const coverages = listCoverages(db);
  const alerts = new Map(listExpirationAlerts(db).map((a) => [a.coverageId, a]));

  return (
    <>
      <h1 className="page-title">Insurance programs</h1>
      <p className="page-sub">
        Coverages on file per company, with alerts opening 90 days before expiration.
      </p>

      {coverages.length === 0 ? (
        <div className="empty">
          <h3>No coverages on file</h3>
          <p>Open a company and use “Add coverage / upload COI” to record a policy.</p>
          <a className="btn btn-primary" href="/companies">
            Go to companies
          </a>
        </div>
      ) : (
        <div className="card">
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th className="driver-cell">Company</th>
                  <th>Coverage</th>
                  <th>Carrier</th>
                  <th>Policy</th>
                  <th>Effective</th>
                  <th>Expires</th>
                  <th>Limits</th>
                  <th>Alert</th>
                </tr>
              </thead>
              <tbody>
                {coverages.map((coverage) => {
                  const alert = alerts.get(coverage.id);
                  return (
                    <tr key={coverage.id}>
                      <td className="driver-cell">{companies.get(coverage.companyId) ?? 'Unknown'}</td>
                      <td>{coverage.coverageType}</td>
                      <td>{coverage.carrier ?? '—'}</td>
                      <td className="mono">{coverage.policyNumber ?? '—'}</td>
                      <td>{coverage.effectiveDate ?? '—'}</td>
                      <td>{coverage.expirationDate ?? '—'}</td>
                      <td>{coverage.limits ?? '—'}</td>
                      <td>
                        {alert ? (
                          <span
                            className={
                              alert.severity === 'expired'
                                ? 'badge badge-not-qualified'
                                : 'badge badge-manual-review'
                            }
                          >
                            {alert.severity === 'expired'
                              ? 'Expired'
                              : `${alert.daysUntil} days`}
                          </span>
                        ) : (
                          <span className="badge badge-qualified">Current</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
