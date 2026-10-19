import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { askClef, type ClefConfig } from './vendor/clef.ts';
import { QUESTIONS, stateOf, verdictOf, type WriteCall } from './vendor/judge.ts';
import { wranglerToken } from './vendor/wrangler.ts';

const CLOUDFLARE_ROOT = resolve(new URL('../../', import.meta.url).pathname);

const GUARDED_PREFIXES = ['tenon/test/', 'tenon/guard/', 'tenon/receipts/', 'basic/kernel/'];
const GUARDED_FILES = ['tenon/gate.sh', 'tenon/invariants.json'];

export const REFRESH_HINT =
  'Clef could not be reached, so this edit to a guarded file is blocked. Refresh the token: export WRITE_JUDGE_TOKEN=$(npx wrangler auth token | tail -1), or run npx wrangler login.';

export const relativeToRoot = (path: string, cwd = process.cwd()): string => {
  const absolute = resolve(cwd, path);
  return absolute.startsWith(`${CLOUDFLARE_ROOT}/`) ? absolute.slice(CLOUDFLARE_ROOT.length + 1) : absolute;
};

export const isGuarded = (path: string, cwd?: string): boolean => {
  const relative = relativeToRoot(path, cwd);
  return GUARDED_FILES.includes(relative) || GUARDED_PREFIXES.some((prefix) => relative.startsWith(prefix));
};

export const configFromEnv = (env: Readonly<Record<string, string | undefined>>): ClefConfig | null => {
  const accountId = env.WRITE_JUDGE_ACCOUNT_ID;
  const token = env.WRITE_JUDGE_TOKEN;
  const model = env.WRITE_JUDGE_MODEL;
  return accountId && token && model ? { accountId, token, model } : null;
};

const removedRuns = (before: string, after: string): Array<readonly [string, string]> => {
  const oldLines = before.split('\n');
  const newLines = after.split('\n');
  let head = 0;
  while (head < oldLines.length && head < newLines.length && oldLines[head] === newLines[head]) head++;
  let tail = 0;
  while (tail < oldLines.length - head && tail < newLines.length - head && oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]) tail++;
  const removed = oldLines.slice(head, oldLines.length - tail).join('\n');
  const added = newLines.slice(head, newLines.length - tail).join('\n');
  return removed === '' && added === '' ? [] : [[removed, added] as const];
};

export const asEdit = (call: WriteCall, cwd?: string, readCurrent: (absolute: string) => string | null = (absolute) => (existsSync(absolute) ? readFileSync(absolute, 'utf8') : null)): WriteCall => {
  if (call.tool !== 'write') return call;
  const current = readCurrent(resolve(cwd ?? process.cwd(), call.path));
  if (current === null) return call;
  const pairs = removedRuns(current, call.pairs[0]?.[1] ?? '');
  return pairs.length ? { ...call, pairs } : call;
};

export type TokenSource = () => Promise<string | undefined>;

export type GuardResult =
  | { readonly kind: 'skipped' }
  | { readonly kind: 'allow'; readonly weakens: number; readonly ms: number }
  | { readonly kind: 'block'; readonly weakens: number; readonly ms: number; readonly reason: string }
  | { readonly kind: 'unavailable'; readonly ms: number; readonly reason: string; readonly error: string };

export const makeGuard = (initial: ClefConfig, refresh: TokenSource = wranglerToken) => {
  let config = initial;
  return async (call: WriteCall, cwd?: string): Promise<GuardResult> => {
    if (!isGuarded(call.path, cwd)) return { kind: 'skipped' };
    const started = Date.now();
    const judged = asEdit(call, cwd);
    const ask = (current: ClefConfig) => askClef(fetch, current, stateOf(judged), QUESTIONS);
    let answers;
    try {
      answers = await ask(config);
    } catch (first) {
      const fresh = await refresh();
      if (!fresh || fresh === config.token) return { kind: 'unavailable', ms: Date.now() - started, reason: REFRESH_HINT, error: String(first) };
      try {
        answers = await ask({ ...config, token: fresh });
        config = { ...config, token: fresh };
      } catch (second) {
        return { kind: 'unavailable', ms: Date.now() - started, reason: REFRESH_HINT, error: String(second) };
      }
    }
    const verdict = verdictOf(answers.weakens ?? 0);
    const ms = Date.now() - started;
    return verdict.kind === 'block' ? { kind: 'block', weakens: verdict.weakens, ms, reason: verdict.reason } : { kind: 'allow', weakens: verdict.weakens, ms };
  };
};

export const blocks = (result: GuardResult): boolean => result.kind === 'block' || result.kind === 'unavailable';
