# Gym Tracker

See how busy gyms and pools in Lithuania are right now, and when it is best to go.

**https://gym-tracker.cn.lt**

## Sources

- [LemonGym](https://www.lemongym.lt/): clubs in Vilnius, Kaunas, and Šiauliai
- [Kauno Žalgirio baseinas](https://www.zalgiriobaseinas.lt/): pool in Kaunas
- [Impuls](https://www.impuls.lt/uzimtumas/): clubs in Vilnius, Klaipėda, and Panevėžys

## How it works

A small TypeScript service runs in Docker on the homelab:

1. Every 15 minutes it reads each source through the VPN proxy. Without a proxy it refuses to start, and on HTTP 403 or 429 it pauses that source for 6 hours.
2. Samples go into SQLite through Drizzle, at about 13 bytes each.
3. The same service serves the JSON API and the static site in `public/`.

Samples are kept at 15-minute detail for 400 days, hourly until 5 years, then deleted. That keeps the database to tens of megabytes.

The CSV files in `data/` are a frozen archive of the original GitHub Actions history, imported into SQLite. Data is no longer committed to Git.

## Reading the data

- The source reports `100` for both full and closed clubs. It is stored as received. On read it counts as full only when a real reading within an hour was at least 70%.
- Marketing suffixes in club names are removed, so renamed clubs keep their history.
- "Usual week" is a weighted median for each weekday and hour over the last 6 months. Each date gets one vote, recent weeks count more (6-week half-life), and public holidays and days that looked closed are excluded.
- Opening hours in `src/hours.ts` come from each operator's club page. Readings outside them are excluded, and a visit must fit inside them.
- "Best time to go" picks the quietest 2-hour visit inside the chosen part of the day.

## Development

```sh
pnpm install
pnpm test
pnpm typecheck
PROXY_URL=http://user:pass@proxy:3128 pnpm start
```

## Deployment

The checkout is at `/opt/stacks/gym-tracker` on the Docker host. On a first deployment, create `db/` as UID 1000 before starting. Push to GitHub, check out the commit there, then run `docker compose up -d --build`. `.env`, `db/`, and `DEPLOYED_COMMIT` are host-local.

`deploy/` holds the nightly NAS backup and its systemd units. `deploy/backup.py --check` reports whether a verified backup is recent.
