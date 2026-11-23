import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanClubName, slugify } from './clubs.ts';
import { openStore, type Store } from './db.ts';

const POOL = 'Kauno Žalgirio baseinas';

// Safe to rerun: existing (club, timestamp) rows are left untouched. Each file
// is its own transaction so a full history import stays small in memory.
export function importCsvDir(store: Store, dir: string): { rows: number; skipped: number } {
  const { sqlite } = store;
  const upsertClub = sqlite.prepare<[string, string, string, string, string], { id: number }>(
    `INSERT INTO clubs (slug, name, city, address, source) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (slug) DO UPDATE SET name = excluded.name, city = excluded.city, address = excluded.address
     RETURNING id`,
  );
  const insertSample = sqlite.prepare(`INSERT OR IGNORE INTO samples (club_id, ts, pct) VALUES (?, ?, ?)`);

  let rows = 0;
  let skipped = 0;
  const importFile = sqlite.transaction((path: string) => {
    const clubIds = new Map<string, number>();
    for (const line of readFileSync(path, 'utf8').trim().split('\n').slice(1)) {
      const [timestamp, city, club, address, occupancy] = line.split(',');
      const ts = Date.parse(timestamp ?? '') / 1000;
      const pct = Number(occupancy);
      if (!city || !club || !address || !Number.isInteger(ts) || !Number.isInteger(pct) || pct < 0 || pct > 100) {
        skipped++;
        continue;
      }
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
  const store = openStore(process.env.DB_PATH ?? 'db/gym-tracker.sqlite');
  const result = importCsvDir(store, dir);
  console.log(JSON.stringify({ ...result, ...store.counts(), maxRssMb: Math.round(process.resourceUsage().maxRSS / 1024) }));
  store.close();
}
