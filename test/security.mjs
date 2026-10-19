import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';

const PORT = Number(process.env.PORT ?? 8711);
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = randomBytes(32).toString('hex');
const TOKEN = `tok_${randomBytes(12).toString('hex')}`;

export const boot = async ({ payer = 'user' } = {}) => {
  const child = spawn(
    'npx',
    ['wrangler', 'dev', '--port', String(PORT), '--inspector-port', String(PORT + 1000), '--ip', '127.0.0.1', '--var', `SESSION_SECRET:${SECRET}`, '--var', 'TENON_DEV_LOGIN:1', '--var', `TENON_PAYER:${payer}`],
    { cwd: new URL('..', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } },
  );
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${BASE}/robots.txt`)).ok) return { child, log: () => log };
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill();
  throw new Error(`wrangler dev did not start:\n${log.slice(-2000)}`);
};

export const login = async (owner) => {
  const r = await fetch(`${BASE}/dev/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ owner }) });
  return r.headers.get('set-cookie').split(';')[0];
};

const call = (cookie, path, init = {}) =>
  fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...(cookie ? { cookie } : {}), origin: BASE, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });

const results = [];
const check = async (id, name, fn) => {
  try {
    await fn();
    results.push({ id, name, pass: true });
  } catch (e) {
    results.push({ id, name, pass: false, detail: String(e.message ?? e) });
  }
};
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

const GOOD_APP = `export default { fetch() { return new Response('<h1>v-good</h1>', { headers: { 'content-type': 'text/html' } }); } };`;
const GOOD_APP_2 = `export default { fetch() { return new Response('<h1>v-two</h1>', { headers: { 'content-type': 'text/html' } }); } };`;
const BROKEN_APP = `export default { fetch() { return new Response('nope', { status: 500 }); } };`;

const { child, log } = await boot();
try {
  const alice = await login('alice');
  const bob = await login('bob');

  await check('T9', 'public pages load without sign-in', async () => {
    for (const p of ['/', '/llms.txt', '/robots.txt']) assert((await fetch(BASE + p)).status === 200, `${p} not 200`);
  });
  await check('T1', 'anonymous API calls are refused', async () => {
    for (const p of ['/api/notes', '/api/versions', '/api/payer', '/app/']) assert((await fetch(BASE + p)).status === 401, `${p} not 401`);
  });
  await check('T1', 'forged and tampered sessions are refused', async () => {
    const forged = `tenon_session=alice.${Date.now() + 1e9}.AAAA`;
    assert((await call(forged, '/api/notes')).status === 401, 'forged accepted');
    const tampered = alice.replace('alice.', 'bob.');
    assert((await call(tampered, '/api/notes')).status === 401, 'tampered accepted');
  });
  await check('T1', 'an Access header without configured Access is refused', async () => {
    const r = await fetch(`${BASE}/api/notes`, { headers: { 'cf-access-jwt-assertion': 'a.b.c' } });
    assert(r.status === 401, `got ${r.status}`);
  });
  await check('T2', 'state survives and is keyed by owner', async () => {
    assert((await call(alice, '/api/notes', { method: 'POST', body: JSON.stringify({ text: 'alice secret note' }) })).status === 201, 'write failed');
    const mine = await (await call(alice, '/api/notes')).json();
    assert(mine.some((n) => n.text === 'alice secret note'), 'alice cannot read own note');
  });
  await check('T2', 'one owner cannot read another owner', async () => {
    const theirs = await (await call(bob, '/api/notes')).json();
    assert(!JSON.stringify(theirs).includes('alice secret note'), 'bob saw alice note');
    const spoof = await (await call(bob, '/api/notes?owner=alice', { headers: { 'x-owner': 'alice' } })).json();
    assert(!JSON.stringify(spoof).includes('alice secret note'), 'owner spoof worked');
  });
  await check('T5', 'cross-origin writes are refused', async () => {
    const r = await call(alice, '/api/notes', { method: 'POST', body: '{"text":"x"}', headers: { origin: 'https://evil.example' } });
    assert(r.status === 403, `got ${r.status}`);
  });
  await check('T3', 'user payer with no grant fails instead of using host inference', async () => {
    const r = await call(bob, '/api/payer');
    const b = await r.json();
    assert(r.status === 409 && b.error === 'no_user_grant', JSON.stringify(b));
  });
  await check('T3', 'user payer with a grant routes to the user account', async () => {
    await call(alice, '/api/grant', { method: 'PUT', body: JSON.stringify({ accountId: 'acct_alice', token: TOKEN }) });
    const b = await (await call(alice, '/api/payer')).json();
    assert(b.route?.via === 'user' && b.route.accountId === 'acct_alice', JSON.stringify(b));
  });
  await check('T4', 'the grant token never appears in any response', async () => {
    for (const p of ['/api/payer', '/api/notes', '/api/versions']) {
      const t = await (await call(alice, p)).text();
      assert(!t.includes(TOKEN), `token leaked by ${p}`);
    }
    assert(!log().includes(TOKEN), 'token leaked into the server log');
  });
  await check('T8', 'a broken version is rejected and never goes live', async () => {
    const ok = await (await call(alice, '/api/versions', { method: 'POST', body: JSON.stringify({ source: GOOD_APP, note: 'first' }) })).json();
    assert(ok.status === 'live', `good version: ${JSON.stringify(ok)}`);
    const bad = await call(alice, '/api/versions', { method: 'POST', body: JSON.stringify({ source: BROKEN_APP, note: 'broken' }) });
    assert(bad.status === 422, `broken got ${bad.status}`);
    const page = await (await call(alice, '/app/')).text();
    assert(page.includes('v-good'), `live page changed: ${page}`);
  });
  await check('T8', 'rollback appends; history is never rewritten', async () => {
    await call(alice, '/api/versions', { method: 'POST', body: JSON.stringify({ source: GOOD_APP_2, note: 'second' }) });
    const before = (await (await call(alice, '/api/versions')).json()).versions;
    const first = before.find((v) => v.note === 'first');
    const rb = await call(alice, `/api/versions/${first.id}/rollback`, { method: 'POST' });
    assert(rb.status === 201, `rollback ${rb.status}`);
    const after = (await (await call(alice, '/api/versions')).json()).versions;
    assert(after.length === before.length + 1, 'rollback did not append');
    for (const v of before) assert(after.some((a) => a.id === v.id && a.tree_hash === v.tree_hash), `version ${v.id} rewritten`);
    assert((await (await call(alice, '/app/')).text()).includes('v-good'), 'rollback did not restore');
    const rejected = before.find((v) => v.status === 'rejected');
    assert((await call(alice, `/api/versions/${rejected.id}/rollback`, { method: 'POST' })).status === 409, 'rolled back to a rejected version');
  });
  await check('T8', 'versions are per owner', async () => {
    const b = await (await call(bob, '/api/versions')).json();
    assert(b.versions.length === 0 && b.live === null, 'bob sees alice versions');
  });
  await check('T6', 'owner code has no network', async () => {
    const r = await (await call(alice, '/api/runs', { method: 'POST', body: JSON.stringify({ code: "const r = await fetch('https://example.com'); return r.status;" }) })).json();
    let row;
    for (let i = 0; i < 40; i++) {
      row = await (await call(alice, `/api/runs/${r.id}`)).json();
      if (row.status !== 'running') break;
      await new Promise((res) => setTimeout(res, 250));
    }
    assert(row.status === 'failed', `network call was allowed: ${JSON.stringify(row)}`);
  });
  await check('T7', 'a run is visible, finishes truthfully, and a stop sticks', async () => {
    const r = await (await call(alice, '/api/runs', { method: 'POST', body: JSON.stringify({ code: 'return 6 * 7;' }) })).json();
    assert(r.status === 'running', 'not visible as running');
    let row;
    for (let i = 0; i < 40; i++) {
      row = await (await call(alice, `/api/runs/${r.id}`)).json();
      if (row.status !== 'running') break;
      await new Promise((res) => setTimeout(res, 250));
    }
    assert(row.status === 'done' && row.result === '42', JSON.stringify(row));
    const slow = await (await call(alice, '/api/runs', { method: 'POST', body: JSON.stringify({ code: 'await new Promise(r => setTimeout(r, 3000)); return 1;' }) })).json();
    const stopped = await (await call(alice, `/api/runs/${slow.id}/stop`, { method: 'POST' })).json();
    assert(stopped.status === 'stopped', JSON.stringify(stopped));
    await new Promise((res) => setTimeout(res, 3500));
    const later = await (await call(alice, `/api/runs/${slow.id}`)).json();
    assert(later.status === 'stopped', `stop was overwritten: ${later.status}`);
    assert((await call(bob, `/api/runs/${slow.id}`)).status === 404, 'bob can see alice run');
  });
} finally {
  child.kill();
}

const passed = results.filter((r) => r.pass).length;
for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'} ${r.id} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
console.log(`${passed}/${results.length} passed`);
mkdirSync(new URL('../receipts', import.meta.url), { recursive: true });
writeFileSync(new URL('../receipts/security.json', import.meta.url), JSON.stringify({ at: new Date().toISOString(), passed, total: results.length, results }, null, 2));
process.exit(passed === results.length ? 0 : 1);
