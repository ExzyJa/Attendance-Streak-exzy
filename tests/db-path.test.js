const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dbModulePath = require.resolve('../db.js');

test('creates missing parent directory for DB_PATH before opening SQLite database', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'attendance-db-'));
  const missingDir = path.join(tempRoot, 'nested', 'data');
  const dbPath = path.join(missingDir, 'attendance.sqlite');

  const previousDbPath = process.env.DB_PATH;
  process.env.DB_PATH = dbPath;

  delete require.cache[dbModulePath];

  try {
    const db = require('../db.js');
    assert.ok(fs.existsSync(missingDir), 'expected DB parent directory to be created');
    assert.ok(fs.existsSync(dbPath), 'expected SQLite file to be created');
    db.close();
  } finally {
    delete require.cache[dbModulePath];
    if (previousDbPath === undefined) {
      delete process.env.DB_PATH;
    } else {
      process.env.DB_PATH = previousDbPath;
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
