import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';
import { checkSync, accept, parseManifest, hashFile } from './check-upstream-sync.mjs';

const SOURCES = {
  'skills/kept/SKILL.md': 'verbatim import\n',
  'skills/tuned/SKILL.md': 'upstream wording\n',
  'infra/plugin.json': '{"cursor":true}\n',
};

const COLUMN_INDEX = { source: 0, status: 1, source_sha256: 2, local: 3, local_sha256: 4, reason: 5 };

function write(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'pstack-sync-'));
  const root = join(dir, 'port');
  const upstream = join(dir, 'upstream');

  for (const [path, text] of Object.entries(SOURCES)) write(join(upstream, 'pstack', path), text);
  execFileSync('git', ['-C', upstream, 'init', '-q']);
  execFileSync('git', ['-C', upstream, 'config', 'core.autocrlf', 'false']);
  execFileSync('git', ['-C', upstream, 'add', '-A']);
  execFileSync('git', [
    '-C', upstream, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'pin',
  ]);
  const pin = execFileSync('git', ['-C', upstream, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

  write(join(root, 'skills/kept/SKILL.md'), SOURCES['skills/kept/SKILL.md']);
  write(join(root, 'skills/tuned/SKILL.md'), 'Copilot wording\n');

  const manifestPath = join(root, 'scripts', 'upstream-sync.manifest.tsv');
  const rows = [
    ['skills/kept/SKILL.md', 'identical', hashFile(join(upstream, 'pstack/skills/kept/SKILL.md')), 'skills/kept/SKILL.md', '', ''],
    ['skills/tuned/SKILL.md', 'adapted', hashFile(join(upstream, 'pstack/skills/tuned/SKILL.md')), 'skills/tuned/SKILL.md', hashFile(join(root, 'skills/tuned/SKILL.md')), 'host wording differs'],
    ['infra/plugin.json', 'excluded', hashFile(join(upstream, 'pstack/infra/plugin.json')), '', '', 'Cursor-only packaging'],
  ];
  const manifest = [`#pin\t${pin}`, '#subtree\tpstack', '#columns\tsource\tstatus\tsource_sha256\tlocal\tlocal_sha256\treason', ...rows.map((r) => r.join('\t'))].join('\n');
  write(manifestPath, `${manifest}\n`);

  return {
    root,
    upstream,
    manifestPath,
    pin,
    manifestText: () => readFileSync(manifestPath, 'utf8'),
    setManifest: (text) => writeFileSync(manifestPath, text),
    editManifest: (edit) => writeFileSync(manifestPath, edit(readFileSync(manifestPath, 'utf8'))),
    editRow: (source, field, value) =>
      writeFileSync(
        manifestPath,
        readFileSync(manifestPath, 'utf8')
          .split('\n')
          .map((line) => {
            if (!line.startsWith(`${source}\t`)) return line;
            const fields = line.split('\t');
            fields[COLUMN_INDEX[field]] = value;
            return fields.join('\t');
          })
          .join('\n'),
      ),
    writeLocal: (path, text) => write(join(root, path), text),
    writeUpstream: (path, text) => write(join(upstream, 'pstack', path), text),
    run: (withUpstream = true) => checkSync({ root, manifestPath, upstream: withUpstream ? upstream : null }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function expectFailure(result, fragment) {
  assert.ok(
    result.failures.some((failure) => failure.includes(fragment)),
    `expected a failure containing "${fragment}", got ${JSON.stringify(result.failures)}`,
  );
}

const cases = {
  'a reconciled port passes against the pinned checkout'() {
    const f = fixture();
    const result = f.run();
    assert.deepEqual(result.failures, []);
    assert.deepEqual(result.counts, { identical: 1, adapted: 1, excluded: 1 });
    f.cleanup();
  },

  'local integrity runs without the upstream checkout'() {
    const f = fixture();
    assert.deepEqual(f.run(false).failures, []);
    f.cleanup();
  },

  'an imported file that drifted locally fails'() {
    const f = fixture();
    f.writeLocal('skills/kept/SKILL.md', 'edited in the port\n');
    expectFailure(f.run(), 'drifted from the imported source');
    expectFailure(f.run(false), 'drifted from the imported source');
    f.cleanup();
  },

  'an adapted file that drifted from its reviewed hash fails'() {
    const f = fixture();
    f.writeLocal('skills/tuned/SKILL.md', 'reworded again\n');
    expectFailure(f.run(), 'drifted from its reviewed hash');
    f.cleanup();
  },

  'a missing local file fails'() {
    const f = fixture();
    rmSync(join(f.root, 'skills/kept/SKILL.md'));
    expectFailure(f.run(), 'is missing');
    f.cleanup();
  },

  'a new upstream file with no manifest row fails and reports its hash'() {
    const f = fixture();
    f.writeUpstream('skills/fresh/SKILL.md', 'brand new\n');
    execFileSync('git', ['-C', f.upstream, 'add', '-A']);
    execFileSync('git', ['-C', f.upstream, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'add']);
    const result = f.run();
    expectFailure(result, 'skills/fresh/SKILL.md: new upstream file');
    expectFailure(result, hashFile(join(f.upstream, 'pstack/skills/fresh/SKILL.md')));
    f.cleanup();
  },

  'an upstream file that disappeared fails'() {
    const f = fixture();
    rmSync(join(f.upstream, 'pstack/infra/plugin.json'));
    execFileSync('git', ['-C', f.upstream, 'add', '-A']);
    execFileSync('git', ['-C', f.upstream, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'drop']);
    expectFailure(f.run(), 'upstream no longer ships this file');
    f.cleanup();
  },

  'changed upstream content fails even when the local file is untouched'() {
    const f = fixture();
    f.writeUpstream('skills/kept/SKILL.md', 'upstream moved on\n');
    execFileSync('git', ['-C', f.upstream, 'add', '-A']);
    execFileSync('git', ['-C', f.upstream, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'change']);
    expectFailure(f.run(), 'upstream content changed since review');
    f.cleanup();
  },

  'a pin that does not match the checkout fails'() {
    const f = fixture();
    f.editManifest((text) => text.replace(f.pin, '0'.repeat(40)));
    expectFailure(f.run(), 'manifest pins');
    f.cleanup();
  },

  'a dirty upstream checkout fails'() {
    const f = fixture();
    f.writeUpstream('skills/kept/SKILL.md', 'uncommitted edit\n');
    expectFailure(f.run(), 'uncommitted changes');
    f.cleanup();
  },

  'an adapted row with no reason fails'() {
    const f = fixture();
    f.editRow('skills/tuned/SKILL.md', 'reason', '');
    expectFailure(f.run(false), 'has no reason');
    f.cleanup();
  },

  'a reason left as a TODO fails'() {
    const f = fixture();
    f.editRow('skills/tuned/SKILL.md', 'reason', 'TODO explain');
    expectFailure(f.run(false), 'still a TODO placeholder');
    f.cleanup();
  },

  'an excluded row that claims a local file fails'() {
    const f = fixture();
    f.editRow('infra/plugin.json', 'local', 'scripts/plugin.json');
    expectFailure(f.run(false), 'excluded row claims local');
    f.cleanup();
  },

  'an unknown status fails'() {
    const f = fixture();
    f.editRow('skills/kept/SKILL.md', 'status', 'ported');
    expectFailure(f.run(false), 'is not one of');
    f.cleanup();
  },

  'a duplicate source row fails'() {
    const f = fixture();
    f.editManifest((text) => {
      const lines = text.trimEnd().split('\n');
      return `${[...lines, lines.at(-1)].join('\n')}\n`;
    });
    expectFailure(f.run(false), 'duplicate source');
    f.cleanup();
  },

  'two rows claiming the same local file fail'() {
    const f = fixture();
    f.editRow('skills/tuned/SKILL.md', 'local', 'skills/kept/SKILL.md');
    expectFailure(f.run(false), 'already claimed at line');
    f.cleanup();
  },

  'a row with a missing column fails'() {
    const f = fixture();
    f.editManifest((text) => `${text}skills/kept/SKILL.md\tidentical\n`);
    expectFailure(f.run(false), 'columns, expected 6');
    f.cleanup();
  },

  'a manifest with no pin header fails'() {
    const f = fixture();
    f.editManifest((text) => text.split('\n').filter((line) => !line.startsWith('#pin')).join('\n'));
    expectFailure(f.run(false), 'no `#pin` header');
    f.cleanup();
  },

  'an adapted row with no reviewed local hash fails'() {
    const f = fixture();
    f.editRow('skills/tuned/SKILL.md', 'local_sha256', '');
    expectFailure(f.run(false), 'no reviewed local_sha256');
    f.cleanup();
  },

  'accept re-records one reviewed adaptation and leaves the rest alone'() {
    const f = fixture();
    f.writeLocal('skills/tuned/SKILL.md', 'Copilot wording, revised\n');
    f.writeUpstream('skills/tuned/SKILL.md', 'upstream wording, revised\n');
    execFileSync('git', ['-C', f.upstream, 'add', '-A']);
    execFileSync('git', ['-C', f.upstream, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'revise']);
    f.editManifest((text) => text.replace(f.pin, execFileSync('git', ['-C', f.upstream, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()));
    expectFailure(f.run(), 'upstream content changed since review');

    const result = accept({ root: f.root, manifestPath: f.manifestPath, upstream: f.upstream, sources: ['skills/tuned/SKILL.md'] });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.accepted, ['skills/tuned/SKILL.md']);
    assert.deepEqual(f.run().failures, []);
    const rows = parseManifest(f.manifestText()).rows;
    assert.equal(rows.find((row) => row.source === 'skills/tuned/SKILL.md').reason, 'host wording differs');
    f.cleanup();
  },

  'accept refuses a path with no manifest row'() {
    const f = fixture();
    const before = f.manifestText();
    const result = accept({ root: f.root, manifestPath: f.manifestPath, upstream: f.upstream, sources: ['skills/ghost/SKILL.md'] });
    assert.deepEqual(result.accepted, []);
    expectFailure({ failures: result.errors }, 'no manifest row');
    assert.equal(f.manifestText(), before, 'manifest is untouched when accept fails');
    f.cleanup();
  },

  'accept refuses a different source pin without rewriting the manifest'() {
    const f = fixture();
    f.editManifest((text) => text.replace(f.pin, '0'.repeat(40)));
    f.writeLocal('skills/tuned/SKILL.md', 'reviewed local change\n');
    const before = f.manifestText();
    const result = accept({ root: f.root, manifestPath: f.manifestPath, upstream: f.upstream, sources: ['skills/tuned/SKILL.md'] });
    expectFailure({ failures: result.errors }, 'manifest pins');
    assert.deepEqual(result.accepted, []);
    assert.equal(f.manifestText(), before);
    f.cleanup();
  },

  'accept refuses dirty source files without rewriting the manifest'() {
    const f = fixture();
    f.writeUpstream('skills/tuned/SKILL.md', 'uncommitted source change\n');
    const before = f.manifestText();
    const result = accept({ root: f.root, manifestPath: f.manifestPath, upstream: f.upstream, sources: ['skills/tuned/SKILL.md'] });
    expectFailure({ failures: result.errors }, 'uncommitted changes');
    assert.deepEqual(result.accepted, []);
    assert.equal(f.manifestText(), before);
    f.cleanup();
  },

  'the CLI rejects missing option values rather than running a weaker check'() {
    const script = fileURLToPath(new URL('./check-upstream-sync.mjs', import.meta.url));
    for (const args of [['--upstream'], ['--accept'], ['--upstream', '--accept', 'skills/foo/SKILL.md']]) {
      const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
      assert.equal(result.status, 2, `arguments ${args.join(' ')} must fail as usage errors`);
      assert.match(result.stderr, /needs a value/);
      assert.doesNotMatch(result.stdout, /ok:/);
    }
  },

  'hashing ignores line endings for text and not for binaries'() {
    const f = fixture();
    f.writeLocal('skills/kept/SKILL.md', SOURCES['skills/kept/SKILL.md'].replace(/\n/g, '\r\n'));
    assert.deepEqual(f.run().failures, [], 'CRLF checkouts still match an LF source');
    f.writeLocal('art.png', 'a\r\nb\n');
    f.writeUpstream('art.png', 'a\nb\n');
    assert.notEqual(hashFile(join(f.root, 'art.png')), hashFile(join(f.upstream, 'pstack/art.png')));
    f.cleanup();
  },
};

let failed = 0;
for (const [name, run] of Object.entries(cases)) {
  try {
    run();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}\n     ${error.stack || error.message}`);
  }
}

console.log(failed ? `${failed} failing` : `ok: ${Object.keys(cases).length} cases`);
process.exitCode = failed ? 1 : 0;
