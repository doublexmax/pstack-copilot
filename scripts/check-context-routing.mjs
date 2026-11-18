import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REQUIRED_BINDINGS = [
  'agents/poteto.agent.md', 'agents/poteto-worker.agent.md', 'agents/double.agent.md',
  'agents/steward.agent.md',
  'always-on/copilot-instructions.md',
  ...['poteto-mode', 'steward', 'double', 'how', 'why', 'architect', 'arena', 'swarm', 'interrogate', 'reflect',
    'no-comments', 'show-me-your-work', 'recall', 'figure-it-out', 'setup-pstack', 'automate-me',
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

export const REQUIRED_STEWARD_PRINCIPLES = [
  'principle-model-the-domain', 'principle-boundary-discipline',
  'principle-migrate-callers-then-delete-legacy-apis', 'principle-test-behavior-not-implementation',
];

export function checkStewardContract(root) {
  const errors = [];
  const instructionsPath = 'always-on/copilot-instructions.md';
  const skillPath = 'skills/steward/SKILL.md';
  const agentPath = 'agents/steward.agent.md';
  const paths = [instructionsPath, skillPath, agentPath];
  for (const path of paths) {
    if (!existsSync(join(root, path))) errors.push(`${path}: missing Steward contract`);
  }
  if (errors.length) return errors;
  const [instructions, skill, agent] = paths.map((path) => readFileSync(join(root, path), 'utf8'));
  const normalize = (text) => text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[`*]/g, '');
  const blocks = (body) => normalize(body).split(/\r?\n\s*\r?\n/)
    .map((block) => block.replace(/\s+/g, ' ').trim().toLowerCase()).filter(Boolean);
  const sentences = (body) => blocks(body).flatMap((block) => block.split(/(?<=[.!?])\s+/));
  const forbidsAll = (clause, terms) =>
    /\b(?:without|forbid\w*|must not|never)\b/.test(clause)
    && !/\bno\s+poteto-mode\s+ban\b/.test(clause)
    && terms.every((term) => term.test(clause));

  if (/poteto mode is on by default[^.]*\bsubagents?\b/i.test(instructions)) {
    errors.push(`${instructionsPath}: must not enable poteto-mode across all inline subagents`);
  }
  if (!sentences(instructions).some((sentence) =>
    /\bbounded\b/.test(sentence) && /\bgeneral-purpose\b/.test(sentence)
    && /\b(?:execute|run|follow)\b[^.!?]*\bprompt\b[^.!?]*\bdirectly\b/.test(sentence)
    && forbidsAll(sentence, [/\bpoteto-mode\b/, /\bplaybooks?\b/, /\bnested subagents\b/]))) {
    errors.push(`${instructionsPath}: must keep bounded general-purpose delegates out of poteto-mode, playbooks, and nested subagents`);
  }
  if (/^##\s+(?:Phase\s+[A-E]\b|Lifecycle\b)/im.test(agent)) {
    errors.push(`${agentPath}: must remain a routing index instead of duplicating Steward lifecycle phases`);
  }

  const indexSections = (body) => body.split(/\r?\n(?=##\s+)/)
    .filter((section) => /^##\s+(?:Supervision|Principles)\b/i.test(section)).join('\n');
  const excluded = new Set(['steward', 'context-routing', 'poteto-mode', 'figure-it-out']);
  const references = (body) => new Set([
    ...[...body.matchAll(/\]\(\.\.\/(?:skills\/)?([a-z0-9-]+)\/SKILL\.md(?:#[^)\s]*)?\)/g)].map((match) => match[1]),
    ...[...indexSections(body).matchAll(/`([a-z0-9-]+)`/g)].map((match) => match[1])
      .filter((slug) => slug !== 'skill'),
  ].filter((slug) => !excluded.has(slug)));
  const skillRefs = references(skill);
  const agentRefs = references(agent);
  for (const [path, refs] of [[skillPath, skillRefs], [agentPath, agentRefs]]) {
    for (const slug of [...refs].sort()) {
      if (!existsSync(join(root, 'skills', slug, 'SKILL.md'))) {
        errors.push(`${path}: referenced skill ${slug} has no skills/${slug}/SKILL.md`);
      }
    }
  }
  for (const slug of [...skillRefs].sort()) {
    if (!agentRefs.has(slug)) errors.push(`${agentPath}: missing Steward skill ${slug} referenced by ${skillPath}`);
  }
  for (const slug of [...agentRefs].sort()) {
    if (!skillRefs.has(slug)) errors.push(`${skillPath}: missing Steward skill ${slug} exposed by ${agentPath}`);
  }
  for (const slug of REQUIRED_STEWARD_PRINCIPLES) {
    if (!agentRefs.has(slug)) errors.push(`${agentPath}: missing required Steward principle ${slug}`);
  }

  for (const phase of ['A', 'B', 'C', 'D', 'E']) {
    if (!new RegExp(`^##\\s+Phase\\s+${phase}\\.`, 'm').test(skill)) {
      errors.push(`${skillPath}: missing required lifecycle heading Phase ${phase}`);
    }
  }
  const skillBlocks = blocks(skill);
  for (const [patterns, negated, message] of [
    [[/\barena cross-judge pool\b/, /--member\s+0\b/, /\bvendor famil(?:y|ies)\b/, /\bdiffers?\b/,
      /\b(?:if no|when no|if none|when none|otherwise)\b/],
    /\b(?:do not|must not|never|skip)\b[^.!?]*\b(?:arena cross-judge pool|fall\s*back|--member\s+0)\b|\bmust not differ\b/,
    'rework critic selection must define a --member 0 fallback for narrow vendor pools'],
    [[/\bresum(?:e|ed|ing)\b/, /\bfollow[- ]ups?\b/, /\bpivots?\b/, /\brework critic\b/,
      /\b(?:rerun|re-run|repeat|run again)\b/, /\bcumulative\b/, /\bmerge[- ]base\b/, /\bdiff\b/,
      /\buntracked\b/, /\b(?:multiple files|multi[- ]file|more than one file)\b/],
    /\b(?:do not|must not|never|skip)\b[^.!?]*\b(?:rerun|re-run|repeat|run again)\b/,
    'must require rework critic on resumed turns when cumulative merge-base diff spans multiple files'],
    [[/\b(?:checks?|tests?|verification)\b/, /\b(?:executed|ran|run)\b/, /\bskipped\b/, /\boptional\b/],
    /\b(?:do not|must not|never)\s+distinguish\b|(?<!\bnever\s)(?<!\bnot\s)\breport\s+skipped\b[^.!?]*\bas\s+(?:executed|passed)\b/,
    'verification must distinguish executed checks from skipped or optional checks'],
    [[/\b(?:added|new)\s+files?\b/, /\bentrypoints?\b/, /\bdiscovery\b/, /\bcross[- ]platform\b/, /\bportable\b/],
    /\b(?:do not|must not|never)\s+(?:verify|confirm)\b/,
    'Phase D must verify real entrypoint wiring and cross-platform doc command portability'],
    [[/\bmode:\s*"sync"/, /\bmode:\s*"background"/, /\bparallel\b/, /\bshell\b/, /\bsleep\b/, /\bpoll\b/],
    /\b(?:do not|must not|never)\s+use\s+mode:\s*"sync"/,
    'Phase B must use mode: "sync" for single sequential delegates and forbid shell sleep polling'],
  ]) {
    if (!skillBlocks.some((block) => patterns.every((pattern) => pattern.test(block)) && !negated.test(block))) {
      errors.push(`${skillPath}: ${message}`);
    }
  }
  if (!skillBlocks.some((block) =>
    /\bbounded\b/.test(block) && /\bgeneral-purpose\b/.test(block) && /\bscouts?\b/.test(block)
    && /\bcritics?\b/.test(block) && /\bprompt\b/.test(block)
    && forbidsAll(block, [/\bwrites?\b/, /\bpoteto-mode\b/, /\bplaybooks?\b/, /\bnested subagents\b/]))) {
    errors.push(`${skillPath}: bounded general-purpose scouts and critics must forbid writes, poteto-mode, playbooks, and nested subagents`);
  }
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = [...checkBindings(ROOT), ...checkStewardContract(ROOT)];
  if (errors.length) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
  } else console.log(`ok: structural lint for ${REQUIRED_BINDINGS.length} required context bindings and Steward contract`);
}
