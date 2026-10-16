import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REQUIRED_BINDINGS = [
  'agents/poteto.agent.md', 'agents/poteto-worker.agent.md', 'always-on/copilot-instructions.md',
  ...['poteto-mode', 'how', 'why', 'architect', 'arena', 'swarm', 'interrogate', 'reflect',
    'no-comments', 'show-me-your-work', 'recall', 'figure-it-out', 'setup-pstack',
    'principle-guard-the-context-window'].map((skill) => `skills/${skill}/SKILL.md`),
];

function markdown(dir, files = []) {
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const file = join(dir, entry.name);
    if (entry.isDirectory()) markdown(file, files);
    else if (entry.name === 'SKILL.md' || entry.name.endsWith('.agent.md')) files.push(file);
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
    const delegates = /reasoning_effort|\b(?:create_session|open_pr_session|open_issue_session)\b|\b(?:spawn|delegate|hand)\b[^\n]*(?:subagent|task|worker|reviewer)|\blaunch\b[^\n]*(?:subagent|delegate|worker|reviewer)/i.test(body);
    if (!known.has(file) && !delegates) continue;
    if (name === 'always-on/copilot-instructions.md') {
      if (!/invoke the\s*\r?\n?\s*`context-routing` skill/i.test(body)) errors.push(`${name}: missing automatic context-routing trigger`);
      continue;
    }
    if (name.startsWith('agents/')) {
      if (!/invoke the\s+`context-routing` skill with the\s+`skill` tool/i.test(body)) {
        errors.push(`${name}: delegation must invoke context-routing by name with the skill tool`);
      }
      continue;
    }
    const links = [...body.matchAll(/\]\(([^)\s]+)\)/g)]
      .some((match) => resolve(dirname(file), match[1].split('#')[0]) === canonical);
    if (!links) errors.push(`${name}: delegation must bind the canonical context-routing skill`);
  }
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = checkBindings(ROOT);
  if (errors.length) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
  } else console.log(`ok: structural lint for ${REQUIRED_BINDINGS.length} required context bindings`);
}
