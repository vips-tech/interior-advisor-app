const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const hasDatabaseUrl = Boolean(process.env.DATABASE_URL);

let sqliteDb = null;
let pool = null;

function initSqliteDatabase() {
  const dataDir = path.join(__dirname, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'app.db');
  const Database = require('better-sqlite3');
  sqliteDb = new Database(dbPath);
  sqliteDb.pragma('journal_mode = WAL');

  const schemaSql = fs.readFileSync(path.join(__dirname, 'supabase', 'schema.sql'), 'utf8');
  const statements = schemaSql
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => !/^--/.test(s));

  for (const statement of statements) {
    sqliteDb.exec(statement + ';');
  }

  return sqliteDb;
}

if (hasDatabaseUrl) {
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
  console.warn('DATABASE_URL is not set. Falling back to local SQLite for development.');
  initSqliteDatabase();
}

function toPostgresSql(sql) {
  let index = 0;
  return sql
    .replace(/datetime\('now'\)/gi, 'CURRENT_TIMESTAMP')
    .replace(/\?/g, () => `$${++index}`);
}

function prepare(sql) {
  if (!hasDatabaseUrl && sqliteDb) {
    return {
      get(...params) {
        const row = sqliteDb.prepare(sql).get(...params);
        return row || undefined;
      },
      all(...params) {
        return sqliteDb.prepare(sql).all(...params);
      },
      run(...params) {
        const result = sqliteDb.prepare(sql).run(...params);
        return { changes: result.changes, rowCount: result.changes, rows: [] };
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
  if (!hasDatabaseUrl && sqliteDb) {
    const stmt = sqliteDb.prepare(text);
    return { rows: stmt.all(...params) };
  }
  return pool.query(toPostgresSql(text), params);
}

module.exports = { pool, query, prepare };
