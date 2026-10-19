#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
BASIC=../basic

echo "1. typecheck"
npx tsc -p .

echo "2. security tests on a real local workerd"
node test/security.mjs

echo "3. basic kernel layer: tenon must be 9/9, strict"
node "$BASIC/kernel/run.mjs" --app=tenon --strict=1

echo "4. kernel reports exist for all five apps, with cited evidence"
for app in coil hark my-ax chat-ax skin; do
  node "$BASIC/kernel/run.mjs" --app="$app" >/dev/null
  f="$BASIC/reports/kernel-$app.md"
  test -s "$f" || { echo "missing $f"; exit 1; }
  grep -qE '`[a-z-]+/[^`]+:[0-9]+`' "$f" || { echo "no file:line evidence in $f"; exit 1; }
done

echo "5. OVERLAP.md names every invariant and every app"
for t in T1 T2 T3 T4 T5 T6 T7 T8 T9; do grep -q "^| $t " OVERLAP.md || { echo "OVERLAP.md missing $t"; exit 1; }; done
for app in coil hark my-ax chat-ax skin; do grep -q "$app" OVERLAP.md || { echo "OVERLAP.md missing $app"; exit 1; }; done

echo "6. demo writes a screenshot and a receipt"
node scripts/demo.mjs
test -s receipts/demo.png
node -e 'const r=require("./receipts/demo.json"); const s=Object.fromEntries(r.steps.map(x=>[x.name,x])); if(s["anonymous visitor is refused"].status!==401) throw "anon"; if(s["agent ships a broken version; the gate rejects it"].status!==422) throw "gate"; if(s["agent code tries the network and is blocked"].body.status!=="failed") throw "net";'

echo "GATE PASS"
