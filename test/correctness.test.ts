import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openStore } from '../src/db.ts';
import { easterSunday, isLithuanianHoliday } from '../src/holidays.ts';
import { importCsvDir } from '../src/import-csv.ts';
import { buildProfile, createReader, dayHoursAt, interpret, type Point } from '../src/read.ts';
import { RAW_RETENTION_DAYS, applyRetention } from '../src/retention.ts';
import { acceptsGzip } from '../src/server.ts';
import { parseLemonGym } from '../src/sources.ts';

const fixture = readFileSync(new URL('./fixtures/lemongym.json', import.meta.url), 'utf8');
const club = { name: 'Pikas', city: 'Vilniaus klubai', address: 'A', pct: 40 };
const WEEK = 7 * 86_400;
// Monday 2026-01-05 10:00 in Vilnius.
const MONDAY = Date.UTC(2026, 0, 5, 8) / 1000;

test('a missing percentage never takes the next club value', () => {
  const parsed = JSON.parse(fixture) as { data: { content: string } };
  const first = /xs-small[^>]*>([^<]+)</.exec(parsed.data.content)![1]!.trim();
  parsed.data.content = parsed.data.content.replace(/<h6 class="clubs-occupancy__percentage[\s\S]*?<\/h6>/, '');
  const rows = parseLemonGym(JSON.stringify(parsed));
  assert.equal(rows.length, 20);
  assert.ok(!rows.some((r) => r.name.toLocaleLowerCase('lt') === first.toLocaleLowerCase('lt')));
});

test('one busy reading cannot chain full status through later 100s', () => {
  const rows = [{ ts: 0, pct: 80 }, ...Array.from({ length: 8 }, (_, i) => ({ ts: (i + 1) * 900, pct: 100 }))];
  const values = interpret(rows).map((p) => p[1]);
  assert.deepEqual(values, [80, 100, 100, 100, 100, null, null, null, null]);
});

test('each date gets one vote', () => {
  const points: Point[] = [[MONDAY, 20], [MONDAY + WEEK, 20], [MONDAY + 2 * WEEK, 20]];
  for (let i = 0; i < 4; i++) points.push([MONDAY + 3 * WEEK + i * 600, 80]);
  const profile = buildProfile(points, MONDAY + 3 * WEEK);
  assert.equal(profile.values[0]![10], 20);
  assert.equal(profile.days[0]![10], 4);
});

test('one day cannot create a usual value', () => {
  const points: Point[] = [[MONDAY, 20], [MONDAY + 600, 20], [MONDAY + 1200, 20]];
  assert.equal(buildProfile(points, MONDAY).values[0]![10], null);
});

test('recent weeks outweigh older ones', () => {
  // Monday 8 June at 10:00, in summer time.
  const now = Date.UTC(2026, 5, 8, 7) / 1000;
  const points: Point[] = [[MONDAY, 10], [MONDAY + WEEK, 10], [MONDAY + 2 * WEEK, 10], [now - WEEK, 50], [now, 50]];
  assert.equal(buildProfile(points, now).values[0]![10], 50);
});

test('recognises Lithuanian holidays', () => {
  assert.deepEqual(easterSunday(2026), { month: 4, day: 5 });
  for (const [y, m, d] of [[2026, 1, 1], [2026, 4, 6], [2026, 5, 3], [2026, 6, 7], [2026, 11, 2], [2026, 12, 24]] as const) {
    assert.ok(isLithuanianHoliday(y, m, d), `${y}-${m}-${d}`);
  }
  assert.ok(!isLithuanianHoliday(2026, 11, 23));
});

test('holidays and closed days are left out of the usual week', () => {
  // Mondays at 10:00: 19 Oct and 26 Oct (EEST/EET), 2 Nov is a holiday, 9 Nov looked closed, 16 Nov.
  const points: Point[] = [
    [Date.UTC(2026, 9, 19, 7) / 1000, 20],
    [Date.UTC(2026, 9, 26, 8) / 1000, 20],
    [Date.UTC(2026, 10, 2, 8) / 1000, 90],
    [Date.UTC(2026, 10, 9, 8) / 1000, 0],
    [Date.UTC(2026, 10, 16, 8) / 1000, 20],
  ];
  const profile = buildProfile(points, Date.UTC(2026, 10, 16, 8) / 1000);
  assert.equal(profile.values[0]![10], 20);
  assert.equal(profile.days[0]![10], 3);
});

test('uses real local midnight on clock-change days', () => {
  const spring = dayHoursAt(Date.UTC(2026, 2, 29, 10) / 1000);
  assert.equal(spring[0], Date.UTC(2026, 2, 28, 22) / 1000);
  assert.equal(spring[24], Date.UTC(2026, 2, 29, 21) / 1000);
  const autumn = dayHoursAt(Date.UTC(2026, 9, 25, 10) / 1000);
  assert.equal(autumn[0], Date.UTC(2026, 9, 24, 21) / 1000);
  assert.equal(autumn[24], Date.UTC(2026, 9, 25, 22) / 1000);
});

test('a closed pool stops showing its last percentage', () => {
  const store = openStore(':memory:');
  const now = MONDAY;
  const pool = { name: 'Kauno Žalgirio baseinas', city: 'Kauno klubai', address: 'B' };
  store.record('zalgirio-baseinas', now - 900, [{ ...pool, pct: 30 }]);
  store.record('zalgirio-baseinas', now - 60, [{ ...pool, pct: null }]);
  store.setStatus('zalgirio-baseinas', { lastOk: now - 60 });
  const row = createReader(store).overview(now).clubs[0]!;
  assert.equal(row.state, 'closed');
  assert.equal(row.pct, null);
});

test('a club missing from recent polls is no data, not closed', () => {
  const store = openStore(':memory:');
  const now = MONDAY;
  store.record('lemongym', now - 3600, [club, { ...club, name: 'Urmas' }]);
  store.record('lemongym', now - 60, [club]);
  store.setStatus('lemongym', { lastOk: now - 60 });
  const states = Object.fromEntries(createReader(store).overview(now).clubs.map((c) => [c.name, c.state]));
  assert.deepEqual(states, { Pikas: 'open', Urmas: 'stale' });
});

test('health reports a long outage of a secondary source', () => {
  const store = openStore(':memory:');
  store.setStatus('lemongym', { lastOk: MONDAY - 60 });
  store.setStatus('impuls', { lastOk: MONDAY - 13 * 3600, lastError: 'HTTP 429' });
  assert.equal(createReader(store).healthy(MONDAY), false);
  store.setStatus('impuls', { lastOk: MONDAY - 3600 });
  assert.equal(createReader(store).healthy(MONDAY), true);
});

test('retention keeps confirmed full readings', () => {
  const store = openStore(':memory:');
  const now = 1_800_000_000;
  const hour = Math.floor((now - (RAW_RETENTION_DAYS + 10) * 86_400) / 3600) * 3600;
  [80, 100, 90, 90].forEach((pct, i) => store.record('lemongym', hour + i * 900, [{ ...club, pct }]));
  applyRetention(store, now);
  assert.deepEqual(store.sqlite.prepare('SELECT ts, pct FROM samples').all(), [{ ts: hour, pct: 90 }]);
});

test('re-importing CSVs cannot change compacted hours', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gym-compact-'));
  const t = Date.UTC(2020, 0, 1, 10);
  const stamp = (m: number) => new Date(t + m * 60_000).toISOString().replace('.000', '');
  writeFileSync(
    join(dir, '2020-01-01.csv'),
    'timestamp,city,club,address,occupancy\n' +
      [[0, 20], [15, 40], [30, 60], [45, 80]].map(([m, p]) => `${stamp(m!)},Vilniaus klubai,Pikas,A,${p}`).join('\n') + '\n',
  );
  const store = openStore(':memory:');
  importCsvDir(store, dir);
  const now = t / 1000 + 500 * 86_400;
  applyRetention(store, now);
  const before = store.sqlite.prepare('SELECT ts, pct FROM samples').all();
  assert.deepEqual(before, [{ ts: t / 1000, pct: 50 }]);
  importCsvDir(store, dir);
  applyRetention(store, now);
  assert.deepEqual(store.sqlite.prepare('SELECT ts, pct FROM samples').all(), before);
});

test('honours gzip preferences', () => {
  assert.ok(acceptsGzip('br, gzip'));
  assert.ok(acceptsGzip('gzip;q=0.5'));
  assert.ok(!acceptsGzip('gzip;q=0, identity;q=1'));
  assert.ok(!acceptsGzip(undefined));
});

test('blank CSV occupancy is skipped, not read as 0%', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gym-blank-'));
  writeFileSync(join(dir, '2026-01-01.csv'), 'timestamp,city,club,address,occupancy\n2026-01-01T10:00:00Z,Vilniaus klubai,Pikas,A,\n');
  const store = openStore(':memory:');
  assert.deepEqual(importCsvDir(store, dir), { rows: 0, skipped: 1 });
});
