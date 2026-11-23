// Source labels carry marketing suffixes that change over time, for example
// "Riešė - jau rugsėjį🔜" or "Pilaitė (atnaujintas)". The cleaned name is the
// club's identity. Addresses cannot be: one address hosts three venues.
export function cleanClubName(label: string): string {
  return label
    .replace(/\s+[-–—]\s+.*$/u, '')
    .replace(/\s*\([^)]*\)/gu, '')
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function slugify(name: string): string {
  return name
    .toLocaleLowerCase('lt')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
