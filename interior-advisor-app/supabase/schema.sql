-- Interior Decision Advisor - PostgreSQL schema for Supabase
-- Run this once in Supabase Dashboard -> SQL Editor.

CREATE TABLE IF NOT EXISTS cases (
  id TEXT PRIMARY KEY,
  service TEXT NOT NULL,
  price_inr INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'INTAKE_PENDING',
  customer_name TEXT,
  customer_phone TEXT,
  customer_email TEXT,
  city TEXT,
  budget_range TEXT,
  decision_needed TEXT,
  priorities TEXT,
  timeline TEXT,
  notes_from_customer TEXT,
  payment_reference TEXT,
  payment_confirmed_at TIMESTAMPTZ,
  agreed_terms_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decision_type TEXT,
  risk_tolerance TEXT,
  non_negotiables TEXT,
  advisor_hypothesis TEXT,
  report_pdf_path TEXT
);

CREATE TABLE IF NOT EXISTS quotes (
  id BIGSERIAL PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  company_name TEXT,
  original_filename TEXT,
  stored_filename TEXT,
  file_type TEXT,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  doc_type TEXT DEFAULT 'QUOTATION',
  doc_subtype TEXT
);

CREATE TABLE IF NOT EXISTS case_notes (
  id BIGSERIAL PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  quote_id BIGINT REFERENCES quotes(id) ON DELETE SET NULL,
  field_label TEXT,
  value TEXT,
  evidence_label TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS investigation_calls (
  id BIGSERIAL PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  quote_id BIGINT REFERENCES quotes(id) ON DELETE SET NULL,
  contact_name TEXT,
  contact_detail TEXT,
  question TEXT,
  answer TEXT,
  evidence_label TEXT,
  follow_up TEXT,
  called_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS comparison_rows (
  id BIGSERIAL PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  attribute TEXT,
  quote_values TEXT,
  status TEXT,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS recommendation (
  case_id TEXT PRIMARY KEY REFERENCES cases(id) ON DELETE CASCADE,
  recommended_option TEXT,
  reasoning TEXT,
  trade_offs TEXT,
  risks TEXT,
  confidence TEXT,
  open_questions TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  conflict_confirmed INTEGER DEFAULT 0,
  approved_at TIMESTAMPTZ,
  alternative_note TEXT,
  decision_cost_note TEXT
);

CREATE TABLE IF NOT EXISTS reports (
  case_id TEXT PRIMARY KEY REFERENCES cases(id) ON DELETE CASCADE,
  content_md TEXT,
  status TEXT DEFAULT 'DRAFT',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  recommendation_snapshot_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS advisory_requests (
  id BIGSERIAL PRIMARY KEY,
  name TEXT,
  phone TEXT,
  email TEXT,
  city TEXT,
  stage TEXT,
  message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- connect-pg-simple session table used by this app.
CREATE TABLE IF NOT EXISTS user_sessions (
  sid VARCHAR(255) PRIMARY KEY,
  sess JSON NOT NULL,
  expire TIMESTAMP(6) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cases_status_created ON cases(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_quotes_case_id ON quotes(case_id, id);
CREATE INDEX IF NOT EXISTS idx_notes_case_id ON case_notes(case_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_calls_case_id ON investigation_calls(case_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_comparison_case_id ON comparison_rows(case_id, sort_order, id);
CREATE INDEX IF NOT EXISTS idx_advisory_requests_created ON advisory_requests(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_sessions_expire ON user_sessions(expire);
