'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/client';
import { COVERAGE_TYPES, type CoverageType } from '@/domain/types';
import type { Guideline } from '@/domain/guideline';

interface Company {
  id: string;
  name: string;
}

const EXAMPLE_RULE_SET = `{
  "schemaVersion": 1,
  "eligibilityPaths": [
    {
      "id": "path.two_year",
      "label": "Two-year experience path",
      "sourceText": "Two or more years of CDL experience: maximum three moving violations in 36 months.",
      "conditions": [
        { "type": "min_experience_months", "months": 24 },
        { "type": "max_events", "category": "moving_violation", "lookbackMonths": 36, "max": 3 }
      ]
    }
  ],
  "disqualifiers": []
}`;

export function GuidelinesView() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [guidelines, setGuidelines] = useState<Guideline[]>([]);
  const [selectedCompany, setSelectedCompany] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const [files, setFiles] = useState<File[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [interpreting, setInterpreting] = useState(false);
  const [draftWarnings, setDraftWarnings] = useState<string[]>([]);

  const [form, setForm] = useState({
    coverageType: 'Auto Liability' as CoverageType,
    carrier: '',
    policyNumber: '',
    version: '',
    effectiveDate: '',
    expirationDate: '',
    fileName: '',
    usedForDriverQualification: true,
    ruleSet: '',
  });

  const loadGuidelines = useCallback(async (companyId: string) => {
    const query = companyId ? `?companyId=${encodeURIComponent(companyId)}` : '';
    const result = await api<{ guidelines: Guideline[] }>(`/api/guidelines${query}`);
    if (result.ok) setGuidelines(result.data.guidelines);
  }, []);

  useEffect(() => {
    void (async () => {
      const result = await api<{ companies: Company[] }>('/api/companies');
      if (result.ok) {
        setCompanies(result.data.companies);
        const first = new URLSearchParams(window.location.search).get('companyId') ?? '';
        setSelectedCompany(first);
        await loadGuidelines(first);
      }
    })();
  }, [loadGuidelines]);

  async function selectCompany(companyId: string) {
    setSelectedCompany(companyId);
    await loadGuidelines(companyId);
  }

  /**
   * Reads the uploaded guideline and drafts criteria into the editor.
   *
   * The draft is never saved directly — it lands in the textarea for a person
   * to correct, and still has to be approved before it decides anything.
   */
  async function interpretDocument() {
    setError(null);
    setNotice(null);
    setDraftWarnings([]);
    if (files.length === 0) {
      setError('Attach the guideline document before reading it.');
      return;
    }

    setInterpreting(true);
    const body = new FormData();
    for (const file of files) body.append('files', file);
    const response = await fetch('/api/guidelines/interpret', { method: 'POST', body });
    const data = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      ruleSet?: unknown;
      warnings?: string[];
      errors?: string[];
      error?: string;
    };
    setInterpreting(false);

    if (!response.ok || !data.ruleSet) {
      setError(data.errors?.join(' ') ?? data.error ?? 'The guideline could not be read.');
      return;
    }

    setForm((current) => ({
      ...current,
      ruleSet: JSON.stringify(data.ruleSet, null, 2),
      fileName: current.fileName || (files[0]?.name ?? ''),
    }));
    setDraftWarnings(data.warnings ?? []);
    setNotice(
      'Draft criteria written below. Check every path and threshold against the document before saving — this is a reading of the file, not an authority.',
    );
  }

  async function submit() {
    setError(null);
    setNotice(null);
    if (!selectedCompany) {
      setError('Select a company before adding a guideline.');
      return;
    }

    let ruleSet: unknown;
    if (form.ruleSet.trim()) {
      try {
        ruleSet = JSON.parse(form.ruleSet);
      } catch {
        setError('The interpreted criteria are not valid JSON.');
        return;
      }
    }

    const result = await api('/api/guidelines', {
      method: 'POST',
      json: {
        companyId: selectedCompany,
        coverageType: form.coverageType,
        carrier: form.carrier || null,
        policyNumber: form.policyNumber || null,
        version: form.version || undefined,
        effectiveDate: form.effectiveDate || null,
        expirationDate: form.expirationDate || null,
        fileName: form.fileName || null,
        usedForDriverQualification: form.usedForDriverQualification,
        ruleSet,
      },
    });

    if (!result.ok) {
      setError(result.data.error ?? 'The guideline could not be saved.');
      return;
    }
    setNotice(
      ruleSet
        ? 'Guideline saved. It is awaiting approval and will not drive decisions until approved.'
        : 'Guideline file saved. Add interpreted criteria and approve them before it can drive decisions.',
    );
    setShowForm(false);
    await loadGuidelines(selectedCompany);
  }

  async function approve(id: string) {
    await api(`/api/guidelines/${id}`, { method: 'POST', json: { action: 'approve' } });
    await loadGuidelines(selectedCompany);
  }

  async function remove(id: string) {
    if (!window.confirm('Remove this guideline? It is archived, not destroyed, so past decisions stay reproducible.')) {
      return;
    }
    await fetch(`/api/guidelines/${id}`, { method: 'DELETE' });
    await loadGuidelines(selectedCompany);
  }

  return (
    <>
      <div className="spread">
        <div>
          <h1 className="page-title">Rules &amp; guidelines</h1>
          <p className="page-sub">
            Every guideline belongs to one company and one coverage. A guideline only drives
            decisions once its interpreted criteria are approved.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => setShowForm((v) => !v)}
          data-testid="add-guideline"
        >
          {showForm ? 'Cancel' : '+ Add guideline'}
        </button>
      </div>

      {error && (
        <div className="alert alert-error" role="alert" data-testid="guideline-error">
          {error}
        </div>
      )}
      {notice && <div className="alert alert-success">{notice}</div>}

      <div className="card" style={{ marginBottom: 18 }}>
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="companyFilter">Company</label>
          <select
            id="companyFilter"
            data-testid="guideline-company-filter"
            value={selectedCompany}
            onChange={(e) => selectCompany(e.target.value)}
          >
            <option value="">All companies</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {showForm && (
        <div className="card" style={{ marginBottom: 18 }}>
          <div
            className="dropzone"
            style={{ marginBottom: 14 }}
            data-active={dragActive}
            data-testid="guideline-dropzone"
            onDragOver={(e) => {
              e.preventDefault();
              setDragActive(true);
            }}
            onDragLeave={() => setDragActive(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragActive(false);
              setFiles(Array.from(e.dataTransfer.files));
            }}
            onClick={() => document.getElementById('guideline-file')?.click()}
          >
            <p style={{ margin: 0 }}>
              <strong>Drag and drop the guideline document</strong>
            </p>
            <p className="muted" style={{ margin: '6px 0 0' }}>
              PDF, JPG, PNG or HEIC. The display name is derived from the company, coverage,
              carrier or filename — there is no separate name field to get wrong.
            </p>
            <input
              id="guideline-file"
              data-testid="guideline-file"
              type="file"
              multiple
              accept=".pdf,.jpg,.jpeg,.png,.heic,.heif"
              style={{ display: 'none' }}
              onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
            />
          </div>

          {files.length > 0 && (
            <ul className="reasons" data-testid="guideline-file-list">
              {files.map((f) => (
                <li key={f.name}>
                  {f.name} <span className="muted">({(f.size / 1024).toFixed(0)} KB)</span>
                </li>
              ))}
            </ul>
          )}

          <div className="row" style={{ marginBottom: 14 }}>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={interpretDocument}
              disabled={interpreting}
              data-testid="interpret-guideline"
            >
              {interpreting ? 'Reading guideline…' : 'Read guideline and draft criteria'}
            </button>
          </div>

          {draftWarnings.length > 0 && (
            <div className="alert alert-warn" data-testid="draft-warnings">
              <strong>Check these before approving:</strong>
              <ul className="reasons">
                {draftWarnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="form-grid">
            <div className="field">
              <label htmlFor="glCoverage">Coverage</label>
              <select
                id="glCoverage"
                value={form.coverageType}
                onChange={(e) => setForm({ ...form, coverageType: e.target.value as CoverageType })}
              >
                {COVERAGE_TYPES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="glCarrier">Insurance carrier (optional)</label>
              <input id="glCarrier" value={form.carrier} onChange={(e) => setForm({ ...form, carrier: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="glPolicy">Policy number (optional)</label>
              <input
                id="glPolicy"
                value={form.policyNumber}
                onChange={(e) => setForm({ ...form, policyNumber: e.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="glVersion">Version</label>
              <input
                id="glVersion"
                placeholder="auto"
                value={form.version}
                onChange={(e) => setForm({ ...form, version: e.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="glEffective">Effective date</label>
              <input
                id="glEffective"
                type="date"
                value={form.effectiveDate}
                onChange={(e) => setForm({ ...form, effectiveDate: e.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="glExpiration">Expiration date</label>
              <input
                id="glExpiration"
                type="date"
                value={form.expirationDate}
                onChange={(e) => setForm({ ...form, expirationDate: e.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="glFile">File name</label>
              <input id="glFile" value={form.fileName} onChange={(e) => setForm({ ...form, fileName: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="glUsed">Used for driver qualification</label>
              <select
                id="glUsed"
                value={form.usedForDriverQualification ? 'yes' : 'no'}
                onChange={(e) => setForm({ ...form, usedForDriverQualification: e.target.value === 'yes' })}
              >
                <option value="yes">Yes</option>
                <option value="no">No — compliance tracking only</option>
              </select>
            </div>
          </div>
          <div className="field">
            <label htmlFor="glRuleSet">Interpreted criteria (JSON rule tree)</label>
            <textarea
              id="glRuleSet"
              data-testid="guideline-ruleset"
              style={{ minHeight: 180, fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
              placeholder={EXAMPLE_RULE_SET}
              value={form.ruleSet}
              onChange={(e) => setForm({ ...form, ruleSet: e.target.value })}
            />
            <span className="muted">
              Alternative eligibility paths are alternatives, not a checklist — a driver who
              satisfies any one path qualifies.
            </span>
          </div>
          <button type="button" className="btn btn-primary" onClick={submit} data-testid="save-guideline">
            Save guideline
          </button>
        </div>
      )}

      {guidelines.length === 0 ? (
        <div className="empty" data-testid="no-guidelines">
          <h3>No guidelines for this selection</h3>
          <p>Upload the company’s driver-qualification guideline for each coverage it underwrites.</p>
        </div>
      ) : (
        <div className="card">
          <div className="table-scroll">
            <table data-testid="guidelines-table">
              <thead>
                <tr>
                  <th>Coverage</th>
                  <th>Version</th>
                  <th>Status</th>
                  <th>Review</th>
                  <th>Effective</th>
                  <th>Expires</th>
                  <th>Driver qualification</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {guidelines.map((guideline) => (
                  <tr key={guideline.id}>
                    <td>
                      {guideline.coverageType}
                      {guideline.carrier ? <span className="muted"> — {guideline.carrier}</span> : null}
                    </td>
                    <td>v{guideline.version}</td>
                    <td>
                      <span className="tag">{guideline.status}</span>
                    </td>
                    <td>
                      <span className="tag">{guideline.reviewStatus.replace(/_/g, ' ')}</span>
                    </td>
                    <td>{guideline.effectiveDate ?? '—'}</td>
                    <td>{guideline.expirationDate ?? '—'}</td>
                    <td>{guideline.usedForDriverQualification ? 'Yes' : 'No'}</td>
                    <td>
                      <div className="row">
                        {guideline.reviewStatus !== 'approved' && guideline.ruleSet && (
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={() => approve(guideline.id)}
                            data-testid="approve-guideline"
                          >
                            Approve
                          </button>
                        )}
                        {guideline.status === 'active' && (
                          <button
                            type="button"
                            className="btn btn-danger btn-sm"
                            onClick={() => remove(guideline.id)}
                          >
                            Remove
                          </button>
                        )}
                      </div>
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
