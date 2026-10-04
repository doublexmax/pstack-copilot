import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectOrganicRouting } from './context-organic-evidence.mjs';

const timestamp = '2026-10-04T19:00:00.000Z';
const start = { type: 'session.start', data: {
  sessionId: 'receipt-session', selectedModel: 'gpt-6.1-sol', contextTier: 'default', copilotVersion: '1.0.87-0',
} };

function launch(workload, support, requestedTier, postTier, effectiveTier) {
  const declaration = {
    role: 'how explainer', workload, why: 'Read the delivery path.', inputs: ['src/worker.mjs', 'src/provider.mjs'],
    modelSupport: { model: 'gpt-6.1-sol', status: support, source: 'Current exact-model task schema' },
    host: { tool: 'task', contextTier: true, source: 'Current task schema' },
  };
  const args = { name: 'pstack-delivery', agent_type: 'general-purpose',
    model: 'gpt-6.1-sol', reasoning_effort: 'max', context_tier: requestedTier,
    prompt: `PSTACK_CONTEXT_V1 ${JSON.stringify(declaration)}\nRead the files.` };
  return {
    events: [
      start,
      { type: 'assistant.message', data: { toolRequests: [{ name: 'task', toolCallId: 'call-1', arguments: args }] } },
      { type: 'subagent.started', agentId: 'worker-1', timestamp, data: { toolCallId: 'call-1' } },
      { type: 'subagent.configured', agentId: 'worker-1', data: {
        model: 'gpt-6.1-sol', reasoningEffort: 'max', contextTier: effectiveTier,
      } },
      { type: 'tool.execution_complete', timestamp, data: { toolCallId: 'call-1', success: true } },
    ],
    observations: [{ toolName: 'task', timestamp: Date.parse(timestamp), toolArgs: { ...args, context_tier: postTier } }],
    completed: true, output: 'The provider accepts a receipt before the worker saves delivery history.',
  };
}

test('direct output is legitimate but supplies no delegation evidence', () => {
  const report = inspectOrganicRouting({ events: [start], completed: true, output: 'The amount is $1.05.' });
  assert.equal(report.outcome, 'direct-result');
  assert.equal(report.classificationEvidence, 'none');
  assert.deepEqual(report.launches, []);
  assert.equal(report.output, 'The amount is $1.05.');
});

test('a timeout or missing output is not a successful direct result', () => {
  for (const [completed, output] of [[false, 'Partial notes.'], [true, '']]) {
    const report = inspectOrganicRouting({ events: [start], completed, output });
    assert.equal(report.outcome, 'inconclusive-output');
  }
});

test('an unbound native delegate cannot be reported as direct completion', () => {
  const report = inspectOrganicRouting({
    events: [start, { type: 'subagent.started', agentId: 'reader', data: { toolCallId: 'unbound' } }],
    completed: true, output: 'Delivery notes.',
  });
  assert.equal(report.outcome, 'inconclusive-classification');
  assert.equal(report.classificationEvidence, 'incomplete');
  assert.equal(report.unboundStarts[0].agentId, 'reader');
});

test('bounded decomposition retains original, post-hook, and effective metadata', () => {
  const report = inspectOrganicRouting(launch('bounded', 'supported', 'long_context', 'default', 'default'));
  assert.equal(report.outcome, 'delegated-result');
  const [row] = report.launches;
  assert.equal(row.requestedTier, 'long_context');
  assert.equal(row.postHookTier, 'default');
  assert.equal(row.effectiveTier, 'default');
  assert.equal(row.outcome, 'bounded-delegation');
  assert.deepEqual(row.declaration.inputs, ['src/worker.mjs', 'src/provider.mjs']);
  assert.equal(row.declaration.why, 'Read the delivery path.');
  assert.deepEqual(row.issues, []);
});

test('eligible corpus, unresolved support downgrade, and unjustified long remain distinct', () => {
  for (const [workload, support, tier, outcome] of [
    ['large-corpus', 'supported', 'long_context', 'large-corpus-delegation'],
    ['large-corpus', 'unknown', 'default', 'unresolved-support-downgrade'],
    ['bounded', 'supported', 'long_context', 'unjustified-long'],
  ]) {
    const [row] = inspectOrganicRouting(launch(workload, support, tier, tier, tier)).launches;
    assert.equal(row.outcome, outcome);
  }
});

test('missing or ambiguous post-hook receipts do not prove dispatch', () => {
  const run = launch('bounded', 'supported', 'default', 'default', 'default');
  assert.equal(inspectOrganicRouting({ ...run, observations: [] }).launches[0].outcome, 'inconclusive-launch');
  assert.equal(inspectOrganicRouting({ ...run, observations: [...run.observations, ...run.observations] })
    .launches[0].outcome, 'inconclusive-launch');
});

test('post-effective mismatches remain visible rather than passing on the request alone', () => {
  const [row] = inspectOrganicRouting(launch('bounded', 'supported', 'default', 'default', 'long_context')).launches;
  assert.deepEqual(row.issues, ['post-effective-tier-mismatch', 'bounded-work-used-long']);
});

test('only successful completed view calls count as opened files', () => {
  const events = [
    start,
    { type: 'tool.execution_start', data: { toolCallId: 'read-1', toolName: 'view', arguments: { path: 'src/worker.mjs' } } },
    { type: 'tool.execution_complete', data: { toolCallId: 'read-1', success: true } },
    { type: 'tool.execution_start', data: { toolCallId: 'read-2', toolName: 'view', arguments: { path: 'src/secret.mjs' } } },
    { type: 'tool.execution_complete', data: { toolCallId: 'read-2', success: false } },
  ];
  const report = inspectOrganicRouting({ events, completed: true, output: 'Read the worker.' });
  assert.deepEqual(report.reads.map((row) => row.path), ['src/worker.mjs']);
});
