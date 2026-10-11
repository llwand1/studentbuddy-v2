import type Database from 'better-sqlite3';
import { MIGRATIONS_V46 } from './migrations-list-v46.js';

/** Repair databases that recorded conflicting v46/v58 changes on older branches. */
export const MIGRATIONS_V59 = [{
  version: 59,
  // Historical v46 is immutable; reuse its idempotent table/index definitions.
  statements: MIGRATIONS_V46.flatMap((migration) => migration.statements)
    .filter((statement) => /\b(?:job|llm_call)\b/.test(statement)),
  after(db: Database.Database): void {
    const columns = db.prepare('PRAGMA table_info(ask_choices)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'grill_phase')) {
      db.exec("ALTER TABLE ask_choices ADD COLUMN grill_phase TEXT CHECK (grill_phase IN ('pre', 'post'))");
    }
  },
}];
