# Gym Occupancy Tracker

Live occupancy tracker for gyms and pools in Lithuania. Data is collected periodically and displayed as interactive charts.

**https://gym-tracker.cn.lt**

## Sources

- [LemonGym](https://www.lemongym.lt/) — all clubs across Vilnius, Kaunas, and Šiauliai
- [Kauno Žalgirio baseinas](https://www.zalgiriobaseinas.lt/) — pool in Kaunas

## How it works

1. A GitHub Actions workflow runs on a schedule
2. `fetch.sh` scrapes occupancy data from each source
3. Data is appended to daily CSV files in `data/`
4. The single-page app (`index.html`) fetches CSVs via the GitHub API and renders charts with Chart.js

## Filters

- **City** — filter by city
- **Club** — filter to a specific location
- **Time range** — Today, 3d, 7d, or 30d

Filter state is preserved in the URL for easy sharing.

## Data format

CSV files in `data/` with one row per location per data point:

```
timestamp,city,club,address,occupancy
2026-02-26T10:04:48Z,Vilniaus klubai,Pilaitė (atnaujintas),Vydūno g. 2; Vilnius,9
```

## Local development

Just open `index.html` in a browser. Data is fetched from GitHub at runtime — no build step needed.
