export function organicEvidenceStatus({ sourceStable, integrityStable, reports }) {
  if (!sourceStable || !integrityStable) return 'ISSUES';
  return reports.length > 0 && reports.every((report) =>
    report.completion === 'completed' && report.outcome !== 'inconclusive-output')
    ? 'RECORDED' : 'INCONCLUSIVE';
}

export function inspectOrganicRouting({ events, observations = [], decisions = [], completed, output }) {
  const start = events.find((event) => event.type === 'session.start');
  const requests = events.filter((event) => event.type === 'assistant.message')
    .flatMap((event) => (event.data.toolRequests ?? []).filter((request) => request.name === 'task')
      .map((request) => ({ ...request, callerAgentId: event.agentId ?? null })));
  const launches = requests.map((request) => {
    const started = events.find((event) => event.type === 'subagent.started'
      && event.data.toolCallId === request.toolCallId);
    const configured = started && events.find((event) => event.type === 'subagent.configured'
      && event.agentId === started.agentId);
    const finished = events.find((event) => event.type === 'tool.execution_complete'
      && event.data.toolCallId === request.toolCallId && (event.agentId ?? null) === request.callerAgentId);
    const matching = observations.filter((event) => event.toolName === 'task'
      && event.toolArgs.name === request.arguments.name && event.toolArgs.prompt === request.arguments.prompt
      && (!started || event.timestamp >= Date.parse(started.timestamp))
      && (!finished || event.timestamp <= Date.parse(finished.timestamp)));
    const observed = matching.length === 1 ? matching[0] : null;
    let declaration = null;
    let declarationError = null;
    const line = String(request.arguments.prompt ?? '').split(/\r?\n/, 1)[0];
    if (line.startsWith('PSTACK_CONTEXT_V1 ')) {
      try { declaration = JSON.parse(line.slice('PSTACK_CONTEXT_V1 '.length)); }
      catch (error) { declarationError = error.message; }
    }
    const native = decisions.filter((record) => record.event === 'preToolUse'
      && record.name === request.arguments.name && (!started || record.timestamp <= Date.parse(started.timestamp)))
      .sort((a, b) => b.timestamp - a.timestamp)[0] ?? null;
    const effectiveTier = configured?.data.contextTier ?? null;
    let outcome = 'inconclusive-launch';
    if (!started && finished?.data.success === false) outcome = 'denied-launch';
    else if (configured && observed && finished?.data.success === true) {
      if (!declaration) outcome = 'unmanaged-launch';
      else if (declaration.workload === 'bounded') {
        outcome = effectiveTier === 'long_context' ? 'unjustified-long' : 'bounded-delegation';
      } else if (declaration.workload === 'large-corpus') {
        outcome = effectiveTier === 'long_context' ? 'large-corpus-delegation'
          : declaration.modelSupport?.status !== 'supported' ? 'unresolved-support-downgrade' : 'default-corpus-delegation';
      }
    }
    const issues = [];
    if (observed && configured && observed.toolArgs.context_tier !== effectiveTier) issues.push('post-effective-tier-mismatch');
    if (configured && configured.data.model !== start?.data.selectedModel) issues.push('model-changed');
    if (configured && configured.data.reasoningEffort !== 'max') issues.push('effort-changed');
    if (declarationError) issues.push('invalid-declaration');
    if (outcome === 'unjustified-long') issues.push('bounded-work-used-long');
    return {
      toolCallId: request.toolCallId, callerAgentId: request.callerAgentId, agentId: started?.agentId ?? null,
      name: request.arguments.name, agentType: request.arguments.agent_type,
      requested: request.arguments, postHook: observed?.toolArgs ?? null, effective: configured?.data ?? null,
      postHookResult: observed?.toolResult ?? null,
      requestedTier: request.arguments.context_tier ?? null, postHookTier: observed?.toolArgs.context_tier ?? null,
      effectiveTier, declaration, declarationError, nativeDecision: native,
      launchToolSucceeded: finished?.data.success ?? null,
      lifecycle: started ? events.filter((event) => event.agentId === started.agentId && event.type.startsWith('subagent.'))
        .map((event) => ({ type: event.type, timestamp: event.timestamp, data: event.data })) : [],
      outcome, issues,
    };
  });
  const reads = events.filter((event) => event.type === 'tool.execution_start' && event.data.toolName === 'view')
    .filter((event) => events.some((done) => done.type === 'tool.execution_complete'
      && done.data.toolCallId === event.data.toolCallId && done.agentId === event.agentId && done.data.success === true))
    .map((event) => ({
      path: event.data.arguments.path, range: event.data.arguments.view_range ?? null,
      agentId: event.agentId ?? null, toolCallId: event.data.toolCallId, timestamp: event.timestamp,
    }));
  const searches = events.filter((event) => event.type === 'tool.execution_start'
    && ['rg', 'glob'].includes(event.data.toolName)).map((event) => ({
    tool: event.data.toolName, arguments: event.data.arguments, agentId: event.agentId ?? null,
    toolCallId: event.data.toolCallId,
  }));
  const answer = output?.trim() ?? '';
  const unboundStarts = events.filter((event) => event.type === 'subagent.started'
    && !launches.some((launch) => launch.toolCallId === event.data.toolCallId))
    .map((event) => ({ agentId: event.agentId, toolCallId: event.data.toolCallId, data: event.data }));
  return {
    sessionId: start?.data.sessionId ?? null, parentModel: start?.data.selectedModel ?? null,
    parentTier: start?.data.contextTier ?? null, copilotVersion: start?.data.copilotVersion ?? null,
    completion: completed ? 'completed' : 'inconclusive',
    outcome: !completed || !answer ? 'inconclusive-output'
      : unboundStarts.length ? 'inconclusive-classification' : launches.length === 0 ? 'direct-result' : 'delegated-result',
    classificationEvidence: unboundStarts.length ? 'incomplete' : launches.length === 0 ? 'none' : 'launch-receipts',
    launches, unboundStarts, reads, searches, output: answer,
  };
}
