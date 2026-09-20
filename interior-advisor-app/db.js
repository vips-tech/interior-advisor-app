require('dotenv').config();

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000,
  max: 5,
});

pool.on('error', (err) => {
  console.error('PostgreSQL pool error:', err);
});

function toPostgresSql(sql) {
  let index = 0;
  return sql
    .replace(/datetime\('now'\)/gi, 'CURRENT_TIMESTAMP')
    .replace(/\?/g, () => `$${++index}`);
}

function prepare(sql) {
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
  return pool.query(toPostgresSql(text), params);
}

module.exports = { pool, query, prepare };
