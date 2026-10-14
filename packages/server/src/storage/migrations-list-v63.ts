import type Database from 'better-sqlite3';
export const MIGRATIONS_V63 = [{ version: 63, statements: [], after(db: Database.Database) {
  const columns = db.prepare('PRAGMA table_info(plugin_connection)').all() as Array<{name:string}>;
  if (!columns.some(c=>c.name==='auth_mode')) db.exec("ALTER TABLE plugin_connection ADD COLUMN auth_mode TEXT NOT NULL DEFAULT 'token'");
} }];
