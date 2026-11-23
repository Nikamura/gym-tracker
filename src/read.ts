import type { Store } from './db.ts';

export type Point = [ts: number, pct: number | null];
export type Typical = (number | null)[][]; // [Mon..Sun][0..23]

const TZ = 'Europe/Vilnius';
const FULL_NEIGHBOUR = 70;
const NEIGHBOUR_SECONDS = 3600;
const TYPICAL_DAYS = 182;
const MIN_TYPICAL_SAMPLES = 3;
export const FRESH_SECONDS = 45 * 60;

// The source reports 100 for both "full" and "closed". A 100 only counts as
// full when an adjacent reading shows the club was already filling up.
// Works on typed arrays because typical patterns scan months of samples inside
// a small container. -1 in the result means no usable reading.
function resolve(ts: ArrayLike<number>, pct: ArrayLike<number>, n: number): Int8Array {
  const out = new Int8Array(n);
  for (let i = 0; i < n; i++) out[i] = pct[i] === 100 ? -1 : pct[i]!;
  const promote = (i: number, j: number) => {
    if (out[i] === -1 && out[j]! >= FULL_NEIGHBOUR && Math.abs(ts[j]! - ts[i]!) <= NEIGHBOUR_SECONDS) out[i] = 100;
  };
  for (let i = 1; i < n; i++) promote(i, i - 1);
  for (let i = n - 2; i >= 0; i--) promote(i, i + 1);
  return out;
}

export function interpret(rows: readonly { ts: number; pct: number }[]): Point[] {
  const out = resolve(rows.map((r) => r.ts), rows.map((r) => r.pct), rows.length);
  return rows.map((r, i) => [r.ts, out[i] === -1 ? null : out[i]!]);
}

const partsFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ,
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function localParts(ts: number) {
  const p = Object.fromEntries(partsFormat.formatToParts(ts * 1000).map((x) => [x.type, x.value]));
  return {
    dow: WEEKDAYS.indexOf(p.weekday!),
    hour: Number(p.hour),
    secondsIntoDay: Number(p.hour) * 3600 + Number(p.minute) * 60 + Number(p.second),
  };
}

const CELLS = 7 * 24;
const VALUES = 101;
// Hour buckets are shared across clubs, so each is only formatted once.
const cellByHour = new Map<number, number>();

function cellFor(ts: number): number {
  const bucket = Math.floor(ts / 3600);
  let cell = cellByHour.get(bucket);
  if (cell === undefined) {
    const at = localParts(bucket * 3600);
    cell = at.dow * 24 + at.hour;
    cellByHour.set(bucket, cell);
  }
  return cell;
}

function medianAt(histogram: Uint32Array, cell: number, rank: number): number {
  let seen = 0;
  for (let v = 0; v < VALUES; v++) {
    seen += histogram[cell * VALUES + v]!;
    if (seen > rank) return v;
  }
  return VALUES - 1;
}

function fromHistogram(histogram: Uint32Array): Typical {
  return WEEKDAYS.map((_, dow) =>
    Array.from({ length: 24 }, (_, hour) => {
      const cell = dow * 24 + hour;
      let count = 0;
      for (let v = 0; v < VALUES; v++) count += histogram[cell * VALUES + v]!;
      if (count < MIN_TYPICAL_SAMPLES) return null;
      const mid = count >> 1;
      return count % 2
        ? medianAt(histogram, cell, mid)
        : Math.round((medianAt(histogram, cell, mid - 1) + medianAt(histogram, cell, mid)) / 2);
    }),
  );
}

export function buildTypical(points: readonly Point[]): Typical {
  const histogram = new Uint32Array(CELLS * VALUES);
  for (const [ts, pct] of points) {
    if (pct !== null) histogram[cellFor(ts) * VALUES + pct]!++;
  }
  return fromHistogram(histogram);
}

function typicalFromRows(rows: Iterable<{ ts: number; pct: number }>): Typical {
  let ts = new Int32Array(8192);
  let pct = new Uint8Array(8192);
  let n = 0;
  for (const row of rows) {
    if (n === ts.length) {
      const nextTs = new Int32Array(n * 2);
      const nextPct = new Uint8Array(n * 2);
      nextTs.set(ts);
      nextPct.set(pct);
      ts = nextTs;
      pct = nextPct;
    }
    ts[n] = row.ts;
    pct[n++] = row.pct;
  }
  const resolved = resolve(ts, pct, n);
  const histogram = new Uint32Array(CELLS * VALUES);
  for (let i = 0; i < n; i++) {
    if (resolved[i] !== -1) histogram[cellFor(ts[i]!) * VALUES + resolved[i]!]!++;
  }
  return fromHistogram(histogram);
}

interface ClubRow {
  id: number;
  slug: string;
  name: string;
  city: string;
  address: string;
  source: string;
}

export function createReader(store: Store) {
  const { sqlite } = store;
  const allClubs = sqlite.prepare<[], ClubRow>('SELECT * FROM clubs ORDER BY name');
  const clubBySlug = sqlite.prepare<[string], ClubRow>('SELECT * FROM clubs WHERE slug = ?');
  const since = sqlite.prepare<[number, number], { ts: number; pct: number }>(
    'SELECT ts, pct FROM samples WHERE club_id = ? AND ts >= ? ORDER BY ts',
  );
  const recent = sqlite.prepare<[number], { ts: number; pct: number }>(
    'SELECT ts, pct FROM samples WHERE club_id = ? ORDER BY ts DESC LIMIT 8',
  );

  let typicalKey = -1;
  let typicalCache = new Map<number, Typical>();

  function typicalFor(clubId: number, now: number): Typical {
    const key = Math.max(0, ...store.allStatuses().map((s) => s.lastOk ?? 0));
    if (key !== typicalKey) {
      typicalKey = key;
      typicalCache = new Map();
    }
    let typical = typicalCache.get(clubId);
    if (!typical) {
      typical = typicalFromRows(since.iterate(clubId, now - TYPICAL_DAYS * 86_400));
      typicalCache.set(clubId, typical);
    }
    return typical;
  }

  function overview(now: number) {
    const statuses = new Map(store.allStatuses().map((s) => [s.source, s]));
    const at = localParts(now);
    const clubs = allClubs.all().map((club) => {
      const lastOk = statuses.get(club.source)?.lastOk ?? 0;
      const sourceFresh = now - lastOk < FRESH_SECONDS;
      const rows = recent.all(club.id).reverse();
      const last = interpret(rows).at(-1);
      const hasCurrent = !!last && now - last[0] < FRESH_SECONDS;
      const pct = hasCurrent ? last[1] : null;
      const state = !sourceFresh ? 'stale' : pct === null ? 'closed' : 'open';
      return {
        slug: club.slug,
        name: club.name,
        city: club.city,
        address: club.address,
        state,
        pct: state === 'open' ? pct : null,
        ts: last?.[0] ?? null,
        typical: typicalFor(club.id, now)[at.dow]![at.hour] ?? null,
      };
    });
    return { now, updated: Math.max(0, ...[...statuses.values()].map((s) => s.lastOk ?? 0)) || null, clubs };
  }

  function club(slug: string, days: 1 | 7 | 30, now: number) {
    const row = clubBySlug.get(slug);
    if (!row) return null;
    const at = localParts(now);
    const dayStart = now - at.secondsIntoDay;
    const from = days === 1 ? dayStart : now - days * 86_400;
    // One earlier reading gives the first point of the range its context.
    const points = interpret(since.all(row.id, from - NEIGHBOUR_SECONDS)).filter((p) => p[0] >= from);
    return {
      now,
      days,
      dayStart,
      dow: at.dow,
      club: { slug: row.slug, name: row.name, city: row.city, address: row.address },
      points,
      typical: typicalFor(row.id, now),
    };
  }

  function healthy(now: number): boolean {
    const lastOk = store.getStatus('lemongym')?.lastOk;
    return !!lastOk && now - lastOk < FRESH_SECONDS;
  }

  return { overview, club, healthy };
}
