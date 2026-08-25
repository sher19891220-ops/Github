'use client';

import { completedMonths, isValidIsoDate } from '@/domain/dates';
import { resolveOriginalIssueDate } from '@/domain/cdl-dates';
import { normalizeEvidence } from '@/domain/evidence';
import { bandLabel, experienceBand } from '@/domain/experience';
import type { DriverEvidence, LicenseStatus, MvrEvent } from '@/domain/types';

const LICENSE_STATUSES: LicenseStatus[] = [
  'Valid',
  'Expired',
  'Suspended',
  'Revoked',
  'Disqualified',
  'Unknown',
];

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * The verification step. Everything extraction produced is shown here and is
 * editable before it is saved — including the derived experience figure, which
 * is displayed alongside its source date so a reviewer can check the arithmetic
 * rather than trust it.
 */
export function EvidenceEditor({
  evidence,
  onChange,
}: {
  evidence: DriverEvidence;
  onChange: (next: DriverEvidence) => void;
}) {
  const set = <K extends keyof DriverEvidence>(key: K, value: DriverEvidence[K]) =>
    onChange({ ...evidence, [key]: value });

  const setEvent = (index: number, patch: Partial<MvrEvent>) =>
    onChange({
      ...evidence,
      events: evidence.events.map((e, i) => (i === index ? { ...e, ...patch } : e)),
    });

  const addEvent = () =>
    onChange({
      ...evidence,
      events: [
        ...evidence.events,
        {
          id: `manual_${evidence.events.length}`,
          description: '',
          violationDate: null,
          convictionDate: null,
          state: null,
          statePoints: null,
          mvrActivityPoints: null,
          disposition: null,
          eventType: 'Unknown',
          severity: 'Unknown',
          atFault: null,
          preventable: null,
        },
      ],
    });

  const normalized = normalizeEvidence(evidence, todayIso());
  const resolved =
    evidence.cdlIssueDateCandidates.length > 0
      ? resolveOriginalIssueDate(evidence.cdlIssueDateCandidates)
      : null;
  const effectiveOriginal = resolved ? resolved.date : evidence.cdlOriginalIssueDate;
  const months =
    effectiveOriginal && isValidIsoDate(effectiveOriginal)
      ? completedMonths(effectiveOriginal, todayIso())
      : null;
  const band = experienceBand(months);

  return (
    <div>
      <h2 className="section">CDL and licence</h2>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="cdlNumber">CDL number</label>
          <input
            id="cdlNumber"
            value={evidence.cdlNumber ?? ''}
            onChange={(e) => set('cdlNumber', e.target.value || null)}
          />
        </div>
        <div className="field">
          <label htmlFor="cdlState">CDL state</label>
          <input
            id="cdlState"
            value={evidence.cdlState ?? ''}
            onChange={(e) => set('cdlState', e.target.value || null)}
          />
        </div>
        <div className="field">
          <label htmlFor="cdlClass">CDL class</label>
          <input
            id="cdlClass"
            value={evidence.cdlClass ?? ''}
            onChange={(e) => set('cdlClass', e.target.value || null)}
          />
        </div>
        <div className="field">
          <label htmlFor="licenseStatus">Licence status</label>
          <select
            id="licenseStatus"
            value={evidence.licenseStatus}
            onChange={(e) => set('licenseStatus', e.target.value as LicenseStatus)}
          >
            {LICENSE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="dateOfBirth">Date of birth</label>
          <input
            id="dateOfBirth"
            type="date"
            value={evidence.dateOfBirth ?? ''}
            onChange={(e) => set('dateOfBirth', e.target.value || null)}
          />
        </div>
        <div className="field">
          <label htmlFor="mvrOrderDate">MVR order date</label>
          <input
            id="mvrOrderDate"
            type="date"
            value={evidence.mvrOrderDate ?? ''}
            onChange={(e) => set('mvrOrderDate', e.target.value || null)}
          />
        </div>
      </div>

      <h2 className="section">Experience</h2>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="cdlOriginalIssueDate">Original CDL issue date</label>
          <input
            id="cdlOriginalIssueDate"
            type="date"
            data-testid="original-issue-date"
            value={evidence.cdlOriginalIssueDate ?? ''}
            onChange={(e) => set('cdlOriginalIssueDate', e.target.value || null)}
          />
          <span className="muted">
            The first/original issue date only — not a renewal, duplicate or expiry date.
          </span>
        </div>
        <div className="field">
          <label htmlFor="cdlCurrentIssueDate">Current card issue date (reference only)</label>
          <input
            id="cdlCurrentIssueDate"
            type="date"
            value={evidence.cdlCurrentIssueDate ?? ''}
            onChange={(e) => set('cdlCurrentIssueDate', e.target.value || null)}
          />
        </div>
      </div>
      {evidence.cdlIssueDateCandidates.length > 0 && (
        <div className="table-scroll" data-testid="issue-date-candidates">
          <table>
            <thead>
              <tr>
                <th>Issue date found</th>
                <th>Document</th>
                <th>Printed as</th>
                <th>Used</th>
              </tr>
            </thead>
            <tbody>
              {evidence.cdlIssueDateCandidates.map((candidate) => {
                const chosen = resolved?.chosen;
                const isChosen =
                  chosen !== null &&
                  chosen !== undefined &&
                  chosen.date === candidate.date &&
                  chosen.sourceDocument === candidate.sourceDocument &&
                  chosen.printedLabel === candidate.printedLabel;
                const rejection = resolved?.rejected.find((r) => r.candidate === candidate);
                return (
                  <tr key={`${candidate.sourceDocument}-${candidate.date}-${candidate.printedLabel}`}>
                    <td className="mono">{candidate.date}</td>
                    <td>{candidate.sourceDocument}</td>
                    <td>{candidate.printedLabel}</td>
                    <td>
                      {isChosen ? (
                        <span className="badge badge-qualified">Original</span>
                      ) : (
                        <span className="muted" title={rejection?.reason}>
                          Not used
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="alert alert-info" data-testid="experience-summary">
        {months === null ? (
          <>
            <strong>Cannot calculate</strong> —{' '}
            {resolved ? resolved.reason : 'no original CDL issue date has been entered.'}
          </>
        ) : (
          <>
            <strong>{months} completed months</strong> of CDL experience, calculated from{' '}
            {effectiveOriginal} to {todayIso()} — <strong>{bandLabel(band)}</strong>.
            {resolved ? ` ${resolved.reason}` : ''}
          </>
        )}
      </div>

      <h2 className="section">Medical certificate</h2>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="medicalPresent">Medical card on file</label>
          <select
            id="medicalPresent"
            value={evidence.medicalCard?.present ? 'yes' : 'no'}
            onChange={(e) =>
              set('medicalCard', {
                present: e.target.value === 'yes',
                expirationDate: evidence.medicalCard?.expirationDate ?? null,
                examinerName: evidence.medicalCard?.examinerName ?? null,
              })
            }
          >
            <option value="no">No</option>
            <option value="yes">Yes</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="medicalExpiration">Medical card expiration</label>
          <input
            id="medicalExpiration"
            type="date"
            value={evidence.medicalCard?.expirationDate ?? ''}
            onChange={(e) =>
              set('medicalCard', {
                present: evidence.medicalCard?.present ?? true,
                expirationDate: e.target.value || null,
                examinerName: evidence.medicalCard?.examinerName ?? null,
              })
            }
          />
        </div>
      </div>

      <h2 className="section">MVR records</h2>
      <p className="muted">
        Descriptions are kept exactly as they appear on the MVR. Classification is applied
        automatically and shown below for verification.
      </p>
      {evidence.events.length === 0 ? (
        <p className="muted">No MVR records captured.</p>
      ) : (
        <div className="table-scroll">
          <table data-testid="evidence-events">
            <thead>
              <tr>
                <th>Description</th>
                <th>Violation date</th>
                <th>Conviction date</th>
                <th>State pts</th>
                <th>MVR pts</th>
                <th>Classified as</th>
              </tr>
            </thead>
            <tbody>
              {evidence.events.map((event, index) => (
                <tr key={event.id}>
                  <td>
                    <input
                      aria-label={`Description ${index + 1}`}
                      value={event.description}
                      onChange={(e) => setEvent(index, { description: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      type="date"
                      aria-label={`Violation date ${index + 1}`}
                      value={event.violationDate ?? ''}
                      onChange={(e) => setEvent(index, { violationDate: e.target.value || null })}
                    />
                  </td>
                  <td>
                    <input
                      type="date"
                      aria-label={`Conviction date ${index + 1}`}
                      value={event.convictionDate ?? ''}
                      onChange={(e) => setEvent(index, { convictionDate: e.target.value || null })}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      aria-label={`State points ${index + 1}`}
                      value={event.statePoints ?? ''}
                      onChange={(e) =>
                        setEvent(index, {
                          statePoints: e.target.value === '' ? null : Number(e.target.value),
                        })
                      }
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      aria-label={`MVR points ${index + 1}`}
                      value={event.mvrActivityPoints ?? ''}
                      onChange={(e) =>
                        setEvent(index, {
                          mvrActivityPoints: e.target.value === '' ? null : Number(e.target.value),
                        })
                      }
                    />
                  </td>
                  <td>
                    <span className="tag">
                      {normalized.events[index]?.eventType ?? 'Unknown'}
                      {normalized.events[index]?.eventType === 'Moving Violation'
                        ? ` / ${normalized.events[index]?.severity}`
                        : ''}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <button type="button" className="btn btn-secondary btn-sm" onClick={addEvent}>
        Add MVR record
      </button>

      {normalized.blockers.length > 0 && (
        <div className="alert alert-warn" style={{ marginTop: 14 }} data-testid="evidence-warnings">
          <strong>This evidence will be held for manual review:</strong>
          <ul className="reasons">
            {normalized.blockers.map((b) => (
              <li key={b.code}>{b.message}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
