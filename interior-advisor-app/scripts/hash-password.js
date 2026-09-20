#!/usr/bin/env node
// scripts/hash-password.js — generate a bcrypt hash for ADVISOR_PASSWORD_HASH.
// Usage: node scripts/hash-password.js yourpassword
const bcrypt = require('bcryptjs');

const password = process.argv[2];
if (!password) {
  console.error('Usage: node scripts/hash-password.js <password>');
  process.exit(1);
}
const hash = bcrypt.hashSync(password, 10);
console.log(hash);
