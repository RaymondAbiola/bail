#!/usr/bin/env bash
# Renders docs/diagrams/*.mmd to docs/images/*.svg, so diagrams show in any markdown viewer.
# Needs Node and a local Chrome or Chromium (set CHROME_PATH if it isn't on PATH).
set -euo pipefail

cd "$(dirname "$0")/.."

chrome="${CHROME_PATH:-$(command -v google-chrome || command -v chromium || command -v chromium-browser || true)}"
if [ -z "$chrome" ]; then
  echo "Chrome or Chromium not found; set CHROME_PATH" >&2
  exit 1
fi

puppeteer_config=$(mktemp)
trap 'rm -f "$puppeteer_config"' EXIT
printf '{"executablePath":"%s","args":["--no-sandbox"]}' "$chrome" > "$puppeteer_config"

for src in docs/diagrams/*.mmd; do
  name=$(basename "$src" .mmd)
  PUPPETEER_SKIP_DOWNLOAD=1 npx -y @mermaid-js/mermaid-cli@11.4.2 -q \
    -i "$src" -o "docs/images/$name.svg" \
    -c docs/diagrams/config.json -p "$puppeteer_config" -b white
  echo "rendered docs/images/$name.svg"
done
