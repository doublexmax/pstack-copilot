import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectDispatch, readEvents } from './copilot-dispatch-evidence.mjs';
import { resolveRole } from './context-routing.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const name = process.argv[i];
  if (!['--cli', '--out', '--model', '--case'].includes(name) || !process.argv[i + 1]) {
    throw new Error('usage: node verify-context-routing.mjs --cli <binary> --out <new-directory> [--model <id>] [--case bounded|large-corpus|opt-out|correction|unmanaged]');
  }
  if (options[name]) throw new Error(`duplicate option ${name}`);
  options[name] = process.argv[i + 1];
}
assert.ok(options['--cli'] && options['--out'], '--cli and --out are required');
assert.ok(process.env.COPILOT_GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
  'provide authentication in the process environment; the verifier never reads or writes credentials');
const cli = resolve(options['--cli']);
const out = resolve(options['--out']);
const model = options['--model'] ?? 'gpt-6.1-sol';
assert.ok(/^[a-z0-9][a-z0-9.-]*$/.test(model), 'invalid model ID');
assert.ok(!existsSync(out), 'use a new evidence directory; existing evidence is never overwritten');
mkdirSync(out, { recursive: true });
const resolver = join(ROOT, 'scripts', 'context-routing.mjs');
const observer = join(ROOT, 'scripts', 'context-proof-observer.mjs');
const installer = join(ROOT, 'scripts', 'install-always-on.mjs');
const cases = options['--case'] ? [options['--case']] : ['bounded', 'large-corpus', 'opt-out'];
assert.ok(cases.every((name) => ['bounded', 'large-corpus', 'opt-out', 'correction', 'unmanaged'].includes(name)), 'unknown verification case');

function artifactFiles() {
  const paths = execFileSync('git', ['-C', ROOT, 'ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
    .trim().split('\n').filter((name) => /^(skills|agents|always-on|scripts|docs)\//.test(name)
      || ['context.default.json', 'models.default.md', 'README.md'].includes(name));
  return paths.filter((name) => existsSync(join(ROOT, name))).sort().map((name) => ({
    path: name, sha256: createHash('sha256').update(readFileSync(join(ROOT, name))).digest('hex'),
  }));
}

const filesBefore = artifactFiles();
const headBefore = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

function prepare(name) {
  const dir = join(out, name);
  const home = join(dir, 'home');
  mkdirSync(join(home, 'agents'), { recursive: true });
  writeFileSync(join(home, 'settings.json'), `${JSON.stringify({ skillDirectories: [join(ROOT, 'skills')], contextTier: 'default' }, null, 2)}\n`);
  const models = readFileSync(join(ROOT, 'models.default.md'), 'utf8').match(/```\r?\n([\s\S]*?)\r?\n```/)[1]
    .replace(/^how explainer:\s*.+$/m, `how explainer: ${model} / max`)
    .replace(/^how explorer:\s*.+$/m, `how explorer: ${model} / max`);
  writeFileSync(join(home, 'pstack-models.md'), `${models}\n`);
  for (const file of readdirSync(join(ROOT, 'agents'))) {
    if (file.endsWith('.agent.md')) copyFileSync(join(ROOT, 'agents', file), join(home, 'agents', file));
  }
  const env = { ...process.env, COPILOT_HOME: home };
  const install = spawnSync(process.execPath, [installer, '--skip-trust', '--skip-shell'], { cwd: ROOT, env, encoding: 'utf8' });
  writeFileSync(join(dir, 'install.txt'), install.stdout + install.stderr);
  assert.equal(install.status, 0, install.stderr);
  const second = spawnSync(process.execPath, [installer, '--skip-trust', '--skip-shell'], { cwd: ROOT, env, encoding: 'utf8' });
  assert.equal(second.status, 0, second.stderr);
  const observations = join(dir, 'observations');
  const proofHooks = { version: 1, hooks: {
    preToolUse: [{ type: 'command', matcher: 'powershell', exec: process.execPath,
      args: [observer, 'pre', observations, resolver], timeoutSec: 30 }],
    postToolUse: [{ type: 'command', matcher: 'task', exec: process.execPath,
      args: [observer, 'post', observations, resolver], timeoutSec: 30 }],
  } };
  writeFileSync(join(home, 'hooks', 'zz-pstack-proof.json'), `${JSON.stringify(proofHooks, null, 2)}\n`);
  return { dir, home, env, observations,
    modelBytes: readFileSync(join(home, 'pstack-models.md')), settingsBytes: readFileSync(join(home, 'settings.json')),
    entryBytes: readFileSync(join(home, 'hooks', 'context-hook.mjs')) };
}

function run(f, label, prompt, resume) {
  const args = [
    '--model', model, '--reasoning-effort', 'max', '--context', 'default',
    '--no-auto-update', '--no-remote', '--no-remote-export', '--no-ask-user', '--disable-builtin-mcps',
    '--available-tools', 'task', 'skill', 'view', 'glob', 'rg', 'powershell', 'read_agent', 'sql',
    '--allow-tool', 'task', '--allow-tool', 'skill', '--allow-tool', 'view', '--allow-tool', 'glob',
    '--allow-tool', 'rg', '--allow-tool', 'powershell', '--allow-tool', 'read_agent', '--allow-tool', 'sql',
    '--allow-tool', 'shell(node:*)',
    '--deny-tool', 'write', '--add-dir', f.home, '--add-dir', ROOT,
    '--output-format', 'json', '--log-level', 'debug', '--log-dir', join(f.dir, `${label}-logs`),
    ...(resume ? ['--resume', resume] : []), '-p', prompt,
  ];
  const result = spawnSync(cli, args, { cwd: ROOT, env: f.env, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, timeout: 20 * 60 * 1000 });
  writeFileSync(join(f.dir, `${label}.jsonl`), result.stdout ?? '');
  writeFileSync(join(f.dir, `${label}.stderr.txt`), result.stderr ?? '');
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${label}: CLI failed; see ${f.dir}`);
  const streamed = (result.stdout ?? '').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const terminal = streamed.findLast((event) => event.type === 'result');
  assert.ok(terminal?.sessionId, `${label}: missing CLI result/session ID`);
  assert.equal(terminal.exitCode, 0, `${label}: CLI result did not succeed`);
  const events = readEvents(join(f.home, 'session-state', terminal.sessionId, 'events.jsonl'));
  assert.deepEqual(readFileSync(join(f.home, 'pstack-models.md')), f.modelBytes, 'the isolated model map changed');
  assert.deepEqual(readFileSync(join(f.home, 'settings.json')), f.settingsBytes, 'parent or per-agent preferences changed');
  assert.deepEqual(readFileSync(join(f.home, 'hooks', 'context-hook.mjs')), f.entryBytes, 'the copied production hook changed during the run');
  return { sessionId: terminal.sessionId, events, streamed };
}

function observations(f) {
  return existsSync(f.observations)
    ? readdirSync(f.observations).filter((name) => name.endsWith('.json')).map((name) => JSON.parse(readFileSync(join(f.observations, name), 'utf8')))
    : [];
}

function decisions(f, sessionId) {
  const dir = join(f.home, 'pstack-context-decisions', sessionId);
  assert.ok(existsSync(dir), 'missing native decision records');
  return readdirSync(dir).filter((name) => name.endsWith('.json')).map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')));
}

const readonly = [
  'This is read-only verification. Do not edit files, preferences, Git, or credentials.',
  'Use exactly one general-purpose explainer delegate with mode sync and wait for its result. No explorer fan-out or nested delegation.',
  `The only permitted shell command is node "${resolver}" resolve or show with literal arguments. Do not use variables, shell operators, or other commands.`,
  'The delegate may only read the requested material and return a concise answer.',
].join(' ');
const prompts = {
  bounded: `/how Explain only parseManagedBlock in scripts\\install-always-on.mjs. Its input and output contract is the whole task. Do not broaden to other helpers. ${readonly}`,
  'large-corpus': `/how Trace the context and model-selection contract jointly across models.default.md, always-on\\copilot-instructions.md, agents\\poteto.agent.md, agents\\poteto-worker.agent.md, the full how/why/architect/arena/swarm/interrogate/reflect/context-routing skills, all poteto-mode delegation playbooks, and the context resolver/hook/installer. This is one cross-document corpus comparison. The delegate must hold these contracts together, not partition them into independent helper tasks. The parent only loads routing and launches the reader; it must not audit the corpus itself before delegation. Return three evidenced invariants, not a general code-quality review. ${readonly}`,
};
const reports = [];
for (const name of cases) {
  const f = prepare(name);
  if (name === 'correction' || name === 'unmanaged') {
    console.log(`running native ${name} dispatch`);
    const plan = name === 'correction' ? resolveRole({
      role: 'how explainer', model, effort: 'max', workload: 'large-corpus',
      why: 'Compare the model, policy, and hook contracts together.', inputs: ['models.default.md', 'context.default.json', 'scripts\\context-hook.mjs'],
      hostContext: true, hostSource: 'Current CLI task context field, verified by natural workflow dispatch',
      support: 'supported', source: 'Exact-model long-context task support verified on this CLI by natural corpus dispatch',
    }, { home: f.home }) : null;
    const args = {
      agent_type: 'general-purpose', mode: 'sync', model, reasoning_effort: 'max',
      context_tier: name === 'correction' ? 'default' : 'long_context',
      name: name === 'correction' ? 'pstack-correction-proof' : 'ordinary-proof',
      description: 'Read the contracts',
      prompt: `${plan ? `${plan.declaration}\n` : ''}Read models.default.md, context.default.json, and scripts\\context-hook.mjs with view. Return NATIVE_PROOF. Do not delegate, invoke skills, run a shell, or write files.`,
    };
    const result = run(f, 'native-probe',
      `This is read-only native protocol verification. Use task exactly once with this exact JSON argument object. Do not change it, add a declaration, use skills, run a shell, or write files. Wait for the result. ${JSON.stringify(args)}`);
    const tier = 'long_context';
    const report = inspectDispatch({ events: result.events, observations: observations(f), expectedModel: model, expectedTier: tier });
    assert.ok(report.delegates.every((delegate) => delegate.requestedTier
      === (name === 'correction' ? 'default' : 'long_context')));
    if (name === 'correction') {
      assert.ok(decisions(f, result.sessionId).some((record) => record.name === args.name
        && record.status === 'resolved' && record.reason === 'eligible-large-corpus'));
    }
    writeFileSync(join(f.dir, 'dispatch-evidence.json'), `${JSON.stringify(report, null, 2)}\n`);
    reports.push({ case: name, ...report });
  } else if (name !== 'opt-out') {
    console.log(`running ${name} with an isolated Copilot home`);
    const result = run(f, 'workflow', prompts[name]);
    const report = inspectDispatch({
      events: result.events, observations: observations(f), expectedModel: model,
      expectedTier: name === 'bounded' ? 'default' : 'long_context',
    });
    const history = result.events.filter((event) => event.type === 'tool.execution_start');
    assert.ok(history.some((event) => event.data.toolName === 'skill' && event.data.arguments.skill === 'context-routing'),
      'the fresh workflow did not invoke context-routing');
    assert.ok(history.some((event) => event.data.toolName === 'powershell'
      && String(event.data.arguments.command).includes(resolver)), 'the workflow did not call the canonical resolver');
    const records = decisions(f, result.sessionId);
    assert.ok(records.some((record) => record.event === 'sessionStart' && record.reason === 'context-routing-ready'), 'missing automatic session hook');
    for (const delegate of report.delegates) {
      assert.ok(records.some((record) => record.event === 'preToolUse' && record.status === 'resolved'
        && record.name === delegate.name && record.effectiveModel === delegate.model
        && record.workload === name && record.tier === delegate.effectiveTier), 'missing delegate-bound workload decision');
    }
    writeFileSync(join(f.dir, 'dispatch-evidence.json'), `${JSON.stringify(report, null, 2)}\n`);
    reports.push({ case: name, ...report, decisionDirectory: join(f.home, 'pstack-context-decisions', result.sessionId) });
  } else {
    console.log('running whole-command opt-out, resume, and explicit re-entry');
    const skipped = run(f, 'skip', 'skip poteto mode');
    const marker = join(f.home, 'session-state', skipped.sessionId, 'files', 'pstack-context-opt-out');
    assert.ok(existsSync(marker), 'whole-command opt-out did not persist');
    const probe = [
      'Use task exactly once with agent_type general-purpose, mode sync,',
      `model ${model}, reasoning_effort max, context_tier long_context, name pstack-opt-out-proof,`,
      'description Read one file, and prompt Read models.default.md with view and return OPT_OUT_PROOF.',
      'Do not invoke any skills or add a pstack declaration. Do not write files or run a shell. Wait for its result.',
    ].join(' ');
    const resumed = run(f, 'resumed-probe', probe, skipped.sessionId);
    assert.equal(resumed.sessionId, skipped.sessionId, 'resume changed session identity');
    assert.ok(existsSync(marker), 'resume cleared the opt-out');
    const report = inspectDispatch({ events: resumed.events, observations: observations(f), expectedModel: model, expectedTier: 'long_context' });
    assert.ok(report.delegates.every((delegate) => delegate.requestedTier === 'long_context'), 'opt-out changed requested arguments');
    assert.ok(decisions(f, skipped.sessionId).some((record) => record.event === 'preToolUse' && record.scope === 'opt-out'), 'native hook ignored session opt-out');
    const entered = run(f, 're-entry', '/poteto-mode', skipped.sessionId);
    assert.equal(entered.sessionId, skipped.sessionId);
    assert.equal(existsSync(marker), false, 'explicit re-entry did not clear opt-out');
    assert.ok(decisions(f, skipped.sessionId).some((record) => record.event === 'userPromptSubmitted' && record.reason === 'explicit-re-entry'));
    writeFileSync(join(f.dir, 'dispatch-evidence.json'), `${JSON.stringify(report, null, 2)}\n`);
    reports.push({ case: name, ...report, optOutResumed: true, explicitReEntry: true });
  }
}
const filesAfter = artifactFiles();
assert.deepEqual(filesAfter, filesBefore, 'feature source files changed during verification; the run is not artifact-bound');
const evidence = {
  status: 'PASS', observedAt: new Date().toISOString(),
  cli, model, branch: execFileSync('git', ['-C', ROOT, 'branch', '--show-current'], { encoding: 'utf8' }).trim(),
  headCommit: headBefore,
  headAfter: execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  reports, files: filesBefore, filesAfter, sourceStable: true,
};
writeFileSync(join(out, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`PASS: ${reports.map((report) => report.case).join(', ')}; ${join(out, 'evidence.json')}`);
