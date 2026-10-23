#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
node ../basic/kernel/planted.test.mjs
node -e "process.exit(require('../basic/reports/kernel-skin.json').rows.find(r=>r.id==='T5').verdict==='has'?0:1)" || { echo "skin T5 is not has"; exit 1; }
token="$(node_modules/.bin/wrangler auth token 2>/dev/null | tail -1)"
test -n "$token" || { echo "wrangler auth token returned nothing; run npx wrangler login"; exit 3; }
WRITE_JUDGE_TOKEN="$token" bash gate.sh
