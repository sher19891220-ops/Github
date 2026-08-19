'use client';

import { useState } from 'react';
import { api } from '@/lib/client';
import type { CoverageEvaluation, OverallDecision } from '@/domain/engine';
import { DecisionBadge } from './Badge';

interface CompanyOption {
  id: string;
  name: string;
  guidelineCount: number;
}

interface Comparison {
  companyId: string;
  companyName: string;
  coverages: CoverageEvaluation[];
  overall: OverallDecision;
}

export function CompareModal({
  applicantId,
  applicantName,
  companies,
  currentCompanyId,
  onClose,
}: {
  applicantId: string;
  applicantName: string;
  companies: CompanyOption[];
  currentCompanyId: string;
  onClose: () => void;
}) {
  // Start with the applicant's own company only. Preselecting arbitrary others
  // would quietly run — and store — evaluations nobody asked for.
  const [selected, setSelected] = useState<string[]>([currentCompanyId]);
  const [results, setResults] = useState<Comparison[] | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setError(null);
    if (selected.length === 0) {
      setError('Select at least one company to compare.');
      return;
    }
    setRunning(true);
    const result = await api<{ comparisons: Comparison[] }>(`/api/applicants/${applicantId}`, {
      method: 'POST',
      json: { action: 'compare', companyIds: selected },
    });
    setRunning(false);
    if (!result.ok) {
      setError(result.data.error ?? 'The comparison could not be run.');
      return;
    }
    setResults(result.data.comparisons);
  }

  return (
    <div
      className="overlay modal-center"
      role="dialog"
      aria-modal="true"
      aria-label={`Compare companies for ${applicantName}`}
    >
      <div className="modal">
        <div className="drawer-head">
          <h2 style={{ margin: 0, fontSize: 17 }}>Compare companies — {applicantName}</h2>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="drawer-body">
          {error && (
            <div className="alert alert-error" role="alert">
              {error}
            </div>
          )}

          <div className="alert alert-info">
            Each company is evaluated independently against its own guidelines. One company’s
            result never changes another company’s result.
          </div>

          <fieldset style={{ border: 0, padding: 0, margin: '0 0 14px' }}>
            <legend className="stat-label" style={{ marginBottom: 8 }}>
              Companies
            </legend>
            {companies.map((company) => (
              <label
                key={company.id}
                className="row"
                style={{ minHeight: 44, gap: 10, cursor: 'pointer' }}
              >
                <input
                  type="checkbox"
                  style={{ width: 18, height: 18, minHeight: 18 }}
                  checked={selected.includes(company.id)}
                  onChange={(e) =>
                    setSelected((current) =>
                      e.target.checked
                        ? [...current, company.id]
                        : current.filter((id) => id !== company.id),
                    )
                  }
                />
                <span>{company.name}</span>
                <span className="tag">{company.guidelineCount} active guideline(s)</span>
              </label>
            ))}
          </fieldset>

          <button
            type="button"
            className="btn btn-primary"
            onClick={run}
            disabled={running}
            data-testid="run-comparison"
          >
            {running ? 'Evaluating…' : 'Evaluate selected companies'}
          </button>

          {results && (
            <div data-testid="comparison-results">
              {results.map((result) => {
                const auto = result.coverages.find((c) => c.coverageType === 'Auto Liability');
                return (
                  <div key={result.companyId} className="card" style={{ marginTop: 16 }}>
                    <div className="spread">
                      <h3 style={{ margin: 0, fontSize: 16 }}>{result.companyName}</h3>
                      <DecisionBadge decision={result.overall.decision} />
                    </div>
                    <p className="muted" style={{ marginTop: 6 }}>
                      {result.overall.reason}
                    </p>

                    <div className="row" style={{ marginTop: 10 }}>
                      {result.coverages.map((coverage) => (
                        <span key={coverage.coverageType} className="tag">
                          {coverage.coverageType}: {coverage.decision}
                        </span>
                      ))}
                    </div>

                    {auto && (
                      <div style={{ marginTop: 12 }}>
                        <p className="stat-label">Guideline applied</p>
                        <p style={{ margin: '2px 0 10px' }}>
                          {auto.guidelineName ?? 'None configured'}
                          {auto.guidelineVersion ? ` — version ${auto.guidelineVersion}` : ''}
                        </p>

                        <p className="stat-label">Decision</p>
                        <p style={{ margin: '2px 0 10px' }}>{auto.reason}</p>

                        {auto.criteriaApplied.length > 0 && (
                          <>
                            <p className="stat-label">Criteria applied</p>
                            <ul className="reasons">
                              {auto.criteriaApplied.map((c) => (
                                <li key={c}>{c}</li>
                              ))}
                            </ul>
                          </>
                        )}
                        {auto.evidenceUsed.length > 0 && (
                          <>
                            <p className="stat-label" style={{ marginTop: 10 }}>
                              Evidence used
                            </p>
                            <ul className="reasons">
                              {auto.evidenceUsed.map((c) => (
                                <li key={c}>{c}</li>
                              ))}
                            </ul>
                          </>
                        )}
                        {auto.excludedEvidence.length > 0 && (
                          <>
                            <p className="stat-label" style={{ marginTop: 10 }}>
                              Excluded records
                            </p>
                            <ul className="reasons">
                              {auto.excludedEvidence.map((c) => (
                                <li key={c}>{c}</li>
                              ))}
                            </ul>
                          </>
                        )}
                        {auto.dataGaps.length > 0 && (
                          <>
                            <p className="stat-label" style={{ marginTop: 10 }}>
                              Data gaps
                            </p>
                            <ul className="reasons">
                              {auto.dataGaps.map((c) => (
                                <li key={c}>{c}</li>
                              ))}
                            </ul>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
