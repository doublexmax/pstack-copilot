import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODES = new Set(['adaptive', 'default', 'long_context']);
const TIERS = new Set(['default', 'long_context']);
const SUPPORT = new Set(['supported', 'unsupported', 'unknown', 'unavailable']);
const ALIASES = new Set(['auto', 'inherit-parent']);
const EFFORTS = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
const TARGETS = new Set(['task', 'create_session', 'open_pr_session', 'open_issue_session']);
export const DECLARATION_PREFIX = 'PSTACK_CONTEXT_V1 ';

export function copilotHome(env = process.env) {
  return resolve(env.COPILOT_HOME || join(env.USERPROFILE || env.HOME || homedir(), '.copilot'));
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}: expected an object`);
  return value;
}

function fields(value, allowed, label) {
  object(value, label);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${label}: unknown field ${key}`);
  }
}

function text(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}: expected non-empty text`);
  return value;
}

function modelId(value, label) {
  text(value, label);
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(value) || ALIASES.has(value)) {
    throw new Error(`${label}: expected an actual model ID, not an alias`);
  }
  return value;
}

function readOptional(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function json(raw, label) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`${label}: invalid JSON`);
  }
  const containers = [];
  const tokens = /"(?:\\.|[^"\\])*"|[{}\[\]]/g;
  for (const match of raw.matchAll(tokens)) {
    const token = match[0];
    if (token === '{') containers.push(new Set());
    else if (token === '[') containers.push(null);
    else if (token === '}' || token === ']') containers.pop();
    else if (raw.slice(match.index + token.length).trimStart().startsWith(':')) {
      const key = JSON.parse(token);
      const keys = containers.at(-1);
      if (keys?.has(key)) throw new Error(`${label}: duplicate field ${key}`);
      keys?.add(key);
    }
  }
  return object(value, label);
}

function parseModels(raw, label, allowed, diagnostics = []) {
  const roles = new Map();
  const seen = new Set();
  for (const [index, line] of raw.replace(/\r\n/g, '\n').split('\n').entries()) {
    const row = line.trim();
    if (!row || row.startsWith('#') || row.startsWith('```')) continue;
    const match = /^([^:]+):\s*(.+)$/.exec(row);
    if (!match) throw new Error(`${label}:${index + 1}: expected role: model / effort`);
    const role = match[1].trim();
    if (seen.has(role)) throw new Error(`${label}:${index + 1}: duplicate role ${role}`);
    seen.add(role);
    const choices = match[2].split(',').map((item) => {
      const choice = item.trim();
      if (ALIASES.has(choice)) return { alias: choice };
      const pair = /^([a-z0-9][a-z0-9.-]*)\s*\/\s*([a-z]+)$/.exec(choice);
      if (!pair || !EFFORTS.has(pair[2]) || ALIASES.has(pair[1])) {
        throw new Error(`${label}:${index + 1}: invalid model / effort choice ${choice}`);
      }
      return { model: pair[1], reasoning_effort: pair[2] };
    });
    if (allowed && !allowed.has(role)) diagnostics.push(`retired-model-role:${role}`);
    else roles.set(role, choices);
  }
  return roles;
}

function defaultModels(root) {
  const file = join(root, 'models.default.md');
  const raw = readFileSync(file, 'utf8');
  const block = /```\r?\n([\s\S]*?)\r?\n```/.exec(raw);
  if (!block) throw new Error(`${file}: missing model role block`);
  const roles = parseModels(block[1], file);
  if (!roles.size) throw new Error(`${file}: empty model role block`);
  return roles;
}

function policy(raw, label, roles) {
  const value = json(raw, label);
  fields(value, ['schemaVersion', 'default', 'roles'], label);
  if (value.schemaVersion !== 1) throw new Error(`${label}: schemaVersion must be 1`);
  if (value.default !== undefined && !MODES.has(value.default)) throw new Error(`${label}: invalid default policy`);
  if (value.roles !== undefined) {
    object(value.roles, `${label}.roles`);
    for (const [role, mode] of Object.entries(value.roles)) {
      if (!roles.has(role)) throw new Error(`${label}: unknown role ${role}`);
      if (!MODES.has(mode)) throw new Error(`${label}: invalid policy for ${role}`);
    }
  }
  return value;
}

export function loadContextPolicy({ root = ROOT, home = copilotHome() } = {}) {
  const roles = defaultModels(root);
  const defaultsFile = join(root, 'context.default.json');
  const defaults = policy(readFileSync(defaultsFile, 'utf8'), defaultsFile, roles);
  if (!defaults.default) throw new Error(`${defaultsFile}: missing default policy`);
  const personalFile = join(home, 'pstack-context.json');
  const personalText = readOptional(personalFile);
  const personal = personalText === null ? {} : policy(personalText, personalFile, roles);
  return {
    policy: {
      schemaVersion: 1,
      default: personal.default ?? defaults.default,
      roles: { ...defaults.roles, ...personal.roles },
    },
    roles,
    policyFile: personalText === null ? defaultsFile : personalFile,
    personalFile,
  };
}

function declaration(raw, roles, target) {
  fields(raw, ['role', 'workload', 'why', 'inputs', 'host', 'modelSupport', 'parentModel'], 'declaration');
  if (!roles.has(raw.role)) throw new Error(`declaration: unknown role ${raw.role}`);
  if (!['bounded', 'large-corpus'].includes(raw.workload)) throw new Error('declaration: invalid workload');
  text(raw.why, 'declaration.why');
  if (!Array.isArray(raw.inputs) || raw.inputs.some((input) => typeof input !== 'string' || !input.trim())) {
    throw new Error('declaration.inputs: expected an array of input references');
  }
  if (raw.workload === 'large-corpus' && !raw.inputs.length) {
    throw new Error('declaration.inputs: large-corpus work needs input references');
  }
  fields(raw.host, ['tool', 'contextTier', 'source'], 'declaration.host');
  if (raw.host.tool !== target) throw new Error('declaration.host: evidence belongs to another tool');
  if (![true, false, null].includes(raw.host.contextTier)) throw new Error('declaration.host: invalid contextTier support');
  text(raw.host.source, 'declaration.host.source');
  fields(raw.modelSupport, ['model', 'status', 'source'], 'declaration.modelSupport');
  if (raw.modelSupport.model !== null) modelId(raw.modelSupport.model, 'declaration.modelSupport.model');
  if (!SUPPORT.has(raw.modelSupport.status)) throw new Error('declaration.modelSupport: invalid support status');
  text(raw.modelSupport.source, 'declaration.modelSupport.source');
  if (raw.parentModel !== undefined) modelId(raw.parentModel, 'declaration.parentModel');
  return raw;
}

function decide(context, declared, model, target) {
  const effectiveModel = model ?? (target === 'task' ? declared.parentModel ?? null : null);
  const mode = context.policy.roles[declared.role] ?? context.policy.default;
  const base = {
    role: declared.role,
    effectiveModel,
    workload: declared.workload,
    policy: mode,
    evidence: [context.policyFile, declared.host.source, declared.modelSupport.source],
    diagnostics: [],
  };
  const blocked = (reason) => ({ ...base, status: 'blocked', reason });
  const resolved = (tier, reason) => ({ ...base, status: 'resolved', tier, reason });
  if (declared.host.contextTier !== true) return blocked('host-context-field-unproven');
  if (effectiveModel !== null && declared.modelSupport.model !== effectiveModel) {
    return blocked('model-support-evidence-mismatch');
  }
  if (declared.modelSupport.status === 'unavailable') return blocked('model-unavailable');
  if (effectiveModel === null) {
    base.diagnostics.push(target === 'task' ? 'alias-parent-unresolved' : 'kickoff-model-unresolved');
  }
  if (declared.modelSupport.status === 'unknown') base.diagnostics.push('model-support-unknown');
  if (declared.modelSupport.status === 'unsupported') base.diagnostics.push('model-long-context-unsupported');
  if (mode === 'default') return resolved('default', 'policy-default');
  if (mode === 'adaptive' && declared.workload === 'bounded') return resolved('default', 'bounded-work');
  if (effectiveModel === null) {
    return mode === 'long_context' ? blocked('required-long-unproven') : resolved('default', base.diagnostics[0]);
  }
  if (declared.modelSupport.status !== 'supported') {
    return mode === 'long_context' ? blocked('required-long-unproven')
      : resolved('default', declared.modelSupport.status === 'unknown' ? 'model-support-unknown' : 'model-long-context-unsupported');
  }
  return resolved('long_context', mode === 'long_context' ? 'policy-long' : 'eligible-large-corpus');
}

function selectedModels(context, home) {
  const file = join(home, 'pstack-models.md');
  const raw = readOptional(file);
  const diagnostics = [];
  const overrides = raw === null ? new Map() : parseModels(raw, file, context.roles, diagnostics);
  return { choices: new Map([...context.roles, ...overrides]), diagnostics };
}

export function resolveRole(request, { root = ROOT, home = copilotHome() } = {}) {
  const context = loadContextPolicy({ root, home });
  const target = request.target ?? 'task';
  if (!TARGETS.has(target)) throw new Error(`unknown launch target ${target}`);
  const models = selectedModels(context, home);
  const choices = models.choices.get(request.role);
  if (!choices) throw new Error(`unknown role ${request.role}`);
  const member = request.member ?? 0;
  if (!Number.isSafeInteger(member) || member < 0 || member >= choices.length) throw new Error('invalid panel member');
  let choice = choices[member];
  if (request.model !== undefined) {
    if (ALIASES.has(request.model)) {
      if (request.effort !== undefined) throw new Error('an inherited model must omit reasoning effort');
      choice = { alias: request.model };
    } else {
      modelId(request.model, 'model');
      if (!EFFORTS.has(request.effort)) throw new Error('an explicit model needs its reasoning effort');
      choice = { model: request.model, reasoning_effort: request.effort };
    }
  } else if (request.effort !== undefined) throw new Error('reasoning effort needs an explicit model');
  const effectiveModel = choice.model ?? (target === 'task' ? request.parentModel ?? null : null);
  const declared = declaration({
    role: request.role,
    workload: request.workload,
    why: request.why,
    inputs: request.inputs ?? [],
    host: {
      tool: target,
      contextTier: request.hostContext ?? null,
      source: request.hostSource ?? 'No current host context-field evidence',
    },
    modelSupport: {
      model: effectiveModel,
      status: request.support ?? 'unknown',
      source: request.source ?? 'No current model support evidence',
    },
    ...(request.parentModel === undefined ? {} : { parentModel: request.parentModel }),
  }, context.roles, target);
  const decision = decide(context, declared, choice.model ?? null, target);
  decision.diagnostics.push(...models.diagnostics);
  const result = { decision, declaration: `${DECLARATION_PREFIX}${JSON.stringify(declared)}` };
  if (decision.status === 'resolved') {
    const args = { ...(choice.model ? choice : {}), context_tier: decision.tier };
    result.toolArguments = target === 'task' ? args : { kickoff: args };
  }
  return result;
}

export function routeToolCall(event, { root = ROOT, home = copilotHome(), optedOut = false } = {}) {
  if (!TARGETS.has(event.toolName)) return { scope: 'unmanaged', reason: 'not-a-delegate', output: {} };
  if (optedOut) return { scope: 'opt-out', reason: 'session-opt-out', output: {} };
  object(event.toolArgs, 'toolArgs');
  const launch = event.toolName === 'task' ? event.toolArgs : event.toolArgs.kickoff;
  const prompt = typeof launch?.prompt === 'string' ? launch.prompt : '';
  const managed = (event.toolName === 'task' && typeof launch.name === 'string' && launch.name.startsWith('pstack-'))
    || prompt.startsWith('PSTACK_CONTEXT_');
  if (!managed) return { scope: 'unmanaged', reason: 'no-pstack-declaration', output: {} };
  if (!prompt.startsWith(DECLARATION_PREFIX)) throw new Error('managed launch needs a PSTACK_CONTEXT_V1 declaration on line 1');
  const newline = prompt.indexOf('\n');
  const first = newline === -1 ? prompt : prompt.slice(0, newline).replace(/\r$/, '');
  if (newline >= 0 && prompt.slice(newline + 1).startsWith(DECLARATION_PREFIX)) throw new Error('duplicate launch declaration');
  const context = loadContextPolicy({ root, home });
  const declared = declaration(json(first.slice(DECLARATION_PREFIX.length), 'declaration'), context.roles, event.toolName);
  if (launch.model !== undefined) modelId(launch.model, 'toolArgs.model');
  if (launch.context_tier !== undefined && !TIERS.has(launch.context_tier)) throw new Error('invalid toolArgs.context_tier');
  if (launch.model === undefined && launch.reasoning_effort !== undefined) throw new Error('inherited model must omit reasoning_effort');
  const decision = decide(context, declared, launch.model ?? null, event.toolName);
  if (decision.status === 'blocked') {
    return { scope: 'managed', decision, output: {
      permissionDecision: 'deny',
      permissionDecisionReason: `pstack context routing: ${decision.reason}`,
    } };
  }
  const modifiedArgs = event.toolName === 'task'
    ? { ...event.toolArgs, context_tier: decision.tier }
    : { ...event.toolArgs, kickoff: { ...launch, context_tier: decision.tier } };
  return { scope: 'managed', decision, output: { modifiedArgs } };
}

export function configurePolicy({ defaultMode, roles = {} }, { root = ROOT, home = copilotHome() } = {}) {
  const context = loadContextPolicy({ root, home });
  const next = { ...context.policy, default: defaultMode ?? context.policy.default, roles: { ...context.policy.roles, ...roles } };
  const body = `${JSON.stringify(next, null, 2)}\n`;
  policy(body, context.personalFile, context.roles);
  if (readOptional(context.personalFile) !== body) {
    mkdirSync(dirname(context.personalFile), { recursive: true });
    writeFileSync(context.personalFile, body);
  }
  return { policyFile: context.personalFile, policy: next };
}

function parseArgs(argv) {
  const command = argv[0];
  if (!['resolve', 'set-policy', 'show'].includes(command)) throw new Error('expected resolve, set-policy, or show');
  const values = { inputs: [], roles: {} };
  const names = {
    '--role': 'role', '--workload': 'workload', '--why': 'why', '--member': 'member',
    '--model': 'model', '--effort': 'effort', '--parent-model': 'parentModel',
    '--support': 'support', '--source': 'source', '--host-context': 'hostContext',
    '--host-source': 'hostSource', '--target': 'target', '--default': 'defaultMode',
  };
  for (let i = 1; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    if (flag === '--input') values.inputs.push(value);
    else if (flag === '--role-policy') {
      const split = value.lastIndexOf('=');
      if (split < 1) throw new Error('--role-policy needs role=policy');
      const role = value.slice(0, split);
      if (Object.hasOwn(values.roles, role)) throw new Error(`duplicate role policy ${role}`);
      Object.defineProperty(values.roles, role, { value: value.slice(split + 1), enumerable: true });
    } else {
      const name = names[flag];
      if (!name) throw new Error(`unknown option ${flag}`);
      if (Object.hasOwn(values, name)) throw new Error(`duplicate option ${flag}`);
      values[name] = value;
    }
  }
  if (values.member !== undefined) {
    if (!/^(0|[1-9]\d*)$/.test(values.member)) throw new Error('invalid panel member');
    values.member = Number(values.member);
  }
  if (values.hostContext !== undefined) {
    if (!['supported', 'unsupported', 'unknown'].includes(values.hostContext)) throw new Error('invalid host context support');
    values.hostContext = values.hostContext === 'supported' ? true : values.hostContext === 'unsupported' ? false : null;
  }
  const allowed = command === 'resolve'
    ? ['inputs', 'roles', 'role', 'workload', 'why', 'member', 'model', 'effort', 'parentModel', 'support', 'source', 'hostContext', 'hostSource', 'target']
    : command === 'set-policy' ? ['inputs', 'roles', 'defaultMode'] : ['inputs', 'roles'];
  for (const key of Object.keys(values)) if (!allowed.includes(key)) throw new Error(`${command} does not accept ${key}`);
  if (command !== 'resolve' && values.inputs.length) throw new Error(`${command} does not accept --input`);
  if (command !== 'set-policy' && Object.keys(values.roles).length) throw new Error(`${command} does not accept --role-policy`);
  return { command, values };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { command, values } = parseArgs(process.argv.slice(2));
    const result = command === 'resolve' ? resolveRole(values)
      : command === 'set-policy' ? configurePolicy(values) : loadContextPolicy();
    console.log(JSON.stringify(command === 'show' ? { policy: result.policy, policyFile: result.policyFile } : result));
    if (result.decision?.status === 'blocked') process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ status: 'error', error: error.message }));
    process.exitCode = 1;
  }
}
