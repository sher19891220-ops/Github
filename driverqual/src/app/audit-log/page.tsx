import { getDb } from '@/db';
import { listAuditEvents } from '@/db/repo';

export const dynamic = 'force-dynamic';

export default function AuditLogPage() {
  const events = listAuditEvents(getDb(), 300);

  return (
    <>
      <h1 className="page-title">Audit log</h1>
      <p className="page-sub">
        Append-only record of company, guideline, document, evidence and evaluation activity.
      </p>

      {events.length === 0 ? (
        <div className="empty">
          <h3>No activity recorded yet</h3>
          <p>Every create, update, replacement and re-evaluation is written here automatically.</p>
        </div>
      ) : (
        <div className="card">
          <div className="table-scroll">
            <table data-testid="audit-table">
              <thead>
                <tr>
                  <th className="driver-cell">When</th>
                  <th>Actor</th>
                  <th>Action</th>
                  <th>Entity</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr key={event.id}>
                    <td className="driver-cell mono">{event.createdAt.replace('T', ' ').slice(0, 19)}</td>
                    <td>{event.actor}</td>
                    <td>
                      <span className="tag">{event.action}</span>
                    </td>
                    <td className="mono">
                      {event.entityType}/{event.entityId}
                    </td>
                    <td className="mono">
                      {event.detail ? JSON.stringify(event.detail) : '—'}
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
