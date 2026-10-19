import { type ExtensionAPI, isToolCallEventType } from '@earendil-works/pi-coding-agent';
import { configFromEnv, guard } from './guard.ts';

export default function tenonGuard(pi: ExtensionAPI) {
  const config = configFromEnv(process.env);
  if (!config) return;

  pi.on('tool_call', async (event) => {
    const call = isToolCallEventType('edit', event)
      ? { tool: 'edit' as const, path: event.input.path, said: '', pairs: event.input.edits.map((edit) => [edit.oldText, edit.newText] as const) }
      : isToolCallEventType('write', event)
        ? { tool: 'write' as const, path: event.input.path, said: '', pairs: [['', event.input.content] as const] }
        : null;
    if (!call) return undefined;
    const result = await guard(config, call);
    return result.judged && result.verdict.kind === 'block' ? { block: true, reason: `tenon guard: ${result.verdict.reason}` } : undefined;
  });
}
