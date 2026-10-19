import { type ExtensionAPI, type ToolCallEvent, isToolCallEventType } from '@earendil-works/pi-coding-agent';
import { blocks, configFromEnv, isGuarded, makeGuard, REFRESH_HINT } from './guard.ts';
import type { WriteCall } from './vendor/judge.ts';

const callOf = (event: ToolCallEvent): WriteCall | null => {
  if (isToolCallEventType('edit', event)) {
    return { tool: 'edit', path: event.input.path, said: '', pairs: event.input.edits.map((edit) => [edit.oldText, edit.newText] as const) };
  }
  if (isToolCallEventType('write', event)) {
    return { tool: 'write', path: event.input.path, said: '', pairs: [['', event.input.content] as const] };
  }
  return null;
};

export default function tenonGuard(pi: ExtensionAPI) {
  const config = configFromEnv(process.env);
  const guard = config ? makeGuard(config) : null;

  pi.on('tool_call', async (event, ctx) => {
    const call = callOf(event);
    if (!call || !isGuarded(call.path, ctx.cwd)) return undefined;
    if (!guard) return { block: true, reason: `tenon guard: WRITE_JUDGE_ACCOUNT_ID, WRITE_JUDGE_TOKEN and WRITE_JUDGE_MODEL are not set. ${REFRESH_HINT}` };
    const result = await guard(call, ctx.cwd);
    if (!blocks(result)) return undefined;
    return { block: true, reason: `tenon guard: ${'reason' in result ? result.reason : REFRESH_HINT}` };
  });
}
