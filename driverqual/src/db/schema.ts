/**
 * Database schema, embedded as a string rather than read from disk at runtime.
 *
 * A deployed build does not always ship the source tree alongside the server
 * bundle (standalone output, container images, serverless bundles), so reading
 * `schema.sql` from `process.cwd()` fails in exactly the environments hardest to
 * debug. Keeping it here means the schema travels with the code that applies it.
 */
export const SCHEMA_SQL = String.raw`CREATE TABLE IF NOT EXISTS companies (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  dba             TEXT,
  status          TEXT NOT NULL DEFAULT 'active',
  usdot_number    TEXT,
  mc_number       TEXT,
  address         TEXT,
  contact         TEXT,
  notes           TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_companies_status ON companies(status);

CREATE TABLE IF NOT EXISTS applicants (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  first_name      TEXT NOT NULL,
  middle_name     TEXT,
  last_name       TEXT NOT NULL,
  date_of_birth   TEXT,
  phone           TEXT,
  email           TEXT,
  cdl_number      TEXT,
  cdl_state       TEXT,
  cdl_class       TEXT,
  driver_type     TEXT,
  recruiter       TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_applicants_company ON applicants(company_id);

-- Uploaded source documents. Files live in private storage; only the key is here.
CREATE TABLE IF NOT EXISTS applicant_documents (
  id              TEXT PRIMARY KEY,
  applicant_id    TEXT NOT NULL REFERENCES applicants(id) ON DELETE CASCADE,
  doc_type        TEXT NOT NULL,
  file_name       TEXT NOT NULL,
  mime_type       TEXT NOT NULL,
  byte_size       INTEGER NOT NULL,
  storage_key     TEXT NOT NULL,
  sha256          TEXT,
  uploaded_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_documents_applicant ON applicant_documents(applicant_id);

-- Immutable evidence snapshots. A new read appends a row; nothing is overwritten,
-- so any past evaluation can be replayed against the exact evidence it used.
CREATE TABLE IF NOT EXISTS applicant_evidence (
  id                        TEXT PRIMARY KEY,
  applicant_id              TEXT NOT NULL REFERENCES applicants(id) ON DELETE CASCADE,
  extraction_format_version INTEGER NOT NULL,
  payload                   TEXT NOT NULL,
  is_current                INTEGER NOT NULL DEFAULT 1,
  verified_by               TEXT,
  created_at                TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evidence_applicant ON applicant_evidence(applicant_id, is_current);

CREATE TABLE IF NOT EXISTS coverages (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  coverage_type   TEXT NOT NULL,
  carrier         TEXT,
  policy_number   TEXT,
  effective_date  TEXT,
  expiration_date TEXT,
  limits          TEXT,
  coi_file_name   TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_coverages_company ON coverages(company_id);

CREATE TABLE IF NOT EXISTS guidelines (
  id                            TEXT PRIMARY KEY,
  company_id                    TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  coverage_type                 TEXT NOT NULL,
  version                       TEXT NOT NULL,
  status                        TEXT NOT NULL DEFAULT 'active',
  effective_date                TEXT,
  expiration_date               TEXT,
  carrier                       TEXT,
  policy_number                 TEXT,
  file_name                     TEXT,
  storage_key                   TEXT,
  used_for_driver_qualification INTEGER NOT NULL DEFAULT 1,
  review_status                 TEXT NOT NULL DEFAULT 'pending_interpretation',
  rule_set                      TEXT,
  supersedes_id                 TEXT REFERENCES guidelines(id) ON DELETE SET NULL,
  created_at                    TEXT NOT NULL,
  updated_at                    TEXT NOT NULL
);
-- At most one active guideline per company + coverage; replacement archives the old one.
CREATE UNIQUE INDEX IF NOT EXISTS idx_guidelines_active_unique
  ON guidelines(company_id, coverage_type) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_guidelines_company ON guidelines(company_id);

-- One row per (applicant, company, coverage). Evaluating for one company
-- can never touch another company's row.
CREATE TABLE IF NOT EXISTS coverage_evaluations (
  id                        TEXT PRIMARY KEY,
  applicant_id              TEXT NOT NULL REFERENCES applicants(id) ON DELETE CASCADE,
  company_id                TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  coverage_type             TEXT NOT NULL,
  decision                  TEXT NOT NULL,
  reason                    TEXT NOT NULL,
  guideline_id              TEXT,
  guideline_version         TEXT,
  evidence_id               TEXT REFERENCES applicant_evidence(id) ON DELETE SET NULL,
  engine_version            TEXT NOT NULL,
  extraction_format_version INTEGER NOT NULL,
  model_version             TEXT,
  result_json               TEXT NOT NULL,
  evaluated_at              TEXT NOT NULL,
  UNIQUE(applicant_id, company_id, coverage_type)
);
CREATE INDEX IF NOT EXISTS idx_eval_applicant ON coverage_evaluations(applicant_id);
CREATE INDEX IF NOT EXISTS idx_eval_company ON coverage_evaluations(company_id);

CREATE TABLE IF NOT EXISTS comparison_runs (
  id            TEXT PRIMARY KEY,
  applicant_id  TEXT NOT NULL REFERENCES applicants(id) ON DELETE CASCADE,
  company_ids   TEXT NOT NULL,
  result_json   TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  role          TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

-- Append-only. There is no update or delete path in the repository layer.
CREATE TABLE IF NOT EXISTS audit_events (
  id            TEXT PRIMARY KEY,
  actor         TEXT NOT NULL,
  action        TEXT NOT NULL,
  entity_type   TEXT NOT NULL,
  entity_id     TEXT NOT NULL,
  company_id    TEXT,
  detail        TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_events(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_events(created_at DESC);

CREATE TABLE IF NOT EXISTS integration_settings (
  key           TEXT PRIMARY KEY,
  value         TEXT,
  status        TEXT,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS expiration_notifications (
  id            TEXT PRIMARY KEY,
  coverage_id   TEXT NOT NULL REFERENCES coverages(id) ON DELETE CASCADE,
  company_id    TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  severity      TEXT NOT NULL,
  message       TEXT NOT NULL,
  days_until    INTEGER NOT NULL,
  acknowledged  INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  UNIQUE(coverage_id, severity)
);

-- Failed access-code attempts, per address. This is what makes a short code
-- survivable: without it, a four-digit code is a few seconds of scripting.
CREATE TABLE IF NOT EXISTS auth_attempts (
  address           TEXT PRIMARY KEY,
  failed_attempts   INTEGER NOT NULL DEFAULT 0,
  first_attempt_at  INTEGER NOT NULL,
  locked_until      INTEGER,
  updated_at        TEXT NOT NULL
);
`;
