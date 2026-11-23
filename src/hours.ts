// Published opening hours, checked on each operator's club page on 2026-11-23.
export type Interval = [open: number, close: number]; // Minutes since local midnight

export interface ClubHours {
  kind: 'always' | 'weekly' | 'classes';
  week?: Interval[]; // Mon..Sun
  firstMondayOpen?: number;
  url: string;
}

const hm = (hour: number, minute = 0) => hour * 60 + minute;
const DAY: Interval = [0, 1440];
const IMPULS_WEEKDAY: Interval = [hm(6, 30), hm(22)];
const IMPULS_WEEKEND: Interval = [hm(9), hm(20)];
const IMPULS_WEEK = [...Array<Interval>(5).fill(IMPULS_WEEKDAY), IMPULS_WEEKEND, IMPULS_WEEKEND];
const POOL_WEEK: Interval[] = [...Array<Interval>(5).fill([hm(6), hm(22)]), [hm(8), hm(22)], [hm(8), hm(21)]];

const lemon = (page: string): ClubHours => ({ kind: 'always', url: `https://www.lemongym.lt/clubs/${page}/` });
const impuls = (page: string, always = false): ClubHours => ({
  kind: always ? 'always' : 'weekly',
  ...(always ? {} : { week: IMPULS_WEEK }),
  url: `https://www.impuls.lt/klubai/${page}/`,
});

const HOURS: Record<string, ClubHours> = {
  antakalnis: lemon('antakalnis'),
  asanaviciute: lemon('asanaviciute'),
  ateities: lemon('ateities'),
  banginis: lemon('banginis'),
  europa: lemon('europa'),
  'kauno-zalgirio-arena': lemon('zalgirio-arena'),
  perkunkiemis: lemon('perkunkiemis'),
  pikas: lemon('pikas'),
  pilaite: lemon('pilaite'),
  raudondvaris: lemon('raudondvaris'),
  riese: lemon('riese'),
  sauletekis: lemon('sauletekis'),
  savanoriai: lemon('savanoriai'),
  'siauliu-akropolis': lemon('siauliu-akropolis'),
  silainiai: lemon('silainiai'),
  skraja: lemon('skraja'),
  urmas: lemon('urmas'),
  vienuolis: lemon('vienuolis'),
  'vilniaus-akropolis': lemon('vilniaus-akropolis'),
  'vilniaus-zalgiris': lemon('zalgiris-2'),
  'lemon-gym-reformer': { kind: 'classes', url: 'https://www.lemongym.lt/clubs/lemon-gym-reformer/' },
  'impuls-fabijoniskiu': impuls('fabijoniskiu-g-97a-vilnius', true),
  'impuls-kareiviu': impuls('kareiviu-g-14-vilnius'),
  'impuls-klaipedos': impuls('liepu-g-53a-klaipeda'),
  'impuls-panevezio': impuls('parko-g-14-panevezys'),
  'impuls-savanoriu': impuls('savanoriu-pr-28-vilnius'),
  'kauno-zalgirio-baseinas': {
    kind: 'weekly',
    week: POOL_WEEK,
    firstMondayOpen: hm(14), // Monthly maintenance morning
    url: 'https://www.zalgiriobaseinas.lt/kontaktai/',
  },
};

export const clubHours = (slug: string): ClubHours | null => HOURS[slug] ?? null;

export function intervalOn(hours: ClubHours | null, dow: number, dayOfMonth: number): Interval | null {
  if (!hours || hours.kind === 'always') return hours ? DAY : null;
  if (hours.kind === 'classes') return null;
  const base = hours.week![dow]!;
  if (dow === 0 && dayOfMonth <= 7 && hours.firstMondayOpen !== undefined) {
    return [Math.max(base[0], hours.firstMondayOpen), base[1]];
  }
  return base;
}

// Clubs without a fixed schedule are never excluded by time.
export function isOpenAt(hours: ClubHours | null, dow: number, dayOfMonth: number, minute: number): boolean {
  if (!hours || hours.kind !== 'weekly') return true;
  const interval = intervalOn(hours, dow, dayOfMonth)!;
  return minute >= interval[0] && minute < interval[1];
}

export function overlapsHour(hours: ClubHours | null, dow: number, hour: number): boolean {
  if (!hours || hours.kind !== 'weekly') return true;
  const [open, close] = hours.week![dow]!;
  return open < (hour + 1) * 60 && close > hour * 60;
}

const clock = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

export interface LocalDay {
  dow: number;
  dayOfMonth: number;
  holiday: boolean;
}

export function hoursStatus(
  hours: ClubHours | null,
  today: LocalDay,
  minute: number,
  tomorrow: LocalDay,
): { known: boolean; open: boolean; label: string } {
  if (!hours) return { known: false, open: true, label: '' };
  if (hours.kind === 'classes') return { known: false, open: true, label: 'By class schedule' };
  if (hours.kind === 'always') return { known: true, open: true, label: 'Open 24/7' };
  if (today.holiday) return { known: false, open: true, label: 'Holiday, hours may differ' };
  const [open, close] = intervalOn(hours, today.dow, today.dayOfMonth)!;
  if (minute >= open && minute < close) return { known: true, open: true, label: `Open until ${clock(close)}` };
  if (minute < open) return { known: true, open: false, label: `Opens ${clock(open)}` };
  if (tomorrow.holiday) return { known: true, open: false, label: 'Closed for today' };
  const next = intervalOn(hours, tomorrow.dow, tomorrow.dayOfMonth)!;
  return { known: true, open: false, label: `Opens tomorrow ${clock(next[0])}` };
}
