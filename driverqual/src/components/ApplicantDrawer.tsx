'use client';

import { useState } from 'react';
import { api } from '@/lib/client';
import { emptyEvidence, type DriverEvidence } from '@/domain/types';
import { EvidenceEditor } from './EvidenceEditor';

export interface CompanyOption {
  id: string;
  name: string;
}

interface Props {
  companies: CompanyOption[];
  mode: 'create' | 'update';
  applicantId?: string;
  initialCompanyId?: string;
  initialEvidence?: DriverEvidence | null;
  initialName?: { firstName: string; lastName: string };
  onClose: () => void;
  onSaved: () => void;
}

const ACCEPT = '.pdf,.jpg,.jpeg,.png,.heic,.heif';

export function ApplicantDrawer({
  companies,
  mode,
  applicantId,
  initialCompanyId,
  initialEvidence,
  initialName,
  onClose,
  onSaved,
}: Props) {
  const [companyId, setCompanyId] = useState(initialCompanyId ?? companies[0]?.id ?? '');
  const [firstName, setFirstName] = useState(initialName?.firstName ?? '');
  const [middleName, setMiddleName] = useState('');
  const [lastName, setLastName] = useState(initialName?.lastName ?? '');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [driverType, setDriverType] = useState('Company driver');
  const [recruiter, setRecruiter] = useState('');

  const [files, setFiles] = useState<File[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [evidence, setEvidence] = useState<DriverEvidence>(initialEvidence ?? emptyEvidence());
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function addFiles(incoming: FileList | null) {
    if (!incoming) return;
    setFiles((current) => [...current, ...Array.from(incoming)].slice(0, 8));
  }

  async function readDocuments() {
    setError(null);
    setNotice(null);
    if (files.length === 0) {
      setError('Attach at least one document before reading.');
      return;
    }
    setReading(true);
    const form = new FormData();
    for (const file of files) form.append('files', file);

    const response = await fetch('/api/extract', { method: 'POST', body: form });
    const data = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      evidence?: DriverEvidence;
      errors?: string[];
      error?: string;
      warnings?: string[];
    };
    setReading(false);

    if (!response.ok || !data.evidence) {
      setError(
        data.errors?.join(' ') ??
          data.error ??
          'The documents could not be read. Enter the evidence manually below.',
      );
      return;
    }
    setEvidence(data.evidence);
    setNotice(
      data.warnings?.length
        ? `Fields populated with warnings: ${data.warnings.join(' ')}`
        : 'Fields populated. Verify every value against the source documents before saving.',
    );
  }

  async function submit() {
    setError(null);
    if (!companyId) {
      setError('Select the applying company.');
      return;
    }
    if (mode === 'create' && (!firstName.trim() || !lastName.trim())) {
      setError('First and last name are required.');
      return;
    }

    setSaving(true);
    const result =
      mode === 'create'
        ? await api('/api/applicants', {
            method: 'POST',
            json: {
              companyId,
              firstName: firstName.trim(),
              middleName: middleName.trim() || null,
              lastName: lastName.trim(),
              phone: phone.trim() || null,
              email: email.trim() || null,
              driverType,
              recruiter: recruiter.trim() || null,
              evidence,
            },
          })
        : await api(`/api/applicants/${applicantId}`, {
            method: 'POST',
            json: { action: 'update_evidence', evidence },
          });
    setSaving(false);

    if (!result.ok) {
      setError(result.data.error ?? 'Could not save the applicant.');
      return;
    }
    onSaved();
  }

  if (companies.length === 0) {
    return (
      <div className="overlay" role="dialog" aria-modal="true" aria-label="Add applicant">
        <div className="drawer">
          <div className="drawer-head">
            <h2 style={{ margin: 0, fontSize: 17 }}>Add applicant</h2>
            <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>
              Close
            </button>
          </div>
          <div className="drawer-body">
            <div className="empty" data-testid="no-companies">
              <h3>No companies available</h3>
              <p>An applicant must be tied to a trucking company before it can be evaluated.</p>
              <a className="btn btn-primary" href="/companies">
                Add a company
              </a>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Add applicant">
      <div className="drawer">
        <div className="drawer-head">
          <h2 style={{ margin: 0, fontSize: 17 }}>
            {mode === 'create' ? 'Add applicant' : 'Update CDL / MVR'}
          </h2>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="drawer-body">
          {error && (
            <div className="alert alert-error" role="alert" data-testid="drawer-error">
              {error}
            </div>
          )}
          {notice && (
            <div className="alert alert-success" data-testid="drawer-notice">
              {notice}
            </div>
          )}

          <div className="field">
            <label htmlFor="companyId">Applying company</label>
            <select
              id="companyId"
              data-testid="company-select"
              value={companyId}
              onChange={(e) => setCompanyId(e.target.value)}
              disabled={mode === 'update'}
            >
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          {mode === 'create' && (
            <div className="form-grid">
              <div className="field">
                <label htmlFor="firstName">First name</label>
                <input id="firstName" value={firstName} onChange={(e) => setFirstName(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="middleName">Middle name</label>
                <input id="middleName" value={middleName} onChange={(e) => setMiddleName(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="lastName">Last name</label>
                <input id="lastName" value={lastName} onChange={(e) => setLastName(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="phone">Phone</label>
                <input id="phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="email">Email</label>
                <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="driverType">Driver type</label>
                <select id="driverType" value={driverType} onChange={(e) => setDriverType(e.target.value)}>
                  <option>Company driver</option>
                  <option>Owner operator</option>
                  <option>Lease operator</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="recruiter">Recruiter</label>
                <input id="recruiter" value={recruiter} onChange={(e) => setRecruiter(e.target.value)} />
              </div>
            </div>
          )}

          <h2 className="section">Documents</h2>
          <div
            className="dropzone"
            data-active={dragActive}
            data-testid="dropzone"
            onDragOver={(e) => {
              e.preventDefault();
              setDragActive(true);
            }}
            onDragLeave={() => setDragActive(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragActive(false);
              addFiles(e.dataTransfer.files);
            }}
            onClick={() => document.getElementById('file-input')?.click()}
          >
            <p style={{ margin: 0 }}>
              <strong>Drag and drop</strong> the MVR, CDL / driver licence and medical card here
            </p>
            <p className="muted" style={{ margin: '6px 0 0' }}>
              or tap to choose files — PDF, JPG, PNG or HEIC, up to 20 MB each
            </p>
            <input
              id="file-input"
              data-testid="file-input"
              type="file"
              multiple
              accept={ACCEPT}
              style={{ display: 'none' }}
              onChange={(e) => addFiles(e.target.files)}
            />
          </div>

          {files.length > 0 && (
            <ul className="reasons" data-testid="file-list">
              {files.map((f) => (
                <li key={f.name}>
                  {f.name} <span className="muted">({(f.size / 1024).toFixed(0)} KB)</span>
                </li>
              ))}
            </ul>
          )}

          <div className="row" style={{ marginTop: 12 }}>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={readDocuments}
              disabled={reading}
              data-testid="read-documents"
            >
              {reading ? 'Reading documents…' : 'Read documents and fill fields'}
            </button>
          </div>

          <EvidenceEditor evidence={evidence} onChange={setEvidence} />

          <div className="disclaimer">
            This result is decision support only. An authorised safety or underwriting
            representative must review it before any hiring decision is made.
          </div>
        </div>

        <div className="drawer-foot">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={submit}
            disabled={saving}
            data-testid="submit-applicant"
          >
            {saving ? 'Saving…' : mode === 'create' ? 'Verify, evaluate, and create' : 'Save and reevaluate'}
          </button>
        </div>
      </div>
    </div>
  );
}
