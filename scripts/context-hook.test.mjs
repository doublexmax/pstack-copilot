import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runHook } from './context-hook.mjs';
import { configurePolicy, loadContextPolicy, resolveRole, routeToolCall } from './context-routing.mjs';

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
  assert.deepEqual(observed.output, {});
  assert.equal(observed.record.observation, 'matched');
  assert.equal(observed.record.observedTier, 'long_context');
  const recorded = readdirSync(dir).map((file) => JSON.parse(readFileSync(join(dir, file), 'utf8')));
  assert.deepEqual(recorded.find((value) => value.event === 'postToolUse'), observed.record);
});

test('post-tool mismatches use the original decision and pre-tool denials remain visible', (t) => {
  const f = fixture(t);
  const event = launch(f);
  runHook('preToolUse', event, f);
  const mismatch = runHook('postToolUse', { ...event, timestamp: event.timestamp + 1 }, f);
  assert.deepEqual(mismatch.output, {
    additionalContext: 'Pstack context mismatch: expected long_context, observed default.',
  });
  assert.equal(mismatch.record.observation, 'mismatch');
  const denied = runHook('preToolUse', { ...event, toolArgs: {
    ...event.toolArgs, model: 'gpt-5.4-mini',
  } }, f);
  assert.deepEqual(denied.output, {
    permissionDecision: 'deny',
    permissionDecisionReason: 'pstack context routing: model-support-evidence-mismatch',
  });
  assert.equal(denied.record.status, 'blocked');
  const dir = join(f.home, 'pstack-context-decisions', event.sessionId);
  const records = readdirSync(dir).map((file) => JSON.parse(readFileSync(join(dir, file), 'utf8')));
  assert.deepEqual(records.find((value) => value.reason === 'model-support-evidence-mismatch'), denied.record);
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
  assert.deepEqual(result, { output: {} });
});

test('whole-command opt-out persists on resume, bypasses routing, and explicit re-entry clears it', (t) => {
  const f = fixture(t);
  const event = launch(f);
  assert.equal(runHook('userPromptSubmitted', envelope({ prompt: '  skip poteto mode  ' }), f).record.reason, 'session-opt-out');
  const state = join(f.home, 'session-state', 'session-1', 'files', 'pstack-context-opt-out');
  assert.equal(existsSync(state), true);
  assert.deepEqual(runHook('preToolUse', event, f).output, {});
  const malformed = {
    ...event, toolArgs: { name: 'pstack-reader', prompt: 'PSTACK_CONTEXT_V1 bad', context_tier: 'long_context' },
  };
  runHook('preToolUse', malformed, { ...f, routing: undefined });
  const optedOutPost = runHook('postToolUse', malformed, { ...f, routing: undefined });
  assert.deepEqual(optedOutPost.output, {});
  assert.equal(optedOutPost.record.scope, 'opt-out');
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
    assert.deepEqual(runHook('userPromptSubmitted', envelope({ prompt }), f), { output: {} });
  }
  const state = join(f.home, 'session-state', 'session-1', 'files', 'pstack-context-opt-out');
  assert.equal(existsSync(state), false);
  assert.equal(existsSync(join(f.home, 'pstack-context-decisions')), false);
  runHook('userPromptSubmitted', envelope({ prompt: 'skip poteto mode' }), f);
  const records = join(f.home, 'pstack-context-decisions', 'session-1');
  const before = readdirSync(records);
  assert.deepEqual(runHook('userPromptSubmitted', envelope({ prompt: 'Read one helper.' }), f), { output: {} });
  assert.deepEqual(readdirSync(records), before);
  assert.equal(existsSync(state), true);
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

test('diagnostic storage errors do not block opted-out delegate calls', (t) => {
  const f = fixture(t);
  mkdirSync(join(f.home, 'pstack-context-decisions'));
  writeFileSync(join(f.home, 'pstack-context-decisions', 'session-1'), 'not a directory');
  runHook('userPromptSubmitted', envelope({ prompt: 'skip poteto mode' }), f);
  const optedOut = runHook('preToolUse', launch(f), f);
  assert.deepEqual(optedOut.output, {});
  assert.deepEqual(optedOut.record, { scope: 'opt-out', status: 'unrecorded', reason: 'diagnostics-write-failed' });
  assert.match(optedOut.warning, /EEXIST|ENOTDIR/);
});

test('the real stdio adapter emits modifiedArgs without an allow decision', (t) => {
  const f = fixture(t);
  const event = launch(f);
  const processResult = spawnSync(process.execPath, [script, 'preToolUse'], {
    env: { ...process.env, COPILOT_HOME: f.home }, encoding: 'utf8', input: JSON.stringify(event),
  });

  assert.equal(processResult.status, 0, processResult.stderr);
  const outputs = processResult.stdout.trim().split('\n').map(JSON.parse);
  assert.deepEqual(outputs, [{ modifiedArgs: { ...event.toolArgs, context_tier: 'long_context' } }]);
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
  for (const phase of ['preToolUse', 'postToolUse']) {
    const result = spawnSync(process.execPath, [script, phase, broken], {
      env: { ...process.env, COPILOT_HOME: f.home }, encoding: 'utf8',
      input: JSON.stringify({ toolName: 'task', toolArgs: { name: 'ordinary', prompt: 'Read one file.' } }),
    });
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), {});
    assert.deepEqual(JSON.parse(result.stderr), { scope: 'unmanaged', reason: 'no-pstack-declaration' });
  }
  assert.deepEqual(readdirSync(f.home), []);
});

test('post-hook observes the accepted alias decision even after policy changes or checkout disappears', (t) => {
  const f = fixture(t);
  const resolved = resolveRole({
    role: 'how explainer', model: 'auto', workload: 'bounded', why: 'Read one helper.',
    hostContext: true, hostSource: 'Current task schema',
  }, f);
  const event = envelope({ toolName: 'task', toolArgs: {
    ...resolved.toolArguments, name: 'pstack-alias', prompt: `${resolved.declaration}\nRead one helper.`,
  } });
  const call = (phase, input, root) => spawnSync(process.execPath, [script, phase, ...(root ? [root] : [])], {
    env: { ...process.env, COPILOT_HOME: f.home }, encoding: 'utf8', input: JSON.stringify(input),
  });
  const pre = call('preToolUse', event);
  assert.equal(pre.status, 0, pre.stderr);
  const args = JSON.parse(pre.stdout).modifiedArgs;
  assert.equal(args.context_tier, 'default');
  configurePolicy({ defaultMode: 'always_long' }, f);
  const postEvent = { ...event, timestamp: event.timestamp + 1, toolArgs: args };
  const post = call('postToolUse', postEvent);
  assert.equal(post.status, 0, post.stderr);
  assert.deepEqual(JSON.parse(post.stdout), {});
  const missingCheckout = call('postToolUse', postEvent, join(f.home, 'missing-checkout'));
  assert.equal(missingCheckout.status, 0, missingCheckout.stderr);
  assert.deepEqual(JSON.parse(missingCheckout.stdout), {});
  const dir = join(f.home, 'pstack-context-decisions', event.sessionId);
  const records = readdirSync(dir).map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')));
  const observed = records.find((value) => value.event === 'postToolUse');
  assert.equal(observed.policy, 'adaptive');
  assert.equal(observed.observation, 'matched');
});

test('observations consume dispatch decisions without guessing across identical in-flight launches', (t) => {
  const f = fixture(t);
  const first = launch(f);
  assert.equal(runHook('postToolUse', first, f).record.reason, 'missing-dispatch-decision');
  const accepted = runHook('preToolUse', first, f);
  const post = { ...first, timestamp: first.timestamp + 1, toolArgs: accepted.output.modifiedArgs };
  const observed = runHook('postToolUse', post, f);
  assert.equal(observed.record.observation, 'matched');
  assert.deepEqual(runHook('postToolUse', post, f), observed);
  const second = { ...first, timestamp: first.timestamp + 2 };
  configurePolicy({ defaultMode: 'default' }, f);
  const next = runHook('preToolUse', second, f);
  assert.equal(runHook('postToolUse', {
    ...second, timestamp: first.timestamp + 3, toolArgs: next.output.modifiedArgs,
  }, f).record.tier, 'default');
  runHook('preToolUse', { ...first, timestamp: first.timestamp + 4 }, f);
  runHook('preToolUse', { ...first, timestamp: first.timestamp + 5 }, f);
  const ambiguous = runHook('postToolUse', { ...first, timestamp: first.timestamp + 6 }, f);
  assert.deepEqual(ambiguous.output, {
    additionalContext: 'Pstack context observation unverified: ambiguous-dispatch-decision.',
  });
  assert.equal(ambiguous.record.status, 'unverified');
});

test('task and kickoff observations retain dispatch policy when policy or opt-out changes in flight', (t) => {
  const f = fixture(t);
  for (const target of ['task', 'create_session', 'open_pr_session', 'open_issue_session']) {
    configurePolicy({ defaultMode: 'always_long' }, f);
    const plan = resolveRole({
      role: 'how explainer', target, model: 'gpt-6.1-sol', effort: 'max',
      workload: 'bounded', why: 'Read one helper.', support: 'supported',
      source: 'Current exact-model schema', hostContext: true, hostSource: 'Current launch schema',
    }, f);
    const prompt = `${plan.declaration}\nRead one helper.`;
    const event = envelope({ toolName: target, toolArgs: target === 'task'
      ? { ...plan.toolArguments, name: 'pstack-reader', prompt }
      : { name: 'Read helper', kickoff: { ...plan.toolArguments.kickoff, prompt } } });
    const pre = runHook('preToolUse', event, f);
    configurePolicy({ defaultMode: 'default' }, f);
    runHook('userPromptSubmitted', envelope({ prompt: 'skip poteto mode' }), f);
    const post = runHook('postToolUse', {
      ...event, timestamp: event.timestamp + 1, toolArgs: pre.output.modifiedArgs,
    }, { home: f.home });
    assert.deepEqual(post.output, {});
    assert.equal(post.record.policy, 'always_long');
    assert.equal(post.record.tier, 'long_context');
    assert.equal(post.record.observation, 'matched');
    runHook('userPromptSubmitted', envelope({ prompt: '/poteto-mode' }), f);
  }
});
