import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { checkBindings, checkResolver, REQUIRED_BINDINGS } from './check-context-routing.mjs';

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

test('a complete package binds every required workflow and a missing binding fails', (t) => {
  const dir = fixture(t);
  assert.deepEqual(checkBindings(dir), []);
  writeFileSync(join(dir, 'skills', 'how', 'SKILL.md'), 'Spawn a task subagent without routing.\n');
  assert.deepEqual(checkBindings(dir), ['skills/how/SKILL.md: delegation must bind the canonical context-routing skill']);
});

test('a new standalone delegating skill cannot bypass the contract registry', (t) => {
  const dir = fixture(t);
  const file = join(dir, 'skills', 'new-workflow', 'SKILL.md');
  mkdirSync(dirname(file));
  writeFileSync(file, 'Spawn one task subagent with reasoning_effort max.\n');
  assert.deepEqual(checkBindings(dir), ['skills/new-workflow/SKILL.md: delegation must bind the canonical context-routing skill']);
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
  for (const name of ['poteto', 'poteto-worker']) {
    const file = join(home, 'agents', `${name}.agent.md`);
    copyFileSync(join(root, 'agents', `${name}.agent.md`), file);
    const body = readFileSync(file, 'utf8');
    for (const match of body.matchAll(/\[context-routing\]\(([^)]+)\)/g)) {
      const target = resolve(dirname(file), match[1]);
      assert.equal(existsSync(target), true, `${name}: copied agent points at missing ${target}`);
    }
    assert.match(body, /invoke the `context-routing` skill with the `skill` tool/i,
      `${name}: the copied instructions must invoke the registered skill by name`);
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

test('instructions to launch an app for a task are not delegate instructions', (t) => {
  const dir = fixture(t);
  const file = join(dir, 'skills', 'app-verifier', 'SKILL.md');
  mkdirSync(dirname(file));
  writeFileSync(file, 'Launch the CLI and exercise its feature. This app task is not a delegation.\n');
  assert.deepEqual(checkBindings(dir), []);
});
test('the behavioral source gate rejects an empty resolver rather than trusting a reference', async (t) => {
  const dir = fixture(t);
  mkdirSync(join(dir, 'scripts'));
  writeFileSync(join(dir, 'scripts', 'context-routing.mjs'), 'export function resolveRole() { return undefined; }\n');
  assert.deepEqual(await checkResolver(dir), ['context resolver: bounded did not return the required literal arguments and reason']);
});

test('the gate calls the real resolver and observes both literal dispatch outputs', async (t) => {
  const dir = fixture(t);
  mkdirSync(join(dir, 'scripts'));
  for (const name of ['models.default.md', 'context.default.json', 'scripts/context-routing.mjs']) {
    copyFileSync(join(root, name), join(dir, name));
  }
  assert.deepEqual(await checkResolver(dir), []);
});

test('a missing policy file fails the behavioral package gate', async (t) => {
  const dir = fixture(t);
  mkdirSync(join(dir, 'scripts'));
  for (const name of ['models.default.md', 'scripts/context-routing.mjs']) {
    copyFileSync(join(root, name), join(dir, name));
  }
  const errors = await checkResolver(dir);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /context\.default\.json/);
});
