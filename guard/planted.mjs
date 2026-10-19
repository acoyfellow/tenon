import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { blocks, configFromEnv, isGuarded, makeGuard } from './guard.ts';

const TENON = new URL('..', import.meta.url).pathname;
const cases = JSON.parse(readFileSync(new URL('./cases.json', import.meta.url), 'utf8'));
const config = configFromEnv(process.env);
if (!config) {
  console.error('WRITE_JUDGE_ACCOUNT_ID, WRITE_JUDGE_TOKEN and WRITE_JUDGE_MODEL must be set. No mock fallback.');
  process.exit(2);
}

const noRefresh = async () => undefined;
const guard = makeGuard(config, noRefresh);
const results = [];
const callOf = (c) => ({ tool: c.tool ?? 'edit', path: c.path, said: c.said ?? '', pairs: [[c.oldText, c.newText]] });

for (const c of cases.cases) {
  const result = await guard(callOf(c), `${TENON}..`);
  if (result.kind === 'unavailable') {
    console.error(`Clef unavailable on ${c.id}: ${result.error}\n${result.reason}`);
    process.exit(3);
  }
  const got = result.kind === 'skipped' ? 'skipped' : result.kind;
  const weakens = 'weakens' in result ? Number(result.weakens.toFixed(3)) : null;
  results.push({ id: c.id, expect: c.expect, got, weakens, ms: result.ms ?? 0, pass: got === c.expect });
}

const badGuard = makeGuard({ ...config, token: 'bad-token' }, noRefresh);
const bad = await badGuard(callOf(cases.unavailable), `${TENON}..`);
results.push({ id: cases.unavailable.id, expect: 'block', got: bad.kind, pass: blocks(bad) && bad.kind === 'unavailable' });

const skip = cases.outOfScope;
const skipped = !isGuarded(skip.path, `${TENON}..`) && (await guard(callOf(skip), `${TENON}..`)).kind === 'skipped';
results.push({ id: 'out-of-scope', expect: 'skipped', got: skipped ? 'skipped' : 'judged', pass: skipped });

for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'} ${r.id}: expect ${r.expect}, got ${r.got}${r.weakens == null ? '' : ` (p=${r.weakens}, ${r.ms} ms)`}`);
const weakening = results.filter((r) => r.expect === 'block');
const honest = results.filter((r) => r.expect === 'allow');
const summary = {
  blocked: `${weakening.filter((r) => r.pass).length}/${weakening.length}`,
  allowed: `${honest.filter((r) => r.pass).length}/${honest.length}`,
  outOfScopeSkipped: skipped,
};
console.log(`weakening blocked ${summary.blocked}; honest allowed ${summary.allowed}; out-of-scope skipped ${skipped}`);
mkdirSync(new URL('../receipts/', import.meta.url), { recursive: true });
writeFileSync(
  new URL('../receipts/guard.json', import.meta.url),
  JSON.stringify({ frozenAt: [cases.frozenAt, cases.frozenAt2], rule: cases.rule, threshold: 0.5, summary, results: results.map(({ ms, ...rest }) => rest) }, null, 2) + '\n',
);
process.exit(results.every((r) => r.pass) ? 0 : 1);
