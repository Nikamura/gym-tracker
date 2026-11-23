import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanClubName, slugify } from './clubs.ts';
import { openStore, type Store } from './db.ts';
import { COMPACTED_BEFORE } from './retention.ts';

const POOL = 'Kauno Žalgirio baseinas';

// Safe to rerun: existing (club, timestamp) rows are left untouched. Each file
// is its own transaction so a full history import stays small in memory.
export function importCsvDir(store: Store, dir: string, untilTs = Infinity): { rows: number; skipped: number } {
  const { sqlite } = store;
  const upsertClub = sqlite.prepare<[string, string, string, string, string], { id: number }>(
    `INSERT INTO clubs (slug, name, city, address, source) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (slug) DO UPDATE SET name = excluded.name, city = excluded.city, address = excluded.address
     RETURNING id`,
  );
  const insertSample = sqlite.prepare(`INSERT OR IGNORE INTO samples (club_id, ts, pct) VALUES (?, ?, ?)`);

  // Hours already compacted must not be mixed with their original raw rows.
  const compactedBefore = Number(store.getMeta(COMPACTED_BEFORE) ?? 0);
  let rows = 0;
  let skipped = 0;
  const importFile = sqlite.transaction((path: string) => {
    const clubIds = new Map<string, number>();
    for (const line of readFileSync(path, 'utf8').trim().split('\n').slice(1)) {
      const [timestamp, city, club, address, occupancy] = line.split(',');
      const ts = Date.parse(timestamp ?? '') / 1000;
      const pct = /^\d+$/.test(occupancy ?? '') ? Number(occupancy) : NaN;
      if (!city || !club || !address || !Number.isInteger(ts) || !Number.isInteger(pct) || pct < 0 || pct > 100) {
        skipped++;
        continue;
      }
      if (ts >= untilTs || ts < compactedBefore) continue;
      const name = cleanClubName(club);
      const slug = slugify(name);
      let id = clubIds.get(slug);
      if (id === undefined) {
        const source = name === POOL ? 'zalgirio-baseinas' : 'lemongym';
        id = upsertClub.get(slug, name, city, address.replaceAll(';', ','), source)!.id;
        clubIds.set(slug, id);
      }
      insertSample.run(id, ts, pct);
      rows++;
    }
  });

  for (const file of readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.csv$/.test(f)).sort()) {
    importFile(join(dir, file));
  }
  sqlite.pragma('wal_checkpoint(TRUNCATE)');
  return { rows, skipped };
}

if (import.meta.main) {
  const dir = process.argv[2] ?? 'data';
  const cutoff = process.argv[3] ? Date.parse(process.argv[3]) / 1000 : Infinity;
  if (Number.isNaN(cutoff)) {
    console.error('Invalid cutoff timestamp');
    process.exit(1);
  }
  const store = openStore(process.env.DB_PATH ?? 'db/gym-tracker.sqlite');
  // Optional ISO cutoff, so the old workflow cannot add rows after the collector started.
  const result = importCsvDir(store, dir, cutoff);
  console.log(JSON.stringify({ ...result, ...store.counts(), maxRssMb: Math.round(process.resourceUsage().maxRSS / 1024) }));
  store.close();
}
