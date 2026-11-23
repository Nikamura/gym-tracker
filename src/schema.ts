import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const clubs = sqliteTable('clubs', {
  id: integer('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  city: text('city').notNull(),
  address: text('address').notNull(),
  source: text('source').notNull(),
  // Last poll that included this club, and whether it reported closed.
  lastSeen: integer('last_seen'),
  lastClosed: integer('last_closed').notNull().default(0),
});

// Raw source value. 100 is ambiguous (full or closed), so it is stored as
// received and interpreted when read.
export const samples = sqliteTable(
  'samples',
  {
    clubId: integer('club_id').notNull(),
    ts: integer('ts').notNull(), // Unix seconds
    pct: integer('pct').notNull(),
  },
  (t) => [primaryKey({ columns: [t.clubId, t.ts] })],
);

export const sourceStatus = sqliteTable('source_status', {
  source: text('source').primaryKey(),
  lastOk: integer('last_ok'),
  lastError: text('last_error'),
  blockedUntil: integer('blocked_until'),
});
