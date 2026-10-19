import { DurableObject } from 'cloudflare:workers';


type Loader = {
  get(id: string, code: () => Record<string, unknown>): { getEntrypoint(): { fetch(r: Request): Promise<Response> } };
};

export interface Env {
  OWNER: DurableObjectNamespace<Owner>;
  LOADER: Loader;
  AI?: unknown;
  SESSION_SECRET?: string;
  TENON_PAYER: 'user' | 'host' | 'none' | string;
  TENON_DEV_LOGIN: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
  });

const PUBLIC = new Map<string, string>([
  ['/', '<!doctype html><title>tenon</title><h1>tenon</h1><p>Sign in to continue.</p>'],
  ['/llms.txt', 'tenon: owner-keyed agent core. All /api routes need a session.\n'],
  ['/robots.txt', 'User-agent: *\nAllow: /\n'],
]);


const enc = new TextEncoder();
const b64u = (bytes: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

const hmac = async (secret: string, data: string) => {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
};

const OWNER_RE = /^[a-z0-9._@-]{1,64}$/;

export const signSession = async (secret: string, owner: string, now = Date.now()) => {
  const body = `${owner}.${now + 30 * 86400_000}`;
  return `${body}.${await hmac(secret, body)}`;
};

export const readSession = async (secret: string | undefined, cookie: string | null, now = Date.now()) => {
  if (!secret || secret.length < 32 || !cookie) return null;
  const raw = cookie.split(';').map((c) => c.trim()).find((c) => c.startsWith('tenon_session='))?.slice(14);
  if (!raw) return null;
  const parts = raw.split('.');
  const mac = parts.pop();
  const expires = Number(parts.at(-1));
  const owner = parts.slice(0, -1).join('.');
  if (!mac || !OWNER_RE.test(owner) || !(expires > now)) return null;
  const want = await hmac(secret, `${owner}.${expires}`);
  if (want.length !== mac.length) return null;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ mac.charCodeAt(i);
  return diff === 0 ? owner : null;
};

const readAccess = async (env: Env, token: string | null): Promise<string | null> => {
  if (!token || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null;
  const [h, p, s] = token.split('.');
  if (!h || !p || !s) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(unb64u(h)));
    const claims = JSON.parse(new TextDecoder().decode(unb64u(p)));
    const certs = (await (await fetch(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`)).json()) as {
      keys: (JsonWebKey & { kid: string })[];
    };
    const jwk = certs.keys.find((k) => k.kid === header.kid);
    if (!jwk || header.alg !== 'RS256') return null;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, unb64u(s), enc.encode(`${h}.${p}`));
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!ok || !aud.includes(env.ACCESS_AUD) || !(claims.exp * 1000 > Date.now())) return null;
    const email = String(claims.email ?? '').toLowerCase();
    return OWNER_RE.test(email) ? email : null;
  } catch {
    return null;
  }
};

const identify = async (env: Env, req: Request) =>
  (await readAccess(env, req.headers.get('cf-access-jwt-assertion'))) ??
  (await readSession(env.SESSION_SECRET, req.headers.get('cookie')));


export type Grant = { accountId: string; token: string } | null;

export const modelRoute = (payer: string, grant: Grant): { via: 'user'; accountId: string } | { via: 'host' } => {
  if (payer === 'user') {
    if (!grant || !grant.accountId) throw new Error('no_user_grant');
    return { via: 'user', accountId: grant.accountId };
  }
  if (payer === 'host') return { via: 'host' };
  throw new Error('no_payer');
};


export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const page = PUBLIC.get(url.pathname);
    if (page && req.method === 'GET') {
      return new Response(page, { headers: { 'content-type': url.pathname === '/' ? 'text/html' : 'text/plain' } });
    }

    if (url.pathname === '/dev/login' && req.method === 'POST') {
      if (env.TENON_DEV_LOGIN !== '1' || !env.SESSION_SECRET || env.SESSION_SECRET.length < 32) return json({ error: 'not_found' }, 404);
      const { owner } = (await req.json()) as { owner?: string };
      if (!owner || !OWNER_RE.test(owner)) return json({ error: 'bad_owner' }, 400);
      const cookie = await signSession(env.SESSION_SECRET, owner);
      const secure = url.protocol === 'https:' ? '; Secure' : '';
      return new Response(null, {
        status: 204,
        headers: { 'set-cookie': `tenon_session=${cookie}; HttpOnly; SameSite=Strict; Path=/${secure}` },
      });
    }

    const owner = await identify(env, req);
    if (!owner) return json({ error: 'sign_in_required' }, 401);

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.get('origin');
      if (origin !== url.origin) return json({ error: 'cross_origin_write' }, 403);
    }

    const stub = env.OWNER.get(env.OWNER.idFromName(owner));
    const inner = new Request(`https://owner${url.pathname}${url.search}`, req);
    inner.headers.set('x-tenon-owner', owner);
    return stub.fetch(inner);
  },
};


type Version = { id: number; parent: number | null; tree_hash: string; status: string; note: string; created_at: number };

export class Owner extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, text TEXT NOT NULL, at INTEGER NOT NULL)');
    this.sql.exec(
      'CREATE TABLE IF NOT EXISTS versions (id INTEGER PRIMARY KEY, parent INTEGER, source TEXT NOT NULL, tree_hash TEXT NOT NULL, status TEXT NOT NULL, note TEXT NOT NULL, created_at INTEGER NOT NULL)',
    );
    this.sql.exec(
      'CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY, status TEXT NOT NULL, result TEXT, started_at INTEGER NOT NULL, ended_at INTEGER)',
    );
    this.sql.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS grant_store (k INTEGER PRIMARY KEY CHECK (k = 1), account_id TEXT NOT NULL, token TEXT NOT NULL)');
    this.sql.exec("UPDATE runs SET status = 'interrupted', ended_at = ? WHERE status = 'running'", Date.now());
  }

  private one<T>(q: string, ...a: unknown[]): T | undefined {
    return this.sql.exec(q, ...a).toArray()[0] as T | undefined;
  }

  private live(): number | null {
    const row = this.one<{ value: string }>("SELECT value FROM meta WHERE key = 'live'");
    return row ? Number(row.value) : null;
  }

  private grant(): Grant {
    const row = this.one<{ account_id: string; token: string }>('SELECT account_id, token FROM grant_store WHERE k = 1');
    return row ? { accountId: row.account_id, token: row.token } : null;
  }

  private isolate(key: string, source: string) {
    return this.env.LOADER.get(key, () => ({
      compatibilityDate: '2026-09-30',
      mainModule: 'main.js',
      modules: { 'main.js': source },
      globalOutbound: null,
      env: {},
    }));
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;
    const m = req.method;

    if (p === '/api/notes' && m === 'GET') return json(this.sql.exec('SELECT id, text, at FROM notes ORDER BY id').toArray());
    if (p === '/api/notes' && m === 'POST') {
      const { text } = (await req.json()) as { text?: string };
      if (typeof text !== 'string' || text.length === 0 || text.length > 4000) return json({ error: 'bad_text' }, 400);
      this.sql.exec('INSERT INTO notes (text, at) VALUES (?, ?)', text, Date.now());
      return json({ ok: true }, 201);
    }

    if (p === '/api/grant' && m === 'PUT') {
      const { accountId, token } = (await req.json()) as { accountId?: string; token?: string };
      if (!accountId || !token) return json({ error: 'bad_grant' }, 400);
      this.sql.exec('INSERT OR REPLACE INTO grant_store (k, account_id, token) VALUES (1, ?, ?)', accountId, token);
      return json({ ok: true });
    }
    if (p === '/api/payer' && m === 'GET') {
      try {
        return json({ payer: this.env.TENON_PAYER, route: modelRoute(this.env.TENON_PAYER, this.grant()) });
      } catch (e) {
        return json({ payer: this.env.TENON_PAYER, error: (e as Error).message }, 409);
      }
    }

    if (p === '/api/versions' && m === 'GET') {
      return json({
        live: this.live(),
        versions: this.sql.exec('SELECT id, parent, tree_hash, status, note, created_at FROM versions ORDER BY id').toArray() as Version[],
      });
    }
    if (p === '/api/versions' && m === 'POST') {
      const { source, note } = (await req.json()) as { source?: string; note?: string };
      if (typeof source !== 'string' || source.length > 64_000) return json({ error: 'bad_source' }, 400);
      const hash = b64u(await crypto.subtle.digest('SHA-256', enc.encode(source)));
      const parent = this.live();
      const id = Number(
        this.one<{ id: number }>(
          "INSERT INTO versions (parent, source, tree_hash, status, note, created_at) VALUES (?, ?, ?, 'building', ?, ?) RETURNING id",
          parent, source, hash, String(note ?? ''), Date.now(),
        )!.id,
      );
      let status = 'rejected';
      let why = '';
      try {
        const res = await this.isolate(`v-${hash}`, source).getEntrypoint().fetch(new Request('https://app/'));
        if (res.status === 200) status = 'live';
        else why = `GET / returned ${res.status}`;
      } catch (e) {
        why = (e as Error).message.slice(0, 300);
      }
      if (status === 'live') {
        if (parent !== null) this.sql.exec("UPDATE versions SET status = 'retired' WHERE id = ?", parent);
        this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('live', ?)", String(id));
      }
      this.sql.exec('UPDATE versions SET status = ?, note = CASE WHEN ? = \'\' THEN note ELSE ? END WHERE id = ?', status, why, why, id);
      return json({ id, status, why }, status === 'live' ? 201 : 422);
    }
    const rb = p.match(/^\/api\/versions\/(\d+)\/rollback$/);
    if (rb && m === 'POST') {
      const target = this.one<{ source: string; tree_hash: string; status: string }>('SELECT source, tree_hash, status FROM versions WHERE id = ?', Number(rb[1]));
      if (!target) return json({ error: 'no_such_version' }, 404);
      if (target.status === 'rejected' || target.status === 'building') return json({ error: 'never_passed_gate' }, 409);
      const parent = this.live();
      const id = Number(
        this.one<{ id: number }>(
          "INSERT INTO versions (parent, source, tree_hash, status, note, created_at) VALUES (?, ?, ?, 'live', ?, ?) RETURNING id",
          parent, target.source, target.tree_hash, `roll back to ${rb[1]}`, Date.now(),
        )!.id,
      );
      if (parent !== null) this.sql.exec("UPDATE versions SET status = 'retired' WHERE id = ?", parent);
      this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('live', ?)", String(id));
      return json({ id, status: 'live' }, 201);
    }
    if (p.startsWith('/app') && m === 'GET') {
      const live = this.live();
      if (live === null) return json({ error: 'no_live_version' }, 404);
      const v = this.one<{ source: string; tree_hash: string }>('SELECT source, tree_hash FROM versions WHERE id = ?', live)!;
      const res = await this.isolate(`v-${v.tree_hash}`, v.source).getEntrypoint().fetch(new Request(`https://app${p.slice(4) || '/'}`));
      const out = new Response(res.body, res);
      out.headers.set('x-tenon-version', String(live));
      out.headers.set('content-security-policy', "default-src 'self'; script-src 'none'");
      return out;
    }

    if (p === '/console' && m === 'GET') {
      const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
      const owner = esc(req.headers.get('x-tenon-owner'));
      let payer: string;
      try {
        const r = modelRoute(this.env.TENON_PAYER, this.grant());
        payer = r.via === 'user' ? `user account ${esc(r.accountId)}` : 'host';
      } catch (e) {
        payer = `blocked: ${esc((e as Error).message)}`;
      }
      const live = this.live();
      const versions = this.sql.exec('SELECT id, status, note, tree_hash FROM versions ORDER BY id DESC').toArray();
      const runs = this.sql.exec('SELECT id, status, result FROM runs ORDER BY id DESC LIMIT 10').toArray();
      const row = (cells: unknown[]) => `<tr>${cells.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`;
      const html = `<!doctype html><meta charset=utf-8><title>tenon console</title><style>body{font:15px system-ui;margin:32px;max-width:900px;color:#1d1d1f}h1{font-size:22px}table{border-collapse:collapse;width:100%;margin:8px 0 24px}td,th{border-bottom:1px solid #ddd;padding:6px 8px;text-align:left}.k{color:#666}</style>
<h1>tenon console</h1><p><span class=k>owner</span> ${owner} · <span class=k>pays</span> ${payer} · <span class=k>live version</span> ${live ?? 'none'}</p>
<h2>Versions (append-only, gated)</h2><table><tr><th>id</th><th>status</th><th>note</th><th>tree</th></tr>${versions.map((v) => row([v.id, v.status, v.note, String(v.tree_hash).slice(0, 12)])).join('')}</table>
<h2>Runs (isolate, no network)</h2><table><tr><th>id</th><th>status</th><th>result</th></tr>${runs.map((r) => row([r.id, r.status, r.result])).join('')}</table>`;
      return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" } });
    }

    if (p === '/api/runs' && m === 'POST') {
      const { code } = (await req.json()) as { code?: string };
      if (typeof code !== 'string' || code.length > 16_000) return json({ error: 'bad_code' }, 400);
      const id = Number(this.one<{ id: number }>("INSERT INTO runs (status, started_at) VALUES ('running', ?) RETURNING id", Date.now())!.id);
      const module = `export default { async fetch() { try { const value = await (async () => { ${code} })(); return Response.json({ ok: true, value: value ?? null }); } catch (e) { return Response.json({ ok: false, error: String(e && e.message || e) }); } } };`;
      const work = (async () => {
        let status = 'failed';
        let result = '';
        try {
          const r = (await (await this.isolate(`run-${id}-${crypto.randomUUID()}`, module).getEntrypoint().fetch(new Request('https://run/'))).json()) as {
            ok: boolean; value?: unknown; error?: string;
          };
          status = r.ok ? 'done' : 'failed';
          result = JSON.stringify(r.ok ? r.value : r.error).slice(0, 4000);
        } catch (e) {
          result = JSON.stringify((e as Error).message);
        }
        this.sql.exec("UPDATE runs SET status = ?, result = ?, ended_at = ? WHERE id = ? AND status = 'running'", status, result, Date.now(), id);
      })();
      this.ctx.waitUntil(work);
      return json({ id, status: 'running' }, 202);
    }
    const run = p.match(/^\/api\/runs\/(\d+)(\/stop)?$/);
    if (run && m === 'GET' && !run[2]) {
      const row = this.one('SELECT id, status, result, started_at, ended_at FROM runs WHERE id = ?', Number(run[1]));
      return row ? json(row) : json({ error: 'no_such_run' }, 404);
    }
    if (run && run[2] && m === 'POST') {
      this.sql.exec("UPDATE runs SET status = 'stopped', ended_at = ? WHERE id = ? AND status = 'running'", Date.now(), Number(run[1]));
      return json(this.one('SELECT id, status FROM runs WHERE id = ?', Number(run[1])) ?? { error: 'no_such_run' });
    }

    return json({ error: 'not_found' }, 404);
  }
}
