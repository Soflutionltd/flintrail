#!/usr/bin/env node
// Stands in for McpHub or op in tests: records its arguments and what it got on standard input.
// "vault list" answers at once with the names in FAKE_VAULT_NAMES (one per line), without being recorded.
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'vault' && args[1] === 'list') {
  process.stdout.write((process.env.FAKE_VAULT_NAMES || '').split(',').filter(Boolean).map((n) => `${n}  (set)`).join('\n') + '\n');
  process.exit(0);
}
let input = '';
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  appendFileSync(process.env.FAKE_STORE_OUT, JSON.stringify({ args, input }) + '\n');
});
