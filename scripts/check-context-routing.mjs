import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
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

const NON_SUPERVISION_MODES = new Set(['steward', 'context-routing', 'poteto-mode', 'figure-it-out']);

function h2Sections(body) {
  const headings = [...body.matchAll(/^##[ \t]+([^\r\n]+)/gm)];
  return headings.map((match, index) => ({
    heading: match[1].trim(),
    body: body.slice(match.index + match[0].length, headings[index + 1]?.index ?? body.length),
  }));
}

function extractStewardSkillRefs(root, relPath, body, sections) {
  const filePath = resolve(root, relPath);
  const refs = new Set([...body.matchAll(/`(principle-[a-z0-9-]+)`/g)].map((match) => match[1]));
  const errors = [];
  for (const [, href] of body.matchAll(/\]\(([^)\s]+)\)/g)) {
    const rawHref = href.split('#')[0];
    if (!rawHref.endsWith('/SKILL.md') || isAbsolute(rawHref) || /^[a-z][a-z0-9+.-]*:/i.test(rawHref)) continue;
    const resolved = resolve(dirname(filePath), rawHref);
    const slug = basename(dirname(resolved));
    if (resolved !== resolve(root, 'skills', slug, 'SKILL.md')) {
      errors.push(`${relPath}: non-canonical or broken skill link ${rawHref}`);
    } else if (!NON_SUPERVISION_MODES.has(slug)) refs.add(slug);
  }
  for (const section of sections) {
    if (!/^Supervision\b/i.test(section.heading)) continue;
    const sites = [
      ...section.body.matchAll(/^\|\s*`([a-z0-9-]+)`\s*\|/gm),
      ...[...section.body.matchAll(/Invoke\b([^.\r\n]*?)\bby name\b/gi)]
        .flatMap(([, clause]) => [...clause.matchAll(/`([a-z0-9-]+)`/g)]),
    ];
    for (const [, slug] of sites) {
      if (NON_SUPERVISION_MODES.has(slug)) errors.push(`${relPath}: Supervision index must not expose ${slug}`);
      else refs.add(slug);
    }
  }
  return { refs, errors };
}

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
  const [instructions, skill, agent] = paths.map((path) => readFileSync(join(root, path), 'utf8')
    .replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '')
    .replace(/^[ \t]*(?:`{3,}|~{3,})[^`\r\n]*\r?\n[\s\S]*?^[ \t]*(?:`{3,}|~{3,})[ \t]*$/gm, ''));

  for (const slug of ['poteto-mode', 'steward', 'double', 'context-routing']) {
    if (!instructions.includes(`\`${slug}\``)) errors.push(`${instructionsPath}: missing mode routing reference ${slug}`);
  }
  if (/^##\s+(?:Phase\s+[A-E]\b|Lifecycle\b)/im.test(agent)) {
    errors.push(`${agentPath}: must remain a routing index instead of duplicating Steward lifecycle phases`);
  }

  const skillSections = h2Sections(skill);
  let latestPhase = null;
  for (const phase of ['A', 'B', 'C', 'D', 'E']) {
    const indices = skillSections.flatMap(({ heading }, idx) => (new RegExp(`^Phase\\s+${phase}\\.`).test(heading) ? [idx] : []));
    if (!indices.length) {
      errors.push(`${skillPath}: missing required lifecycle heading Phase ${phase}`);
      continue;
    }
    if (indices.length > 1) errors.push(`${skillPath}: duplicate lifecycle heading Phase ${phase}`);
    const index = indices[0];
    if (latestPhase && index < latestPhase.index) {
      errors.push(`${skillPath}: lifecycle heading Phase ${phase} must follow Phase ${latestPhase.phase}`);
    } else latestPhase = { phase, index };
    if (!skillSections[index].body.trim()) errors.push(`${skillPath}: lifecycle section Phase ${phase} must not be empty`);
  }

  const skillIndex = extractStewardSkillRefs(root, skillPath, skill, skillSections);
  const agentIndex = extractStewardSkillRefs(root, agentPath, agent, h2Sections(agent));
  for (const [path, { refs, errors: refErrors }] of [[skillPath, skillIndex], [agentPath, agentIndex]]) {
    errors.push(...refErrors);
    for (const slug of [...refs].sort()) {
      if (!existsSync(join(root, 'skills', slug, 'SKILL.md'))) {
        errors.push(`${path}: referenced skill ${slug} has no skills/${slug}/SKILL.md`);
      }
    }
  }
  for (const slug of [...skillIndex.refs].sort()) {
    if (!agentIndex.refs.has(slug)) errors.push(`${agentPath}: missing Steward skill ${slug} referenced by ${skillPath}`);
  }
  for (const slug of [...agentIndex.refs].sort()) {
    if (!skillIndex.refs.has(slug)) errors.push(`${skillPath}: missing Steward skill ${slug} exposed by ${agentPath}`);
  }
  for (const slug of REQUIRED_STEWARD_PRINCIPLES) {
    if (!agentIndex.refs.has(slug)) errors.push(`${agentPath}: missing required Steward principle ${slug}`);
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
