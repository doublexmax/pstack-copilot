import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runHook } from './context-hook.mjs';
import { loadContextPolicy, resolveRole, routeToolCall } from './context-routing.mjs';

const script = fileURLToPath(new URL('./context-hook.mjs', import.meta.url));

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'pstack-hook-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return { home, routing: { loadContextPolicy, routeToolCall } };
}

function envelope(overrides = {}) {
  return { sessionId: 'session-1', timestamp: 1791081960000, cwd: 'C:\\repo', ...overrides };
}

function launch(f) {
  const result = resolveRole({
    role: 'how explainer', model: 'gpt-6.1-sol', effort: 'max', workload: 'large-corpus',
    why: 'Compare the named contracts together.', inputs: ['skills', 'always-on'],
    hostContext: true, hostSource: 'Current task schema', support: 'supported', source: 'Current exact-model task schema',
  }, f);
  return envelope({ toolName: 'task', toolArgs: {
    ...result.toolArguments, context_tier: 'default', name: 'pstack-reader',
    agent_type: 'general-purpose', mode: 'sync', description: 'Read contracts',
    prompt: `${result.declaration}\nRead the contracts without writing files.`,
  } });
}

test('native mutation preserves payload and writes a concise durable decision', (t) => {
  const f = fixture(t);
  const event = launch(f);
  const routed = runHook('preToolUse', event, f);
  assert.deepEqual(routed.output, { modifiedArgs: { ...event.toolArgs, context_tier: 'long_context' } });
  assert.equal(routed.record.role, 'how explainer');
  assert.equal(routed.record.effectiveModel, 'gpt-6.1-sol');
  assert.equal(routed.record.tier, 'long_context');
  const dir = join(f.home, 'pstack-context-decisions', 'session-1');
  const files = readdirSync(dir);
  assert.equal(files.length, 1);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, files[0]), 'utf8')), routed.record);
  assert.deepEqual(runHook('preToolUse', event, f), routed);
  assert.equal(readdirSync(dir).length, 1);
  const observed = runHook('postToolUse', { ...event, toolArgs: routed.output.modifiedArgs }, f);
  assert.equal(observed.record.observation, 'matched');
  assert.equal(observed.record.observedTier, 'long_context');
});

test('managed missing/invalid declarations deny but ordinary delegates ignore invalid policy', (t) => {
  const f = fixture(t);
  const invalid = envelope({ toolName: 'task', toolArgs: { name: 'pstack-reader', prompt: 'Read the file.' } });
  assert.deepEqual(runHook('preToolUse', invalid, f).output, {
    permissionDecision: 'deny',
    permissionDecisionReason: 'pstack context routing: managed launch needs a PSTACK_CONTEXT_V1 declaration on line 1',
  });
  writeFileSync(join(f.home, 'pstack-context.json'), '{');
  const ordinary = envelope({ toolName: 'task', toolArgs: { name: 'ordinary', prompt: 'Read the file.', context_tier: 'long_context' } });
  const result = runHook('preToolUse', ordinary, f);
  assert.deepEqual(result.output, {});
  assert.equal(result.record.scope, 'unmanaged');
  assert.equal(result.record.reason, 'no-pstack-declaration');
});

test('whole-command opt-out persists on resume, bypasses routing, and explicit re-entry clears it', (t) => {
  const f = fixture(t);
  const event = launch(f);
  assert.equal(runHook('userPromptSubmitted', envelope({ prompt: '  skip poteto mode  ' }), f).record.reason, 'session-opt-out');
  const state = join(f.home, 'session-state', 'session-1', 'files', 'pstack-context-opt-out');
  assert.equal(existsSync(state), true);
  assert.deepEqual(runHook('preToolUse', event, f).output, {});
  const resumed = runHook('sessionStart', envelope({ source: 'resume' }), f);
  assert.equal(resumed.record.scope, 'opt-out');
  assert.deepEqual(runHook('preToolUse', event, f).output, {});
  runHook('userPromptSubmitted', envelope({ prompt: '/poteto-mode' }), f);
  assert.equal(existsSync(state), false);
  assert.deepEqual(runHook('preToolUse', event, f).output, {
    modifiedArgs: { ...event.toolArgs, context_tier: 'long_context' },
  });
});

test('quoted prose, code, and extended commands do not change session opt-out', (t) => {
  const f = fixture(t);
  for (const prompt of [
    'Explain "skip poteto mode".', '```\nskip poteto mode\n```', 'skip poteto mode for this example',
    'Please run /poteto-mode.', '/poteto-mode explain this',
  ]) {
    assert.equal(runHook('userPromptSubmitted', envelope({ prompt }), f).record.reason, 'not-a-routing-command');
  }
  const state = join(f.home, 'session-state', 'session-1', 'files', 'pstack-context-opt-out');
  assert.equal(existsSync(state), false);
  runHook('sessionStart', envelope({ initialPrompt: 'skip poteto mode', source: 'startup' }), f);
  assert.equal(existsSync(state), true);
  runHook('sessionStart', envelope({ initialPrompt: 'An example of /poteto-mode', source: 'resume' }), f);
  assert.equal(existsSync(state), true);
});

test('session start injects the canonical policy path without changing tier settings', (t) => {
  const f = fixture(t);
  const settings = '{"contextTier":"default","subagents":{"agents":{"general-purpose":{"contextTier":"inherit"}}}}\n';
  writeFileSync(join(f.home, 'settings.json'), settings);
  const result = runHook('sessionStart', envelope({ source: 'startup' }), f);
  assert.equal(result.record.reason, 'context-routing-ready');
  assert.match(result.output.additionalContext, /context-routing skill/);
  assert.match(result.output.additionalContext, /context\.default\.json/);
  assert.equal(readFileSync(join(f.home, 'settings.json'), 'utf8'), settings);
});

test('diagnostic storage errors do not block unrelated or opted-out delegate calls', (t) => {
  const f = fixture(t);
  mkdirSync(join(f.home, 'pstack-context-decisions'));
  writeFileSync(join(f.home, 'pstack-context-decisions', 'session-1'), 'not a directory');
  const ordinary = envelope({ toolName: 'task', toolArgs: { name: 'ordinary', prompt: 'Read one file.' } });
  const result = runHook('preToolUse', ordinary, f);
  assert.deepEqual(result.output, {});
  assert.deepEqual(result.record, { scope: 'unmanaged', status: 'unrecorded', reason: 'diagnostics-write-failed' });
  assert.match(result.warning, /EEXIST|ENOTDIR/);
  runHook('userPromptSubmitted', envelope({ prompt: 'skip poteto mode' }), f);
  const optedOut = runHook('preToolUse', launch(f), f);
  assert.deepEqual(optedOut.output, {});
  assert.equal(optedOut.record.scope, 'opt-out');
});

test('the real stdio adapter emits modifiedArgs without an allow decision', (t) => {
  const f = fixture(t);
  const event = launch(f);
  const processResult = spawnSync(process.execPath, [script, 'preToolUse'], {
    env: { ...process.env, COPILOT_HOME: f.home }, encoding: 'utf8', input: JSON.stringify(event),
  });

  assert.equal(processResult.status, 0, processResult.stderr);
  const outputs = processResult.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(outputs[0].type, 'progress');
  assert.deepEqual(outputs[1], { modifiedArgs: { ...event.toolArgs, context_tier: 'long_context' } });
  const unsafe = spawnSync(process.execPath, [script, 'userPromptSubmitted'], {
    env: { ...process.env, COPILOT_HOME: f.home }, encoding: 'utf8',
    input: JSON.stringify(envelope({ sessionId: '..\\outside', prompt: 'skip poteto mode' })),
  });
  assert.equal(unsafe.status, 1);
  assert.equal(unsafe.stdout, '');
  assert.deepEqual(JSON.parse(unsafe.stderr), {
    status: 'error', event: 'userPromptSubmitted', error: 'invalid hook sessionId',
  });
});

test('unmarked native calls bypass broken checkout and session validation before importing anything', (t) => {
  const f = fixture(t);
  const broken = join(f.home, 'missing-checkout');
  const result = spawnSync(process.execPath, [script, 'preToolUse', broken], {
    env: { ...process.env, COPILOT_HOME: f.home }, encoding: 'utf8',
    input: JSON.stringify({ toolName: 'task', toolArgs: { name: 'ordinary', prompt: 'Read one file.' } }),
  });
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), {});
  assert.deepEqual(JSON.parse(result.stderr), { scope: 'unmanaged', reason: 'no-pstack-declaration' });
});
