/** Keep opening/closing semantics when a learner refreshes a GrillMe choice. */
export const MIGRATIONS_V58 = [{ version: 58, statements: [
  `ALTER TABLE ask_choices ADD COLUMN grill_phase TEXT CHECK (grill_phase IN ('pre', 'post'))`,
] }];
