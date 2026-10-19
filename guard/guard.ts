import { askClef, type ClefConfig } from '../../write-judge/src/clef.ts';
import { QUESTIONS, stateOf, verdictOf, type Verdict, type WriteCall } from '../../write-judge/src/judge.ts';

const CLOUDFLARE_ROOT = new URL('../../', import.meta.url).pathname;

const GUARDED_PREFIXES = ['tenon/test/', 'basic/kernel/'];
const GUARDED_FILES = ['tenon/gate.sh'];

export const relativeToRoot = (path: string): string =>
  path.startsWith(CLOUDFLARE_ROOT) ? path.slice(CLOUDFLARE_ROOT.length) : path.replace(/^[.]?[/]/, '');

export const isGuarded = (path: string): boolean => {
  const relative = relativeToRoot(path);
  return GUARDED_FILES.includes(relative) || GUARDED_PREFIXES.some((prefix) => relative.startsWith(prefix));
};

export const configFromEnv = (env: Readonly<Record<string, string | undefined>>): ClefConfig | null => {
  const accountId = env.WRITE_JUDGE_ACCOUNT_ID;
  const token = env.WRITE_JUDGE_TOKEN;
  const model = env.WRITE_JUDGE_MODEL;
  return accountId && token && model ? { accountId, token, model } : null;
};

export type GuardResult = { readonly judged: false } | { readonly judged: true; readonly verdict: Verdict; readonly ms: number };

export const guard = async (config: ClefConfig, call: WriteCall): Promise<GuardResult> => {
  if (!isGuarded(call.path)) return { judged: false };
  const started = Date.now();
  const answers = await askClef(fetch, config, stateOf(call), QUESTIONS);
  return { judged: true, verdict: verdictOf(answers.weakens ?? 0), ms: Date.now() - started };
};
