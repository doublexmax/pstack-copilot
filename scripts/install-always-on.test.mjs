import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(root, 'scripts', 'install-always-on.mjs');

function snapshot(dir, prefix = '') {
  if (!existsSync(dir)) return {};
  return Object.fromEntries(readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = join(dir, entry.name);
    const name = `${prefix}${entry.name}`;
    return entry.isDirectory()
      ? Object.entries(snapshot(file, `${name}/`))
      : [[name, readFileSync(file)]];
  }));
}

function withHome(seed, { profile = true, shellRc = false, copilotName = '.copilot' } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'pstack-'));
  const copilotDir = join(home, copilotName);
  const target = join(copilotDir, 'copilot-instructions.md');
  const config = join(copilotDir, 'config.json');
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
        COPILOT_HOME: copilotDir,
        ...(profile ? { PSTACK_PROFILE_PATH: profilePath } : { PSTACK_PROFILE_PATH: '' }),
        ...(shellRc ? { PSTACK_SHELL_RC: shellRcPath } : {}),
      },
      encoding: 'utf8',
    });
  const read = () => (existsSync(target) ? readFileSync(target, 'utf8') : null);
  const readConfig = () => (existsSync(config) ? JSON.parse(readFileSync(config, 'utf8')) : null);
  const readProfile = () => (existsSync(profilePath) ? readFileSync(profilePath, 'utf8') : null);
  const readRc = () => (existsSync(shellRcPath) ? readFileSync(shellRcPath, 'utf8') : null);
  const bin = (name) => join(copilotDir, 'bin', name);
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
    copilotDir,
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
    const hooksOnce = readFileSync(join(h.copilotDir, 'hooks', 'pstack-context.json'), 'utf8');
    h.run();
    assert.strictEqual(h.read(), once);
    assert.strictEqual(readFileSync(h.config, 'utf8'), configOnce);
    assert.strictEqual(h.readProfile(), profileOnce);
    assert.strictEqual(readFileSync(join(h.copilotDir, 'hooks', 'pstack-context.json'), 'utf8'), hooksOnce);
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
    assert.strictEqual(existsSync(join(h.copilotDir, 'hooks', 'pstack-context.json')), false);
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
  'COPILOT_HOME selects the instruction, config, and shim directory'() {
    const h = withHome(undefined, { copilotName: 'isolated-copilot' });
    h.run();
    assert.ok(h.read().includes('poteto mode'));
    assert.deepStrictEqual(h.readConfig().trustedFolders, [join(h.home, 'isolated-copilot')]);
    assert.ok(existsSync(h.bin('pstack.cmd')));
    assert.strictEqual(existsSync(join(h.home, '.copilot')), false);
    h.cleanup();
  },
  'invalid config fails before any installation write'() {
    for (const value of ['{', '[]', '{"trustedFolders": "bad"}', '{"trustedFolders": [1]}']) {
      const h = withHome();
      mkdirSync(dirname(h.config), { recursive: true });
      writeFileSync(h.config, value);
      assert.throws(() => h.run(), /invalid JSON configuration/);
      assert.strictEqual(h.read(), null);
      assert.strictEqual(h.readProfile(), null);
      assert.strictEqual(existsSync(h.bin('pstack.cmd')), false);
      assert.strictEqual(readFileSync(h.config, 'utf8'), value);
      h.cleanup();
    }
  },
  'skip-trust preserves JSONC and unrelated preferences across install and uninstall'() {
    const h = withHome('keep these instructions\n');
    const jsonc = '{\n  // Preserve this comment.\n  "trustedFolders": ["C:\\\\already-trusted"]\n}\n';
    const models = readFileSync(join(root, 'models.default.md'), 'utf8').match(/```\r?\n([\s\S]*?)\r?\n```/)[1];
    const modelFile = join(dirname(h.config), 'pstack-models.md');
    const settingsFile = join(dirname(h.config), 'settings.json');
    const settings = '{"contextTier":"default","subagents":{"agents":{"poteto-worker":{"contextTier":"inherit"}}}}\n';
    writeFileSync(h.config, jsonc);
    writeFileSync(modelFile, models);
    writeFileSync(settingsFile, settings);
    h.run('--skip-trust', '--skip-shell');
    const once = h.read();
    h.run('--skip-trust', '--skip-shell');
    assert.strictEqual(h.read(), once);
    h.run('--uninstall', '--skip-trust', '--skip-shell');
    assert.strictEqual(h.read(), 'keep these instructions\n');
    assert.strictEqual(readFileSync(h.config, 'utf8'), jsonc);
    assert.strictEqual(readFileSync(modelFile, 'utf8'), models);
    assert.strictEqual(readFileSync(settingsFile, 'utf8'), settings);
    h.cleanup();
  },
  'native hooks use direct execution and preserve unrelated hook files and personal policy'() {
    const h = withHome();
    const dir = join(h.copilotDir, 'hooks');
    mkdirSync(dir, { recursive: true });
    const foreign = '{"version":1,"hooks":{"sessionStart":[{"type":"command","exec":"user-helper"}]}}\n';
    const policy = '{"schemaVersion":1,"default":"adaptive","roles":{"how explainer":"default"}}\n';
    writeFileSync(join(dir, 'user.json'), foreign);
    writeFileSync(join(h.copilotDir, 'pstack-context.json'), policy);
    h.run('--skip-shell');
    const hooks = JSON.parse(readFileSync(join(dir, 'pstack-context.json'), 'utf8'));
    for (const phase of ['sessionStart', 'userPromptSubmitted', 'preToolUse', 'postToolUse']) {
      assert.strictEqual(hooks.hooks[phase][0].exec, process.execPath);
      assert.deepStrictEqual(hooks.hooks[phase][0].args, [join(h.copilotDir, 'hooks', 'context-hook.mjs'), phase, root]);
      assert.strictEqual(hooks.hooks[phase][0].powershell, undefined);
      assert.strictEqual(hooks.hooks[phase][0].bash, undefined);
    }
    assert.strictEqual(readFileSync(join(dir, 'user.json'), 'utf8'), foreign);
    assert.strictEqual(readFileSync(join(h.copilotDir, 'pstack-context.json'), 'utf8'), policy);
    h.run('--uninstall', '--skip-shell');
    assert.strictEqual(existsSync(join(dir, 'pstack-context.json')), false);
    assert.strictEqual(existsSync(join(dir, 'context-hook.mjs')), false);
    assert.strictEqual(readFileSync(join(dir, 'user.json'), 'utf8'), foreign);
    assert.strictEqual(readFileSync(join(h.copilotDir, 'pstack-context.json'), 'utf8'), policy);
    h.cleanup();
  },
  'hook collision and invalid policy fail before any installation write'() {
    for (const scenario of ['foreign-hook', 'invalid-policy']) {
      const h = withHome();
      mkdirSync(h.copilotDir, { recursive: true });
      if (scenario === 'foreign-hook') {
        mkdirSync(join(h.copilotDir, 'hooks'));
        writeFileSync(join(h.copilotDir, 'hooks', 'pstack-context.json'), '{"version":1,"hooks":{}}\n');
      } else writeFileSync(join(h.copilotDir, 'pstack-context.json'), '{"schemaVersion":1,"default":"invalid"}');
      assert.throws(() => h.run('--skip-trust', '--skip-shell'), /foreign hook file|invalid default policy/);
      assert.strictEqual(h.read(), null);
      assert.strictEqual(h.readConfig(), null);
      assert.strictEqual(h.readProfile(), null);
      h.cleanup();
    }
  },
  'the copied entry permits unmarked calls after checkout loss and uninstall needs no resolver'() {
    const h = withHome();
    h.run('--skip-trust', '--skip-shell');
    const entry = join(h.copilotDir, 'hooks', 'context-hook.mjs');
    const output = execFileSync(process.execPath, [entry, 'preToolUse', join(h.home, 'missing-checkout')], {
      env: { ...process.env, COPILOT_HOME: h.copilotDir }, encoding: 'utf8',
      input: JSON.stringify({ toolName: 'task', toolArgs: { name: 'ordinary', prompt: 'Read one file.' } }),
    });
    assert.deepStrictEqual(JSON.parse(output), {});
    const brokenRoot = join(h.home, 'broken-checkout');
    mkdirSync(join(brokenRoot, 'scripts'), { recursive: true });
    writeFileSync(join(brokenRoot, 'scripts', 'install-always-on.mjs'), readFileSync(script));
    execFileSync(process.execPath, [join(brokenRoot, 'scripts', 'install-always-on.mjs'),
      '--uninstall', '--skip-trust', '--skip-shell'], {
      env: { ...process.env, COPILOT_HOME: h.copilotDir }, encoding: 'utf8',
    });
    assert.strictEqual(existsSync(entry), false);
    assert.strictEqual(existsSync(join(h.copilotDir, 'hooks', 'pstack-context.json')), false);
    h.cleanup();
  },
  'fresh hook skip installs the other integration without native hook files'() {
    const h = withHome();
    try {
      h.run('--hooks', 'skip');
      assert.ok(h.read().includes('<!-- pstack:begin poteto-mode -->'));
      assert.deepStrictEqual(h.readConfig().trustedFolders, [h.copilotDir]);
      assert.ok(h.readProfile().includes('function pstack'));
      assert.ok(existsSync(h.bin('pstack.cmd')));
      assert.strictEqual(existsSync(join(h.copilotDir, 'hooks', 'pstack-context.json')), false);
      assert.strictEqual(existsSync(join(h.copilotDir, 'hooks', 'context-hook.mjs')), false);
      const once = snapshot(h.home);
      h.run('--hooks', 'skip');
      assert.deepStrictEqual(snapshot(h.home), once);
    } finally { h.cleanup(); }
  },
  'hook skip leaves existing and foreign hooks unchanged during instruction refresh'() {
    const h = withHome();
    try {
      h.run();
      const dir = join(h.copilotDir, 'hooks');
      writeFileSync(join(dir, 'context-hook.mjs'), 'user entry\n');
      writeFileSync(join(dir, 'pstack-context.json'), '{invalid but untouched}\n');
      const hooks = snapshot(dir);
      writeFileSync(h.target, 'my notes\n');
      h.run('--hooks', 'skip');
      assert.ok(h.read().startsWith('my notes\n\n<!-- pstack:begin poteto-mode -->'));
      assert.deepStrictEqual(snapshot(dir), hooks);
    } finally { h.cleanup(); }
  },
  'hook-only removal preserves instructions, policy, models, trust, wrappers, agents, and session state'() {
    const h = withHome('user instructions\n');
    try {
      h.run();
      const dir = h.copilotDir;
      mkdirSync(join(dir, 'agents'));
      copyFileSync(join(root, 'agents', 'poteto.agent.md'), join(dir, 'agents', 'poteto.agent.md'));
      writeFileSync(join(dir, 'settings.json'), '{"contextTier":"default","subagents":{"agents":{"poteto-worker":{"contextTier":"inherit"}}}}\n');
      writeFileSync(join(dir, 'pstack-models.md'), readFileSync(join(root, 'models.default.md')));
      writeFileSync(join(dir, 'pstack-context.json'), '{"schemaVersion":1,"default":"invalid"}\n');
      writeFileSync(join(dir, 'hooks', 'user.json'), '{"version":1,"hooks":{}}\n');
      writeFileSync(h.config, '{\n  // User trust comment.\n  "trustedFolders": ["retained"]\n}\n');
      const marker = join(dir, 'session-state', 'session-one', 'files', 'pstack-context-opt-out');
      mkdirSync(dirname(marker), { recursive: true });
      writeFileSync(marker, 'disabled\n');
      const before = snapshot(h.home);
      const expected = { ...before };
      delete expected['.copilot/hooks/pstack-context.json'];
      delete expected['.copilot/hooks/context-hook.mjs'];
      h.run('--hooks', 'remove', '--dry-run');
      assert.deepStrictEqual(snapshot(h.home), before);
      h.run('--hooks', 'remove');
      assert.strictEqual(existsSync(join(dir, 'hooks', 'pstack-context.json')), false);
      assert.strictEqual(existsSync(join(dir, 'hooks', 'context-hook.mjs')), false);
      assert.deepStrictEqual(snapshot(h.home), expected);
      h.run('--hooks', 'remove');
      assert.deepStrictEqual(snapshot(h.home), expected);
    } finally { h.cleanup(); }
  },
  'hook-only removal needs neither source instructions nor a resolver checkout'() {
    const h = withHome();
    try {
      h.run('--skip-shell', '--skip-trust');
      const before = h.read();
      const brokenRoot = join(h.home, 'missing-sources');
      mkdirSync(join(brokenRoot, 'scripts'), { recursive: true });
      copyFileSync(script, join(brokenRoot, 'scripts', 'install-always-on.mjs'));
      execFileSync(process.execPath, [join(brokenRoot, 'scripts', 'install-always-on.mjs'), '--hooks', 'remove'], {
        env: { ...process.env, COPILOT_HOME: h.copilotDir }, encoding: 'utf8',
      });
      assert.strictEqual(existsSync(join(h.copilotDir, 'hooks', 'context-hook.mjs')), false);
      assert.strictEqual(existsSync(join(h.copilotDir, 'hooks', 'pstack-context.json')), false);
      assert.strictEqual(h.read(), before);
    } finally { h.cleanup(); }
  },
  'hook removal and reinstall refuse foreign reserved files before any write'() {
    for (const [file, bytes, message] of [
      ['pstack-context.json', '{"version":1,"hooks":{}}\n', /foreign hook file/],
      ['pstack-context.json', '{\n', /invalid hook file/],
      ['context-hook.mjs', 'user entry\n', /foreign hook entry/],
    ]) {
      const h = withHome();
      try {
        h.run();
        writeFileSync(join(h.copilotDir, 'hooks', file), bytes);
        const before = snapshot(h.home);
        assert.throws(() => h.run('--hooks', 'remove'), message);
        assert.deepStrictEqual(snapshot(h.home), before);
        assert.throws(() => h.run(), message);
        assert.deepStrictEqual(snapshot(h.home), before);
      } finally { h.cleanup(); }
    }
  },
  'dry-run with either install or skip writes nothing'() {
    for (const action of ['install', 'skip']) {
      const h = withHome();
      try {
        const before = snapshot(h.home);
        h.run('--hooks', action, '--dry-run');
        assert.deepStrictEqual(snapshot(h.home), before);
        assert.strictEqual(h.read(), null);
      } finally { h.cleanup(); }
    }
  },
  'default and explicit reinstall re-enable the removed owned hooks'() {
    const h = withHome();
    try {
      h.run();
      const installed = snapshot(h.home);
      h.run('--hooks', 'remove');
      h.run('--hooks', 'skip');
      assert.strictEqual(existsSync(join(h.copilotDir, 'hooks', 'pstack-context.json')), false);
      h.run();
      assert.deepStrictEqual(snapshot(h.home), installed);
      h.run('--hooks', 'remove');
      h.run('--hooks', 'install');
      assert.deepStrictEqual(snapshot(h.home), installed);
    } finally { h.cleanup(); }
  },
  'context-only policy changes leave hooks disabled and the explicit resolver usable'() {
    const h = withHome();
    try {
      h.run();
      h.run('--hooks', 'remove');
      const before = snapshot(h.home);
      const env = { ...process.env, COPILOT_HOME: h.copilotDir };
      const resolver = join(root, 'scripts', 'context-routing.mjs');
      execFileSync(process.execPath, [resolver, 'set-policy', '--default', 'adaptive'], { env, encoding: 'utf8' });
      const after = snapshot(h.home);
      delete after['.copilot/pstack-context.json'];
      assert.deepStrictEqual(after, before);
      const result = JSON.parse(execFileSync(process.execPath, [resolver, 'resolve',
        '--role', 'how explainer', '--model', 'gpt-6.1-sol', '--effort', 'max',
        '--workload', 'bounded', '--why', 'Read one helper.', '--input', 'src/format.mjs',
        '--host-context', 'supported', '--host-source', 'Current task context schema',
        '--support', 'supported', '--source', 'Exact-model current task schema',
      ], { env, encoding: 'utf8' }));
      assert.deepStrictEqual(result.toolArguments, {
        model: 'gpt-6.1-sol', reasoning_effort: 'max', context_tier: 'default',
      });
      assert.strictEqual(result.decision.reason, 'bounded-work');
      assert.ok(result.declaration.startsWith('PSTACK_CONTEXT_V1 '));
      assert.strictEqual(existsSync(join(h.copilotDir, 'hooks', 'pstack-context.json')), false);
    } finally { h.cleanup(); }
  },
  'malformed and contradictory hook options fail without writes'() {
    for (const args of [
      ['--hooks'], ['--hooks', '--dry-run'], ['--hooks', 'invalid'],
      ['--hooks', 'install', '--hooks', 'skip'], ['--dry-run', '--dry-run'],
      ['--uninstall', '--hooks', 'install'], ['--uninstall', '--hooks', 'skip'],
      ['--uninstall', '--hooks', 'remove'], ['--hooks', 'remove', '--skip-shell'],
      ['--hooks', 'remove', '--skip-trust'],
    ]) {
      const h = withHome();
      try {
        const before = snapshot(h.home);
        assert.throws(() => h.run(...args), /--hooks|duplicate option/);
        assert.deepStrictEqual(snapshot(h.home), before);
      } finally { h.cleanup(); }
    }
  },
  'help distinguishes hook skip from hook-only removal'() {
    const h = withHome();
    try {
      const help = h.run('--help');
      assert.match(help, /--hooks <install\|skip\|remove>/);
      assert.match(help, /skip leaves existing hooks unchanged/);
      assert.match(help, /remove changes only owned hook files/);
      assert.strictEqual(h.read(), null);
    } finally { h.cleanup(); }
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
