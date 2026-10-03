import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const checker = fileURLToPath(new URL('./check-copilot-port.mjs', import.meta.url));

const cases = [
  {
    name: 'loads a folded description',
    frontmatter: 'description: >-\n  A short description.\n  Use for "probe".',
    status: 0,
    output: /ok: 1 skills, 1 markdown files/,
  },
  {
    name: 'rejects a folded description over the load limit',
    frontmatter: `description: >-\n  ${'a'.repeat(650)}\n  ${'b'.repeat(650)}`,
    status: 1,
    output: /1301 chars, limit is 1024/,
  },
  {
    name: 'checks unsupported keys after a folded description',
    frontmatter: 'description: >-\n  A description.\ndisable-model-invocation: true',
    status: 1,
    output: /unsupported-frontmatter/,
  },
  {
    name: 'rejects imported host tools',
    frontmatter: 'description: A description.',
    body: 'Drive the app with control-ui.',
    status: 1,
    output: /foreign-token/,
  },
  {
    name: 'rejects unresolved skill references',
    frontmatter: 'description: A description.',
    body: '[Read the reference](references/missing.md).',
    status: 1,
    output: /broken-link/,
  },
];

for (const scenario of cases) {
  test(scenario.name, () => {
    const root = mkdtempSync(join(tmpdir(), 'pstack-port-'));
    try {
      mkdirSync(join(root, 'scripts'));
      mkdirSync(join(root, 'skills', 'probe'), { recursive: true });
      copyFileSync(checker, join(root, 'scripts', 'check-copilot-port.mjs'));
      writeFileSync(join(root, 'README.md'), '# Fixture\n');
      writeFileSync(
        join(root, 'skills', 'probe', 'SKILL.md'),
        `---\nname: probe\n${scenario.frontmatter}\n---\n\n# Probe\n${scenario.body ?? ''}\n`,
      );
      const result = spawnSync(process.execPath, [join(root, 'scripts', 'check-copilot-port.mjs')], { encoding: 'utf8' });
      assert.equal(result.status, scenario.status, result.stdout + result.stderr);
      assert.match(result.stdout + result.stderr, scenario.output);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
