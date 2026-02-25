#!/usr/bin/env bash
set -euo pipefail

API_URL="https://www.lemongym.lt/wp-json/api/async-render-block?pid=MTI2NQ==&bid=YWNmL2NsdWJzLW9jY3VwYW5jeQ==&rest_language=lt"
DATA_DIR="$(dirname "$0")/data"
TIMESTAMP="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
DATE="$(date -u '+%Y-%m-%d')"
FILE="$DATA_DIR/$DATE.csv"

mkdir -p "$DATA_DIR"

# Add header if file doesn't exist
if [ ! -f "$FILE" ]; then
  echo "timestamp,city,club,address,occupancy" > "$FILE"
fi

# Fetch and parse
html=$(curl -sf "$API_URL" | jq -r '.data.content')

echo "$html" | awk -v ts="$TIMESTAMP" '
  /<h5 / {
    gsub(/<[^>]*>/, "")
    gsub(/^[[:space:]]+|[[:space:]]+$/, "")
    city = $0
  }
  /xs-small/ {
    gsub(/<[^>]*>/, "")
    gsub(/^[[:space:]]+|[[:space:]]+$/, "")
    # Remove emoji characters
    gsub(/✨/, "")
    gsub(/[[:space:]]+$/, "")
    club = $0
  }
  /<p class="mb-0">/ {
    gsub(/<[^>]*>/, "")
    gsub(/^[[:space:]]+|[[:space:]]+$/, "")
    addr = $0
  }
  /clubs-occupancy__percentage/ {
    getline line
    match(line, /[0-9]+/)
    pct = substr(line, RSTART, RLENGTH)
    # Escape any commas in fields
    gsub(/,/, ";", city)
    gsub(/,/, ";", club)
    gsub(/,/, ";", addr)
    print ts "," city "," club "," addr "," pct
  }
' >> "$FILE"

lines=$(wc -l < "$FILE")
echo "Saved to $FILE ($((lines - 1)) total records)"
