import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
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
