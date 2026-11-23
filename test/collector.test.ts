import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cleanClubName, clubSlug, slugify } from '../src/clubs.ts';
import { BLOCK_BACKOFF_SECONDS, HttpError, runSource } from '../src/collector.ts';
import { openStore } from '../src/db.ts';
import { importCsvDir } from '../src/import-csv.ts';
import { RAW_RETENTION_DAYS, applyRetention } from '../src/retention.ts';
import { parseImpuls, parseLemonGym, parseZalgiris, type Source } from '../src/sources.ts';

const fixture = readFileSync(new URL('./fixtures/lemongym.json', import.meta.url), 'utf8');
const impulsFixture = readFileSync(new URL('./fixtures/impuls.html', import.meta.url), 'utf8');
const memory = () => openStore(':memory:');
const reading = { name: 'Pikas', city: 'Vilniaus klubai', address: 'Ukmergės g. 221, Vilnius', pct: 40 };
const source: Source = { id: 'test', url: 'https://example.invalid', parse: () => [reading] };

test('parses every club in the live LemonGym response', () => {
  const rows = parseLemonGym(fixture);
  assert.equal(rows.length, 21);
  assert.equal(new Set(rows.map((r) => slugify(r.name))).size, 21);
  assert.ok(rows.every((r) => r.city && r.address && r.pct >= 0 && r.pct <= 100));
});

test('rejects changed LemonGym markup', () => {
  const body = JSON.stringify({ data: { content: '<h5>City</h5><h6 class="clubs-occupancy__percentage x">5%</h6>' } });
  assert.throws(() => parseLemonGym(body), /markup changed/);
});

test('drops only the club with an out-of-range value', () => {
  const parsed = JSON.parse(fixture) as { data: { content: string } };
  parsed.data.content = parsed.data.content.replace(/(clubs-occupancy__percentage[^>]*>\s*)\d+%/, '$1102%');
  const rows = parseLemonGym(JSON.stringify(parsed));
  assert.equal(rows.length, 20);
  assert.ok(rows.every((r) => r.pct <= 100));
});

test('parses Impuls clubs into their real cities', () => {
  const rows = parseImpuls(impulsFixture);
  assert.equal(rows.length, 5);
  assert.ok(rows.every((r) => r.address && r.pct >= 0 && r.pct <= 100));
  const city = (name: string) => rows.find((r) => r.name === name)?.city;
  assert.equal(city('Kareivių'), 'Vilniaus klubai');
  assert.equal(city('Klaipėdos'), 'Klaipėdos klubai');
  assert.equal(city('Panevėžio'), 'Panevėžio klubai');
});

test('keeps Impuls clubs with no current rate out of the sample', () => {
  const noRate = impulsFixture.replace(/(occupancy-card-rate[^>]*>\s*)\d+%/, '$1');
  assert.equal(parseImpuls(noRate).length, 4);
});

test('rejects changed Impuls markup', () => {
  assert.throws(() => parseImpuls('<html>maintenance</html>'), /markup changed/);
  assert.throws(() => parseImpuls(impulsFixture.replaceAll('occupancy-card-rate', 'renamed')), /markup changed/);
});

test('never merges similarly named clubs across operators', () => {
  assert.equal(clubSlug('lemongym', 'Savanoriai'), 'savanoriai');
  assert.equal(clubSlug('impuls', 'Savanoriai'), 'impuls-savanoriai');
});

test('ignores closed pool readings', () => {
  assert.equal(parseZalgiris('{"percent":27}')[0]?.pct, 27);
  assert.deepEqual(parseZalgiris('{"percent":0}'), []);
  assert.deepEqual(parseZalgiris('{"percent":null}'), []);
});

test('merges marketing labels without merging venues', () => {
  assert.equal(cleanClubName('Riešė - jau rugsėjį🔜'), 'Riešė');
  assert.equal(cleanClubName('Savanoriai – ĮKRAUTAS NAUJAI nuo 09.21🔋'), 'Savanoriai');
  assert.equal(cleanClubName('Pilaitė (atnaujintas)'), 'Pilaitė');
  assert.equal(cleanClubName('Kauno Žalgirio arena - atnaujintas'), 'Kauno Žalgirio arena');
  assert.notEqual(slugify('Kauno Žalgirio arena'), slugify('Kauno Žalgirio baseinas'));
});

test('backs off after a block and makes no request meanwhile', async () => {
  const store = memory();
  let calls = 0;
  const blocked = async () => {
    calls++;
    throw new HttpError(429);
  };
  assert.equal(await runSource(store, source, blocked, () => 1000), 'blocked');
  assert.equal(await runSource(store, source, blocked, () => 1000 + BLOCK_BACKOFF_SECONDS - 1), 'backing-off');
  assert.equal(calls, 1);
  assert.equal(await runSource(store, source, async () => '{}', () => 1000 + BLOCK_BACKOFF_SECONDS), 'ok');
});

test('retries a network failure once and never stores secrets', async () => {
  const store = memory();
  let calls = 0;
  const failing = async () => {
    calls++;
    throw new Error('connect failed http://user:secret@proxy:3128');
  };
  assert.equal(await runSource(store, source, failing, () => 1, async () => {}), 'error');
  assert.equal(calls, 2);
  assert.doesNotMatch(store.getStatus('test')?.lastError ?? '', /secret/);
});

test('retention downsamples old rows, is idempotent, and keeps recent rows', () => {
  const store = memory();
  const now = 1_800_000_000;
  const hour = Math.floor((now - (RAW_RETENTION_DAYS + 10) * 86_400) / 3600) * 3600;
  for (const [offset, pct] of [[0, 20], [900, 40], [1800, 100], [2700, 60]] as const) {
    store.record('test', hour + offset, [{ ...reading, pct }]);
  }
  store.record('test', hour + 7200, [{ ...reading, pct: 100 }]);
  store.record('test', hour + 7500, [{ ...reading, pct: 100 }]);
  store.record('test', now - 60, [reading]);

  applyRetention(store, now);
  const read = () => store.sqlite.prepare('SELECT ts, pct FROM samples ORDER BY ts').all();
  const after = read();
  assert.deepEqual(after, [
    { ts: hour, pct: 40 },
    { ts: hour + 7200, pct: 100 },
    { ts: now - 60, pct: 40 },
  ]);
  applyRetention(store, now);
  assert.deepEqual(read(), after);
});

test('CSV import merges renamed clubs and is idempotent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gym-import-'));
  writeFileSync(
    join(dir, '2026-01-01.csv'),
    'timestamp,city,club,address,occupancy\n' +
      '2026-01-01T10:00:00Z,Vilniaus klubai,Pikas - naujas,Ukmergės g. 221; Vilnius,10\n' +
      '2026-01-01T10:15:00Z,Vilniaus klubai,Pikas,Ukmergės g. 221; Vilnius,20\n',
  );
  const store = memory();
  importCsvDir(store, dir);
  importCsvDir(store, dir);
  assert.equal(store.counts().samples, 2);
  assert.deepEqual(store.sqlite.prepare('SELECT name, address FROM clubs').all(), [
    { name: 'Pikas', address: 'Ukmergės g. 221, Vilnius' },
  ]);
});
