import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { configFromEnv, guard, isGuarded } from './guard.ts';

const cases = JSON.parse(readFileSync(new URL('./cases.json', import.meta.url), 'utf8'));
const config = configFromEnv(process.env);
if (!config) {
  console.error('WRITE_JUDGE_ACCOUNT_ID, WRITE_JUDGE_TOKEN and WRITE_JUDGE_MODEL must be set. No mock fallback.');
  process.exit(2);
}

const results = [];
for (const c of cases.cases) {
  const result = await guard(config, { tool: 'edit', path: c.path, said: c.said, pairs: [[c.oldText, c.newText]] });
  const got = result.judged ? result.verdict.kind : 'skipped';
  const weakens = result.judged ? Number(result.verdict.weakens.toFixed(3)) : null;
  results.push({ id: c.id, expect: c.expect, got, weakens, ms: result.judged ? result.ms : 0, pass: got === c.expect });
}
const skip = cases.outOfScope;
const skipped = !isGuarded(skip.path) && !(await guard(config, { tool: 'edit', path: skip.path, said: '', pairs: [[skip.oldText, skip.newText]] })).judged;
results.push({ id: 'out-of-scope', expect: 'skipped', got: skipped ? 'skipped' : 'judged', pass: skipped });

for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'} ${r.id}: expect ${r.expect}, got ${r.got}${r.weakens === null || r.weakens === undefined ? '' : ` (p=${r.weakens}, ${r.ms} ms)`}`);
const weakening = results.filter((r) => r.expect === 'block');
const honest = results.filter((r) => r.expect === 'allow');
const summary = {
  blocked: `${weakening.filter((r) => r.pass).length}/${weakening.length}`,
  allowed: `${honest.filter((r) => r.pass).length}/${honest.length}`,
  outOfScopeSkipped: skipped,
};
console.log(`weakening blocked ${summary.blocked}; honest allowed ${summary.allowed}; out-of-scope skipped ${skipped}`);
mkdirSync(new URL('../receipts/', import.meta.url), { recursive: true });
writeFileSync(new URL('../receipts/guard.json', import.meta.url), JSON.stringify({ frozenAt: cases.frozenAt, rule: cases.rule, threshold: 0.5, summary, results }, null, 2) + '\n');
process.exit(results.every((r) => r.pass) ? 0 : 1);
