import type { Store } from './db.ts';
import { resolveReadings } from './read.ts';

const DAY = 86_400;
const HOUR = 3600;
export const RAW_RETENTION_DAYS = 400; // 15-minute samples
export const HOURLY_RETENTION_DAYS = 5 * 365; // then deleted
export const COMPACTED_BEFORE = 'compacted_before';

// Keeps storage bounded: old samples become one row per club per hour, and
// rows past the hourly window are removed. Compacted hours are never reprocessed.
export function applyRetention(store: Store, now: number = Math.floor(Date.now() / 1000)) {
  const rawCutoff = Math.floor((now - RAW_RETENTION_DAYS * DAY) / HOUR) * HOUR;
  const deleteCutoff = now - HOURLY_RETENTION_DAYS * DAY;
  const { sqlite } = store;
  const from = Number(store.getMeta(COMPACTED_BEFORE) ?? 0);

  const result = sqlite.transaction(() => {
    const clubIds = sqlite.prepare<[], { id: number }>('SELECT id FROM clubs').all();
    const rowsFor = sqlite.prepare<[number, number, number], { ts: number; pct: number }>(
      'SELECT ts, pct FROM samples WHERE club_id = ? AND ts >= ? AND ts < ? ORDER BY ts',
    );
    const remove = sqlite.prepare('DELETE FROM samples WHERE club_id = ? AND ts >= ? AND ts < ?');
    const insert = sqlite.prepare('INSERT INTO samples (club_id, ts, pct) VALUES (?, ?, ?)');
    let removed = 0;
    let inserted = 0;

    if (rawCutoff > from) {
      for (const { id } of clubIds) {
        // Neighbouring rows outside the range decide whether a 100 means full.
        const rows = rowsFor.all(id, from - HOUR, rawCutoff + HOUR);
        const resolved = resolveReadings(rows.map((r) => r.ts), rows.map((r) => r.pct), rows.length);
        const buckets = new Map<number, { count: number; sum: number; usable: number; first: number }>();
        rows.forEach((row, i) => {
          if (row.ts < from || row.ts >= rawCutoff) return;
          const start = Math.floor(row.ts / HOUR) * HOUR;
          const bucket = buckets.get(start) ?? { count: 0, sum: 0, usable: 0, first: row.ts };
          bucket.count++;
          if (resolved[i] !== -1) {
            bucket.sum += resolved[i]!;
            bucket.usable++;
          }
          buckets.set(start, bucket);
        });
        for (const [start, bucket] of buckets) {
          if (bucket.count === 1 && bucket.first === start) continue;
          removed += remove.run(id, start, start + HOUR).changes;
          // 100 is the source's own closed marker when nothing usable remains.
          insert.run(id, start, bucket.usable ? Math.round(bucket.sum / bucket.usable) : 100);
          inserted++;
        }
      }
      store.setMeta(COMPACTED_BEFORE, String(rawCutoff));
    }
    const expired = sqlite.prepare('DELETE FROM samples WHERE ts < ?').run(deleteCutoff).changes;
    return { downsampled: removed - inserted, expired };
  })();

  sqlite.pragma('incremental_vacuum');
  sqlite.pragma('wal_checkpoint(TRUNCATE)');
  return result;
}
