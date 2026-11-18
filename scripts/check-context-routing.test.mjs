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
      'Poteto mode is on by default for engineering sessions, project workers, and code-writing subagents.',
      'Use `poteto-mode` for code-writing workers, `steward` for coordination, `double` for supervision, and `context-routing` before delegation.',
      '',
      'Read-only, single-pass scouts, critics, judges, and reviewers execute their assigned prompt directly without invoking `poteto-mode`, opening playbooks, or spawning nested subagents.',
    ].join('\n'),
    'skills/steward/SKILL.md': [
      'Use [context-routing](../context-routing/SKILL.md). Never invoke `poteto-mode` or `figure-it-out` in the root.',
      '',
      '## Supervision skills and principles',
      'Invoke `how` and `unslop` by name with the `skill` tool.',
      'Inspect the `merge-base` diff for `read-only` checks on `main` without `poteto-worker`.',
      'Read `principle-model-the-domain`, `principle-boundary-discipline`,',
      '`principle-migrate-callers-then-delete-legacy-apis`, and `principle-test-behavior-not-implementation`.',
      '',
      '## Phase A. Frame goal and scope',
      'Frame purpose.',
      '',
      '## Phase B. Coordinate milestone steps',
      'Coordinate workers.',
      '',
      '## Phase C. Check in and steer',
      'Steer workers.',
      '',
      '## Phase D. Verify behavior and claims',
      '- Verify that added files wire into real entrypoints and discovery paths, and confirm cross-platform portable doc commands.',
      '',
      '- Distinguish executed checks from skipped or optional checks.',
      '',
      '- Never verify against mock data.',
      '',
      '## Phase E. Run rework critic and hand back',
      'Run the critic.',
    ].join('\n'),
    'agents/steward.agent.md': [
      'Invoke `steward` and `context-routing`, not `poteto-mode` or `figure-it-out`.',
      '',
      '## Supervision and review skills',
      '| Skill | Reach for it when |',
      '| --- | --- |',
      '| `how` | Understand `read-only` behavior on `main`. |',
      '| `unslop` | Clean prose outside the `merge-base` diff without `poteto-worker`. |',
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

test('Steward contract fixtures enforce file structure, ordered non-empty phases, and index-only agent headings', async (t) => {
  const instructions = 'always-on/copilot-instructions.md';
  const skill = 'skills/steward/SKILL.md';
  const agent = 'agents/steward.agent.md';
  await t.test('accepts code-writing subagents, read-only delegates, and formatted verification bullets', (t) => {
    assert.deepEqual(checkStewardContract(stewardFixture(t)), []);
  });
  for (const name of [instructions, skill, agent]) {
    await t.test(`requires ${name}`, (t) => {
      const dir = stewardFixture(t);
      rmSync(join(dir, name));
      assert.deepEqual(checkStewardContract(dir), [`${name}: missing Steward contract`]);
    });
  }
  for (const slug of ['poteto-mode', 'steward', 'double', 'context-routing']) {
    await t.test(`requires the ${slug} mode routing reference`, (t) => {
      const dir = stewardFixture(t);
      const file = join(dir, instructions);
      const body = readFileSync(file, 'utf8');
      assert.ok(body.includes(`\`${slug}\``));
      writeFileSync(file, body.replaceAll(`\`${slug}\``, slug));
      assert.deepEqual(checkStewardContract(dir), [`${instructions}: missing mode routing reference ${slug}`]);
    });
  }
  for (const [description, name, before, after, expected] of [
    ['rejects an agent Lifecycle heading', agent, '## Principles', '## Lifecycle\nOwn phases.\n\n## Principles',
      `${agent}: must remain a routing index instead of duplicating Steward lifecycle phases`],
    ['rejects an agent Phase heading', agent, '## Principles', '## Phase A. Frame goal and scope\nFrame purpose.\n\n## Principles',
      `${agent}: must remain a routing index instead of duplicating Steward lifecycle phases`],
    ['requires the Phase E heading', skill, '## Phase E. Run rework critic and hand back', '## Reply',
      `${skill}: missing required lifecycle heading Phase E`],
    ['rejects an empty Phase E before another heading', skill, 'Run the critic.', '\n## Reply\nDone.\n',
      `${skill}: lifecycle section Phase E must not be empty`],
    ['rejects an empty Phase E at EOF', skill, 'Run the critic.', '',
      `${skill}: lifecycle section Phase E must not be empty`],
  ]) {
    await t.test(description, (t) => {
      const dir = stewardFixture(t);
      const file = join(dir, name);
      const body = readFileSync(file, 'utf8');
      assert.ok(body.includes(before), `Fixture must contain ${before}`);
      writeFileSync(file, body.replace(before, after));
      assert.deepEqual(checkStewardContract(dir), [expected]);
    });
  }
  await t.test('requires Phase E to follow Phase D', (t) => {
    const dir = stewardFixture(t);
    const file = join(dir, skill);
    const body = readFileSync(file, 'utf8');
    const phases = /(## Phase D\.[\s\S]*?)(## Phase E\.[\s\S]*)$/;
    assert.match(body, phases);
    writeFileSync(file, body.replace(phases, '$2\n\n$1'));
    assert.deepEqual(checkStewardContract(dir), [`${skill}: lifecycle heading Phase E must follow Phase D`]);
  });
});

test('Steward skill references resolve table columns, links, and principles while ignoring non-skill code spans', async (t) => {
  const skill = 'skills/steward/SKILL.md';
  const agent = 'agents/steward.agent.md';
  for (const [description, name, before, after, expected] of [
    ['resolves unknown table skills from column one', agent, '| --- | --- |',
      '| --- | --- |\n| `missing-table-skill` | Check diffs. |', [
        `${agent}: referenced skill missing-table-skill has no skills/missing-table-skill/SKILL.md`,
        `${skill}: missing Steward skill missing-table-skill exposed by ${agent}`,
      ]],
    ['resolves relative skill links and principle names', skill, 'Invoke `how` and `unslop` by name with the `skill` tool.',
      'Invoke `how` and `unslop` by name with the `skill` tool.\nRead [missing-review](../missing-review/SKILL.md) and `principle-missing`.', [
        `${skill}: referenced skill missing-review has no skills/missing-review/SKILL.md`,
        `${skill}: referenced skill principle-missing has no skills/principle-missing/SKILL.md`,
        `${agent}: missing Steward skill missing-review referenced by ${skill}`,
        `${agent}: missing Steward skill principle-missing referenced by ${skill}`,
      ]],
    ['requires agent parity with the skill index', agent,
      '| `unslop` | Clean prose outside the `merge-base` diff without `poteto-worker`. |\n', '', [
        `${agent}: missing Steward skill unslop referenced by ${skill}`,
      ]],
    ['requires skill parity with the agent index', skill, '`how` and `unslop`', '`how`', [
      `${skill}: missing Steward skill unslop exposed by ${agent}`,
    ]],
  ]) {
    await t.test(description, (t) => {
      const dir = stewardFixture(t);
      const file = join(dir, name);
      const body = readFileSync(file, 'utf8');
      assert.ok(body.includes(before), `Fixture must contain ${before}`);
      writeFileSync(file, body.replace(before, after));
      assert.deepEqual(checkStewardContract(dir), expected);
    });
  }
  await t.test('requires referenced skill files from both indexes', (t) => {
    const dir = stewardFixture(t);
    rmSync(join(dir, 'skills', 'unslop', 'SKILL.md'));
    assert.deepEqual(checkStewardContract(dir), [
      `${skill}: referenced skill unslop has no skills/unslop/SKILL.md`,
      `${agent}: referenced skill unslop has no skills/unslop/SKILL.md`,
    ]);
  });
  for (const slug of REQUIRED_STEWARD_PRINCIPLES) {
    await t.test(`requires ${slug} in the exposure index`, (t) => {
      const dir = stewardFixture(t);
      for (const name of [skill, agent]) {
        const file = join(dir, name);
        const body = readFileSync(file, 'utf8');
        assert.ok(body.includes(`\`${slug}\``));
        writeFileSync(file, body.replace(`\`${slug}\``, ''));
      }
      assert.deepEqual(checkStewardContract(dir), [`${agent}: missing required Steward principle ${slug}`]);
    });
  }
  await t.test('ignores domain code spans in supervision and principle prose', (t) => {
    const dir = stewardFixture(t);
    const prose = 'Use the `skill` tool for `read-only` checks on `main` against `merge-base` without `poteto-worker`.\n';
    for (const [name, heading] of [[skill, '## Supervision skills and principles'], [agent, '## Principles']]) {
      const file = join(dir, name);
      const body = readFileSync(file, 'utf8');
      assert.ok(body.includes(heading));
      writeFileSync(file, body.replace(heading, `${heading}\n${prose}`));
    }
    assert.deepEqual(checkStewardContract(dir), []);
  });
  await t.test('ignores known skills in table descriptions and outside the supervision index', (t) => {
    const dir = stewardFixture(t);
    const leaf = join(dir, 'skills', 'tdd', 'SKILL.md');
    mkdirSync(dirname(leaf), { recursive: true });
    writeFileSync(leaf, '# TDD\n');
    const file = join(dir, agent);
    const body = readFileSync(file, 'utf8');
    const description = 'Understand `read-only` behavior on `main`.';
    assert.ok(body.includes(description));
    writeFileSync(file, body.replace(description, `${description} Workers run \`tdd\` separately.`));
    const skillFile = join(dir, skill);
    writeFileSync(skillFile, `${readFileSync(skillFile, 'utf8')}\n\n## Worker notes\nWorkers run \`tdd\` separately.\n`);
    assert.deepEqual(checkStewardContract(dir), []);
  });
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
