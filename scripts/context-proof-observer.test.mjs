import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('./context-proof-observer.mjs', import.meta.url));
const resolver = fileURLToPath(new URL('./context-routing.mjs', import.meta.url));

test('read-only verification permits only the exact resolver read commands', () => {
  const call = (command) => {
    const result = spawnSync(process.execPath, [script, 'pre', tmpdir(), resolver], {
      encoding: 'utf8', input: JSON.stringify({ toolName: 'powershell', toolArgs: { command } }),
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  assert.deepEqual(call(`node "${resolver}" show`), {});
  assert.deepEqual(call(`node "${resolver}" resolve --role "how explainer" --workload bounded`), {});
  for (const command of [
    `node "${resolver}" set-policy --default long_context`,
    `node "${resolver}" show\nnode -e "process.exit()"`,
    `node "${resolver}" show; Get-ChildItem`,
    `node "${resolver}" show | Get-Content`,
    `node "$env:USERPROFILE\\resolver.mjs" show`,
    'node -e "process.exit()"',
  ]) {
    assert.deepEqual(call(command), {
      permissionDecision: 'deny',
      permissionDecisionReason: 'Read-only verification permits only the pstack resolver resolve/show command, without shell operators or variables.',
    });
  }
});

test('independent observation records the actual post-hook payload without granting permission', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pstack-observer-'));
  try {
    const event = { toolName: 'task', toolArgs: { name: 'pstack-reader', context_tier: 'long_context', model: 'gpt-6.1-sol' } };
    const result = spawnSync(process.execPath, [script, 'post', dir, resolver], {
      encoding: 'utf8', input: JSON.stringify(event),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {});
    const files = readdirSync(dir);
    assert.equal(files.length, 1);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, files[0]), 'utf8')), event);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
