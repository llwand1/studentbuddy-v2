import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDb, openIsolated } from './db.js';
import { migrate } from './migrations.js';
import { MIGRATIONS } from './migrations-list.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-mig-v59-'));
  openIsolated(dir);
});
afterEach(() => {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});
function columns(table: string): string[] {
  return (getDb().prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
}
function legacy(version: 57 | 58): void {
  getDb().prepare('DELETE FROM schema_version WHERE version > ?').run(version);
  getDb().exec('ALTER TABLE ask_choices DROP COLUMN grill_phase');
}
function assertUsable(): void {
  expect(columns('ask_choices')).toContain('grill_phase');
  getDb().prepare("INSERT INTO job (id, kind, payload) VALUES ('restored', 'test', '{}')").run();
  getDb().prepare("UPDATE ask_choices SET grill_phase = 'post' WHERE id = 'absent'").run();
  expect(getDb().prepare('SELECT COUNT(*) AS count FROM job').get()).toEqual({ count: 1 });
  expect(getDb().prepare('SELECT MAX(version) AS version FROM schema_version').get()).toEqual({ version: MIGRATIONS.at(-1)!.version });
}

describe('v59 repairs historical migration collisions', () => {
  it('preserves the older learning_event layout without applying incompatible indexes', () => {
    getDb().prepare('DELETE FROM schema_version WHERE version >= 59').run();
    getDb().exec('DROP TABLE learning_event; CREATE TABLE learning_event (id INTEGER PRIMARY KEY); INSERT INTO learning_event VALUES (1)');
    migrate(getDb());
    expect(columns('learning_event')).toEqual(['id']);
    expect(getDb().prepare('SELECT id FROM learning_event').all()).toEqual([{ id: 1 }]);
  });
  it('repairs a v57 database that already recorded v46 but lacks job/llm_call', () => {
    legacy(57);
    getDb().exec('DROP TABLE job; DROP TABLE llm_call');
    migrate(getDb());
    assertUsable();
    expect(columns('llm_call')).toContain('latency_ms');
  });
  it('repairs a v58 database that already has job tables but lacks grill_phase', () => {
    legacy(58);
    getDb().prepare("INSERT INTO job (id, kind) VALUES ('existing', 'keep')").run();
    migrate(getDb());
    expect(columns('ask_choices')).toContain('grill_phase');
    expect(getDb().prepare('SELECT id FROM job').all()).toEqual([{ id: 'existing' }]);
    getDb().prepare("UPDATE ask_choices SET grill_phase = 'pre' WHERE id = 'absent'").run();
  });
  it('also repairs both missing tables and field when the v58 number was already recorded', () => {
    legacy(58);
    getDb().exec('DROP TABLE job; DROP TABLE llm_call');
    migrate(getDb());
    assertUsable();
  });
  it('recreates exactly the existing job/call columns and indexes', () => {
    const expected = { job: columns('job'), call: columns('llm_call') };
    getDb().prepare('DELETE FROM schema_version WHERE version >= 59').run();
    getDb().exec('DROP TABLE job; DROP TABLE llm_call');
    migrate(getDb());
    expect(columns('job')).toEqual(expected.job);
    expect(columns('llm_call')).toEqual(expected.call);
    const indexes = getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>;
    for (const name of ['idx_job_pick', 'idx_job_owner', 'idx_llm_call_created', 'idx_llm_call_owner_purpose']) {
      expect(indexes.some((index) => index.name === name)).toBe(true);
    }
  });
  it('does not duplicate an existing field or lose data when replaying the new migration', () => {
    getDb().prepare("INSERT INTO job (id, kind) VALUES ('keep', 'test')").run();
    getDb().prepare('DELETE FROM schema_version WHERE version >= 59').run();
    migrate(getDb());
    migrate(getDb());
    expect(getDb().prepare('SELECT id FROM job').all()).toEqual([{ id: 'keep' }]);
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM schema_version WHERE version = 59').get()).toEqual({ count: 1 });
  });
  it('rolls back table repair and version bookkeeping together if field repair fails', () => {
    getDb().prepare('DELETE FROM schema_version WHERE version >= 59').run();
    getDb().exec('DROP TABLE job; DROP TABLE ask_choices');
    expect(() => migrate(getDb())).toThrow('no such table: ask_choices');
    expect(columns('job')).toEqual([]);
    expect(getDb().prepare('SELECT MAX(version) AS version FROM schema_version').get()).toEqual({ version: 58 });
  });
});
