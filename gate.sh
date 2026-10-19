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

echo "7. invariants.json is the one source: ids, references and tests agree"
node -e '
const fs=require("fs");
const spec=JSON.parse(fs.readFileSync("invariants.json"));
const ids=spec.invariants.map(v=>v.id);
if(ids.join()!=="T1,T2,T3,T4,T5,T6,T7,T8,T9") throw "ids "+ids;
const overlap=fs.readFileSync("OVERLAP.md","utf8");
const tests=fs.readFileSync("test/security.mjs","utf8");
const src=fs.readFileSync("src/index.ts","utf8").split("\n");
for(const v of spec.invariants){
  if(!overlap.includes("| "+v.id+" ")) throw v.id+" not in OVERLAP.md";
  if(!v.tests.length) throw v.id+" has no tests";
  for(const t of v.tests) if(!tests.includes(t)) throw v.id+" test missing: "+t;
  const line=Number(v.reference.split(":")[1]);
  if(!(line>0&&line<=src.length)) throw v.id+" bad reference "+v.reference;
  if(!v.probes.strong.length) throw v.id+" has no strong probe";
}
const r=JSON.parse(fs.readFileSync("receipts/security.json"));
for(const id of ids) if(!r.results.some(x=>x.id===id&&x.pass)) throw id+" has no passing test";
const kernel=fs.readFileSync("../basic/kernel/invariants.mjs","utf8");
if(!kernel.includes("tenon/invariants.json")) throw "basic/kernel does not read invariants.json";
if(/strong:\s*\[\//.test(kernel)) throw "basic/kernel still has inline probes";
'

echo "8. every gap has a fix with a runnable proof"
for app in coil hark my-ax chat-ax skin; do
  node -e '
const app=process.argv[1];
const r=JSON.parse(require("fs").readFileSync("../basic/reports/kernel-"+app+".json"));
if(r.rows.length!==9) throw app+" rows "+r.rows.length;
for(const row of r.rows){
  const gap=row.verdict==="partial"||row.verdict==="missing";
  if(gap&&!(row.fix&&row.fix.change&&row.fix.reference&&row.fix.proof)) throw app+" "+row.id+" gap without fix";
  if(row.verdict==="n/a"&&!row.note) throw app+" "+row.id+" n/a without reason";
}' "$app"
done
first_proof=$(node -e 'const r=require("../basic/reports/kernel-chat-ax.json");console.log(r.rows.find(x=>x.fix).fix.proof)')
( cd .. && set +e; eval "$first_proof" >/dev/null; code=$?; test "$code" -eq 1 ) || { echo "fix proof does not run or does not fail on an open gap"; exit 1; }
tenon_proof=$(node -e 'const p=require("../basic/reports/kernel-chat-ax.json").rows.find(x=>x.fix).fix.proof;console.log(p.replaceAll("chat-ax","tenon"))')
( cd .. && eval "$tenon_proof" >/dev/null ) || { echo "fix proof does not pass on a rule that holds"; exit 1; }

echo "9. matrix diagram has 45 cells"
node ../basic/diagram.mjs --layer=kernel >/dev/null
cells=$(grep -o 'class="cell"' ../basic/diagrams/kernel-matrix.svg | wc -l | tr -d ' ')
test "$cells" -eq 45 || { echo "matrix has $cells cells"; exit 1; }
cp ../basic/diagrams/kernel-matrix.svg docs/kernel-matrix.svg
grep -q 'docs/kernel-matrix.svg' README.md

echo "10. SKILL.md names the command"
grep -q 'node basic/kernel/run.mjs --app=' SKILL.md
grep -q '^name: tenon' SKILL.md

echo "11. kernel cannot be fooled by comments, and fails closed"
node ../basic/kernel/source.test.mjs
node ../basic/kernel/planted.test.mjs
set +e; node ../basic/kernel/run.mjs --app=coil --root=/nonexistent >/dev/null 2>&1; code=$?; set -e
test "$code" -eq 2 || { echo "missing root exited $code, want 2"; exit 1; }

echo "12. a passing gate leaves basic reports and diagrams unchanged"
dirty=$(git -C ../basic status --porcelain -- reports diagrams)
test -z "$dirty" || { echo "gate changed tracked files:"; echo "$dirty"; exit 1; }

echo "GATE PASS"
