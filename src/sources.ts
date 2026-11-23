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
  let cards = 0;
  for (const section of html.split(/(?=<h5[\s>])/).slice(1)) {
    const city = text(/<h5[^>]*>([\s\S]*?)<\/h5>/.exec(section)?.[1] ?? '');
    // Each field is read inside its own card, so a gap can't borrow a neighbour's value.
    for (const card of section.split(/(?=<div class="clubs-occupancy">)/).filter((c) => c.startsWith('<div class="clubs-occupancy">'))) {
      cards++;
      const name = cleanClubName(text(/<h6[^>]*xs-small[^>]*>([\s\S]*?)<\/h6>/.exec(card)?.[1] ?? ''));
      const address = text(/<p[^>]*>([\s\S]*?)<\/p>/.exec(card)?.[1] ?? '');
      if (!name || !address || !city) throw new Error('LemonGym markup changed: incomplete club card');
      const rate = /clubs-occupancy__percentage[^>]*>\s*(\d+)\s*%/.exec(card);
      // The source occasionally reports values such as 102. Skip only that club.
      if (!rate || Number(rate[1]) > 100) continue;
      readings.push({ name, city, address, pct: Number(rate[1]) });
    }
  }
  if (readings.length < MIN_LEMON_CLUBS) {
    throw new Error(`LemonGym markup changed: parsed ${readings.length} of ${cards} clubs`);
  }
  return readings;
}

export function parseZalgiris(body: string): Reading[] {
  const data = JSON.parse(body) as { percent?: unknown } | null;
  if (!data || typeof data !== 'object' || !('percent' in data)) throw new Error('Zalgiris response has no percent');
  const raw = data.percent;
  const value = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw;
  const club = { name: 'Kauno Žalgirio baseinas', city: 'Kauno klubai', address: 'Karaliaus Mindaugo pr. 50, Kaunas' };
  // The pool reports 0, empty or 100 when it has no live count.
  if (value === null || value === '' || value === 0 || value === 100) return [{ ...club, pct: null }];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 99) {
    throw new Error('Zalgiris response has an invalid percent');
  }
  return [{ ...club, pct: value }];
}

// Impuls lists every club under one "Vilniaus klubai" heading.
const IMPULS_CITY_BY_CLUB: Record<string, string> = {
  Klaipėdos: 'Klaipėdos klubai',
  Panevėžio: 'Panevėžio klubai',
};
const MIN_IMPULS_CLUBS = 3;

export function parseImpuls(body: string): Reading[] {
  const readings: Reading[] = [];
  let cards = 0;
  for (const block of body.split(/(?=<div class="occupancy-city)/).filter((b) => b.startsWith('<div class="occupancy-city'))) {
    const heading = text(/<h4[^>]*>([\s\S]*?)<\/h4>/.exec(block)?.[1] ?? '');
    for (const card of block.split(/(?=<div class="occupancy-card">)/).filter((c) => c.startsWith('<div class="occupancy-card">'))) {
      cards++;
      const name = text(/<div class="text-xl font-bold">([\s\S]*?)<\/div>/.exec(card)?.[1] ?? '');
      const address = text(/<div class="text-neutral-600">([\s\S]*?)<\/div>/.exec(card)?.[1] ?? '');
      if (!name || !address || !heading) throw new Error('Impuls markup changed: incomplete club card');
      // A card without a rate has no current reading.
      const rate = /occupancy-card-rate[^>]*>\s*(\d+)\s*%/.exec(card);
      if (!rate || Number(rate[1]) > 100) continue;
      readings.push({ name, city: IMPULS_CITY_BY_CLUB[name] ?? heading, address, pct: Number(rate[1]) });
    }
  }
  if (cards < MIN_IMPULS_CLUBS || readings.length === 0) {
    throw new Error(`Impuls markup changed: parsed ${readings.length} of ${cards} clubs`);
  }
  return readings;
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
  {
    id: 'impuls',
    url: 'https://www.impuls.lt/uzimtumas/',
    parse: parseImpuls,
  },
];
