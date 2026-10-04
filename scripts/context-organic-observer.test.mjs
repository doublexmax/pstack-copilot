import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { checkOperation } from './context-organic-observer.mjs';

const project = resolve('cedar-receipts');
const home = resolve('cedar-home');
const options = { project, home, model: 'gpt-6.1-sol', writable: [join(project, 'src', 'amount.mjs')] };
const call = (toolName, toolArgs) => checkOperation({ toolName, toolArgs }, options);

test('ordinary resolver reads are allowed but settings writes and shell composition are denied', () => {
  const resolver = join(home, 'pstack', 'scripts', 'context-routing.mjs');
  assert.equal(call('powershell', { command: `node "${resolver}" resolve --role "how explainer" --workload bounded` }), null);
  assert.equal(call('powershell', { command: `node "${resolver}" show` }), null);
  assert.equal(call('powershell', { command: `node "${resolver}" set-policy --default adaptive` }),
    'Shell commands are restricted to the project entry point and the context resolver.');
  assert.equal(call('powershell', { command: `node "${resolver}" show; git push` }),
    'Shell commands are restricted to the project entry point and the context resolver.');
  assert.equal(call('powershell', { command: 'node -e "process.env"' }),
    'Shell commands are restricted to the project entry point and the context resolver.');
});

test('only the named project entry point can run', () => {
  assert.equal(call('powershell', { command: 'node src/receipts.mjs' }), null);
  assert.equal(call('powershell', { command: `node "${join(project, 'src', 'receipts.mjs')}"` }), null);
  assert.equal(call('powershell', { command: 'node ../receipts.mjs' }),
    'Shell commands are restricted to the project entry point and the context resolver.');
});

test('patches cannot escape the requested file or move it into the Copilot home', () => {
  assert.equal(call('apply_patch', { input: '*** Begin Patch\n*** Update File: src/amount.mjs\n@@\n-old\n+new\n*** End Patch' }), null);
  for (const patch of [
    '*** Begin Patch\n*** Update File: ../amount.mjs\n@@\n-old\n+new\n*** End Patch',
    `*** Begin Patch\n*** Update File: src/amount.mjs\n*** Move to: ${join(home, 'pstack-models.md')}\n*** End Patch`,
  ]) {
    assert.equal(call('apply_patch', { input: patch }), 'Patch paths are restricted to the requested project file.');
  }
  assert.equal(call('write', { path: join(home, 'settings.json') }), 'Writes are restricted to the requested project file.');
  assert.equal(call('edit', { path: 'src/amount.mjs' }), null);
});

test('delegates keep the configured model without prescribing a tier or delegate count', () => {
  assert.equal(call('task', { model: 'gpt-6.1-sol', reasoning_effort: 'max', context_tier: 'long_context' }), null);
  assert.equal(call('task', { context_tier: 'default' }), null);
  assert.equal(call('task', { model: 'another-model' }), 'Only the configured project model is available.');
});

test('the real stdio observer denies an escaping write and records post-hook arguments', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pstack-operations-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = join(dir, 'operations.mjs');
  copyFileSync(fileURLToPath(new URL('./context-organic-observer.mjs', import.meta.url)), script);
  mkdirSync(join(dir, 'home'));
  const run = (phase, input) => JSON.parse(execFileSync(process.execPath,
    [script, phase, dir, join(dir, 'home'), 'gpt-6.1-sol', 'src/amount.mjs'],
    { input: JSON.stringify(input), encoding: 'utf8' }));
  assert.deepEqual(run('pre', { toolName: 'write', toolArgs: { path: join(dir, 'home', 'settings.json') } }), {
    permissionDecision: 'deny', permissionDecisionReason: 'Writes are restricted to the requested project file.',
  });
  const event = { toolName: 'task', toolArgs: { name: 'reader', prompt: 'Read the delivery path.', context_tier: 'default' } };
  assert.deepEqual(run('post', event), {});
  const records = readdirSync(join(dir, 'home', 'operation-records')).map((file) =>
    JSON.parse(readFileSync(join(dir, 'home', 'operation-records', file), 'utf8')));
  assert.deepEqual(records.find((record) => record.toolName === 'task').toolArgs, event.toolArgs);
});
