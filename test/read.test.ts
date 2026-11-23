import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { openStore } from '../src/db.ts';
import { buildTypical, interpret, localParts, type Point } from '../src/read.ts';
import { createHandler } from '../src/server.ts';

const at = (...pcts: number[]) => pcts.map((pct, i) => ({ ts: 1000 + i * 900, pct }));
const values = (points: Point[]) => points.map((p) => p[1]);

test('100 after an empty club means closed, not full', () => {
  assert.deepEqual(values(interpret(at(5, 100, 100, 3))), [5, null, null, 3]);
});

test('100 next to a busy reading means full', () => {
  assert.deepEqual(values(interpret(at(60, 85, 100, 100, 90))), [60, 85, 100, 100, 90]);
});

test('a distant busy reading does not make a 100 full', () => {
  assert.deepEqual(values(interpret([{ ts: 0, pct: 90 }, { ts: 7200, pct: 100 }])), [90, null]);
});

test('uses Vilnius local time across daylight saving', () => {
  assert.deepEqual(
    { dow: localParts(Date.UTC(2026, 6, 6, 21) / 1000).dow, hour: localParts(Date.UTC(2026, 6, 6, 21) / 1000).hour },
    { dow: 1, hour: 0 },
  );
  assert.equal(localParts(Date.UTC(2026, 0, 5, 22) / 1000).hour, 0);
});

test('typical uses the median and needs three samples', () => {
  const monday10 = Date.UTC(2026, 0, 5, 8) / 1000;
  const typical = buildTypical([
    [monday10, 10],
    [monday10 + 7 * 86_400, 20],
    [monday10 + 14 * 86_400, 90],
    [monday10 + 3600, 40],
    [monday10 + 3700, null],
  ]);
  assert.equal(typical[0]![10], 20);
  assert.equal(typical[0]![11], null);
});

test('API serves data, hides nothing sensitive, and rejects bad input', async () => {
  const store = openStore(':memory:');
  const now = Date.UTC(2026, 0, 5, 12) / 1000;
  store.record('lemongym', now - 60, [{ name: 'Pikas', city: 'Vilniaus klubai', address: 'A', pct: 42 }]);
  store.setStatus('lemongym', { lastOk: now - 60, lastError: 'secret detail' });
  const publicDir = fileURLToPath(new URL('../public', import.meta.url));
  const server = createServer(createHandler(store, publicDir, () => now));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const overview = (await (await fetch(`${base}/api/overview`)).json()) as { clubs: { state: string; pct: number; source: string }[] };
    assert.equal(overview.clubs[0]?.state, 'open');
    assert.equal(overview.clubs[0]?.source, 'lemongym');
    assert.equal(overview.clubs[0]?.pct, 42);
    const detail = (await (await fetch(`${base}/api/clubs/pikas?days=7`)).json()) as { points: Point[] };
    assert.deepEqual(detail.points, [[now - 60, 42]]);
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { healthy: true });
    assert.equal((await fetch(`${base}/api/clubs/pikas?days=9`)).status, 400);
    assert.equal((await fetch(`${base}/api/clubs/nope`)).status, 404);
    assert.equal((await fetch(`${base}/../package.json`)).status, 404);
    assert.equal((await fetch(`${base}/api/overview`, { method: 'POST' })).status, 405);
    assert.match(await (await fetch(`${base}/`)).text(), /Gym Tracker/);
  } finally {
    server.close();
    store.close();
  }
});
