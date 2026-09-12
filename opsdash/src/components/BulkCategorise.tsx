'use client';

import { useCallback, useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import type { CategoryGroup, CategoryGroupsView } from '@/db/repo/categorise';
import { bulkCategorise, getCategoryGroups, getReferenceData } from './data/api';
import { errorMessageFor, errored, loaded, loading, type FetchState } from './data/fetchState';
import type { ReferenceData } from './data/types';
import { formatMoney } from './format/decimal';
import { StatusPill } from './StatusPill';

/**
 * Categorising a document's costs a group at a time.
 *
 * On the operator's real expenses export this is 1,342 rows and 807
 * distinct descriptions, which one at a time means never — and while the
 * costs sit in staging, every margin on every screen is revenue.
 *
 * Three things about the design are deliberate rather than decorative:
 *
 *  - **Money leads, not row count.** Groups are ordered by what is at
 *    stake, and the amount is the largest thing in each row, because a
 *    wrong decision on the $221,869 group costs more than a wrong one on
 *    the $1,403 group.
 *  - **The rule is shown, and so are the awkward members.** Samples are
 *    the longest descriptions in the group, not the tidiest, so a person
 *    sees what might not belong before they accept 267 rows at once.
 *  - **A basis is required.** It goes onto every row the action touches.
 *    A category applied to hundreds of rows will be read back long after
 *    whoever pressed the button has forgotten why.
 */

const cell: CSSProperties = { padding: '0.5rem 0.6rem', verticalAlign: 'top' };
const num: CSSProperties = { ...cell, textAlign: 'right', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' };

export function BulkCategorise({ documentId, onApplied }: { documentId: string; onApplied?: () => void }) {
  const [state, setState] = useState<FetchState<CategoryGroupsView>>(loading());
  const [reference, setReference] = useState<ReferenceData | null>(null);
  const [appliedBy, setAppliedBy] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  /** Per-group category override, so an operator can disagree with a
   *  suggestion without leaving the screen. */
  const [chosen, setChosen] = useState<Record<string, string>>({});

  const load = useCallback(() => {
    setState(loading());
    getCategoryGroups(documentId)
      .then((v) => setState(loaded(v)))
      .catch((err) => setState(errored(errorMessageFor(err, 'Could not load the category groups.'))));
  }, [documentId]);

  useEffect(load, [load]);
  useEffect(() => {
    getReferenceData()
      .then(setReference)
      .catch(() => setReference(null));
  }, []);

  const apply = useCallback(
    async (group: CategoryGroup, categoryId: string) => {
      const key = group.suggestedCategoryId ?? 'unrecognised';
      setBusy(key);
      setMessage(null);
      try {
        const r = await bulkCategorise({
          documentId,
          categoryId,
          stagingRowIds: group.stagingRowIds,
          appliedBy,
          basis: group.rule ?? 'Assigned by hand from the review screen',
        });
        const parts = [`${r.updated} rows set to ${categoryId}`];
        if (r.skippedAlreadyCategorised > 0) {
          parts.push(`${r.skippedAlreadyCategorised} already had a category and were left alone`);
        }
        if (r.stillMissingEntity > 0) {
          parts.push(`${r.stillMissingEntity} of them still have no company and cannot post yet`);
        }
        setMessage({ tone: 'good', text: `${parts.join('. ')}.` });
        load();
        onApplied?.();
      } catch (err) {
        setMessage({ tone: 'bad', text: errorMessageFor(err, 'Could not apply the category.') });
      } finally {
        setBusy(null);
      }
    },
    [documentId, appliedBy, load, onApplied],
  );

  if (state.status === 'loading') return <p style={{ color: 'var(--muted)' }}>Loading category groups…</p>;
  if (state.status === 'error') {
    return (
      <p role="alert" style={{ color: 'var(--bad)' }}>
        {state.message}
      </p>
    );
  }

  const view = state.data;
  if (view.uncategorisedRows === 0) {
    return (
      <p style={{ color: 'var(--good)' }}>
        Every row in this document has a category.
      </p>
    );
  }

  const categories = reference?.categories ?? [];

  return (
    <section style={{ marginBottom: '1.5rem' }}>
      <h2 style={{ fontSize: '1rem', margin: '0 0 0.35rem' }}>Categorise in bulk</h2>
      <p style={{ color: 'var(--muted)', margin: '0 0 0.75rem', maxWidth: '46rem' }}>
        {view.uncategorisedRows} rows have no category. They are grouped below by what the description
        looks like, largest amount first. {view.unrecognisedDescriptions > 0 && (
          <>
            {view.unrecognisedDescriptions} descriptions matched no rule and are listed last — those need
            looking at one at a time.
          </>
        )}
      </p>

      <label style={{ display: 'block', marginBottom: '0.9rem', maxWidth: '18rem' }}>
        <div style={{ fontSize: '0.85rem', color: 'var(--muted)', marginBottom: '0.25rem' }}>
          Your name — recorded on every row you categorise
        </div>
        <input
          value={appliedBy}
          onChange={(e) => setAppliedBy(e.target.value)}
          style={{ width: '100%', boxSizing: 'border-box' }}
        />
      </label>

      {message !== null && (
        <p style={{ color: message.tone === 'good' ? 'var(--good)' : 'var(--bad)' }}>{message.text}</p>
      )}

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
          <thead>
            <tr style={{ color: 'var(--muted)', fontSize: '0.78rem', textAlign: 'left' }}>
              <th style={{ ...num, paddingLeft: 0 }}>Amount</th>
              <th style={cell}>Rows</th>
              <th style={cell}>Looks like</th>
              <th style={cell}>Set to</th>
              <th style={{ ...cell, paddingRight: 0 }} />
            </tr>
          </thead>
          <tbody>
            {view.groups.map((g) => {
              const key = g.suggestedCategoryId ?? 'unrecognised';
              const selected = chosen[key] ?? g.suggestedCategoryId ?? '';
              const isUnrecognised = g.suggestedCategoryId === null;
              return (
                <tr key={key} style={{ borderTop: '1px solid var(--line)' }}>
                  <td style={{ ...num, paddingLeft: 0, fontWeight: 700, fontSize: '1.05rem' }}>
                    {formatMoney(g.totalAmount)}
                  </td>
                  <td style={cell}>
                    {g.rowCount}
                    {g.missingEntityCount > 0 && (
                      <div style={{ color: 'var(--warn)', fontSize: '0.78rem' }}>
                        {g.missingEntityCount} with no company
                      </div>
                    )}
                  </td>
                  <td style={{ ...cell, maxWidth: '22rem' }}>
                    {isUnrecognised ? (
                      <StatusPill label="No rule matched" tone="warn" />
                    ) : (
                      <div style={{ color: 'var(--muted)', fontSize: '0.85rem' }}>{g.rule}</div>
                    )}
                    {/* Longest descriptions first — the awkward members,
                        not the obvious ones. */}
                    <div style={{ color: 'var(--muted)', fontSize: '0.78rem', marginTop: '0.25rem', overflowWrap: 'anywhere' }}>
                      {g.sampleDescriptions.join(' · ')}
                    </div>
                  </td>
                  <td style={cell}>
                    <select
                      value={selected}
                      onChange={(e) => setChosen({ ...chosen, [key]: e.target.value })}
                      style={{ maxWidth: '14rem' }}
                    >
                      <option value="">Choose a category…</option>
                      {categories.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td style={{ ...cell, paddingRight: 0, whiteSpace: 'nowrap' }}>
                    <button
                      type="button"
                      disabled={busy !== null || selected === '' || appliedBy.trim() === ''}
                      onClick={() => void apply(g, selected)}
                    >
                      {busy === key ? 'Applying…' : `Apply to ${g.rowCount}`}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p style={{ color: 'var(--muted)', fontSize: '0.8rem', marginTop: '0.5rem' }}>
        A category is applied only to rows that do not already have one, so pressing this twice — or two
        people working the same document — cannot overwrite somebody&rsquo;s decision.
      </p>
    </section>
  );
}
