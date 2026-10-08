import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectDispatch } from './copilot-dispatch-evidence.mjs';

function fixture() {
  const args = {
    name: 'pstack-proof',
    prompt: 'Read the named file.',
    model: 'gpt-6.1-sol',
    reasoning_effort: 'max',
    context_tier: 'default',
    agent_type: 'general-purpose',
  };
  return {
    expectedModel: 'gpt-6.1-sol',
    expectedTier: 'long_context',
    events: [
      { type: 'session.start', data: {
        sessionId: 'session', copilotVersion: '1.0.87-0', selectedModel: 'gpt-6.1-sol',
        contextTier: 'default', context: { branch: 'feature', headCommit: 'abc' },
      } },
      { type: 'assistant.message', data: { toolRequests: [{ name: 'task', toolCallId: 'call', arguments: args }] } },
      { type: 'subagent.started', agentId: 'agent', data: { toolCallId: 'call' } },
      { type: 'subagent.configured', agentId: 'agent', timestamp: 'configured', data: {
        model: 'gpt-6.1-sol', reasoningEffort: 'max', contextTier: 'long_context',
      } },
      { type: 'tool.execution_complete', timestamp: 'completed', data: { toolCallId: 'call', success: true } },
    ],
    observations: [{ toolName: 'task', toolArgs: { ...args, context_tier: 'long_context' } }],
  };
}

test('reports original, post-hook, and effective values for the same successful delegate', () => {
  assert.deepEqual(inspectDispatch(fixture()), {
    sessionId: 'session', copilotVersion: '1.0.87-0', parentModel: 'gpt-6.1-sol', parentTier: 'default',
    branch: 'feature', headCommit: 'abc', delegates: [{
      agentId: 'agent', toolCallId: 'call', name: 'pstack-proof', model: 'gpt-6.1-sol',
      reasoningEffort: 'max', requestedTier: 'default', postHookTier: 'long_context',
      effectiveTier: 'long_context', configuredAt: 'configured', completedAt: 'completed',
    }],
  });
});

test('does not accept a requested tier as proof of the effective tier', () => {
  const data = fixture();
  data.events[3].data.contextTier = 'default';
  assert.throws(() => inspectDispatch(data), /runtime did not apply/);
});

test('rejects missing, failed, or unrelated post-hook evidence', () => {
  for (const change of [
    (data) => { data.observations = []; },
    (data) => { data.events[4].data.success = false; },
    (data) => { data.observations[0].toolArgs.model = 'different-model'; },
    (data) => { data.events[0].data.contextTier = 'long_context'; },
    (data) => { data.events[3].agentId = 'another-agent'; },
  ]) {
    const data = fixture();
    change(data);
    assert.throws(() => inspectDispatch(data));
  }
});
