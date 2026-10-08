import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

export function readEvents(file) {
  const bytes = readFileSync(file);
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf16le' : 'utf8';
  return bytes.toString(encoding).replace(/^\uFEFF/, '').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

export function inspectDispatch({ events, observations, expectedModel, expectedTier, parentTier = 'default' }) {
  const start = events.find((event) => event.type === 'session.start');
  assert.ok(start, 'missing session.start metadata');
  assert.equal(start.data.contextTier, parentTier, 'the parent tier changed');
  const requests = events.filter((event) => event.type === 'assistant.message' && !event.agentId)
    .flatMap((event) => event.data.toolRequests ?? []).filter((request) => request.name === 'task');
  assert.ok(requests.length > 0, 'the workflow did not request a delegate');
  const delegates = [];
  for (const request of requests) {
    const started = events.find((event) => event.type === 'subagent.started'
      && event.data.toolCallId === request.toolCallId);
    if (!started) continue;
    const configured = events.find((event) => event.type === 'subagent.configured'
      && event.agentId === started.agentId);
    assert.ok(configured, 'missing effective subagent configuration');
    const completed = events.find((event) => event.type === 'tool.execution_complete'
      && !event.agentId && event.data.toolCallId === request.toolCallId);
    assert.equal(completed?.data.success, true, 'the delegate tool call did not succeed');
    const observed = observations.find((event) => event.toolName === 'task'
      && event.toolArgs.name === request.arguments.name
      && event.toolArgs.prompt === request.arguments.prompt);
    assert.ok(observed, 'missing independent postToolUse arguments');
    assert.equal(configured.data.model, expectedModel, 'the effective delegate model changed');
    assert.equal(configured.data.contextTier, expectedTier, 'the runtime did not apply the expected tier');
    assert.equal(observed.toolArgs.context_tier, expectedTier, 'postToolUse did not observe the expected tier');
    assert.deepEqual(observed.toolArgs, { ...request.arguments, context_tier: expectedTier },
      'the hook changed unrelated tool arguments');
    delegates.push({
      agentId: started.agentId,
      toolCallId: request.toolCallId,
      name: request.arguments.name,
      model: configured.data.model,
      reasoningEffort: configured.data.reasoningEffort,
      requestedTier: request.arguments.context_tier ?? null,
      postHookTier: observed.toolArgs.context_tier,
      effectiveTier: configured.data.contextTier,
      configuredAt: configured.timestamp,
      completedAt: completed.timestamp,
    });
  }
  assert.ok(delegates.length > 0, 'no successful configured delegate matched the request');
  return {
    sessionId: start.data.sessionId,
    copilotVersion: start.data.copilotVersion,
    parentModel: start.data.selectedModel,
    parentTier: start.data.contextTier,
    branch: start.data.context?.branch,
    headCommit: start.data.context?.headCommit,
    delegates,
  };
}
