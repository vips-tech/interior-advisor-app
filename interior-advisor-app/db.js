require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const sqlite3 = require('sqlite3').verbose();

const useSqlite = !process.env.DATABASE_URL;
const dataDir = path.join(__dirname, 'data');
const sqlitePath = path.join(dataDir, 'app.db');

fs.mkdirSync(dataDir, { recursive: true });

let pool = null;
let sqliteDb = null;

if (!useSqlite) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
    max: 5,
  });

  pool.on('error', (err) => {
    console.error('PostgreSQL pool error:', err);
  });
} else {
  sqliteDb = new sqlite3.Database(sqlitePath);
  console.log(`Using local SQLite database at ${sqlitePath}`);
}

const SQLITE_SCHEMA = `
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
    payment_confirmed_at TEXT,
    agreed_terms_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    decision_type TEXT,
    risk_tolerance TEXT,
    non_negotiables TEXT,
    advisor_hypothesis TEXT,
    report_pdf_path TEXT
  );

  CREATE TABLE IF NOT EXISTS quotes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id TEXT NOT NULL,
    company_name TEXT,
    original_filename TEXT,
    stored_filename TEXT,
    file_type TEXT,
    uploaded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    doc_type TEXT DEFAULT 'QUOTATION',
    doc_subtype TEXT,
    FOREIGN KEY(case_id) REFERENCES cases(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS case_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id TEXT NOT NULL,
    quote_id INTEGER,
    field_label TEXT,
    value TEXT,
    evidence_label TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(case_id) REFERENCES cases(id) ON DELETE CASCADE,
    FOREIGN KEY(quote_id) REFERENCES quotes(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS investigation_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id TEXT NOT NULL,
    quote_id INTEGER,
    contact_name TEXT,
    contact_detail TEXT,
    question TEXT,
    answer TEXT,
    evidence_label TEXT,
    follow_up TEXT,
    called_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(case_id) REFERENCES cases(id) ON DELETE CASCADE,
    FOREIGN KEY(quote_id) REFERENCES quotes(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS comparison_rows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id TEXT NOT NULL,
    attribute TEXT,
    quote_values TEXT,
    status TEXT,
    sort_order INTEGER DEFAULT 0,
    FOREIGN KEY(case_id) REFERENCES cases(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS recommendation (
    case_id TEXT PRIMARY KEY,
    recommended_option TEXT,
    reasoning TEXT,
    trade_offs TEXT,
    risks TEXT,
    confidence TEXT,
    open_questions TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    conflict_confirmed INTEGER DEFAULT 0,
    approved_at TEXT,
    alternative_note TEXT,
    decision_cost_note TEXT,
    FOREIGN KEY(case_id) REFERENCES cases(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS reports (
    case_id TEXT PRIMARY KEY,
    content_md TEXT,
    status TEXT DEFAULT 'DRAFT',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    recommendation_snapshot_at TEXT,
    FOREIGN KEY(case_id) REFERENCES cases(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS advisory_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    phone TEXT,
    email TEXT,
    city TEXT,
    stage TEXT,
    message TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS user_sessions (
    sid TEXT PRIMARY KEY,
    sess TEXT NOT NULL,
    expire TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_cases_status_created ON cases(status, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_quotes_case_id ON quotes(case_id, id);
  CREATE INDEX IF NOT EXISTS idx_notes_case_id ON case_notes(case_id, id DESC);
  CREATE INDEX IF NOT EXISTS idx_calls_case_id ON investigation_calls(case_id, id DESC);
  CREATE INDEX IF NOT EXISTS idx_comparison_case_id ON comparison_rows(case_id, sort_order, id);
  CREATE INDEX IF NOT EXISTS idx_advisory_requests_created ON advisory_requests(created_at DESC);
`;

if (sqliteDb) {
  sqliteDb.exec(SQLITE_SCHEMA, (err) => {
    if (err) console.error('SQLite schema init failed:', err);
  });
}

function toPostgresSql(sql) {
  let index = 0;
  return sql
    .replace(/datetime\('now'\)/gi, 'CURRENT_TIMESTAMP')
    .replace(/\?/g, () => `$${++index}`);
}

function prepare(sql) {
  if (sqliteDb) {
    return {
      async get(...params) {
        return new Promise((resolve, reject) => {
          sqliteDb.get(sql, params, (err, row) => err ? reject(err) : resolve(row || undefined));
        });
      },
      async all(...params) {
        return new Promise((resolve, reject) => {
          sqliteDb.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows || []));
        });
      },
      async run(...params) {
        return new Promise((resolve, reject) => {
          sqliteDb.run(sql, params, function (err) {
            if (err) return reject(err);
            resolve({ changes: this.changes, rowCount: this.changes, rows: [] });
          });
        });
      },
    };
  }

  const pgSql = toPostgresSql(sql);
  return {
    async get(...params) {
      const result = await pool.query(pgSql, params);
      return result.rows[0] || undefined;
    },
    async all(...params) {
      const result = await pool.query(pgSql, params);
      return result.rows;
    },
    async run(...params) {
      const result = await pool.query(pgSql, params);
      return { changes: result.rowCount, rowCount: result.rowCount, rows: result.rows };
    },
  };
}

async function query(text, params = []) {
  if (sqliteDb) {
    return { rows: await new Promise((resolve, reject) => {
      sqliteDb.all(text, params, (err, rows) => err ? reject(err) : resolve(rows || []));
    }) };
  }
  return pool.query(toPostgresSql(text), params);
}

module.exports = { pool, query, prepare, useSqlite };
