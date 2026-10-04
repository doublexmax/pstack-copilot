import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REQUIRED_BINDINGS = [
  'agents/poteto.agent.md', 'agents/poteto-worker.agent.md', 'always-on/copilot-instructions.md',
  ...['poteto-mode', 'how', 'why', 'architect', 'arena', 'swarm', 'interrogate', 'reflect',
    'no-comments', 'show-me-your-work', 'recall', 'figure-it-out', 'setup-pstack',
    'principle-guard-the-context-window'].map((skill) => `skills/${skill}/SKILL.md`),
  ...['feature', 'bug-fix', 'perf-issue', 'hillclimb', 'refactoring', 'autonomous-run',
    'autopilot-full', 'autopilot-stack', 'orchestrate', 'multi-phase-plan',
    'worktree-cleanup', 'opening-a-pr'].map((book) => `skills/poteto-mode/playbooks/${book}.md`),
];

function markdown(dir, files = []) {
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const file = join(dir, entry.name);
    if (entry.isDirectory()) markdown(file, files);
    else if (entry.name === 'SKILL.md' || entry.name.endsWith('.agent.md')
      || file.includes(`${join('poteto-mode', 'playbooks')}`) && entry.name.endsWith('.md')) files.push(file);
  }
  return files;
}

export function checkBindings(root) {
  const errors = [];
  const canonical = resolve(root, 'skills', 'context-routing', 'SKILL.md');
  const known = new Set(REQUIRED_BINDINGS.map((file) => resolve(root, file)));
  const files = new Set([...known, ...markdown(join(root, 'skills')), ...markdown(join(root, 'agents'))]);
  for (const file of files) {
    const name = relative(root, file).replaceAll('\\', '/');
    if (!existsSync(file)) {
      errors.push(`${name}: missing required context binding`);
      continue;
    }
    if (file === canonical) continue;
    const body = readFileSync(file, 'utf8').replace(/^---[\s\S]*?\n---\r?\n/, '');
    const delegates = /reasoning_effort|create_session|\b(?:spawn|delegate|hand)\b[^\n]*(?:subagent|task|worker|reviewer)|\blaunch\b[^\n]*(?:subagent|delegate|worker|reviewer)/i.test(body);
    if (!known.has(file) && !delegates) continue;
    if (name === 'always-on/copilot-instructions.md') {
      if (!/invoke the\s*\r?\n?\s*`context-routing` skill/i.test(body)) errors.push(`${name}: missing automatic context-routing trigger`);
      continue;
    }
    const links = [...body.matchAll(/\]\(([^)\s]+)\)/g)]
      .some((match) => resolve(dirname(file), match[1].split('#')[0]) === canonical);
    if (!links) errors.push(`${name}: delegation must bind the canonical context-routing skill`);
  }
  return errors;
}

export async function checkResolver(root) {
  try {
    const { resolveRole } = await import(pathToFileURL(join(root, 'scripts', 'context-routing.mjs')).href);
    const base = {
      role: 'feature, refactoring', model: 'gpt-6.1-sol', effort: 'max',
      why: 'Check literal launch arguments.', inputs: ['models.default.md'],
      support: 'supported', source: 'Contract fixture exact-model evidence',
      hostContext: true, hostSource: 'Contract fixture task schema',
    };
    const paths = { root, home: join(root, 'scripts', 'contract-fixture-home') };
    for (const [workload, tier, reason] of [
      ['bounded', 'default', 'bounded-work'], ['large-corpus', 'long_context', 'eligible-large-corpus'],
    ]) {
      const result = resolveRole({ ...base, workload }, paths);
      const expected = { model: 'gpt-6.1-sol', reasoning_effort: 'max', context_tier: tier };
      if (JSON.stringify(result?.toolArguments) !== JSON.stringify(expected)
        || result?.decision?.status !== 'resolved' || result?.decision?.reason !== reason
        || !result?.declaration?.startsWith('PSTACK_CONTEXT_V1 ')) {
        return [`context resolver: ${workload} did not return the required literal arguments and reason`];
      }
    }
    return [];
  } catch (error) {
    return [`context resolver: ${error.message}`];
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = [...checkBindings(ROOT), ...await checkResolver(ROOT)];
  if (errors.length) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
  } else console.log(`ok: ${REQUIRED_BINDINGS.length} context bindings and literal resolver outputs`);
}
