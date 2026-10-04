import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [phase, output, resolver] = process.argv.slice(2);
const event = JSON.parse(readFileSync(0, 'utf8'));
let result = {};
if (phase === 'pre' && event.toolName === 'powershell') {
  const command = String(event.toolArgs.command).replace(/`\r?\n/g, ' ');
  const tokens = command.match(/"[^"]*"|'[^']*'|[^\s"']+/g) ?? [];
  const clean = tokens.map((token) => token.replace(/^["']|["']$/g, ''));
  const permitted = !/[;$|&<>`\r\n]/.test(command) && /^\s*node(?:\.exe)?\s/i.test(command)
    && clean.length >= 3 && resolve(clean[1]) === resolve(resolver) && ['resolve', 'show'].includes(clean[2]);
  if (!permitted) result = {
    permissionDecision: 'deny',
    permissionDecisionReason: 'Read-only verification permits only the pstack resolver resolve/show command, without shell operators or variables.',
  };
}
if (phase === 'post' && event.toolName === 'task') {
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, `${randomUUID()}.json`), `${JSON.stringify(event)}\n`, { flag: 'wx' });
}
console.log(JSON.stringify(result));
