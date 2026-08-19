'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/client';
import { COVERAGE_TYPES, type CoverageType } from '@/domain/types';

interface CompanyCard {
  id: string;
  name: string;
  dba: string | null;
  status: string;
  usdotNumber: string | null;
  mcNumber: string | null;
  guidelineCount: number;
  activeCoverageCount: number;
  applicantCount: number;
  coverageTags: CoverageType[];
}

export function CompaniesView() {
  const [companies, setCompanies] = useState<CompanyCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [coverageFor, setCoverageFor] = useState<CompanyCard | null>(null);

  const [form, setForm] = useState({
    name: '',
    dba: '',
    status: 'active',
    usdotNumber: '',
    mcNumber: '',
    address: '',
    contact: '',
    notes: '',
  });
  const [lookingUp, setLookingUp] = useState(false);

  const refresh = useCallback(async () => {
    const result = await api<{ companies: CompanyCard[] }>('/api/companies');
    if (result.ok) setCompanies(result.data.companies);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function lookupUsdot() {
    setError(null);
    setNotice(null);
    if (!form.usdotNumber.trim()) {
      setError('Enter a USDOT number to look up.');
      return;
    }
    setLookingUp(true);
    const result = await api<{ company: Record<string, string | null> }>(
      `/api/fmcsa?usdot=${encodeURIComponent(form.usdotNumber.trim())}`,
    );
    setLookingUp(false);
    if (!result.ok) {
      setError(result.data.error ?? 'The USDOT lookup failed. Enter the details manually.');
      return;
    }
    const company = result.data.company;
    setForm((current) => ({
      ...current,
      name: company['name'] ?? current.name,
      dba: company['dba'] ?? current.dba,
      mcNumber: company['mcNumber'] ?? current.mcNumber,
      address: company['address'] ?? current.address,
      status: company['status'] ?? current.status,
    }));
    setNotice('Company details filled from FMCSA. Verify before saving.');
  }

  async function submit() {
    setError(null);
    if (!form.name.trim()) {
      setError('Company name is required.');
      return;
    }
    const result = await api('/api/companies', { method: 'POST', json: form });
    if (!result.ok) {
      setError(result.data.error ?? 'The company could not be created.');
      return;
    }
    setShowForm(false);
    setForm({
      name: '',
      dba: '',
      status: 'active',
      usdotNumber: '',
      mcNumber: '',
      address: '',
      contact: '',
      notes: '',
    });
    await refresh();
  }

  async function remove(company: CompanyCard) {
    setError(null);
    if (
      !window.confirm(
        `Delete ${company.name}? Its guidelines, coverages and stored evaluations will be removed.`,
      )
    ) {
      return;
    }
    const response = await fetch(`/api/companies/${company.id}`, { method: 'DELETE' });
    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      setError(data.error ?? 'The company could not be deleted.');
      return;
    }
    await refresh();
  }

  return (
    <>
      <div className="spread">
        <div>
          <h1 className="page-title">Companies</h1>
          <p className="page-sub">
            Each company keeps its own applicants, coverages and guidelines. Nothing is shared
            between them.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => setShowForm((v) => !v)}
          data-testid="add-company"
        >
          {showForm ? 'Cancel' : '+ Add company'}
        </button>
      </div>

      {error && (
        <div className="alert alert-error" role="alert" data-testid="company-error">
          {error}
        </div>
      )}
      {notice && <div className="alert alert-success">{notice}</div>}

      {showForm && (
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="usdot">USDOT number</label>
              <div className="row">
                <input
                  id="usdot"
                  style={{ flex: 1, minWidth: 120 }}
                  value={form.usdotNumber}
                  onChange={(e) => setForm({ ...form, usdotNumber: e.target.value })}
                />
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={lookupUsdot}
                  disabled={lookingUp}
                  data-testid="usdot-lookup"
                >
                  {lookingUp ? 'Looking up…' : 'Look up'}
                </button>
              </div>
            </div>
            <div className="field">
              <label htmlFor="companyName">Company name</label>
              <input
                id="companyName"
                data-testid="company-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="dba">DBA</label>
              <input id="dba" value={form.dba} onChange={(e) => setForm({ ...form, dba: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="status">Status</label>
              <select
                id="status"
                value={form.status}
                onChange={(e) => setForm({ ...form, status: e.target.value })}
              >
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="mc">MC number</label>
              <input id="mc" value={form.mcNumber} onChange={(e) => setForm({ ...form, mcNumber: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="address">Address</label>
              <input id="address" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="contact">Contact</label>
              <input id="contact" value={form.contact} onChange={(e) => setForm({ ...form, contact: e.target.value })} />
            </div>
          </div>
          <div className="field">
            <label htmlFor="notes">Notes</label>
            <textarea id="notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </div>
          <button type="button" className="btn btn-primary" onClick={submit} data-testid="save-company">
            Save company
          </button>
        </div>
      )}

      {loading ? (
        <p className="muted">Loading companies…</p>
      ) : companies.length === 0 ? (
        <div className="empty" data-testid="no-companies-empty">
          <h3>No companies yet</h3>
          <p>Add the trucking companies your safety department qualifies drivers for.</p>
          <button type="button" className="btn btn-primary" onClick={() => setShowForm(true)}>
            Add a company
          </button>
        </div>
      ) : (
        <div className="grid grid-cards">
          {companies.map((company) => (
            <div className="card" key={company.id} data-testid="company-card">
              <div className="spread">
                <h2 style={{ margin: 0, fontSize: 16 }}>{company.name}</h2>
                <span className="tag">{company.status}</span>
              </div>
              {company.dba && <p className="muted" style={{ margin: '2px 0' }}>DBA {company.dba}</p>}
              <p className="muted" style={{ margin: '2px 0 10px' }}>
                USDOT {company.usdotNumber ?? '—'} · MC {company.mcNumber ?? '—'}
              </p>

              <div className="row">
                <span className="tag">{company.activeCoverageCount} coverage(s)</span>
                <span className="tag">{company.guidelineCount} guideline(s)</span>
                <span className="tag">{company.applicantCount} applicant(s)</span>
              </div>
              <div className="row" style={{ marginTop: 6 }}>
                {company.coverageTags.map((tag) => (
                  <span className="tag" key={tag}>
                    {tag}
                  </span>
                ))}
              </div>

              <div className="row" style={{ marginTop: 12 }}>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setCoverageFor(company)}
                >
                  Add coverage / upload COI
                </button>
                <a className="btn btn-secondary btn-sm" href={`/guidelines?companyId=${company.id}`}>
                  Add guideline
                </a>
                <button type="button" className="btn btn-danger btn-sm" onClick={() => remove(company)}>
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {coverageFor && (
        <CoverageForm
          company={coverageFor}
          onClose={() => setCoverageFor(null)}
          onSaved={() => {
            setCoverageFor(null);
            void refresh();
          }}
        />
      )}
    </>
  );
}

function CoverageForm({
  company,
  onClose,
  onSaved,
}: {
  company: { id: string; name: string };
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    coverageType: 'Auto Liability' as CoverageType,
    carrier: '',
    policyNumber: '',
    effectiveDate: '',
    expirationDate: '',
    limits: '',
  });
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    const result = await api('/api/coverages', {
      method: 'POST',
      json: { companyId: company.id, ...form },
    });
    if (!result.ok) {
      setError(result.data.error ?? 'The coverage could not be saved.');
      return;
    }
    onSaved();
  }

  return (
    <div className="overlay modal-center" role="dialog" aria-modal="true" aria-label="Add coverage">
      <div className="modal" style={{ maxWidth: 560 }}>
        <div className="drawer-head">
          <h2 style={{ margin: 0, fontSize: 17 }}>Add coverage — {company.name}</h2>
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
          <div className="dropzone" style={{ marginBottom: 14 }}>
            <p style={{ margin: 0 }}>
              <strong>Drag and drop the certificate of insurance</strong>
            </p>
            <p className="muted" style={{ margin: '6px 0 0' }}>
              Extracted values appear below for correction before saving.
            </p>
          </div>
          <div className="field">
            <label htmlFor="coverageType">Coverage type</label>
            <select
              id="coverageType"
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
          <div className="form-grid">
            <div className="field">
              <label htmlFor="carrier">Carrier</label>
              <input id="carrier" value={form.carrier} onChange={(e) => setForm({ ...form, carrier: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="policyNumber">Policy number</label>
              <input
                id="policyNumber"
                value={form.policyNumber}
                onChange={(e) => setForm({ ...form, policyNumber: e.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="effectiveDate">Effective date</label>
              <input
                id="effectiveDate"
                type="date"
                value={form.effectiveDate}
                onChange={(e) => setForm({ ...form, effectiveDate: e.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="expirationDate">Expiration date</label>
              <input
                id="expirationDate"
                type="date"
                value={form.expirationDate}
                onChange={(e) => setForm({ ...form, expirationDate: e.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="limits">Limits</label>
              <input id="limits" value={form.limits} onChange={(e) => setForm({ ...form, limits: e.target.value })} />
            </div>
          </div>
        </div>
        <div className="drawer-foot">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={submit} data-testid="save-coverage">
            Save coverage
          </button>
        </div>
      </div>
    </div>
  );
}
