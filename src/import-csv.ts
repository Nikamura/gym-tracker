import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanClubName } from './clubs.ts';
import { openStore, type Reading, type Store } from './db.ts';

const POOL = 'Kauno Žalgirio baseinas';

// Safe to rerun: existing (club, timestamp) rows are left untouched.
export function importCsvDir(store: Store, dir: string): { rows: number; skipped: number } {
  let rows = 0;
  let skipped = 0;
  const files = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.csv$/.test(f)).sort();

  store.sqlite.transaction(() => {
    for (const file of files) {
      const groups = new Map<string, { source: string; ts: number; readings: Reading[] }>();
      for (const line of readFileSync(join(dir, file), 'utf8').trim().split('\n').slice(1)) {
        const [timestamp, city, club, address, occupancy] = line.split(',');
        const ts = Date.parse(timestamp ?? '') / 1000;
        const pct = Number(occupancy);
        if (!city || !club || !address || !Number.isInteger(ts) || !Number.isInteger(pct) || pct < 0 || pct > 100) {
          skipped++;
          continue;
        }
        const name = cleanClubName(club);
        const source = name === POOL ? 'zalgirio-baseinas' : 'lemongym';
        const key = `${source}:${ts}`;
        const group = groups.get(key) ?? { source, ts, readings: [] };
        group.readings.push({ name, city, address: address.replaceAll(';', ','), pct });
        groups.set(key, group);
        rows++;
      }
      for (const g of groups.values()) store.record(g.source, g.ts, g.readings);
    }
  })();
  return { rows, skipped };
}

if (import.meta.main) {
  const dir = process.argv[2] ?? 'data';
  const store = openStore(process.env.DB_PATH ?? 'db/gym-tracker.sqlite');
  const result = importCsvDir(store, dir);
  console.log(JSON.stringify({ ...result, ...store.counts() }));
  store.close();
}
