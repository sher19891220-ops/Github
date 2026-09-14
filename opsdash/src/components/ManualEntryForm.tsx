'use client';

import { useEffect, useMemo, useState } from 'react';
import type { CategoryOption, ReferenceData } from './data/types';
import { getReferenceData, postManualEntry } from './data/api';
import { errorMessageFor } from './data/fetchState';
import {
  ENTRY_PRESETS,
  describeAmount,
  presetById,
  toSignedAmount,
  validateDraft,
} from './manual/presets';

/**
 * Type a figure in.
 *
 * The second intake path, and the one that makes the other three optional
 * while connectors are still being built. One form, driven by presets, for
 * all nine sources in the intake matrix — nine bespoke forms would be nine
 * chances to get the sign convention wrong.
 *
 * Two deliberate frictions, both of which the database enforces anyway:
 *
 *  - **Amount is a magnitude plus a direction**, never a box where a minus
 *    sign is expected. A cost typed positive is revenue, and the P&L still
 *    looks plausible — which is the worst kind of wrong.
 *  - **Your name and your basis are required.** Not a compliance box: this
 *    figure will sit next to parsed invoices for years, and the only thing
 *    that keeps it honest is that somebody is on record for it.
 */
export function ManualEntryForm({ onSaved }: { onSaved?: () => void }) {
  const [presetId, setPresetId] = useState('maintenance');
  const preset = useMemo(() => presetById(presetId), [presetId]);

  const [reference, setReference] = useState<ReferenceData | null>(null);
  const [referenceError, setReferenceError] = useState<string | null>(null);

  const [entityId, setEntityId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [accrualDate, setAccrualDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [magnitude, setMagnitude] = useState('');
  const [direction, setDirection] = useState<'in' | 'out'>('out');
  const [truckId, setTruckId] = useState('');
  const [driverId, setDriverId] = useState('');
  const [quantity, setQuantity] = useState('');
  const [jurisdiction, setJurisdiction] = useState('');
  const [chargedTo, setChargedTo] = useState<'company' | 'driver' | 'unknown'>('company');
  const [memo, setMemo] = useState('');
  const [assertedBy, setAssertedBy] = useState('');
  const [basis, setBasis] = useState('');

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getReferenceData()
      .then((r) => {
        if (cancelled) return;
        setReference(r);
        setReferenceError(null);
      })
      .catch((err) => {
        if (!cancelled) setReferenceError(errorMessageFor(err, 'Could not load the pickers.'));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Changing what you are entering changes which categories make sense and
  // which way the money goes by default.
  useEffect(() => {
    setDirection(preset.defaultSign === -1 ? 'out' : 'in');
    setCategoryId('');
  }, [preset]);

  const categories: CategoryOption[] = useMemo(() => {
    const all = reference?.categories ?? [];
    return all.filter((c) => preset.categoryGroups.includes(c.categoryGroup) && c.isActive);
  }, [reference, preset]);

  const signedAmount = toSignedAmount(magnitude, direction);
  const validity = validateDraft({ entityId, categoryId, accrualDate, amount: signedAmount, assertedBy, basis });

  async function save(): Promise<void> {
    if (!validity.ok || signedAmount === null) return;
    setSaving(true);
    setSaveError(null);
    setSaved(null);
    try {
      const result = await postManualEntry({
        entityId,
        categoryId,
        accrualDate,
        amount: signedAmount,
        truckId: truckId || null,
        driverId: driverId || null,
        quantity: quantity.trim() === '' ? null : quantity.trim(),
        jurisdiction: jurisdiction.trim() === '' ? null : jurisdiction.trim().toUpperCase(),
        chargedTo: preset.fields.chargedTo ? chargedTo : 'company',
        memo: memo.trim() === '' ? null : memo.trim(),
        assertedBy: assertedBy.trim(),
        basis: basis.trim(),
      });
      setSaved(result.entry.entryId);
      // The figure and its evidence are saved; who you are and what you are
      // working from usually stay the same for the next one.
      setMagnitude('');
      setMemo('');
      setQuantity('');
      onSaved?.();
    } catch (err) {
      setSaveError(errorMessageFor(err, 'Could not save this figure.'));
    } finally {
      setSaving(false);
    }
  }

  const label: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.2rem',
    fontSize: '0.8rem',
    color: 'var(--muted)',
    flex: '1 1 11rem',
    minWidth: 0,
  };
  const control: React.CSSProperties = { width: '100%', minWidth: 0, boxSizing: 'border-box' };
  const row: React.CSSProperties = { display: 'flex', gap: '1rem', flexWrap: 'wrap', marginBottom: '1rem' };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div style={row}>
        <label style={{ ...label, flex: '1 1 100%' }}>
          What are you adding?
          <select style={control} value={presetId} onChange={(e) => setPresetId(e.target.value)}>
            {ENTRY_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          <span style={{ color: 'var(--muted)', fontSize: '0.8rem' }}>{preset.hint}</span>
        </label>
      </div>

      {referenceError !== null && (
        <p role="alert" style={{ color: 'var(--bad)' }}>
          {referenceError} The pickers below will be empty until that is fixed.
        </p>
      )}

      <div style={row}>
        <label style={label}>
          Company
          <select style={control} value={entityId} onChange={(e) => setEntityId(e.target.value)}>
            <option value="">Choose…</option>
            {(reference?.entities ?? []).map((e) => (
              <option key={e.id} value={e.id}>
                {e.label}
              </option>
            ))}
          </select>
        </label>
        <label style={label}>
          Category
          <select style={control} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">Choose…</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label style={label}>
          Date the money belongs to
          <input style={control} type="date" value={accrualDate} onChange={(e) => setAccrualDate(e.target.value)} />
        </label>
      </div>

      <div style={row}>
        <label style={label}>
          Amount
          <input
            style={control}
            inputMode="decimal"
            placeholder="1200.00"
            value={magnitude}
            onChange={(e) => setMagnitude(e.target.value)}
          />
        </label>
        <label style={label}>
          Direction
          <select style={control} value={direction} onChange={(e) => setDirection(e.target.value as 'in' | 'out')}>
            <option value="out">Money out (a cost)</option>
            <option value="in">Money in (revenue or a receipt)</option>
          </select>
        </label>
        <div style={{ ...label, flex: '2 1 16rem', justifyContent: 'flex-end' }}>
          Will be saved as
          {/* A readout, boxed so it does not read as an input somebody
              forgot to fill in. This is the last place a sign error can be
              caught before it becomes revenue. */}
          <strong
            style={{
              color: signedAmount === null ? 'var(--muted)' : signedAmount.startsWith('-') ? 'var(--bad)' : 'var(--good)',
              fontVariantNumeric: 'tabular-nums',
              fontSize: '0.95rem',
              border: '1px solid var(--line)',
              borderRadius: 6,
              padding: '0.35rem 0.55rem',
              background: 'var(--select-bg)',
            }}
          >
            {describeAmount(signedAmount)}
          </strong>
        </div>
      </div>

      {(preset.fields.truck || preset.fields.driver || preset.fields.quantity || preset.fields.jurisdiction) && (
        <div style={row}>
          {preset.fields.truck && (
            <label style={label}>
              Truck
              <select style={control} value={truckId} onChange={(e) => setTruckId(e.target.value)}>
                <option value="">Not truck-specific</option>
                {(reference?.trucks ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {preset.fields.driver && (
            <label style={label}>
              Driver
              <select style={control} value={driverId} onChange={(e) => setDriverId(e.target.value)}>
                <option value="">Not driver-specific</option>
                {(reference?.drivers ?? []).map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {preset.fields.quantity && (
            <label style={label}>
              {preset.fields.quantity.label}
              <input
                style={control}
                inputMode="decimal"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
              />
            </label>
          )}
          {preset.fields.jurisdiction && (
            <label style={label}>
              State
              <input
                style={control}
                maxLength={2}
                placeholder="TX"
                value={jurisdiction}
                onChange={(e) => setJurisdiction(e.target.value)}
              />
            </label>
          )}
        </div>
      )}

      {preset.fields.chargedTo && (
        <div style={row}>
          <label style={label}>
            Who bears this
            <select
              style={control}
              value={chargedTo}
              onChange={(e) => setChargedTo(e.target.value as 'company' | 'driver' | 'unknown')}
            >
              <option value="company">The company</option>
              <option value="driver">The driver</option>
              <option value="unknown">Not decided yet</option>
            </select>
            <span style={{ color: 'var(--muted)', fontSize: '0.78rem' }}>
              &ldquo;Not decided&rdquo; keeps it out of both sides until somebody rules on it.
            </span>
          </label>
          <label style={{ ...label, flex: '2 1 20rem' }}>
            Note (optional)
            <input style={control} value={memo} onChange={(e) => setMemo(e.target.value)} />
          </label>
        </div>
      )}

      <fieldset
        style={{
          border: '1px solid var(--line)',
          borderRadius: 8,
          padding: '0.75rem 0.9rem',
          marginBottom: '1rem',
        }}
      >
        <legend style={{ fontSize: '0.8rem', color: 'var(--muted)', padding: '0 0.4rem' }}>
          Where this figure comes from
        </legend>
        <p style={{ margin: '0 0 0.6rem', color: 'var(--muted)', fontSize: '0.85rem' }}>
          This is not a document, so it is recorded as your word. It will show that way on every screen —
          weaker than a parsed invoice, and traceable to you. When the real document arrives, upload it and
          it supersedes this without erasing what you said.
        </p>
        <div style={{ ...row, marginBottom: 0 }}>
          <label style={label}>
            Your name
            <input
              style={control}
              value={assertedBy}
              onChange={(e) => setAssertedBy(e.target.value)}
              placeholder="you@company"
            />
          </label>
          <label style={{ ...label, flex: '3 1 22rem' }}>
            What is this based on?
            <input
              style={control}
              value={basis}
              onChange={(e) => setBasis(e.target.value)}
              placeholder={preset.basisPlaceholder}
            />
          </label>
        </div>
      </fieldset>

      {saveError !== null && (
        <div
          role="alert"
          style={{ color: 'var(--bad)', border: '1px solid var(--bad)', borderRadius: 8, padding: '0.75rem', marginBottom: '1rem' }}
        >
          <strong>Nothing was saved.</strong> {saveError}
        </div>
      )}

      {saved !== null && (
        <p style={{ color: 'var(--good)', marginBottom: '1rem' }}>
          Saved. It is on the books now, marked as your word rather than a document.
        </p>
      )}

      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="submit" disabled={!validity.ok || saving}>
          {saving ? 'Saving…' : 'Add this figure'}
        </button>
        {/* The first thing stopping the save, rather than a disabled button
            with no explanation. */}
        {!validity.ok && (
          <span style={{ color: 'var(--muted)', fontSize: '0.85rem' }}>{validity.reason}</span>
        )}
      </div>
    </form>
  );
}
