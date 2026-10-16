import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ENTRY_VERSION = 'pstack-context-entry-v1';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PHASES = new Set(['sessionStart', 'userPromptSubmitted', 'preToolUse', 'postToolUse']);

function copilotHome() {
  return resolve(process.env.COPILOT_HOME || join(process.env.USERPROFILE || process.env.HOME || homedir(), '.copilot'));
}

function managed(event) {
  const launch = event.toolName === 'task' ? event.toolArgs : event.toolArgs?.kickoff;
  return (event.toolName === 'task' && typeof launch?.name === 'string' && launch.name.startsWith('pstack-'))
    || (typeof launch?.prompt === 'string' && launch.prompt.startsWith('PSTACK_CONTEXT_'));
}

function statePath(home, sessionId) {
  if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error('invalid hook sessionId');
  return join(home, 'session-state', sessionId, 'files', 'pstack-context-opt-out');
}

function wholeCommand(prompt) {
  if (typeof prompt !== 'string') return null;
  const command = prompt.trim().toLowerCase();
  if (command === 'skip poteto mode') return 'off';
  if (command === '/poteto-mode') return 'on';
  return null;
}

function applyCommand(prompt, file) {
  const command = wholeCommand(prompt);
  if (command === 'off') {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'disabled\n');
  } else if (command === 'on' && existsSync(file)) unlinkSync(file);
  return command;
}

function record(home, phase, event, result) {
  const value = {
    ...result.dispatch,
    schemaVersion: 1,
    event: phase,
    sessionId: event.sessionId,
    timestamp: event.timestamp,
    tool: event.toolName ?? null,
    scope: result.scope,
    name: event.toolArgs?.name ?? null,
    ...(result.decision ?? (result.dispatch ? {} : { reason: result.reason })),
    ...(result.launchKey === undefined ? {} : { launchKey: result.launchKey }),
    ...(result.dispatchRecord === undefined ? {} : { dispatchRecord: result.dispatchRecord }),
    ...(result.observedTier === undefined ? {} : { observedTier: result.observedTier, observation: result.observation }),
  };
  const body = `${JSON.stringify(value)}\n`;
  const hash = createHash('sha256').update(body).digest('hex');
  const dir = join(home, 'pstack-context-decisions', event.sessionId);
  const file = join(dir, `${phase}-${hash}.json`);
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(file, body, { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (readFileSync(file, 'utf8') !== body) throw new Error('context decision record collision');
  }
  return value;
}

function respond(home, phase, event, result) {
  try {
    return { output: result.output ?? {}, record: record(home, phase, event, result) };
  } catch (error) {
    if (result.scope !== 'opt-out') throw error;
    return {
      output: result.output ?? {},
      record: { scope: result.scope, status: 'unrecorded', reason: 'diagnostics-write-failed' },
      warning: error.message,
    };
  }
}

function launchKey(event) {
  const args = event.toolName === 'task'
    ? { ...event.toolArgs, context_tier: undefined }
    : { ...event.toolArgs, kickoff: { ...event.toolArgs.kickoff, context_tier: undefined } };
  const body = JSON.stringify([event.toolName, args], (key, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map((name) => [name, value[name]])) : value);
  return createHash('sha256').update(body).digest('hex');
}

function observe(home, event) {
  const dir = join(home, 'pstack-context-decisions', event.sessionId);
  const key = launchKey(event);
  const records = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.json'))
    .map((name) => ({ name, value: JSON.parse(readFileSync(join(dir, name), 'utf8')) })) : [];
  const consumed = new Set(records.filter(({ value }) => value.event === 'postToolUse'
    && value.timestamp !== event.timestamp).map(({ value }) => value.dispatchRecord));
  const candidates = records.filter(({ name, value }) => value.event === 'preToolUse'
    && value.launchKey === key && value.timestamp <= event.timestamp && !consumed.has(name)
    && (value.status === 'resolved' || value.scope === 'opt-out'));
  if (candidates.length !== 1) {
    const reason = candidates.length ? 'ambiguous-dispatch-decision' : 'missing-dispatch-decision';
    return {
      output: { additionalContext: `Pstack context observation unverified: ${reason}.` },
      record: record(home, 'postToolUse', event, {
        scope: 'managed', launchKey: key, decision: { status: 'unverified', reason },
      }),
    };
  }
  const { name, value: dispatch } = candidates[0];
  const launch = event.toolName === 'task' ? event.toolArgs : event.toolArgs.kickoff;
  const observedTier = launch.context_tier ?? null;
  const observation = observedTier === dispatch.tier ? 'matched' : 'mismatch';
  const result = { scope: dispatch.scope, dispatch, dispatchRecord: name,
    ...(dispatch.scope === 'opt-out' ? {} : { observedTier, observation }) };
  return {
    output: dispatch.scope !== 'opt-out' && observation === 'mismatch'
      ? { additionalContext: `Pstack context mismatch: expected ${dispatch.tier}, observed ${observedTier ?? 'no tier'}.` } : {},
    record: record(home, 'postToolUse', event, result),
  };
}

export function runHook(phase, event, { root = ROOT, home = copilotHome(), routing } = {}) {
  if (!PHASES.has(phase)) throw new Error(`unknown hook event ${phase}`);
  if (['preToolUse', 'postToolUse'].includes(phase) && !managed(event)) return { output: {} };
  const state = statePath(home, event.sessionId);
  if (!Number.isSafeInteger(event.timestamp) || event.timestamp < 0) throw new Error('invalid hook timestamp');
  if (phase === 'userPromptSubmitted') {
    const command = applyCommand(event.prompt, state);
    if (command === null) return { output: {} };
    const result = {
      scope: existsSync(state) ? 'opt-out' : 'session',
      reason: command === 'off' ? 'session-opt-out' : 'explicit-re-entry',
    };
    return respond(home, phase, event, result);
  }
  if (phase === 'sessionStart') {
    applyCommand(event.initialPrompt, state);
    if (existsSync(state)) {
      const result = { scope: 'opt-out', reason: 'session-opt-out' };
      return respond(home, phase, event, {
        ...result,
        output: { additionalContext: `Pstack context routing is off for this session, including resume. Submit /poteto-mode to re-enter. State: ${state}.` },
      });
    }
    const context = routing.loadContextPolicy({ root, home });
    const result = { scope: 'session', reason: 'context-routing-ready' };
    return {
      output: { additionalContext: [
        'Pstack context routing is available. Before each pstack-managed task or session kickoff, invoke the context-routing skill.',
        `Policy file is ${context.policyFile}. Default policy is ${context.policy.default}.`,
        `Machine-readable decisions are in ${join(home, 'pstack-context-decisions', event.sessionId)}.`,
      ].join('\n') },
      record: record(home, phase, event, result),
    };
  }
  if (phase === 'postToolUse') return observe(home, event);
  const optedOut = existsSync(state);
  let result;
  try {
    result = optedOut ? { scope: 'opt-out', reason: 'session-opt-out', output: {} }
      : routing.routeToolCall(event, { root, home });
  } catch (error) {
    result = {
      scope: 'managed',
      reason: 'invalid-context-launch',
      decision: { status: 'blocked', reason: 'invalid-context-launch', error: error.message },
      output: { permissionDecision: 'deny', permissionDecisionReason: `pstack context routing: ${error.message}` },
    };
  }
  return respond(home, phase, event, { ...result, launchKey: launchKey(event) });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const phase = process.argv[2];
  try {
    const event = JSON.parse(readFileSync(0, 'utf8'));
    if (['preToolUse', 'postToolUse'].includes(phase) && !managed(event)) {
      console.error(JSON.stringify({ scope: 'unmanaged', reason: 'no-pstack-declaration' }));
      console.log('{}');
      process.exit(0);
    }
    const home = copilotHome();
    const root = resolve(process.argv[3] || ROOT);
    const optedOut = typeof event.sessionId === 'string' && /^[a-zA-Z0-9_-]+$/.test(event.sessionId)
      && existsSync(statePath(home, event.sessionId));
    const needsRouting = (!optedOut || wholeCommand(event.initialPrompt) === 'on')
      && (phase === 'sessionStart' && wholeCommand(event.initialPrompt) !== 'off'
      || phase === 'preToolUse');
    const routing = needsRouting
      ? await import(pathToFileURL(join(root, 'scripts', 'context-routing.mjs')).href) : undefined;
    const result = runHook(phase, event, { root, home, routing });
    if (result.warning) console.error(JSON.stringify({ status: 'warning', scope: result.record.scope, error: result.warning }));
    console.log(JSON.stringify(result.output));
  } catch (error) {
    console.error(JSON.stringify({ status: 'error', event: phase, error: error.message }));
    if (phase === 'sessionStart') {
      console.log(JSON.stringify({ additionalContext: `Pstack context hook failed: ${error.message}. Routing is unverified. Repair the installation before a managed launch.` }));
    }
    process.exitCode = 1;
  }
}
