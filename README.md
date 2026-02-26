# LemonGym Occupancy Tracker

Live occupancy tracker for [LemonGym](https://www.lemongym.lt/) clubs in Lithuania. Data is collected every 15 minutes and displayed as interactive charts.

**https://gym-tracker.cn.lt**

## How it works

1. A GitHub Actions workflow runs every 15 minutes
2. `fetch.sh` queries the LemonGym API for current occupancy percentages across all clubs
3. Data is appended to daily CSV files in `data/`
4. The single-page app (`index.html`) fetches CSVs via the GitHub API and renders charts with Chart.js

## Filters

- **City** — filter by Vilnius, Kaunas, or Šiauliai
- **Club** — filter to a specific gym location
- **Time range** — Today, 3d, 7d, or 30d

Filter state is preserved in the URL for easy sharing.

## Data format

CSV files in `data/` with one row per club per data point:

```
timestamp,city,club,address,occupancy
2026-02-26T10:04:48Z,Vilniaus klubai,Pilaitė (atnaujintas),Vydūno g. 2; Vilnius,9
```

## Local development

Just open `index.html` in a browser. Data is fetched from GitHub at runtime — no build step needed.
