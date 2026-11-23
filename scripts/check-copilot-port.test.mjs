import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
  {
    name: 'rejects docs outside the upstream inventory',
    frontmatter: 'description: A description.',
    files: { 'docs/search-discovery.md': '# Search discovery\n' },
    status: 1,
    output: /untracked-doc[\s\S]*docs\/search-discovery\.md/,
  },
  {
    name: 'allows the upstream mapping doc and manifest-claimed guides',
    frontmatter: 'description: A description.',
    files: {
      'docs/upstream-sync.md': '# Upstream sync\n',
      'docs/guide/01-setup.md': '# Setup\n',
      'CONTRIBUTING.md': '[Setup](docs/guide/01-setup.md)\n',
      'scripts/upstream-sync.manifest.tsv':
        '# Fixture manifest\n\n'
        + 'guide/01-setup.md\tadapted\t-\tdocs/guide/01-setup.md\t-\tFixture guide.\n'
        + 'unused.md\texcluded\t-\t\t\tNo local file.\n',
    },
    status: 0,
    output: /ok: 1 skills, 3 markdown files/,
  },
  {
    name: 'allows the local Steward guide without an upstream manifest entry',
    frontmatter: 'description: A description.',
    files: { 'docs/guide/11-steward.md': '# Steward\n\n[Project README](../../README.md)\n' },
    status: 0,
    output: /ok: 1 skills, 2 markdown files/,
  },
  {
    name: 'rejects foreign tokens in the local Steward guide',
    frontmatter: 'description: A description.',
    files: { 'docs/guide/11-steward.md': '# Steward\n\nUse AskQuestion.\n' },
    status: 1,
    output: /foreign-token \(1\)\s+docs\/guide\/11-steward\.md: .*AskQuestion/,
  },
  {
    name: 'rejects broken links in the local Steward guide',
    frontmatter: 'description: A description.',
    files: { 'docs/guide/11-steward.md': '# Steward\n\n[Missing page](./missing.md)\n' },
    status: 1,
    output: /broken-link \(1\)\s+docs\/guide\/11-steward\.md: \.\/missing\.md does not resolve/,
  },
  {
    name: 'rejects docs excluded by the upstream manifest',
    frontmatter: 'description: A description.',
    files: {
      'docs/search-discovery.md': '# Search discovery\n',
      'scripts/upstream-sync.manifest.tsv':
        'search-discovery.md\texcluded\t-\tdocs/search-discovery.md\t-\tExcluded guide.\n',
    },
    status: 1,
    output: /untracked-doc[\s\S]*docs\/search-discovery\.md/,
  },
  {
    name: 'rejects unresolved contributing links',
    frontmatter: 'description: A description.',
    files: { 'CONTRIBUTING.md': '[Search discovery](docs/search-discovery.md)\n' },
    status: 1,
    output: /broken-link[\s\S]*CONTRIBUTING\.md: docs\/search-discovery\.md does not resolve/,
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
      for (const [path, contents] of Object.entries(scenario.files ?? {})) {
        const file = join(root, path);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, contents);
      }
      const result = spawnSync(process.execPath, [join(root, 'scripts', 'check-copilot-port.mjs')], { encoding: 'utf8' });
      assert.equal(result.status, scenario.status, result.stdout + result.stderr);
      assert.match(result.stdout + result.stderr, scenario.output);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
