export const dynamic = 'force-dynamic';

const ROLES = [
  {
    role: 'Administrator',
    summary: 'Full access, including integrations, company deletion and guideline approval.',
    permissions: [
      'Manage companies, coverages and guidelines',
      'Approve interpreted guideline criteria',
      'Configure integrations and secrets',
      'Manage users and roles',
      'Read the full audit log',
    ],
  },
  {
    role: 'Safety Reviewer',
    summary: 'Runs qualification work and records the final human decision.',
    permissions: [
      'Create and update applicants',
      'Upload and verify driver documents',
      'Re-evaluate and compare companies',
      'Record a final reviewer decision',
      'Read the audit log',
    ],
  },
  {
    role: 'Recruiter',
    summary: 'Adds candidates and their documents; cannot change criteria.',
    permissions: [
      'Create applicants',
      'Upload driver documents',
      'View decisions for their own company',
    ],
  },
  {
    role: 'Read Only',
    summary: 'Views results without changing anything.',
    permissions: ['View applicants and decisions', 'View reports'],
  },
];

export default function TeamPage() {
  return (
    <>
      <h1 className="page-title">Team &amp; roles</h1>
      <p className="page-sub">
        Role-based access. Driver records are sensitive; access is granted per role and every change
        is written to the audit log.
      </p>

      <div className="grid grid-cards">
        {ROLES.map((entry) => (
          <div className="card" key={entry.role}>
            <h2 style={{ margin: '0 0 4px', fontSize: 16 }}>{entry.role}</h2>
            <p className="muted" style={{ marginTop: 0 }}>
              {entry.summary}
            </p>
            <ul className="reasons">
              {entry.permissions.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="disclaimer">
        AI output is decision support. An authorised safety or underwriting representative must make
        and record the final qualification decision.
      </div>
    </>
  );
}
