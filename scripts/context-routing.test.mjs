import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { configurePolicy, loadContextPolicy, resolveRole, routeToolCall } from './context-routing.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const script = fileURLToPath(new URL('./context-routing.mjs', import.meta.url));

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pstack-context-'));
  const home = join(dir, 'home');
  mkdirSync(home);
  copyFileSync(join(root, 'models.default.md'), join(dir, 'models.default.md'));
  copyFileSync(join(root, 'context.default.json'), join(dir, 'context.default.json'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return {
    root: dir, home,
    write: (name, value) => writeFileSync(join(home, name), typeof value === 'string' ? value : JSON.stringify(value)),
    run: (...args) => spawnSync(process.execPath, [script, ...args], {
      encoding: 'utf8', env: { ...process.env, COPILOT_HOME: home },
    }),
  };
}

function request(overrides = {}) {
  return {
    role: 'feature, refactoring',
    model: 'gpt-6.1-sol',
    effort: 'max',
    workload: 'bounded',
    why: 'Read the named helper.',
    inputs: ['scripts\\install-always-on.mjs'],
    support: 'supported',
    source: 'Current exact-model task schema',
    hostContext: true,
    hostSource: 'Current task context_tier schema',
    ...overrides,
  };
}

function event(result, args = {}) {
  return {
    toolName: 'task',
    toolArgs: {
      description: 'Read the helper',
      agent_type: 'general-purpose',
      mode: 'background',
      name: 'pstack-reader',
      ...result.toolArguments,
      prompt: `${result.declaration}\nRead the helper without writing files.`,
      ...args,
    },
  };
}

test('missing optional files use adaptive policy and literal default arguments for bounded work', (t) => {
  const f = fixture(t);
  const result = resolveRole(request(), f);
  assert.deepEqual(result.toolArguments, {
    model: 'gpt-6.1-sol', reasoning_effort: 'max', context_tier: 'default',
  });
  assert.deepEqual(result.decision, {
    role: 'feature, refactoring', effectiveModel: 'gpt-6.1-sol', workload: 'bounded',
    policy: 'adaptive', evidence: [
      join(f.root, 'context.default.json'), 'Current task context_tier schema', 'Current exact-model task schema',
    ], diagnostics: [], status: 'resolved', tier: 'default', reason: 'bounded-work',
  });
});

test('supported joint large-corpus work gets long context without changing the model or effort', (t) => {
  const f = fixture(t);
  const result = resolveRole(request({ workload: 'large-corpus' }), f);
  assert.deepEqual(result.toolArguments, {
    model: 'gpt-6.1-sol', reasoning_effort: 'max', context_tier: 'long_context',
  });
  assert.equal(result.decision.reason, 'eligible-large-corpus');
});

test('exact role policy overrides the global mode', (t) => {
  const f = fixture(t);
  f.write('pstack-context.json', {
    schemaVersion: 1, default: 'long_context', roles: { 'feature, refactoring': 'default' },
  });
  const result = resolveRole(request({ workload: 'large-corpus' }), f);
  assert.deepEqual(result.toolArguments, {
    model: 'gpt-6.1-sol', reasoning_effort: 'max', context_tier: 'default',
  });
  assert.equal(result.decision.reason, 'policy-default');
});

test('explicit long policy still needs current host and model support', (t) => {
  const f = fixture(t);
  f.write('pstack-context.json', { schemaVersion: 1, default: 'long_context' });
  const supported = resolveRole(request(), f);
  assert.deepEqual(supported.toolArguments, {
    model: 'gpt-6.1-sol', reasoning_effort: 'max', context_tier: 'long_context',
  });
  assert.equal(supported.decision.reason, 'policy-long');
  for (const support of ['unknown', 'unsupported']) {
    const result = resolveRole(request({ support }), f);
    assert.equal(result.decision.status, 'blocked');
    assert.equal(result.decision.reason, 'required-long-unproven');
    assert.equal(Object.hasOwn(result, 'toolArguments'), false);
  }
});

test('adaptive unknown and unsupported support select default with explicit diagnostics', (t) => {
  const f = fixture(t);
  for (const [support, reason] of [
    ['unknown', 'model-support-unknown'],
    ['unsupported', 'model-long-context-unsupported'],
  ]) {
    const result = resolveRole(request({ workload: 'large-corpus', support }), f);
    assert.deepEqual(result.toolArguments, {
      model: 'gpt-6.1-sol', reasoning_effort: 'max', context_tier: 'default',
    });
    assert.equal(result.decision.reason, reason);
    assert.deepEqual(result.decision.diagnostics, [reason]);
  }
});

test('known unavailable models and unproven host fields block rather than replace a model or drop a field', (t) => {
  const f = fixture(t);
  for (const [overrides, reason] of [
    [{ support: 'unavailable' }, 'model-unavailable'],
    [{ hostContext: null }, 'host-context-field-unproven'],
    [{ hostContext: false }, 'host-context-field-unproven'],
  ]) {
    const result = resolveRole(request(overrides), f);
    assert.equal(result.decision.status, 'blocked');
    assert.equal(result.decision.reason, reason);
    assert.equal(Object.hasOwn(result, 'toolArguments'), false);
  }
});

test('legacy model configuration and mixed panels resolve every member independently', (t) => {
  const f = fixture(t);
  const models = '# budget: unlimited (max)\n'
    + 'arena runners: claude-opus-5.5 / max, gpt-6.1-sol / max, grok-4.7 / xhigh, gemini-3.8-flash / high\n';
  f.write('pstack-models.md', models);
  const states = ['supported', 'supported', 'unknown', 'unsupported'];
  const results = states.map((support, member) => resolveRole({
    role: 'arena runners', member, workload: 'large-corpus', why: 'Compare the same corpus together.',
    inputs: ['skills', 'always-on'], support, source: 'Current per-member tool evidence',
    hostContext: true, hostSource: 'Current task schema',
  }, f));
  assert.deepEqual(results.map((result) => result.toolArguments), [
    { model: 'claude-opus-5.5', reasoning_effort: 'max', context_tier: 'long_context' },
    { model: 'gpt-6.1-sol', reasoning_effort: 'max', context_tier: 'long_context' },
    { model: 'grok-4.7', reasoning_effort: 'xhigh', context_tier: 'default' },
    { model: 'gemini-3.8-flash', reasoning_effort: 'high', context_tier: 'default' },
  ]);
  assert.deepEqual(results.map((result) => result.decision.reason), [
    'eligible-large-corpus', 'eligible-large-corpus', 'model-support-unknown', 'model-long-context-unsupported',
  ]);
  assert.equal(readFileSync(join(f.home, 'pstack-models.md'), 'utf8'), models);
});

test('both aliases preserve absent model/effort and use known parent identity or explicit unresolved identity', (t) => {
  const f = fixture(t);
  for (const alias of ['auto', 'inherit-parent']) {
    const known = resolveRole(request({
      model: alias, effort: undefined, parentModel: 'gpt-6.1-sol', workload: 'large-corpus',
    }), f);
    assert.deepEqual(known.toolArguments, { context_tier: 'long_context' });
    assert.equal(known.decision.effectiveModel, 'gpt-6.1-sol');
    const unknown = resolveRole(request({ model: alias, effort: undefined, workload: 'large-corpus' }), f);
    assert.deepEqual(unknown.toolArguments, { context_tier: 'default' });
    assert.equal(unknown.decision.effectiveModel, null);
    assert.equal(unknown.decision.reason, 'alias-parent-unresolved');
    const kickoff = resolveRole(request({
      target: 'create_session', model: alias, effort: undefined, parentModel: 'gpt-6.1-sol', workload: 'large-corpus',
    }), f);
    assert.deepEqual(kickoff.toolArguments, { kickoff: { context_tier: 'default' } });
    assert.equal(kickoff.decision.reason, 'kickoff-model-unresolved');
  }
});

test('parent settings do not enable long context for a bounded child', (t) => {
  const f = fixture(t);
  f.write('settings.json', { contextTier: 'long_context', subagents: { agents: { 'general-purpose': { contextTier: 'long_context' } } } });
  assert.deepEqual(resolveRole(request(), f).toolArguments, {
    model: 'gpt-6.1-sol', reasoning_effort: 'max', context_tier: 'default',
  });
});

test('managed task and kickoff binding preserves all other arguments and is idempotent', (t) => {
  const f = fixture(t);
  const result = resolveRole(request({ workload: 'large-corpus' }), f);
  const original = event(result, { context_tier: 'default', extra: { preserved: true } });
  const routed = routeToolCall(original, f);
  assert.deepEqual(routed.output, { modifiedArgs: { ...original.toolArgs, context_tier: 'long_context' } });
  assert.equal(Object.hasOwn(routed.output, 'permissionDecision'), false);
  assert.deepEqual(routeToolCall({ ...original, toolArgs: routed.output.modifiedArgs }, f).output, routed.output);
  const session = resolveRole(request({ target: 'create_session', workload: 'large-corpus' }), f);
  const kickoff = { ...session.toolArguments.kickoff, prompt: `${session.declaration}\nRead the corpus.`, mode: 'autopilot' };
  const args = { name: 'Corpus review', execution_location: 'cloud', kickoff, notify_on_idle: 'once' };
  assert.deepEqual(routeToolCall({ toolName: 'create_session', toolArgs: args }, f).output, {
    modifiedArgs: { ...args, kickoff: { ...kickoff, context_tier: 'long_context' } },
  });
});

test('unmanaged and opted-out calls remain unchanged even when policy or declarations are malformed', (t) => {
  const f = fixture(t);
  f.write('pstack-context.json', '{');
  const ordinary = { toolName: 'task', toolArgs: { name: 'ordinary', prompt: 'Read the helper.', context_tier: 'long_context' } };
  assert.deepEqual(routeToolCall(ordinary, f), {
    scope: 'unmanaged', reason: 'no-pstack-declaration', output: {},
  });
  const optedOut = { toolName: 'task', toolArgs: { name: 'pstack-reader', prompt: 'PSTACK_CONTEXT_V1 bad', context_tier: 'long_context' } };
  assert.deepEqual(routeToolCall(optedOut, { ...f, optedOut: true }), {
    scope: 'opt-out', reason: 'session-opt-out', output: {},
  });
});

test('managed invalid declarations and evidence mismatches cannot look successful', (t) => {
  const f = fixture(t);
  assert.throws(() => routeToolCall({ toolName: 'task', toolArgs: { name: 'pstack-reader', prompt: 'No header' } }, f),
    /needs a PSTACK_CONTEXT_V1 declaration/);
  const launch = event(resolveRole(request(), f));
  assert.throws(() => routeToolCall({ ...launch, toolArgs: { ...launch.toolArgs, prompt: 'PSTACK_CONTEXT_V1 {}\nRead.' } }, f),
    /unknown role/);
  const mismatch = routeToolCall({ ...launch, toolArgs: { ...launch.toolArgs, model: 'claude-opus-5.5' } }, f);
  assert.deepEqual(mismatch.output, {
    permissionDecision: 'deny', permissionDecisionReason: 'pstack context routing: model-support-evidence-mismatch',
  });
});

test('malformed policy, duplicate JSON keys, unknown roles, and malformed legacy model config fail loudly', (t) => {
  const f = fixture(t);
  for (const raw of [
    '{', '{}', '{"schemaVersion":1,"default":"forever"}', '{"schemaVersion":1,"roles":{"retired role":"default"}}',
    '{"schemaVersion":1,"default":"default","default":"adaptive"}', '{"schemaVersion":1,"extra":true}',
  ]) {
    f.write('pstack-context.json', raw);
    assert.throws(() => loadContextPolicy(f));
  }
  f.write('pstack-context.json', { schemaVersion: 1 });
  for (const raw of [
    'feature, refactoring: gpt-6.1-sol / impossible\n', 'feature, refactoring: auto / max\n',
    'bad line\n',
    'feature, refactoring: auto\nfeature, refactoring: inherit-parent\n',
  ]) {
    f.write('pstack-models.md', raw);
    assert.throws(() => resolveRole(request(), f));
  }
});

test('retired valid model-role lines are diagnostic and never rewritten or allowed to block context-only setup', (t) => {
  const f = fixture(t);
  const models = 'how critics: gpt-6.1-sol / max\nfeature, refactoring: gpt-6.1-sol / max\n';
  f.write('pstack-models.md', models);
  configurePolicy({ defaultMode: 'adaptive' }, f);
  const result = resolveRole(request(), f);
  assert.deepEqual(result.toolArguments, { model: 'gpt-6.1-sol', reasoning_effort: 'max', context_tier: 'default' });
  assert.deepEqual(result.decision.diagnostics, ['retired-model-role:how critics']);
  assert.equal(readFileSync(join(f.home, 'pstack-models.md'), 'utf8'), models);
  assert.deepEqual(routeToolCall(event(result), f).output, { modifiedArgs: event(result).toolArgs });
  f.write('pstack-models.md', 'how critics: invalid / impossible\n');
  assert.throws(() => resolveRole(request(), f), /invalid model \/ effort/);
});
test('policy-only configuration is idempotent and preserves a full 17-role model map and parent preferences', (t) => {
  const f = fixture(t);
  const models = readFileSync(join(root, 'models.default.md'), 'utf8').match(/```\r?\n([\s\S]*?)\r?\n```/)[1];
  f.write('pstack-models.md', models);
  f.write('settings.json', '{"contextTier":"default"}\n');
  const changed = configurePolicy({ defaultMode: 'adaptive', roles: { 'how explainer': 'default' } }, f);
  assert.deepEqual(changed.policy, { schemaVersion: 1, default: 'adaptive', roles: { 'how explainer': 'default' } });
  const once = readFileSync(changed.policyFile, 'utf8');
  configurePolicy({ defaultMode: 'adaptive', roles: { 'how explainer': 'default' } }, f);
  assert.equal(readFileSync(changed.policyFile, 'utf8'), once);
  assert.equal(loadContextPolicy(f).roles.size, 17);
  assert.equal(readFileSync(join(f.home, 'pstack-models.md'), 'utf8'), models);
  assert.equal(readFileSync(join(f.home, 'settings.json'), 'utf8'), '{"contextTier":"default"}\n');
});

test('the executable resolver returns tool arguments and rejects invalid CLI options', (t) => {
  const f = fixture(t);
  const args = [
    'resolve', '--role', 'feature, refactoring', '--workload', 'bounded', '--why', 'Read one helper.',
    '--model', 'gpt-6.1-sol', '--effort', 'max', '--host-context', 'supported', '--host-source', 'Current task schema',
    '--support', 'supported', '--source', 'Current exact-model evidence',
  ];
  const result = f.run(...args);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).toolArguments, {
    model: 'gpt-6.1-sol', reasoning_effort: 'max', context_tier: 'default',
  });
  for (const extra of [['--role', 'bug-fix'], ['--member', '1.5'], ['--nope', 'value'], ['--default', 'adaptive']]) {
    const failed = f.run(...args, ...extra);
    assert.equal(failed.status, 1);
    assert.equal(failed.stdout, '');
    assert.equal(JSON.parse(failed.stderr).status, 'error');
  }
});
