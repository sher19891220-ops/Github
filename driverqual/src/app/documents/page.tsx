import { getDb } from '@/db';
import { getCurrentEvidence, listApplicants, listCompanies } from '@/db/repo';
import { CURRENT_EXTRACTION_FORMAT_VERSION } from '@/domain/types';

export const dynamic = 'force-dynamic';

export default async function DocumentsPage() {
  const db = await getDb();
  const companies = new Map((await listCompanies(db)).map((c) => [c.id, c.name]));
  const applicants = await Promise.all(
    (await listApplicants(db)).map(async (applicant) => {
      const current = await getCurrentEvidence(db, applicant.id);
      return { applicant, evidence: current?.evidence ?? null };
    }),
  );

  return (
    <>
      <h1 className="page-title">Documents</h1>
      <p className="page-sub">
        Evidence currently on file for each applicant, and whether it was read with the current
        extraction format.
      </p>

      {applicants.length === 0 ? (
        <div className="empty">
          <h3>No documents on file</h3>
          <p>Add an applicant and upload their MVR, CDL and medical card.</p>
        </div>
      ) : (
        <div className="card">
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th className="driver-cell">Driver</th>
                  <th>Company</th>
                  <th>MVR order date</th>
                  <th>Original CDL issue</th>
                  <th>Licence status</th>
                  <th>Medical card</th>
                  <th>MVR records</th>
                  <th>Extraction format</th>
                </tr>
              </thead>
              <tbody>
                {applicants.map(({ applicant, evidence }) => (
                  <tr key={applicant.id}>
                    <td className="driver-cell">
                      {applicant.firstName} {applicant.lastName}
                    </td>
                    <td>{companies.get(applicant.companyId) ?? 'Unknown'}</td>
                    <td>{evidence?.mvrOrderDate ?? '—'}</td>
                    <td>{evidence?.cdlOriginalIssueDate ?? 'Cannot calculate'}</td>
                    <td>{evidence?.licenseStatus ?? 'Unknown'}</td>
                    <td>
                      {evidence?.medicalCard?.present
                        ? `Expires ${evidence.medicalCard.expirationDate ?? 'unknown'}`
                        : 'Not on file'}
                    </td>
                    <td>{evidence?.events.length ?? 0}</td>
                    <td>
                      {evidence
                        ? evidence.extractionFormatVersion < CURRENT_EXTRACTION_FORMAT_VERSION
                          ? `v${evidence.extractionFormatVersion} — re-read required`
                          : `v${evidence.extractionFormatVersion}`
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
