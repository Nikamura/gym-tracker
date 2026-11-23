import type { Store } from './db.ts';
import { isLithuanianHoliday } from './holidays.ts';
import { clubHours, hoursStatus, intervalOn, isOpenAt, overlapsHour, type ClubHours, type LocalDay } from './hours.ts';

export type Point = [ts: number, pct: number | null];
export type Typical = (number | null)[][]; // [Mon..Sun][0..23]
export interface Profile {
  values: Typical;
  days: number[][]; // Distinct dates behind each value
}

const TZ = 'Europe/Vilnius';
const FULL_NEIGHBOUR = 70;
const NEIGHBOUR_SECONDS = 3600;
const TYPICAL_DAYS = 182;
const HALF_LIFE_DAYS = 42;
const MIN_TYPICAL_DATES = 3;
const DAYTIME_FROM = 10;
const DAYTIME_TO = 21;
const SLOW_SOURCE_SECONDS = 12 * 3600;
export const FRESH_SECONDS = 45 * 60;

// The source reports 100 for both "full" and "closed". A 100 is full only when
// a real, non-100 reading within an hour shows the club was already busy.
// Works on typed arrays because profiles scan months of samples. -1 = no reading.
export function resolveReadings(ts: ArrayLike<number>, pct: ArrayLike<number>, n: number): Int8Array {
  const out = new Int8Array(n);
  let anchor = -1;
  for (let i = 0; i < n; i++) {
    if (pct[i] !== 100) {
      out[i] = pct[i]!;
      anchor = i;
    } else {
      out[i] = anchor >= 0 && pct[anchor]! >= FULL_NEIGHBOUR && ts[i]! - ts[anchor]! <= NEIGHBOUR_SECONDS ? 100 : -1;
    }
  }
  anchor = -1;
  for (let i = n - 1; i >= 0; i--) {
    if (pct[i] !== 100) anchor = i;
    else if (out[i] === -1 && anchor >= 0 && pct[anchor]! >= FULL_NEIGHBOUR && ts[anchor]! - ts[i]! <= NEIGHBOUR_SECONDS) out[i] = 100;
  }
  return out;
}

export function interpret(rows: readonly { ts: number; pct: number }[]): Point[] {
  const out = resolveReadings(rows.map((r) => r.ts), rows.map((r) => r.pct), rows.length);
  return rows.map((r, i) => [r.ts, out[i] === -1 ? null : out[i]!]);
}

const partsFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ,
  weekday: 'short',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
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
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
    second: Number(p.second),
  };
}

function wallClockToTs(year: number, month: number, day: number, hour: number): number {
  const target = Date.UTC(year, month - 1, day, hour) / 1000;
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const p = localParts(guess);
    guess += target - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) / 1000;
  }
  return guess;
}

// Timestamps of 00:00 through 24:00 on the local date, correct on clock-change days.
export function dayHoursAt(ts: number): number[] {
  const p = localParts(ts);
  const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
  const hours = Array.from({ length: 24 }, (_, h) => wallClockToTs(p.year, p.month, p.day, h));
  hours.push(wallClockToTs(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0));
  return hours;
}

interface HourInfo {
  date: number; // Days since epoch for the local date
  hour: number;
  dow: number;
  dayOfMonth: number;
  holiday: boolean;
}
const hourInfoCache = new Map<number, HourInfo>();

function hourInfo(ts: number): HourInfo {
  const bucket = Math.floor(ts / 3600);
  let info = hourInfoCache.get(bucket);
  if (!info) {
    if (hourInfoCache.size > 20_000) hourInfoCache.clear();
    const p = localParts(bucket * 3600);
    info = {
      date: Date.UTC(p.year, p.month - 1, p.day) / 86_400_000,
      hour: p.hour,
      dow: p.dow,
      dayOfMonth: p.day,
      holiday: isLithuanianHoliday(p.year, p.month, p.day),
    };
    hourInfoCache.set(bucket, info);
  }
  return info;
}

function weightedMedian(entries: { value: number; weight: number }[]): number {
  entries.sort((a, b) => a.value - b.value);
  const half = entries.reduce((sum, e) => sum + e.weight, 0) / 2;
  let seen = 0;
  for (let i = 0; i < entries.length; i++) {
    seen += entries[i]!.weight;
    if (Math.abs(seen - half) < 1e-9 && entries[i + 1]) return Math.round((entries[i]!.value + entries[i + 1]!.value) / 2);
    if (seen > half) return Math.round(entries[i]!.value);
  }
  return Math.round(entries.at(-1)!.value);
}

// Each local date gets one vote per hour, recent dates count more, and public
// holidays or days that looked closed all daytime are left out.
function profileFrom(
  ts: ArrayLike<number>,
  values: ArrayLike<number>,
  n: number,
  now: number,
  clubSchedule: ClubHours | null = null,
): Profile {
  const hours = new Map<number, { sum: number; count: number }>();
  const daytime = new Map<number, { seen: number; usable: number }>();
  for (let i = 0; i < n; i++) {
    const info = hourInfo(ts[i]!);
    if (info.holiday) continue;
    // Readings outside published hours say nothing about a normal visit.
    const minute = info.hour * 60 + Math.floor((ts[i]! % 3600) / 60);
    if (!isOpenAt(clubSchedule, info.dow, info.dayOfMonth, minute)) continue;
    const value = values[i]!;
    if (info.hour >= DAYTIME_FROM && info.hour < DAYTIME_TO) {
      const day = daytime.get(info.date) ?? { seen: 0, usable: 0 };
      day.seen++;
      if (value > 0) day.usable++;
      daytime.set(info.date, day);
    }
    if (value < 0) continue;
    const key = info.date * 24 + info.hour;
    const hour = hours.get(key) ?? { sum: 0, count: 0 };
    hour.sum += value;
    hour.count++;
    hours.set(key, hour);
  }

  const today = hourInfo(now).date;
  const cells: { value: number; weight: number }[][] = Array.from({ length: 7 * 24 }, () => []);
  for (const [key, { sum, count }] of hours) {
    const date = Math.floor(key / 24);
    const day = daytime.get(date);
    if (day && day.usable === 0) continue;
    const dow = (date + 3) % 7; // 1970-01-01 was a Thursday
    const weight = 0.5 ** (Math.max(0, today - date) / HALF_LIFE_DAYS);
    cells[dow * 24 + (key - date * 24)]!.push({ value: sum / count, weight });
  }

  const result: Profile = { values: [], days: [] };
  for (let dow = 0; dow < 7; dow++) {
    const dayCells = cells.slice(dow * 24, (dow + 1) * 24);
    result.values.push(
      dayCells.map((c, hour) => (c.length >= MIN_TYPICAL_DATES && overlapsHour(clubSchedule, dow, hour) ? weightedMedian(c) : null)),
    );
    result.days.push(dayCells.map((c, hour) => (overlapsHour(clubSchedule, dow, hour) ? c.length : 0)));
  }
  return result;
}

export function buildProfile(points: readonly Point[], now?: number): Profile {
  const end = now ?? Math.max(0, ...points.map((p) => p[0]));
  return profileFrom(points.map((p) => p[0]), points.map((p) => p[1] ?? -1), points.length, end);
}

export function buildTypical(points: readonly Point[], now?: number): Typical {
  return buildProfile(points, now).values;
}

function profileFromRows(rows: Iterable<{ ts: number; pct: number }>, now: number, clubSchedule: ClubHours | null): Profile {
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
  return profileFrom(ts, resolveReadings(ts, pct, n), n, now, clubSchedule);
}

function localDay(ts: number): LocalDay {
  const p = localParts(ts);
  return { dow: p.dow, dayOfMonth: p.day, holiday: isLithuanianHoliday(p.year, p.month, p.day) };
}

interface ClubRow {
  id: number;
  slug: string;
  name: string;
  city: string;
  address: string;
  source: string;
  last_seen: number | null;
  last_closed: number;
}

export function createReader(store: Store) {
  const { sqlite } = store;
  const allClubs = sqlite.prepare<[], ClubRow>('SELECT * FROM clubs ORDER BY name');
  const clubBySlug = sqlite.prepare<[string], ClubRow>('SELECT * FROM clubs WHERE slug = ?');
  const since = sqlite.prepare<[number, number], { ts: number; pct: number }>(
    'SELECT ts, pct FROM samples WHERE club_id = ? AND ts >= ? ORDER BY ts',
  );

  let profileHour = -1;
  let profiles = new Map<number, Profile>();

  function profileFor(club: ClubRow, now: number): Profile {
    const hour = Math.floor(now / 3600);
    if (hour !== profileHour) {
      profileHour = hour;
      profiles = new Map();
    }
    let profile = profiles.get(club.id);
    if (!profile) {
      profile = profileFromRows(since.iterate(club.id, now - TYPICAL_DAYS * 86_400), now, clubHours(club.slug));
      profiles.set(club.id, profile);
    }
    return profile;
  }

  function overview(now: number) {
    const allStatuses = store.allStatuses();
    const statuses = new Map(allStatuses.map((s) => [s.source, s]));
    const nowParts = localParts(now);
    const today = localDay(now);
    const tomorrow = localDay(now + 86_400);
    const minute = nowParts.hour * 60 + nowParts.minute;
    const clubs = allClubs.all().map((club) => {
      const sourceFresh = now - (statuses.get(club.source)?.lastOk ?? 0) < FRESH_SECONDS;
      const seenFresh = club.last_seen !== null && now - club.last_seen < FRESH_SECONDS;
      const last = interpret(since.all(club.id, now - FRESH_SECONDS - NEIGHBOUR_SECONDS)).at(-1);
      const hasCurrent = !!last && now - last[0] < FRESH_SECONDS;
      const schedule = clubHours(club.slug);
      const hours = hoursStatus(schedule, today, minute, tomorrow);
      // Without a usable reading, only clubs with unknown hours can be called closed.
      const noReading = schedule ? 'unavailable' : 'closed';
      let state: 'open' | 'closed' | 'unavailable' | 'stale' = 'stale';
      if (hours.known && !hours.open) state = 'closed';
      else if (sourceFresh && seenFresh) {
        if (club.last_closed) state = noReading;
        else if (hasCurrent) state = last[1] === null ? noReading : 'open';
      }
      const at = localParts(hasCurrent ? last[0] : now);
      return {
        slug: club.slug,
        name: club.name,
        city: club.city,
        address: club.address,
        source: club.source,
        state,
        hoursLabel: hours.label,
        pct: state === 'open' ? last![1] : null,
        ts: state === 'open' ? last![0] : club.last_seen,
        // Compared against the hour the reading was actually taken.
        typical: profileFor(club, now).values[at.dow]![at.hour] ?? null,
      };
    });
    const delayed = allStatuses
      .filter((s) => s.lastError && now - (s.lastOk ?? 0) >= FRESH_SECONDS)
      .map((s) => s.source);
    return { now, updated: Math.max(0, ...allStatuses.map((s) => s.lastOk ?? 0)) || null, delayed, clubs };
  }

  function club(slug: string, days: 1 | 7 | 30, now: number) {
    const row = clubBySlug.get(slug);
    if (!row) return null;
    const dayHours = dayHoursAt(now);
    const dayStart = dayHours[0]!;
    const from = days === 1 ? dayStart : now - days * 86_400;
    // Earlier readings give the first points of the range their context.
    const points = interpret(since.all(row.id, from - NEIGHBOUR_SECONDS)).filter((p) => p[0] >= from);
    const profile = profileFor(row, now);
    const schedule = clubHours(row.slug);
    const today = localDay(now);
    const minute = localParts(now).hour * 60 + localParts(now).minute;
    const upcoming = Array.from({ length: 7 }, (_, i) => {
      const day = localDay(dayStart + 43_200 + i * 86_400);
      const interval = schedule ? intervalOn(schedule, day.dow, day.dayOfMonth) : ([0, 1440] as const);
      return { dow: day.dow, holiday: day.holiday, open: interval?.[0] ?? null, close: interval?.[1] ?? null };
    });
    return {
      now,
      days,
      dayStart,
      dayEnd: dayHours[24],
      dayHours,
      dow: localParts(now).dow,
      club: { slug: row.slug, name: row.name, city: row.city, address: row.address, source: row.source },
      points,
      typical: profile.values,
      typicalDays: profile.days,
      upcoming,
      hours: schedule
        ? {
            kind: schedule.kind,
            url: schedule.url,
            label: hoursStatus(schedule, today, minute, localDay(now + 86_400)).label,
            week: schedule.week ?? null,
          }
        : null,
    };
  }

  // LemonGym must be current. Other sources can legitimately pause overnight.
  function healthy(now: number): boolean {
    const statuses = store.allStatuses();
    const lemon = statuses.find((s) => s.source === 'lemongym');
    if (!lemon?.lastOk || now - lemon.lastOk >= FRESH_SECONDS) return false;
    return statuses.every((s) => (s.lastOk ? now - s.lastOk < SLOW_SOURCE_SECONDS : !s.lastError));
  }

  return { overview, club, healthy };
}
