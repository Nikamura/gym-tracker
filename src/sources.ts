import { cleanClubName } from './clubs.ts';
import type { Reading } from './db.ts';

export interface Source {
  id: string;
  url: string;
  init?: { method: string; headers: Record<string, string>; body: string };
  parse(body: string): Reading[];
}

const ENTITIES: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };

function text(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&([a-z]+);/g, (m, e: string) => ENTITIES[e] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

const MIN_LEMON_CLUBS = 10;

export function parseLemonGym(body: string): Reading[] {
  const html = (JSON.parse(body) as { data?: { content?: unknown } }).data?.content;
  if (typeof html !== 'string') throw new Error('LemonGym response has no content');

  const readings: Reading[] = [];
  let outOfRange = 0;
  for (const section of html.split(/(?=<h5[\s>])/).slice(1)) {
    const city = text(/<h5[^>]*>([\s\S]*?)<\/h5>/.exec(section)?.[1] ?? '');
    const club =
      /<h6[^>]*xs-small[^>]*>([\s\S]*?)<\/h6>\s*<p[^>]*>([\s\S]*?)<\/p>[\s\S]*?clubs-occupancy__percentage[^>]*>\s*(\d+)\s*%/g;
    for (const m of section.matchAll(club)) {
      const pct = Number(m[3]);
      // The source occasionally reports values such as 102. Drop only that club.
      if (pct > 100) {
        outOfRange++;
        continue;
      }
      readings.push({ name: cleanClubName(text(m[1]!)), city, address: text(m[2]!), pct });
    }
  }

  const expected = html.match(/clubs-occupancy__percentage[\s"]/g)?.length ?? 0;
  if (readings.length + outOfRange !== expected || readings.length < MIN_LEMON_CLUBS) {
    throw new Error(`LemonGym markup changed: parsed ${readings.length} of ${expected} clubs`);
  }
  return readings;
}

export function parseZalgiris(body: string): Reading[] {
  const pct = (JSON.parse(body) as { percent?: unknown }).percent;
  const value = typeof pct === 'string' && /^\d+$/.test(pct) ? Number(pct) : pct;
  // The pool reports 0 or nothing when closed, so only real readings count.
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 99) return [];
  return [
    {
      name: 'Kauno Žalgirio baseinas',
      city: 'Kauno klubai',
      address: 'Karaliaus Mindaugo pr. 50, Kaunas',
      pct: value,
    },
  ];
}

export const SOURCES: Source[] = [
  {
    id: 'lemongym',
    url: 'https://www.lemongym.lt/wp-json/api/async-render-block?pid=MTI2NQ==&bid=YWNmL2NsdWJzLW9jY3VwYW5jeQ==&rest_language=lt',
    parse: parseLemonGym,
  },
  {
    id: 'zalgirio-baseinas',
    url: 'https://www.zalgiriobaseinas.lt/_/r/',
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: 'action=custom_current_capacity',
    },
    parse: parseZalgiris,
  },
];
