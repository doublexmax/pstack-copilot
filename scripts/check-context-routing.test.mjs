import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { checkBindings, checkStewardContract, REQUIRED_BINDINGS, REQUIRED_STEWARD_PRINCIPLES } from './check-context-routing.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pstack-binding-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const canonical = join(dir, 'skills', 'context-routing', 'SKILL.md');
  mkdirSync(dirname(canonical), { recursive: true });
  writeFileSync(canonical, '# Context routing\n');
  for (const name of REQUIRED_BINDINGS) {
    const file = join(dir, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, name.startsWith('always-on')
      ? 'Before delegation invoke the `context-routing` skill.\n'
      : name.startsWith('agents/')
      ? 'Before delegation invoke the `context-routing` skill with the `skill` tool.\n'
      : `Before a task delegate, invoke [context-routing](${relative(dirname(file), canonical).replaceAll('\\', '/')}).\n`);
  }
  return dir;
}

function stewardFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pstack-steward-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const files = {
    'always-on/copilot-instructions.md': [
      'Poteto mode is on by default for engineering sessions and project workers.',
      '',
      'Bounded `general-purpose` delegates execute their assigned prompt directly without invoking `poteto-mode`, opening playbooks, or spawning nested subagents.',
    ].join('\n'),
    'skills/steward/SKILL.md': [
      'Use [context-routing](../context-routing/SKILL.md). Never invoke `poteto-mode` or `figure-it-out` in the root.',
      '',
      'Use `arena cross-judge pool` for a `--member` whose vendor family differs from Steward and the worker. If no configured member differs, fall back to `--member 0`.',
      '',
      'Bounded `general-purpose` scouts and critics execute directly, and their prompt must forbid file writes, `poteto-mode`, playbooks, and nested subagents.',
      '',
      '## Supervision skills and principles',
      'Invoke `how` and `unslop` by name with the `skill` tool.',
      'Read `principle-model-the-domain`, `principle-boundary-discipline`,',
      '`principle-migrate-callers-then-delete-legacy-apis`, and `principle-test-behavior-not-implementation`.',
      '',
      '## Start',
      'On resumed follow-up or pivot turns, rerun the rework critic when the cumulative diff from merge-base plus untracked repository files touches multiple files.',
      '',
      '## Phase A. Frame goal and scope',
      'Frame purpose.',
      '',
      '## Phase B. Coordinate milestone steps',
      'Use `mode: "sync"` for a single sequential delegate and `mode: "background"` only for parallel waves; never sleep or poll in a shell while waiting.',
      '',
      '## Phase C. Check in and steer',
      'Steer workers.',
      '',
      '## Phase D. Verify behavior and claims',
      'Verify that added files wire into real entrypoints and discovery paths, and confirm cross-platform portable doc commands. Verification must distinguish executed checks from skipped or optional checks.',
      '',
      '## Phase E. Run rework critic and hand back',
      'Run the critic.',
    ].join('\n'),
    'agents/steward.agent.md': [
      'Invoke `steward` and `context-routing`, not `poteto-mode` or `figure-it-out`.',
      '',
      '## Supervision and review skills',
      'Available skills are `how` and `unslop`.',
      '',
      '## Principles',
      'Read `principle-model-the-domain`, `principle-boundary-discipline`,',
      '`principle-migrate-callers-then-delete-legacy-apis`, and `principle-test-behavior-not-implementation`.',
    ].join('\n'),
  };
  for (const slug of ['how', 'unslop', ...REQUIRED_STEWARD_PRINCIPLES]) {
    files[`skills/${slug}/SKILL.md`] = `# ${slug}\n`;
  }
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  return dir;
}

test('the repository satisfies the Steward contract and skill exposure index', () => {
  assert.deepEqual(checkStewardContract(root), []);
});

test('Steward contract fixtures accept a complete contract and diagnose broken or inverted safeguards', (t) => {
  const dir = stewardFixture(t);
  assert.deepEqual(checkStewardContract(dir), []);
  const instructions = 'always-on/copilot-instructions.md';
  const skill = 'skills/steward/SKILL.md';
  const agent = 'agents/steward.agent.md';
  for (const [name, before, after, expected] of [
    [instructions, 'and project workers.', 'and all subagents in every repository.',
      `${instructions}: must not enable poteto-mode across all inline subagents`],
    [instructions, 'without invoking `poteto-mode`, opening playbooks, or spawning nested subagents.', 'immediately.',
      `${instructions}: must keep bounded general-purpose delegates out of poteto-mode, playbooks, and nested subagents`],
    [instructions, 'without invoking `poteto-mode`, opening playbooks, or spawning nested subagents.',
      'quickly. Do not invoke `poteto-mode`, open playbooks, or spawn nested subagents.',
      `${instructions}: must keep bounded general-purpose delegates out of poteto-mode, playbooks, and nested subagents`],
    [agent, '## Principles', '## Lifecycle\n- Phase A.\n\n## Principles',
      `${agent}: must remain a routing index instead of duplicating Steward lifecycle phases`],
    [agent, '`how` and `unslop`', '`how`',
      `${agent}: missing Steward skill unslop referenced by ${skill}`],
    [skill, '`how` and `unslop`', '`how`',
      `${skill}: missing Steward skill unslop exposed by ${agent}`],
    [skill, '## Phase E. Run rework critic and hand back', '## Handback',
      `${skill}: missing required lifecycle heading Phase E`],
    [skill, 'If no configured member differs, fall back to `--member 0`.', '',
      `${skill}: rework critic selection must define a --member 0 fallback for narrow vendor pools`],
    [skill, 'If no configured member differs, fall back to `--member 0`.',
      'If no configured member differs, never fall back to `--member 0`.',
      `${skill}: rework critic selection must define a --member 0 fallback for narrow vendor pools`],
    [skill, 'file writes, `poteto-mode`, playbooks, and nested subagents.', '`poteto-mode` and nested subagents.',
      `${skill}: bounded general-purpose scouts and critics must forbid writes, poteto-mode, playbooks, and nested subagents`],
    [skill, 'rerun the rework critic', 'never rerun the rework critic',
      `${skill}: must require rework critic on resumed turns when cumulative merge-base diff spans multiple files`],
    [skill, ' plus untracked repository files', '',
      `${skill}: must require rework critic on resumed turns when cumulative merge-base diff spans multiple files`],
    [skill, 'Verification must distinguish executed checks from skipped or optional checks.',
      'Report skipped checks and optional tests as executed checks that passed.',
      `${skill}: verification must distinguish executed checks from skipped or optional checks`],
    [skill, 'Verify that added files wire into real entrypoints and discovery paths, and confirm cross-platform portable doc commands. ', '',
      `${skill}: Phase D must verify real entrypoint wiring and cross-platform doc command portability`],
    [skill, 'never sleep or poll in a shell while waiting.', 'poll while waiting.',
      `${skill}: Phase B must use mode: "sync" for single sequential delegates and forbid shell sleep polling`],
  ]) {
    const file = join(dir, name);
    const original = readFileSync(file, 'utf8');
    assert.ok(original.includes(before), `Fixture must contain ${before}`);
    writeFileSync(file, original.replace(before, after));
    assert.deepEqual(checkStewardContract(dir), [expected], expected);
    writeFileSync(file, original);
  }
  assert.deepEqual(checkStewardContract(dir), []);
});

test('Steward skill references must resolve and required principles must remain indexed', (t) => {
  const dir = stewardFixture(t);
  const skill = join(dir, 'skills', 'steward', 'SKILL.md');
  const original = readFileSync(skill, 'utf8');
  writeFileSync(skill, original.replace(
    'Invoke `how` and `unslop` by name with the `skill` tool.',
    'Invoke `how`, `unslop`, `principle-missing`, and [missing-review](../missing-review/SKILL.md).',
  ));
  assert.deepEqual(checkStewardContract(dir), [
    'skills/steward/SKILL.md: referenced skill missing-review has no skills/missing-review/SKILL.md',
    'skills/steward/SKILL.md: referenced skill principle-missing has no skills/principle-missing/SKILL.md',
    'agents/steward.agent.md: missing Steward skill missing-review referenced by skills/steward/SKILL.md',
    'agents/steward.agent.md: missing Steward skill principle-missing referenced by skills/steward/SKILL.md',
  ]);
  writeFileSync(skill, original);
  writeFileSync(skill, `${original}\nIn the root, never invoke \`swarm\` directly.\n`);
  assert.deepEqual(checkStewardContract(dir), []);
  writeFileSync(skill, original);
  const leaf = join(dir, 'skills', 'unslop', 'SKILL.md');
  rmSync(leaf);
  assert.deepEqual(checkStewardContract(dir), [
    'skills/steward/SKILL.md: referenced skill unslop has no skills/unslop/SKILL.md',
    'agents/steward.agent.md: referenced skill unslop has no skills/unslop/SKILL.md',
  ]);
  writeFileSync(leaf, '# Unslop\n');
  for (const slug of REQUIRED_STEWARD_PRINCIPLES) {
    const agent = join(dir, 'agents', 'steward.agent.md');
    const index = readFileSync(agent, 'utf8');
    writeFileSync(skill, original.replace(`\`${slug}\``, ''));
    writeFileSync(agent, index.replace(`\`${slug}\``, ''));
    assert.deepEqual(checkStewardContract(dir), [
      `agents/steward.agent.md: missing required Steward principle ${slug}`,
    ]);
    writeFileSync(skill, original);
    writeFileSync(agent, index);
  }
  assert.deepEqual(checkStewardContract(dir), []);
});

test('Steward safeguards accept equivalent wording instead of pinning full sentences', (t) => {
  const dir = stewardFixture(t);
  writeFileSync(join(dir, 'always-on', 'copilot-instructions.md'),
    'Bounded general-purpose reviewers run the assigned prompt directly without poteto-mode, playbooks, or nested subagents.\n');
  const skill = join(dir, 'skills', 'steward', 'SKILL.md');
  const body = readFileSync(skill, 'utf8')
    .replace('If no configured member differs, fall back to `--member 0`.',
      'When none differs from that vendor family, select `--member 0`.')
    .replace('On resumed follow-up or pivot turns, rerun the rework critic when the cumulative diff from merge-base plus untracked repository files touches multiple files.',
      'For resumed follow-ups and pivots, repeat the rework critic if the cumulative merge-base diff and untracked repository files affect more than one file.')
    .replace('Verification must distinguish executed checks from skipped or optional checks.',
      'List checks you ran separately from skipped and optional checks.');
  writeFileSync(skill, body);
  assert.deepEqual(checkStewardContract(dir), []);
});

test('a complete package binds every required workflow and a missing binding fails', (t) => {
  const dir = fixture(t);
  assert.deepEqual(checkBindings(dir), []);
  writeFileSync(join(dir, 'skills', 'how', 'SKILL.md'), 'Spawn a task subagent without routing.\n');
  assert.deepEqual(checkBindings(dir), ['skills/how/SKILL.md: delegation must bind the canonical context-routing skill']);
});

test('steward requires its root agent and canonical skill binding', (t) => {
  const dir = fixture(t);
  assert.deepEqual(checkBindings(dir), []);
  const agent = join(dir, 'agents', 'steward.agent.md');
  rmSync(agent);
  assert.deepEqual(checkBindings(dir), ['agents/steward.agent.md: missing required context binding']);
  writeFileSync(agent, 'Before each delegate invoke the `context-routing` skill with the `skill` tool.\n');
  const skill = join(dir, 'skills', 'steward', 'SKILL.md');
  writeFileSync(skill, 'Before delegation invoke the `context-routing` skill with the `skill` tool.\n');
  assert.deepEqual(checkBindings(dir), ['skills/steward/SKILL.md: delegation must bind the canonical context-routing skill']);
  writeFileSync(skill, 'Before delegation invoke [context-routing](../context-routing/SKILL.md).\n');
  assert.deepEqual(checkBindings(dir), []);
});

test('a new standalone delegating skill cannot bypass the contract registry', (t) => {
  const dir = fixture(t);
  const file = join(dir, 'skills', 'new-workflow', 'SKILL.md');
  mkdirSync(dirname(file));
  writeFileSync(file, 'Spawn one task subagent with reasoning_effort max.\n');
  assert.deepEqual(checkBindings(dir), ['skills/new-workflow/SKILL.md: delegation must bind the canonical context-routing skill']);
});

test('every supported kickoff API requires a canonical binding in a standalone skill', (t) => {
  const dir = fixture(t);
  const file = join(dir, 'skills', 'new-workflow', 'SKILL.md');
  mkdirSync(dirname(file));
  for (const tool of ['create_session', 'open_pr_session', 'open_issue_session']) {
    writeFileSync(file, `Use ${tool} with a kickoff prompt.\n`);
    assert.deepEqual(checkBindings(dir), ['skills/new-workflow/SKILL.md: delegation must bind the canonical context-routing skill']);
  }
});

test('copied agents invoke the registered skill in the documented separate install layout', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'pstack-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const skills = join(home, 'pstack', 'skills');
  const canonical = join(skills, 'context-routing', 'SKILL.md');
  mkdirSync(dirname(canonical), { recursive: true });
  copyFileSync(join(root, 'skills', 'context-routing', 'SKILL.md'), canonical);
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ skillDirectories: [skills] }));
  mkdirSync(join(home, 'agents'));
  for (const agent of readdirSync(join(root, 'agents')).filter((name) => name.endsWith('.agent.md'))) {
    const file = join(home, 'agents', agent);
    copyFileSync(join(root, 'agents', agent), file);
    const body = readFileSync(file, 'utf8');
    for (const [, href] of body.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^(https?:\/\/|mailto:|#)/i.test(href)) continue;
      const target = resolve(dirname(file), decodeURIComponent(href.split('#')[0]));
      assert.equal(target.startsWith(`${home}${sep}`), true, `${agent} points outside the installed home at ${target}`);
      assert.equal(existsSync(target), true, `${agent} points at missing ${target}`);
    }
    if (REQUIRED_BINDINGS.includes(`agents/${agent}`)) {
      assert.match(body, /invoke the `context-routing` skill with the `skill` tool/i,
        `${agent} must invoke the registered skill by name`);
    }
  }
  const registered = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')).skillDirectories;
  assert.deepEqual(registered, [skills]);
  assert.match(readFileSync(join(registered[0], 'context-routing', 'SKILL.md'), 'utf8'), /\nname: context-routing\r?\n/);
  assert.equal(existsSync(join(home, 'skills', 'context-routing', 'SKILL.md')), false);
});

test('skill-name invocation does not replace canonical links inside checkout skills', (t) => {
  const dir = fixture(t);
  writeFileSync(join(dir, 'skills', 'how', 'SKILL.md'),
    'Before delegation invoke the `context-routing` skill with the `skill` tool.\n');
  assert.deepEqual(checkBindings(dir), ['skills/how/SKILL.md: delegation must bind the canonical context-routing skill']);
});

test('agent bindings reject a checkout-relative routing link', (t) => {
  const dir = fixture(t);
  writeFileSync(join(dir, 'agents', 'poteto.agent.md'),
    'Before delegation invoke [context-routing](../skills/context-routing/SKILL.md).\n');
  assert.deepEqual(checkBindings(dir), ['agents/poteto.agent.md: delegation must invoke context-routing by name with the skill tool']);
});

test('instructions to launch an app for a task are not delegate instructions', (t) => {
  const dir = fixture(t);
  const file = join(dir, 'skills', 'app-verifier', 'SKILL.md');
  mkdirSync(dirname(file));
  writeFileSync(file, 'Launch the CLI and exercise its feature. This app task is not a delegation.\n');
  assert.deepEqual(checkBindings(dir), []);
});
test('playbooks inherit the shared delegate contract instead of requiring repeated preambles', (t) => {
  const dir = fixture(t);
  const file = join(dir, 'skills', 'poteto-mode', 'playbooks', 'feature.md');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, 'Delegate implementation using the feature, refactoring role.\n');
  assert.deepEqual(checkBindings(dir), []);
});
