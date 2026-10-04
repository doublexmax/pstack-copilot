import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readEvents } from './copilot-dispatch-evidence.mjs';
import { inspectOrganicRouting } from './context-organic-evidence.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const name = process.argv[i];
  if (!['--cli', '--out', '--model', '--case', '--timeout-minutes'].includes(name) || !process.argv[i + 1]) {
    throw new Error('usage: node verify-context-organic.mjs --cli <binary> --out <new-directory> [--model <id>] [--case receipts|delivery] [--timeout-minutes 1..30]');
  }
  if (options[name]) throw new Error(`duplicate option ${name}`);
  options[name] = process.argv[i + 1];
}
assert.ok(options['--cli'] && options['--out'], '--cli and --out are required');
assert.ok(process.env.COPILOT_GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
  'provide authentication in the process environment; credentials are never read or written');
const cli = resolve(options['--cli']);
const out = resolve(options['--out']);
const model = options['--model'] ?? 'gpt-6.1-sol';
const minutes = Number(options['--timeout-minutes'] ?? 12);
assert.ok(/^[a-z0-9][a-z0-9.-]*$/.test(model), 'invalid model ID');
assert.ok(Number.isInteger(minutes) && minutes >= 1 && minutes <= 30, 'timeout must be 1..30 minutes');
assert.ok(!existsSync(out), 'use a new evidence directory; previous attempts are never overwritten');
mkdirSync(out, { recursive: true });

const scenarios = {
  receipts: {
    project: 'cedar-receipts',
    writable: ['src/amount.mjs'],
    prompt: 'Our printed receipts round small amounts to whole dollars. Fix formatAmount so every safe integer number of cents, including refunds, displays the exact amount with two decimal digits. Keep invalid inputs as errors and leave the receipt labels and surrounding output unchanged.',
    files: {
      'README.md': '# Cedar receipts\n\nThis package formats printed receipts. Run `node src/receipts.mjs` for sample output.\n',
      'package.json': '{"name":"cedar-receipts","private":true,"type":"module"}\n',
      'src/amount.mjs': "export function formatAmount(cents) {\n  if (!Number.isSafeInteger(cents)) throw new TypeError('cents must be a safe integer');\n  return `$${Math.round(cents / 100).toFixed(2)}`;\n}\n",
      'src/receipts.mjs': "import { formatAmount } from './amount.mjs';\n\nexport function receiptLine(id, cents) {\n  return `${id} ${formatAmount(cents)}`;\n}\n\nconsole.log(receiptLine('INV-17', 105));\nconsole.log(receiptLine('REF-2', -1));\n",
    },
    expected: [
      'Format safe integer cents exactly, including zero, cents below one dollar, and negative refunds.',
      'Reject non-integers, non-numbers, and unsafe integers.',
      'Keep the receipt entry point and labels unchanged.',
      'Justify any decomposition from actual inputs; direct completion is valid.',
    ],
  },
  delivery: {
    project: 'cedar-delivery',
    writable: [],
    prompt: 'Before we connect receipt delivery to our storefront, trace a purchase through intake, the queue, retries, the mail provider, and delivery history. What happens when the same purchase arrives twice, the provider accepts a receipt but the worker loses the connection, or the provider rate-limits us? Explain the duplicate or missing-receipt risks and recommend the smallest safe corrections. Leave the code as it is.',
    files: {
      'README.md': '# Cedar delivery\n\nThe storefront publishes purchases through `src/api/purchases.mjs`. A worker sends receipts and records delivery history. The queue provides at-least-once delivery.\n',
      'package.json': '{"name":"cedar-delivery","private":true,"type":"module"}\n',
      'config/pipeline.json': '{"maximumAttempts":3,"visibilitySeconds":60}\n',
      'docs/queue.md': '# Purchase queue\n\nA purchase can be published more than once. A lease increments attempts. An acknowledgement removes the message. Retry preserves the payload and key. A dead letter needs manual redelivery.\n',
      'docs/provider.md': '# Mail provider\n\nThe provider accepts an idempotency key with each request and remembers it for 24 hours. It can accept a receipt before the response connection closes. HTTP 429 is temporary and requires retry.\n',
      'docs/history.md': '# Delivery history\n\nHistory maps the account and purchase key to a provider receipt ID. The worker writes history after the provider responds. A history lookup is not a reservation or a lock.\n',
      'src/domain/key.mjs': "export function receiptKey(accountId, purchaseId) {\n  return `${accountId}/${purchaseId}`;\n}\n",
      'src/api/purchases.mjs': "import { receiptKey } from '../domain/key.mjs';\n\nexport async function submitPurchase(purchase, queue) {\n  if (!purchase.accountId || !purchase.purchaseId || !purchase.email) throw new TypeError('missing purchase identity');\n  await queue.publish({ ...purchase, key: receiptKey(purchase.accountId, purchase.purchaseId) });\n  return { status: 202 };\n}\n",
      'src/queue/memory.mjs': "export class PurchaseQueue {\n  messages = new Map();\n  sequence = 0;\n  async publish(payload) {\n    const id = ++this.sequence;\n    this.messages.set(id, { id, payload, attempts: 0, state: 'ready' });\n    return id;\n  }\n  async lease(id) {\n    const message = this.messages.get(id);\n    message.state = 'leased';\n    message.attempts += 1;\n    return message;\n  }\n  async ack(message) { this.messages.delete(message.id); }\n  async retry(message) { message.state = 'ready'; }\n  async deadLetter(message) { message.state = 'dead'; }\n}\n",
      'src/storage/history.mjs': "export class DeliveryHistory {\n  receipts = new Map();\n  async delivered(key) { return this.receipts.has(key); }\n  async record(key, receiptId) { this.receipts.set(key, receiptId); }\n}\n",
      'src/provider/mail.mjs': "export function mailProvider(http) {\n  return {\n    async send(purchase) {\n      const response = await http.post('/receipts', {\n        email: purchase.email, purchaseId: purchase.purchaseId, totalCents: purchase.totalCents,\n      });\n      return response.receiptId;\n    },\n  };\n}\n",
      'src/worker/delivery.mjs': "export async function deliver(message, { queue, provider, history }) {\n  const purchase = message.payload;\n  if (await history.delivered(purchase.key)) {\n    await queue.ack(message);\n    return 'already-delivered';\n  }\n  const receiptId = await provider.send(purchase);\n  await history.record(purchase.key, receiptId);\n  await queue.ack(message);\n  return 'delivered';\n}\n",
      'src/worker/process.mjs': "import { deliver } from './delivery.mjs';\n\nexport async function processMessage(message, services, maximumAttempts) {\n  try {\n    return await deliver(message, services);\n  } catch (error) {\n    const retryable = error.status >= 500 || error.code === 'ECONNRESET';\n    if (retryable && message.attempts < maximumAttempts) {\n      await services.queue.retry(message);\n      return 'retry';\n    }\n    await services.queue.deadLetter(message);\n    return 'dead-letter';\n  }\n}\n",
    },
    expected: [
      'Sequential repeated purchases are acknowledged after successful recorded delivery, but simultaneous duplicates can both pass the history lookup.',
      'Post-accept connection loss leaves history unwritten; retry can resend because the stable purchase key never reaches the provider idempotency field.',
      'HTTP 429 incorrectly goes to dead-letter rather than automatic retry. A missing receipt requires manual redelivery.',
      'Use the stable account/purchase key at the provider boundary and include rate limiting in retry classification. Do not claim a history lock alone closes the post-accept gap.',
      'Keep project files unchanged and support conclusions with the actual code and provider contract.',
    ],
  },
};
const names = options['--case'] ? [options['--case']] : Object.keys(scenarios);
assert.ok(names.every((name) => scenarios[name]), 'unknown organic request');
const hiddenWords = /\b(?:eval|test|judge|experiment|rubric|score|compare|benchmark|candidate|arena)\b/i;
for (const name of names) {
  const scenario = scenarios[name];
  assert.equal(hiddenWords.test(scenario.project + scenario.prompt), false, 'organic name or prompt leaked the frame');
  for (const [file, content] of Object.entries(scenario.files)) {
    assert.equal(hiddenWords.test(file + content), false, 'project material leaked the frame');
  }
}

function files(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const name = `${prefix}${entry.name}`;
    return entry.isDirectory() ? files(join(dir, entry.name), `${name}/`) : [name];
  });
}

function hashes(dir, paths) {
  return paths.map((path) => ({
    path, sha256: existsSync(join(dir, path))
      ? createHash('sha256').update(readFileSync(join(dir, path))).digest('hex') : null,
  }));
}

function sourcePaths() {
  return execFileSync('git', ['-C', ROOT, 'ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
    .trim().split('\n').filter((name) => /^(skills|agents|always-on|scripts|docs)\//.test(name)
      || ['README.md', 'context.default.json', 'models.default.md'].includes(name)).sort();
}

function save(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
}

const sourceBefore = hashes(ROOT, sourcePaths());
const headBefore = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
save(join(out, 'expectations.json'), {
  variant: 'Integrated adaptive context routing with copied agents and native hooks.',
  scope: 'Classification and useful project output, not model quality, context-tier quality, efficiency, speed, or cost.',
  criteria: [
    'Complete the ordinary request with the expected behavior.',
    'Base decomposition and workload classification on the actual input set, not a desired tier.',
    'Keep requested, post-hook, and effective configurations distinct and preserve the approved model and effort.',
    'Verify reads and outputs from durable native events and files, not an agent self-report.',
    'Preserve the feature source and isolated integration throughout every attempt.',
  ],
  requests: Object.fromEntries(names.map((name) => [name, scenarios[name].expected])),
});

function prepare(name) {
  const scenario = scenarios[name];
  const base = mkdtempSync(join(tmpdir(), `${scenario.project}-`));
  const project = join(base, scenario.project);
  const user = join(base, 'user');
  const home = join(user, '.copilot');
  const pstack = join(home, 'pstack');
  mkdirSync(project, { recursive: true });
  for (const [file, content] of Object.entries(scenario.files)) {
    mkdirSync(dirname(join(project, file)), { recursive: true });
    writeFileSync(join(project, file), content);
  }
  const installation = sourceBefore.map((row) => row.path).filter((file) =>
    (file.startsWith('skills/') && !/\.test\./.test(file)) || file.startsWith('agents/')
    || file.startsWith('always-on/') || ['models.default.md', 'context.default.json',
      'scripts/context-routing.mjs', 'scripts/context-hook.mjs', 'scripts/install-always-on.mjs'].includes(file));
  for (const file of installation) {
    mkdirSync(dirname(join(pstack, file)), { recursive: true });
    copyFileSync(join(ROOT, file), join(pstack, file));
  }
  mkdirSync(join(home, 'agents'));
  for (const file of readdirSync(join(pstack, 'agents'))) {
    if (file.endsWith('.agent.md')) copyFileSync(join(pstack, 'agents', file), join(home, 'agents', file));
  }
  writeFileSync(join(home, 'settings.json'), `${JSON.stringify({
    skillDirectories: [join(pstack, 'skills')], contextTier: 'default',
  }, null, 2)}\n`);
  const defaults = readFileSync(join(pstack, 'models.default.md'), 'utf8').match(/```\r?\n([\s\S]*?)\r?\n```/)[1];
  const models = defaults.replace(/^([^:\r\n]+):[^\r\n]+$/gm, (_, role) => `${role}: ${model} / max`);
  assert.equal(models.split(/\r?\n/).filter((line) => line.includes(':')).length, 17);
  writeFileSync(join(home, 'pstack-models.md'), `${models}\n`);
  const env = { ...process.env, COPILOT_HOME: home, HOME: user, USERPROFILE: user,
    COPILOT_ALLOW_ALL: '', COPILOT_ASSISTED_APPROVAL: '', PSTACK_PROFILE_PATH: '', PSTACK_SHELL_RC: '' };
  const install = spawnSync(process.execPath, [join(pstack, 'scripts', 'install-always-on.mjs'),
    '--skip-trust', '--skip-shell'], { cwd: project, env, encoding: 'utf8' });
  const dir = join(out, name);
  mkdirSync(dir);
  writeFileSync(join(dir, 'install.txt'), install.stdout + install.stderr);
  assert.equal(install.status, 0, install.stderr);
  const observer = join(home, 'hooks', 'operations.mjs');
  copyFileSync(join(ROOT, 'scripts', 'context-organic-observer.mjs'), observer);
  save(join(home, 'hooks', 'zz-operations.json'), { version: 1, hooks: {
    preToolUse: [{ type: 'command', exec: process.execPath,
      args: [observer, 'pre', project, home, model, ...scenario.writable], timeoutSec: 30 }],
    postToolUse: [{ type: 'command', exec: process.execPath,
      args: [observer, 'post', project, home, model, ...scenario.writable], timeoutSec: 30 }],
  } });
  const protectedPaths = files(home);
  return { name, scenario, project, home, env, dir, protectedPaths,
    protectedBefore: hashes(home, protectedPaths), projectBefore: hashes(project, files(project)),
    sessionId: randomUUID() };
}

function run(f) {
  const args = [
    '--agent', 'poteto', '--model', model, '--reasoning-effort', 'max', '--context', 'default',
    '--session-id', f.sessionId, '--no-auto-update', '--no-remote', '--no-remote-export', '--no-ask-user',
    '--disable-builtin-mcps', '--disallow-temp-dir', '--max-ai-credits', '64',
    '--secret-env-vars', 'COPILOT_GITHUB_TOKEN,GH_TOKEN,GITHUB_TOKEN',
    '--available-tools', 'task', 'skill', 'view', 'glob', 'rg', 'powershell', 'read_powershell',
    'read_agent', 'sql', 'update_todo', 'apply_patch', 'create', 'edit',
    '--allow-tool', 'task', '--allow-tool', 'skill', '--allow-tool', 'view', '--allow-tool', 'glob',
    '--allow-tool', 'rg', '--allow-tool', 'powershell', '--allow-tool', 'read_powershell',
    '--allow-tool', 'read_agent', '--allow-tool', 'sql', '--allow-tool', 'update_todo', '--allow-tool', 'write',
    '--allow-tool', 'apply_patch', '--allow-tool', 'create', '--allow-tool', 'edit', '--allow-tool', 'shell(node:*)',
    '--add-dir', f.home, '--output-format', 'json', '--log-level', 'debug', '--log-dir', join(f.dir, 'logs'),
    '-p', f.scenario.prompt,
  ];
  save(join(f.dir, 'invocation.json'), { cli, args, cwd: f.project, home: f.home, sessionId: f.sessionId });
  console.log(`running ordinary request in ${f.project}`);
  return new Promise((finish) => {
    const child = spawn(cli, args, { cwd: f.project, env: f.env });
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    let error = null;
    child.stdout.on('data', (data) => stdout.push(data));
    child.stderr.on('data', (data) => stderr.push(data));
    child.on('error', (value) => { error = value.message; });
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) {
        if (process.platform === 'win32') {
          spawnSync('powershell.exe', ['-NoProfile', '-Command', `Stop-Process -Id ${child.pid} -Force`], { encoding: 'utf8' });
        } else child.kill('SIGTERM');
      }
    }, minutes * 60 * 1000);
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      const text = Buffer.concat(stdout).toString('utf8');
      writeFileSync(join(f.dir, 'workflow.jsonl'), text, { flag: 'wx' });
      writeFileSync(join(f.dir, 'stderr.txt'), Buffer.concat(stderr), { flag: 'wx' });
      const streamed = text.trim().split(/\r?\n/).filter(Boolean).flatMap((line) => {
        try { return [JSON.parse(line)]; }
        catch { return []; }
      });
      const terminal = streamed.findLast((event) => event.type === 'result');
      const eventFile = join(f.home, 'session-state', f.sessionId, 'events.jsonl');
      const events = existsSync(eventFile) ? readEvents(eventFile) : [];
      const messages = events.filter((event) => event.type === 'assistant.message' && !event.agentId
        && typeof event.data.content === 'string' && !(event.data.toolRequests?.length));
      const output = messages.at(-1)?.data.content ?? '';
      const records = join(f.home, 'operation-records');
      const observations = existsSync(records) ? readdirSync(records).filter((file) => file.startsWith('post-'))
        .map((file) => JSON.parse(readFileSync(join(records, file), 'utf8'))) : [];
      const decisionDir = join(f.home, 'pstack-context-decisions', f.sessionId);
      const decisions = existsSync(decisionDir) ? readdirSync(decisionDir)
        .map((file) => JSON.parse(readFileSync(join(decisionDir, file), 'utf8'))) : [];
      const completed = !timedOut && !error && exitCode === 0 && terminal?.exitCode === 0
        && terminal.sessionId === f.sessionId;
      const report = inspectOrganicRouting({ events, observations, decisions, completed, output });
      const protectedAfter = hashes(f.home, f.protectedPaths);
      const projectAfter = hashes(f.project, files(f.project));
      const allowed = new Set(f.scenario.writable);
      const stableProject = f.projectBefore.filter((row) => !allowed.has(row.path));
      const stableAfter = projectAfter.filter((row) => !allowed.has(row.path));
      const integrity = {
        protectedBefore: f.protectedBefore, protectedAfter,
        integrationStable: JSON.stringify(f.protectedBefore) === JSON.stringify(protectedAfter),
        projectBefore: f.projectBefore, projectAfter,
        scopeStable: JSON.stringify(stableProject) === JSON.stringify(stableAfter),
      };
      const boundaryDenials = existsSync(records) ? readdirSync(records).filter((file) => file.startsWith('pre-'))
        .map((file) => JSON.parse(readFileSync(join(records, file), 'utf8'))).filter((record) => record.boundaryDenial) : [];
      writeFileSync(join(f.dir, 'answer.txt'), report.output, { flag: 'wx' });
      const result = { case: f.name, ...report, exitCode, signal, timedOut, error, project: f.project, home: f.home,
        terminal: terminal ?? null, integrity, boundaryDenials, expectedBehavior: f.scenario.expected };
      save(join(f.dir, 'receipt.json'), result);
      finish({ f, report: result });
    });
  });
}

function validateAmounts(f) {
  const module = pathToFileURL(join(f.project, 'src', 'amount.mjs')).href;
  const code = [
    "import assert from 'node:assert/strict';",
    `import { formatAmount } from ${JSON.stringify(module)};`,
    "for (const [cents, dollars] of [[0,'$0.00'],[1,'$0.01'],[10,'$0.10'],[105,'$1.05'],[-1,'$-0.01'],[-105,'$-1.05'],[123456,'$1234.56'],[9007199254740991,'$90071992547409.91'],[-9007199254740991,'$-90071992547409.91']]) assert.equal(formatAmount(cents), dollars);",
    "for (const cents of [1.5, NaN, Infinity, '105', null, 9007199254740992]) assert.throws(() => formatAmount(cents));",
  ].join('\n');
  const env = { ...f.env };
  for (const name of ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']) delete env[name];
  const amount = spawnSync(process.execPath, ['--input-type=module', '-e', code],
    { cwd: f.project, env, encoding: 'utf8', timeout: 10000 });
  const entry = spawnSync(process.execPath, ['src/receipts.mjs'],
    { cwd: f.project, env, encoding: 'utf8', timeout: 10000 });
  const result = {
    status: amount.status === 0 && entry.status === 0 && entry.stdout === 'INV-17 $1.05\nREF-2 $-0.01\n' ? 'PASS' : 'ISSUES',
    amountExit: amount.status, amountError: amount.stderr, entryExit: entry.status,
    entryOutput: entry.stdout, expectedEntryOutput: 'INV-17 $1.05\nREF-2 $-0.01\n',
  };
  save(join(f.dir, 'artifact-checks.json'), result);
  return result;
}

const fixtures = names.map(prepare);
const results = await Promise.all(fixtures.map(run));
for (const result of results) {
  result.report.artifactChecks = result.f.scenario === scenarios.receipts
    ? validateAmounts(result.f)
    : { status: 'REVIEW_REQUIRED', expected: result.f.scenario.expected,
      answer: join(result.f.dir, 'answer.txt'), sourceUnchanged: result.report.integrity.scopeStable };
}
const sourceAfter = hashes(ROOT, sourcePaths());
const sourceStable = JSON.stringify(sourceBefore) === JSON.stringify(sourceAfter);
const reports = results.map((result) => result.report);
const integrityStable = reports.every((report) => report.integrity.integrationStable && report.integrity.scopeStable);
const evidence = {
  status: !sourceStable || !integrityStable ? 'ISSUES' : reports.every((report) => report.completion === 'completed') ? 'RECORDED' : 'INCONCLUSIVE',
  observedAt: new Date().toISOString(), cli, model, reasoningEffort: 'max',
  headBefore, headAfter: execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  sourceBefore, sourceAfter, sourceStable, reports,
  limits: 'No quality or efficiency improvement is measured. Direct output and bounded decomposition are valid. Large-corpus justifications and prose correctness require artifact review.',
};
save(join(out, 'evidence.json'), evidence);
writeFileSync(join(out, 'findings.md'), [
  '# Organic routing findings', '',
  'The integrated feature ran on ordinary project requests. The prompts did not prescribe decomposition, models, skills, workload labels, or context tiers.',
  'The isolated role map selected the approved model and effort. Each invocation requested default parent context. Receipts record the effective value.',
  'This is evidence about classification and project output. It is not a quality, speed, efficiency, or cost improvement claim.', '',
  ...reports.flatMap((report) => [
    `## ${report.case}`, '',
    `The request produced ${report.outcome}. Completion was ${report.completion}.`,
    `Artifact validation is ${report.artifactChecks.status}. Read the answer, launch receipts, and independent expectations before accepting a classification.`,
    ...report.launches.map((launch) => `- ${launch.name} recorded ${launch.outcome}. Requested ${launch.requestedTier}, post-hook ${launch.postHookTier}, effective ${launch.effectiveTier}.`),
    report.launches.length || report.unboundStarts.length ? '' : 'No delegate launched. This provides no delegate-classification evidence.', '',
  ]),
  `The feature source hash check returned ${sourceStable}. The isolated integration and protected project hash checks returned ${integrityStable}.`,
  'Every attempt remains in its receipt directory. No prompt was expanded to obtain a preferred tier.', '',
].join('\n'), { flag: 'wx' });
console.log(`${evidence.status}: ${join(out, 'evidence.json')}`);
process.exitCode = evidence.status === 'ISSUES' ? 1 : 0;
