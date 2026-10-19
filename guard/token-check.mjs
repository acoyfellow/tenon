import { configFromEnv } from './guard.ts';
import { askClef } from './vendor/clef.ts';

const REFRESH = 'Refresh your token: export WRITE_JUDGE_TOKEN=$(npx wrangler auth token | tail -1), or run npx wrangler login.';
const config = configFromEnv(process.env);
if (!config) {
  console.error(`WRITE_JUDGE_ACCOUNT_ID, WRITE_JUDGE_TOKEN and WRITE_JUDGE_MODEL must be set. ${REFRESH}`);
  process.exit(3);
}
try {
  await askClef(fetch, config, 'File: probe\n\nChange 1 removes:\n(nothing)\n\nChange 1 adds:\nok', { weakens: { type: 'noul', instructions: 'Does the change delete or weaken a test?' } });
  console.log('Clef token ok');
} catch (error) {
  console.error(`Clef rejected the token (${String(error).slice(0, 120)}). ${REFRESH}`);
  process.exit(3);
}
