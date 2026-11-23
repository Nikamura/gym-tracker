import type { Store } from './db.ts';

const DAY = 86_400;
export const RAW_RETENTION_DAYS = 400; // 15-minute samples
export const HOURLY_RETENTION_DAYS = 5 * 365; // then deleted

// Keeps storage bounded: old samples become one row per club per hour, and
// rows past the hourly window are removed. Safe to run repeatedly.
export function applyRetention(store: Store, now: number = Math.floor(Date.now() / 1000)) {
  const rawCutoff = Math.floor((now - RAW_RETENTION_DAYS * DAY) / 3600) * 3600;
  const deleteCutoff = now - HOURLY_RETENTION_DAYS * DAY;
  const { sqlite } = store;

  const result = sqlite.transaction(() => {
    sqlite.exec(`
      DROP TABLE IF EXISTS temp.hourly;
      CREATE TEMP TABLE hourly (club_id INTEGER, bucket INTEGER, pct INTEGER, PRIMARY KEY (club_id, bucket)) WITHOUT ROWID;
    `);
    // 100 can mean closed, so it only survives when the whole hour is 100.
    sqlite
      .prepare(
        `INSERT INTO temp.hourly
         SELECT club_id, ts / 3600 * 3600,
                COALESCE(CAST(ROUND(AVG(CASE WHEN pct < 100 THEN pct END)) AS INTEGER), 100)
         FROM samples WHERE ts < ?
         GROUP BY club_id, ts / 3600
         HAVING COUNT(*) > 1 OR MIN(ts) % 3600 <> 0`,
      )
      .run(rawCutoff);
    const removed = sqlite
      .prepare(
        `DELETE FROM samples WHERE ts < ? AND EXISTS (
           SELECT 1 FROM temp.hourly h WHERE h.club_id = samples.club_id AND h.bucket = samples.ts / 3600 * 3600
         )`,
      )
      .run(rawCutoff).changes;
    const inserted = sqlite
      .prepare(`INSERT INTO samples (club_id, ts, pct) SELECT club_id, bucket, pct FROM temp.hourly`)
      .run().changes;
    const expired = sqlite.prepare(`DELETE FROM samples WHERE ts < ?`).run(deleteCutoff).changes;
    sqlite.exec(`DROP TABLE temp.hourly`);
    return { downsampled: removed - inserted, expired };
  })();

  sqlite.pragma('incremental_vacuum');
  sqlite.pragma('wal_checkpoint(TRUNCATE)');
  return result;
}
