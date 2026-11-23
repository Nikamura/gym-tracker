import Database from 'better-sqlite3';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { clubSlug } from './clubs.ts';
import { clubs, samples, sourceStatus } from './schema.ts';

export interface Reading {
  name: string;
  city: string;
  address: string;
  pct: number | null; // null = the source explicitly reported closed
}

export type Store = ReturnType<typeof openStore>;

export function openStore(path: string) {
  const sqlite = new Database(path);
  // auto_vacuum must be set before the first table is created.
  sqlite.pragma('auto_vacuum = INCREMENTAL');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS clubs (
      id INTEGER PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      city TEXT NOT NULL,
      address TEXT NOT NULL,
      source TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS samples (
      club_id INTEGER NOT NULL REFERENCES clubs(id),
      ts INTEGER NOT NULL,
      pct INTEGER NOT NULL CHECK (pct BETWEEN 0 AND 100),
      PRIMARY KEY (club_id, ts)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS source_status (
      source TEXT PRIMARY KEY,
      last_ok INTEGER,
      last_error TEXT,
      blocked_until INTEGER
    );
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  const columns = sqlite.pragma('table_info(clubs)') as { name: string }[];
  if (!columns.some((c) => c.name === 'last_seen')) {
    sqlite.exec(`
      ALTER TABLE clubs ADD COLUMN last_seen INTEGER;
      ALTER TABLE clubs ADD COLUMN last_closed INTEGER NOT NULL DEFAULT 0;
      UPDATE clubs SET last_seen = (SELECT MAX(ts) FROM samples WHERE club_id = clubs.id);
    `);
  }
  const db = drizzle(sqlite);
  const readMeta = sqlite.prepare<[string], { value: string }>('SELECT value FROM meta WHERE key = ?');
  const writeMeta = sqlite.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
  );

  function record(source: string, ts: number, readings: Reading[]): void {
    sqlite.transaction(() => {
      for (const r of readings) {
        const [club] = db
          .insert(clubs)
          .values({
            slug: clubSlug(source, r.name),
            name: r.name,
            city: r.city,
            address: r.address,
            source,
            lastSeen: ts,
            lastClosed: r.pct === null ? 1 : 0,
          })
          .onConflictDoUpdate({
            target: clubs.slug,
            set: { name: r.name, city: r.city, address: r.address, lastSeen: ts, lastClosed: r.pct === null ? 1 : 0 },
          })
          .returning({ id: clubs.id })
          .all();
        if (r.pct !== null) db.insert(samples).values({ clubId: club!.id, ts, pct: r.pct }).onConflictDoNothing().run();
      }
    })();
  }

  function getStatus(source: string) {
    return db.select().from(sourceStatus).where(eq(sourceStatus.source, source)).get();
  }

  function setStatus(source: string, patch: Partial<typeof sourceStatus.$inferInsert>): void {
    db.insert(sourceStatus)
      .values({ source, ...patch })
      .onConflictDoUpdate({ target: sourceStatus.source, set: patch })
      .run();
  }

  function allStatuses() {
    return db.select().from(sourceStatus).all();
  }

  function counts() {
    const row = db
      .select({ samples: sql<number>`count(*)`, latest: sql<number | null>`max(${samples.ts})` })
      .from(samples)
      .get();
    return { samples: row?.samples ?? 0, latest: row?.latest ?? null };
  }

  return {
    sqlite,
    db,
    record,
    getStatus,
    setStatus,
    allStatuses,
    counts,
    getMeta: (key: string) => readMeta.get(key)?.value ?? null,
    setMeta: (key: string, value: string) => void writeMeta.run(key, value),
    close: () => sqlite.close(),
  };
}
