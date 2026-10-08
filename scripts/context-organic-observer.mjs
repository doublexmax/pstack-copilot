import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function checkOperation(event, { project, home, writable, model }) {
  const args = event.toolArgs;
  const writablePath = (path) => typeof path === 'string'
    && writable.includes(resolve(project, path));
  if (event.toolName === 'task') {
    if (args.model && args.model !== model) return 'Only the configured project model is available.';
    if (args.reasoning_effort && args.reasoning_effort !== 'max') return 'Use the configured maximum reasoning effort.';
  }
  if (['apply_patch', 'write', 'edit', 'create'].includes(event.toolName)) {
    if (event.toolName !== 'apply_patch') {
      return writablePath(args.path) ? null : 'Writes are restricted to the requested project file.';
    }
    const patch = typeof args === 'string' ? args
      : Object.values(args).filter((value) => typeof value === 'string').join('\n');
    const paths = [...patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)];
    return paths.length > 0 && paths.every((match) => writablePath(match[1].trim()))
      ? null : 'Patch paths are restricted to the requested project file.';
  }
  if (event.toolName !== 'powershell') return null;
  const command = String(args.command).replace(/`\r?\n/g, ' ').trim();
  const tokens = command.match(/"[^"]*"|'[^']*'|[^\s"']+/g) ?? [];
  const clean = tokens.map((token) => token.replace(/^["']|["']$/g, ''));
  if (/[;$|&<>`\r\n]/.test(command) || !['node', 'node.exe'].includes(basename(clean[0] ?? '').toLowerCase())) {
    return 'Shell commands are restricted to the project entry point and the context resolver.';
  }
  const file = resolve(project, clean[1] ?? '');
  const resolver = resolve(home, 'pstack', 'scripts', 'context-routing.mjs');
  if (file === resolver && ['resolve', 'show'].includes(clean[2])) return null;
  if (clean.length === 2 && file === resolve(project, 'src', 'receipts.mjs')) return null;
  return 'Shell commands are restricted to the project entry point and the context resolver.';
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [phase, project, home, model, ...paths] = process.argv.slice(2);
  const event = JSON.parse(readFileSync(0, 'utf8'));
  const output = join(home, 'operation-records');
  mkdirSync(output, { recursive: true });
  const reason = phase === 'pre'
    ? checkOperation(event, { project, home, model, writable: paths.map((path) => resolve(project, path)) }) : null;
  writeFileSync(join(output, `${phase}-${randomUUID()}.json`),
    `${JSON.stringify({ ...event, boundaryDenial: reason })}\n`, { flag: 'wx' });
  console.log(JSON.stringify(reason ? { permissionDecision: 'deny', permissionDecisionReason: reason } : {}));
}
