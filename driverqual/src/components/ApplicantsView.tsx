'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/client';
import type { CoverageType, Decision } from '@/domain/types';
import type { DriverEvidence } from '@/domain/types';
import { ApplicantDrawer } from './ApplicantDrawer';
import { CompareModal } from './CompareModal';
import { DecisionBadge } from './Badge';

interface Row {
  applicant: {
    id: string;
    companyId: string;
    firstName: string;
    lastName: string;
    cdlNumber: string | null;
    cdlState: string | null;
  };
  companyName: string;
  coverageDecisions: Partial<Record<CoverageType, Decision>>;
  overall: Decision;
  overallReason: string;
}

interface Company {
  id: string;
  name: string;
  guidelineCount: number;
}

const TABLE_COVERAGES: CoverageType[] = [
  'Auto Liability',
  'General Liability',
  'Cargo',
  'Physical Damage',
];

export function ApplicantsView({ title, subtitle }: { title: string; subtitle: string }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<
    | { mode: 'create' }
    | { mode: 'update'; applicantId: string; companyId: string; evidence: DriverEvidence | null }
    | null
  >(null);
  const [comparing, setComparing] = useState<{ id: string; name: string; companyId: string } | null>(
    null,
  );
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [applicants, companyList] = await Promise.all([
      api<{ rows: Row[] }>('/api/applicants'),
      api<{ companies: Company[] }>('/api/companies'),
    ]);
    if (applicants.ok) setRows(applicants.data.rows);
    if (companyList.ok) setCompanies(companyList.data.companies);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function act(applicantId: string, json: Record<string, unknown>) {
    setBusy(applicantId);
    setError(null);
    const result = await api(`/api/applicants/${applicantId}`, { method: 'POST', json });
    setBusy(null);
    if (!result.ok) {
      setError(result.data.error ?? 'The action could not be completed.');
      return;
    }
    await refresh();
  }

  async function openUpdate(applicantId: string, companyId: string) {
    const result = await api<{ evidence: DriverEvidence | null }>(`/api/applicants/${applicantId}`);
    setDrawer({
      mode: 'update',
      applicantId,
      companyId,
      evidence: result.ok ? result.data.evidence : null,
    });
  }

  async function removeApplicant(applicantId: string, name: string) {
    if (!window.confirm(`Remove ${name}? Their documents and evaluations will be deleted.`)) return;
    setBusy(applicantId);
    await fetch(`/api/applicants/${applicantId}`, { method: 'DELETE' });
    setBusy(null);
    await refresh();
  }

  return (
    <>
      <div className="spread">
        <div>
          <h1 className="page-title">{title}</h1>
          <p className="page-sub">{subtitle}</p>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => setDrawer({ mode: 'create' })}
          data-testid="add-applicant"
        >
          + Add applicant
        </button>
      </div>

      {error && (
        <div className="alert alert-error" role="alert" data-testid="view-error">
          {error}
        </div>
      )}

      {loading ? (
        <p className="muted">Loading applicants…</p>
      ) : rows.length === 0 ? (
        <div className="empty" data-testid="no-applicants">
          <h3>No applicants yet</h3>
          <p>
            {companies.length === 0
              ? 'Add a trucking company first, then add an applicant and upload their MVR, CDL and medical card.'
              : 'Add an applicant and upload their MVR, CDL and medical card to run an evaluation.'}
          </p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setDrawer({ mode: 'create' })}
          >
            Add applicant
          </button>
        </div>
      ) : (
        <div className="card">
          <p className="swipe-hint">Swipe sideways to see every coverage column.</p>
          <div className="table-scroll">
            <table data-testid="applicants-table">
              <thead>
                <tr>
                  <th className="driver-cell">Driver</th>
                  <th>Applying company</th>
                  <th>CDL</th>
                  {TABLE_COVERAGES.map((c) => (
                    <th key={c}>{c}</th>
                  ))}
                  <th>Overall</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const name = `${row.applicant.firstName} ${row.applicant.lastName}`;
                  return (
                    <tr key={row.applicant.id} data-testid="applicant-row">
                      <td className="driver-cell">{name}</td>
                      <td>
                        <select
                          aria-label={`Applying company for ${name}`}
                          value={row.applicant.companyId}
                          disabled={busy === row.applicant.id}
                          onChange={(e) =>
                            act(row.applicant.id, {
                              action: 'change_company',
                              companyId: e.target.value,
                            })
                          }
                        >
                          {companies.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="mono">
                        {row.applicant.cdlNumber ?? '—'}
                        {row.applicant.cdlState ? ` (${row.applicant.cdlState})` : ''}
                      </td>
                      {TABLE_COVERAGES.map((coverage) => (
                        <td key={coverage}>
                          <DecisionBadge decision={row.coverageDecisions[coverage]} />
                        </td>
                      ))}
                      <td title={row.overallReason} data-testid="overall-decision">
                        <DecisionBadge decision={row.overall} />
                      </td>
                      <td>
                        <div className="row">
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={() =>
                              setComparing({
                                id: row.applicant.id,
                                name,
                                companyId: row.applicant.companyId,
                              })
                            }
                          >
                            Compare
                          </button>
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={() => openUpdate(row.applicant.id, row.applicant.companyId)}
                          >
                            Update CDL/MVR
                          </button>
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            disabled={busy === row.applicant.id}
                            onClick={() => act(row.applicant.id, { action: 'reevaluate' })}
                          >
                            Reevaluate
                          </button>
                          <button
                            type="button"
                            className="btn btn-danger btn-sm"
                            onClick={() => removeApplicant(row.applicant.id, name)}
                          >
                            Remove
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="disclaimer">
        Results are decision support only. An authorised safety or underwriting representative must
        review every decision before it is acted upon.
      </div>

      {drawer && (
        <ApplicantDrawer
          companies={companies}
          mode={drawer.mode}
          applicantId={drawer.mode === 'update' ? drawer.applicantId : undefined}
          initialCompanyId={drawer.mode === 'update' ? drawer.companyId : undefined}
          initialEvidence={drawer.mode === 'update' ? drawer.evidence : null}
          onClose={() => setDrawer(null)}
          onSaved={() => {
            setDrawer(null);
            void refresh();
          }}
        />
      )}

      {comparing && (
        <CompareModal
          applicantId={comparing.id}
          applicantName={comparing.name}
          companies={companies}
          currentCompanyId={comparing.companyId}
          onClose={() => setComparing(null)}
        />
      )}
    </>
  );
}
