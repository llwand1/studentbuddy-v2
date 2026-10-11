const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const [mode, filename, sessionId] = process.argv.slice(2);
const file = path.resolve(filename || '');
const relative = path.relative(path.resolve(__dirname, '../../.runtime'), file);
if (relative.startsWith('..') || path.isAbsolute(relative) || !/^smoke-[^/\\]+[/\\]data[/\\]studentbuddy\.db$/.test(relative)
    || !fs.existsSync(file)) throw new Error('Migration smoke requires a known isolated desktop database');
const db = new Database(file);
try {
  if (mode === 'prepare') {
    db.exec('DELETE FROM schema_version WHERE version >= 59; DROP TABLE job; DROP TABLE llm_call; ALTER TABLE ask_choices DROP COLUMN grill_phase');
  } else if (mode === 'verify') {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
    if (!tables.has('job') || !tables.has('llm_call')) throw new Error('Missing job/call tables after installed upgrade');
    if (!db.prepare('PRAGMA table_info(ask_choices)').all().some(row => row.name === 'grill_phase')) throw new Error('Missing GrillMe column after installed upgrade');
    if (!db.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId)) throw new Error('Installed migration lost the saved session');
    if (db.prepare('SELECT MAX(version) AS version FROM schema_version').get().version < 59) throw new Error('Repair migration was not recorded');
  } else throw new Error('Unknown migration smoke operation');
} finally { db.close(); }
console.log('Installed legacy migration ' + mode + ' verified');
