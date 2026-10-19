import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../basic/package.json', import.meta.url));
const { chromium } = require('playwright');

const PORT = 8712;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = new URL('..', import.meta.url).pathname;
const child = spawn(
  'npx',
  ['wrangler', 'dev', '--port', String(PORT), '--inspector-port', String(PORT + 1000), '--ip', '127.0.0.1',
    '--var', `SESSION_SECRET:${randomBytes(32).toString('hex')}`, '--var', 'TENON_DEV_LOGIN:1', '--var', 'TENON_PAYER:user'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } },
);
const steps = [];
const step = (name, detail) => {
  steps.push({ name, ...detail });
  console.log(`- ${name}${detail?.status ? ` → ${detail.status}` : ''}`);
};

try {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${BASE}/robots.txt`)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  const anon = await fetch(`${BASE}/console`);
  step('anonymous visitor is refused', { status: anon.status });

  const login = await fetch(`${BASE}/dev/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"owner":"jordan"}' });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const api = async (path, body) => {
    const r = await fetch(BASE + path, { method: body === undefined ? 'GET' : 'POST', headers: { cookie, origin: BASE, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  await fetch(`${BASE}/api/grant`, { method: 'PUT', headers: { cookie, origin: BASE, 'content-type': 'application/json' }, body: JSON.stringify({ accountId: 'acct-demo', token: randomBytes(16).toString('hex') }) });
  step('owner connects their own account as the payer', {});

  const app = (title) => `export default { fetch() { return new Response('<h1>${title}</h1>', { headers: { 'content-type': 'text/html' } }); } };`;
  step('agent ships version 1', await api('/api/versions', { source: app('hello v1'), note: 'first app' }));
  step('agent ships a broken version; the gate rejects it', await api('/api/versions', { source: "export default { fetch() { throw new Error('boom') } }", note: 'broken change' }));
  step('agent ships version 2', await api('/api/versions', { source: app('hello v2'), note: 'nicer heading' }));
  step('owner rolls back to version 1 (appends, never rewrites)', await api('/api/versions/1/rollback', {}));

  const run = await api('/api/runs', { code: 'return [1,2,3].map(x => x * 14).reduce((a, b) => a + b);' });
  const net = await api('/api/runs', { code: "return (await fetch('https://example.com')).status;" });
  await new Promise((r) => setTimeout(r, 1500));
  step('agent code runs in an isolate', await api(`/api/runs/${run.body.id}`));
  step('agent code tries the network and is blocked', await api(`/api/runs/${net.body.id}`));

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 760 } });
  const [name, value] = cookie.split('=');
  await ctx.addCookies([{ name, value, url: BASE }]);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/console`);
  mkdirSync(`${ROOT}receipts`, { recursive: true });
  await page.screenshot({ path: `${ROOT}receipts/demo.png`, fullPage: true });
  await browser.close();
  step('console screenshot saved', { path: 'receipts/demo.png' });
  writeFileSync(`${ROOT}receipts/demo.json`, JSON.stringify({ at: new Date().toISOString(), base: BASE, steps }, null, 2));
} finally {
  child.kill();
}
