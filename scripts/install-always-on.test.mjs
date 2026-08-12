import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(root, 'scripts', 'install-always-on.mjs');

function withHome(seed) {
  const home = mkdtempSync(join(tmpdir(), 'pstack-'));
  const target = join(home, '.copilot', 'copilot-instructions.md');
  if (seed !== undefined) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, seed);
  }
  const run = (...args) =>
    execFileSync(process.execPath, [script, ...args], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: 'utf8',
    });
  const read = () => (existsSync(target) ? readFileSync(target, 'utf8') : null);
  return { run, read, target, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

const cases = {
  'fresh install has no leading blank and ends with a newline'() {
    const h = withHome();
    h.run();
    const text = h.read();
    assert.ok(text.startsWith('<!-- pstack:begin poteto-mode -->'), 'starts at the marker');
    assert.ok(text.endsWith('-->\n'), 'ends with a newline');
    h.cleanup();
  },
  'block is path-independent so it survives the clone moving'() {
    const h = withHome();
    h.run();
    const text = h.read();
    assert.ok(!text.includes(root), 'no clone path baked in');
    assert.ok(text.includes('`Poteto-Mode`'), 'routes by skill name');
    h.cleanup();
  },
  'running twice is byte-identical'() {
    const h = withHome();
    h.run();
    const once = h.read();
    h.run();
    assert.strictEqual(h.read(), once);
    h.cleanup();
  },
  'foreign content survives install and uninstall byte-identical'() {
    for (const seed of ['my own notes\n', 'my own notes', 'a\n\nb\n']) {
      const h = withHome(seed);
      h.run();
      assert.ok(h.read().includes('poteto mode'), 'block installed');
      assert.ok(h.read().startsWith(seed.trim()), 'foreign content still leads');
      h.run('--uninstall');
      assert.strictEqual(h.read(), `${seed.trim()}\n`);
      h.cleanup();
    }
  },
  'exactly one blank line separates foreign content from the block'() {
    const h = withHome('notes\n');
    h.run();
    assert.ok(h.read().startsWith('notes\n\n<!-- pstack:begin'), h.read().slice(0, 40));
    h.cleanup();
  },
  'uninstall on a file without the block changes nothing'() {
    const h = withHome('unrelated\n');
    h.run('--uninstall');
    assert.strictEqual(h.read(), 'unrelated\n');
    h.cleanup();
  },
  'dry run writes nothing'() {
    const h = withHome();
    h.run('--dry-run');
    assert.strictEqual(h.read(), null);
    h.cleanup();
  },
  'uninstall leaving nothing else empties the file'() {
    const h = withHome();
    h.run();
    h.run('--uninstall');
    assert.strictEqual(h.read(), '');
    h.cleanup();
  },
  'unknown option fails loudly'() {
    const h = withHome();
    assert.throws(() => h.run('--nope'), /unknown option/);
    h.cleanup();
  },
};

let failed = 0;
for (const [name, run] of Object.entries(cases)) {
  try {
    run();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}\n     ${error.message}`);
  }
}

console.log(failed ? `${failed} failing` : `ok: ${Object.keys(cases).length} cases`);
process.exitCode = failed ? 1 : 0;
