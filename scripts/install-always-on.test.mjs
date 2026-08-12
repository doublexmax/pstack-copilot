import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(root, 'scripts', 'install-always-on.mjs');

function withHome(seed, { profile = true, shellRc = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'pstack-'));
  const target = join(home, '.copilot', 'copilot-instructions.md');
  const config = join(home, '.copilot', 'config.json');
  const profilePath = join(home, 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1');
  const shellRcPath = join(home, '.bashrc');
  if (seed !== undefined) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, seed);
  }
  const run = (...args) =>
    execFileSync(process.execPath, [script, ...args], {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        ...(profile ? { PSTACK_PROFILE_PATH: profilePath } : { PSTACK_PROFILE_PATH: '' }),
        ...(shellRc ? { PSTACK_SHELL_RC: shellRcPath } : {}),
      },
      encoding: 'utf8',
    });
  const read = () => (existsSync(target) ? readFileSync(target, 'utf8') : null);
  const readConfig = () => (existsSync(config) ? JSON.parse(readFileSync(config, 'utf8')) : null);
  const readProfile = () => (existsSync(profilePath) ? readFileSync(profilePath, 'utf8') : null);
  const readRc = () => (existsSync(shellRcPath) ? readFileSync(shellRcPath, 'utf8') : null);
  const bin = (name) => join(home, '.copilot', 'bin', name);
  return {
    home,
    run,
    read,
    readConfig,
    readProfile,
    readRc,
    profilePath,
    bin,
    target,
    config,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
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
    assert.ok(text.includes('`poteto-mode`'), 'routes by skill name');
    h.cleanup();
  },
  'running twice is byte-identical'() {
    const h = withHome();
    h.run();
    const once = h.read();
    const configOnce = readFileSync(h.config, 'utf8');
    const profileOnce = h.readProfile();
    h.run();
    assert.strictEqual(h.read(), once);
    assert.strictEqual(readFileSync(h.config, 'utf8'), configOnce);
    assert.strictEqual(h.readProfile(), profileOnce);
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
    assert.strictEqual(h.readConfig(), null);
    assert.strictEqual(h.readProfile(), null);
    assert.ok(!existsSync(h.bin('pstack.cmd')));
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
  'trustedFolders gains absolute ~/.copilot and preserves other entries'() {
    const h = withHome();
    mkdirSync(dirname(h.config), { recursive: true });
    writeFileSync(
      h.config,
      `${JSON.stringify({ staff: true, trustedFolders: ['C:\\\\other\\\\repo'] }, null, 2)}\n`,
    );
    h.run();
    const cfg = h.readConfig();
    assert.strictEqual(cfg.staff, true);
    assert.ok(cfg.trustedFolders.some((p) => /other[\\/]+repo/i.test(p)));
    const copilotEntry = cfg.trustedFolders.find((p) => normalizeEndsWithCopilot(p, h.home));
    assert.ok(copilotEntry, `expected ~/.copilot in ${JSON.stringify(cfg.trustedFolders)}`);
    h.cleanup();
  },
  'trustedFolders uninstall removes only the copilot entry'() {
    const h = withHome();
    h.run();
    h.run('--uninstall');
    const cfg = h.readConfig();
    assert.ok(cfg);
    assert.ok(!cfg.trustedFolders || cfg.trustedFolders.length === 0);
    h.cleanup();
  },
  'profile wrapper passes --add-dir ~/.copilot'() {
    const h = withHome();
    h.run();
    const profile = h.readProfile();
    assert.ok(profile.includes('function pstack'), profile);
    assert.ok(profile.includes('--add-dir'), profile);
    assert.ok(profile.includes(join(h.home, '.copilot')) || profile.includes('.copilot'), profile);
    h.cleanup();
  },
  'bin shims are written'() {
    const h = withHome();
    h.run();
    assert.ok(existsSync(h.bin('pstack.cmd')));
    assert.ok(existsSync(h.bin('pstack.ps1')));
    assert.ok(existsSync(h.bin('pstack')));
    const cmd = readFileSync(h.bin('pstack.cmd'), 'utf8');
    assert.ok(cmd.includes('--add-dir'));
    h.cleanup();
  },
  'skip-shell leaves profile and shims alone'() {
    const h = withHome();
    h.run('--skip-shell');
    assert.ok(h.read().includes('poteto mode'));
    assert.ok(h.readConfig().trustedFolders?.length);
    assert.strictEqual(h.readProfile(), null);
    assert.ok(!existsSync(h.bin('pstack.cmd')));
    h.cleanup();
  },
  'uninstall removes profile block and shims'() {
    const h = withHome('keep me\n');
    mkdirSync(dirname(h.profilePath), { recursive: true });
    writeFileSync(h.profilePath, 'existing profile bits\n');
    h.run();
    assert.ok(h.readProfile().includes('existing profile bits'));
    h.run('--uninstall');
    const profile = h.readProfile();
    assert.ok(profile.includes('existing profile bits'));
    assert.ok(!profile.includes('function pstack'));
    assert.ok(!existsSync(h.bin('pstack.cmd')));
    h.cleanup();
  },
  'unix rc wrapper installs when PSTACK_SHELL_RC is set'() {
    const h = withHome(undefined, { shellRc: true });
    h.run();
    const rc = h.readRc();
    assert.ok(rc.includes('pstack()'), rc);
    assert.ok(rc.includes('--add-dir'), rc);
    h.cleanup();
  },
};

function normalizeEndsWithCopilot(p, home) {
  const n = String(p).replace(/\\/g, '/').toLowerCase();
  const expect = join(home, '.copilot').replace(/\\/g, '/').toLowerCase();
  return n === expect || n.endsWith('/.copilot');
}

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
