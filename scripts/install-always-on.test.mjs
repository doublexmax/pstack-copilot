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
  let preload;
  const mockPowerShell = (responses, osPlatform = 'win32') => {
    const source = `
      import childProcess from 'node:child_process';
      import os from 'node:os';
      import { syncBuiltinESMExports } from 'node:module';
      import assert from 'node:assert/strict';
      os.platform = () => ${JSON.stringify(osPlatform)};
      const responses = ${JSON.stringify(responses)};
      childProcess.execFileSync = (command, args, options) => {
        assert.ok(Object.hasOwn(responses, command), 'unexpected PowerShell query: ' + command);
        assert.ok(args.includes('-NoProfile'));
        assert.ok(args.includes('-NonInteractive'));
        assert.ok(args.includes('-Command'));
        assert.match(args.at(-1), /\\$PROFILE\\.CurrentUserCurrentHost/);
        assert.match(args.at(-1), /UTF8Encoding/);
        assert.equal(options.encoding, 'utf8');
        assert.ok(options.timeout > 0 && options.timeout <= 10000);
        const response = responses[command];
        if (typeof response === 'string') return response;
        throw Object.assign(new Error(response.message || response.code || 'PowerShell query failed'), response);
      };
      for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'fork']) {
        childProcess[name] = () => { throw new Error('unexpected child process API: ' + name); };
      }
      syncBuiltinESMExports();
    `;
    preload = `data:text/javascript,${encodeURIComponent(source)}`;
  };
  const run = (...args) =>
    execFileSync(process.execPath, [...(preload ? ['--import', preload] : []), script, ...args], {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        COPILOT_HOME: copilotDir,
        ...(profile ? { PSTACK_PROFILE_PATH: profilePath } : { PSTACK_PROFILE_PATH: '' }),
        PSTACK_SHELL_RC: shellRc ? shellRcPath : '',
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
    mockPowerShell,
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
    const doubleHookOnce = readFileSync(join(h.copilotDir, 'hooks', 'pstack-double.json'), 'utf8');
    h.run();
    assert.strictEqual(h.read(), once);
    assert.strictEqual(readFileSync(h.config, 'utf8'), configOnce);
    assert.strictEqual(h.readProfile(), profileOnce);
    assert.strictEqual(readFileSync(join(h.copilotDir, 'hooks', 'pstack-context.json'), 'utf8'), hooksOnce);
    assert.strictEqual(readFileSync(join(h.copilotDir, 'hooks', 'pstack-double.json'), 'utf8'), doubleHookOnce);
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
  'default Windows profile discovery follows pwsh redirection and preserves user content'() {
    const h = withHome(undefined, { profile: false });
    try {
      const profile = join(h.home, 'OneDrive - Work', 'Døcuments', 'PowerShell', 'Microsoft.PowerShell_profile.ps1');
      const legacy = join(h.home, 'Redirected', 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1');
      h.mockPowerShell({ 'pwsh.exe': `${profile}\r\n`, 'powershell.exe': `${legacy}\r\n` });
      mkdirSync(dirname(profile), { recursive: true });
      const foreign = "Write-Output 'my profile'\n";
      writeFileSync(profile, foreign);
      const before = snapshot(h.home);
      assert.ok(h.run('--dry-run').includes(`would update ${profile}`));
      assert.deepStrictEqual(snapshot(h.home), before);
      h.run();
      const installed = readFileSync(profile, 'utf8');
      assert.ok(installed.startsWith(foreign));
      assert.ok(installed.includes('function pstack'));
      assert.strictEqual(h.readProfile(), null);
      assert.strictEqual(existsSync(legacy), false);
      const once = snapshot(h.home);
      h.run();
      assert.deepStrictEqual(snapshot(h.home), once);
      h.run('--uninstall');
      assert.strictEqual(readFileSync(profile, 'utf8'), foreign);
      assert.strictEqual(existsSync(h.bin('pstack.cmd')), false);
    } finally { h.cleanup(); }
  },
  'Windows profile discovery falls back when pwsh is unavailable'() {
    const h = withHome(undefined, { profile: false });
    try {
      const profile = join(h.home, 'OneDrive', 'Documents', 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1');
      h.mockPowerShell({ 'pwsh.exe': { code: 'ENOENT' }, 'powershell.exe': `${profile}\r\n` });
      h.run();
      assert.ok(readFileSync(profile, 'utf8').includes('function pstack'));
      assert.strictEqual(h.readProfile(), null);
      h.run('--uninstall');
      assert.strictEqual(existsSync(profile), false);
    } finally { h.cleanup(); }
  },
  'an explicit profile override bypasses discovery on Windows and Unix'() {
    for (const osPlatform of ['win32', 'linux']) {
      const h = withHome();
      try {
        h.mockPowerShell({}, osPlatform);
        h.run();
        assert.ok(h.readProfile().includes('function pstack'));
        h.run('--uninstall');
        assert.strictEqual(h.readProfile(), null);
      } finally { h.cleanup(); }
    }
  },
  'PowerShell query failures abort install and uninstall before any write'() {
    for (const responses of [
      { 'pwsh.exe': { status: 1, message: 'query failed' } },
      { 'pwsh.exe': { code: 'EACCES' } },
      { 'pwsh.exe': { code: 'ETIMEDOUT' } },
      { 'pwsh.exe': { code: 'ENOENT' }, 'powershell.exe': { code: 'ENOENT' } },
      { 'pwsh.exe': { code: 'ENOENT' }, 'powershell.exe': { status: 1, message: 'query failed' } },
    ]) {
      const h = withHome('keep these instructions\n', { profile: false });
      try {
        h.mockPowerShell({
          'powershell.exe': `${join(h.home, 'fallback-profile.ps1')}\r\n`,
          ...responses,
        });
        writeFileSync(h.config, `${JSON.stringify({ trustedFolders: [h.copilotDir] })}\n`);
        mkdirSync(dirname(h.bin('pstack.cmd')), { recursive: true });
        writeFileSync(h.bin('pstack.cmd'), 'keep this shim\n');
        const before = snapshot(h.home);
        for (const args of [[], ['--uninstall'], ['--dry-run']]) {
          assert.throws(() => h.run(...args), /PowerShell profile/);
          assert.deepStrictEqual(snapshot(h.home), before);
        }
      } finally { h.cleanup(); }
    }
  },
  'empty and malformed discovered profile paths fail without guessing or writing'() {
    const h = withHome(undefined, { profile: false });
    try {
      const profile = join(h.home, 'profile.ps1');
      const before = snapshot(h.home);
      for (const output of ['', ' \r\n', 'relative\\profile.ps1', 'C:relative\\profile.ps1',
        `${profile}\n${profile}`, `"${profile}"`, `${profile}\0`, `${profile}?`, `${profile}:stream`]) {
        h.mockPowerShell({
          'pwsh.exe': output,
          'powershell.exe': `${join(h.home, 'fallback-profile.ps1')}\r\n`,
        });
        assert.throws(() => h.run(), /invalid PowerShell profile path/i);
        assert.deepStrictEqual(snapshot(h.home), before);
        assert.throws(() => h.run('--dry-run'), /invalid PowerShell profile path/i);
        assert.deepStrictEqual(snapshot(h.home), before);
      }
    } finally { h.cleanup(); }
  },
  'skip-shell bypasses default profile discovery for install and uninstall'() {
    const h = withHome(undefined, { profile: false });
    try {
      h.mockPowerShell({});
      h.run('--skip-shell');
      assert.ok(h.read().includes('poteto mode'));
      assert.deepStrictEqual(h.readConfig().trustedFolders, [h.copilotDir]);
      assert.strictEqual(h.readProfile(), null);
      assert.strictEqual(existsSync(h.bin('pstack.cmd')), false);
      h.run('--uninstall', '--skip-shell');
      assert.strictEqual(h.read(), '');
      assert.strictEqual(existsSync(join(h.copilotDir, 'hooks', 'pstack-context.json')), false);
    } finally { h.cleanup(); }
  },
  'hook-only removal bypasses profile discovery and preserves shell integration'() {
    const h = withHome(undefined, { profile: false });
    try {
      const profile = join(h.home, 'Redirected', 'Microsoft.PowerShell_profile.ps1');
      h.mockPowerShell({ 'pwsh.exe': `${profile}\r\n` });
      h.run();
      assert.ok(readFileSync(profile, 'utf8').includes('function pstack'));
      const before = snapshot(h.home);
      h.mockPowerShell({});
      h.run('--hooks', 'remove');
      delete before['.copilot/hooks/pstack-context.json'];
      delete before['.copilot/hooks/context-hook.mjs'];
      delete before['.copilot/hooks/pstack-double.json'];
      delete before['.copilot/extensions/double/extension.mjs'];
      assert.deepStrictEqual(snapshot(h.home), before);
    } finally { h.cleanup(); }
  },
  'non-Windows default discovery keeps Unix shell integration without PowerShell'() {
    const h = withHome(undefined, { profile: false, shellRc: true });
    try {
      h.mockPowerShell({}, 'linux');
      h.run();
      assert.ok(h.readRc().includes('pstack()'));
      assert.strictEqual(h.readProfile(), null);
      h.run('--uninstall');
      assert.strictEqual(h.readRc(), null);
    } finally { h.cleanup(); }
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
    const extension = join(h.copilotDir, 'extensions', 'double', 'extension.mjs');
    const ordinary = execFileSync(process.execPath, [extension, '--pstack-double-hook', 'preToolUse'], {
      env: { ...process.env, COPILOT_HOME: h.copilotDir }, encoding: 'utf8',
      input: JSON.stringify({ sessionId: 'unattached', toolName: 'send_session_message', toolArgs: { message: 'Ready.' } }),
    });
    assert.strictEqual(ordinary, '{}\n');
    const brokenRoot = join(h.home, 'broken-checkout');
    mkdirSync(join(brokenRoot, 'scripts'), { recursive: true });
    writeFileSync(join(brokenRoot, 'scripts', 'install-always-on.mjs'), readFileSync(script));
    execFileSync(process.execPath, [join(brokenRoot, 'scripts', 'install-always-on.mjs'),
      '--uninstall', '--skip-trust', '--skip-shell'], {
      env: { ...process.env, COPILOT_HOME: h.copilotDir }, encoding: 'utf8',
    });
    assert.strictEqual(existsSync(entry), false);
    assert.strictEqual(existsSync(join(h.copilotDir, 'hooks', 'pstack-context.json')), false);
    assert.strictEqual(existsSync(join(h.copilotDir, 'hooks', 'pstack-double.json')), false);
    assert.strictEqual(existsSync(extension), false);
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
      assert.strictEqual(existsSync(join(h.copilotDir, 'hooks', 'pstack-double.json')), false);
      assert.strictEqual(existsSync(join(h.copilotDir, 'extensions', 'double', 'extension.mjs')), false);
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
      writeFileSync(join(dir, 'pstack-double.json'), '{foreign double guard}\n');
      const extension = join(h.copilotDir, 'extensions', 'double', 'extension.mjs');
      writeFileSync(extension, 'foreign extension\n');
      const hooks = snapshot(dir);
      writeFileSync(h.target, 'my notes\n');
      h.run('--hooks', 'skip');
      assert.ok(h.read().startsWith('my notes\n\n<!-- pstack:begin poteto-mode -->'));
      assert.deepStrictEqual(snapshot(dir), hooks);
      assert.strictEqual(readFileSync(extension, 'utf8'), 'foreign extension\n');
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
      delete expected['.copilot/hooks/pstack-double.json'];
      delete expected['.copilot/extensions/double/extension.mjs'];
      h.run('--hooks', 'remove', '--dry-run');
      assert.deepStrictEqual(snapshot(h.home), before);
      h.run('--hooks', 'remove');
      assert.strictEqual(existsSync(join(dir, 'hooks', 'pstack-context.json')), false);
      assert.strictEqual(existsSync(join(dir, 'hooks', 'context-hook.mjs')), false);
      assert.strictEqual(existsSync(join(dir, 'hooks', 'pstack-double.json')), false);
      assert.strictEqual(existsSync(join(dir, 'extensions', 'double')), false);
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
      assert.strictEqual(existsSync(join(h.copilotDir, 'hooks', 'pstack-double.json')), false);
      assert.strictEqual(existsSync(join(h.copilotDir, 'extensions', 'double', 'extension.mjs')), false);
      assert.strictEqual(h.read(), before);
    } finally { h.cleanup(); }
  },
  'hook removal and reinstall refuse foreign reserved files before any write'() {
    for (const [file, bytes, message] of [
      ['pstack-context.json', '{"version":1,"hooks":{}}\n', /foreign hook file/],
      ['pstack-context.json', '{\n', /invalid hook file/],
      ['context-hook.mjs', 'user entry\n', /foreign hook entry/],
      ['pstack-double.json', '{"version":1,"hooks":{}}\n', /foreign hook file/],
      ['pstack-double.json', '{\n', /invalid hook file/],
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
  'double runtime binds the installing clone and installs one native wake guard'() {
    const h = withHome();
    try {
      const file = join(h.copilotDir, 'extensions', 'double', 'extension.mjs');
      const guardFile = join(h.copilotDir, 'hooks', 'pstack-double.json');
      h.run('--skip-trust', '--skip-shell');
      const installed = readFileSync(file, 'utf8');
      assert.ok(installed.includes(`const pstackRoot = ${JSON.stringify(root)};`), 'bound to this clone');
      assert.ok(!installed.includes('".copilot", "pstack"'), 'default root replaced');
      assert.ok(existsSync(join(root, 'skills', 'double', 'scripts', 'double_watch.py')), 'bound watcher exists');
      const guard = JSON.parse(readFileSync(guardFile, 'utf8'));
      assert.deepStrictEqual(guard, {
        version: 1,
        hooks: {
          preToolUse: [{
            type: 'command', exec: process.execPath,
            args: [file, '--pstack-double-hook', 'preToolUse'],
            env: { PSTACK_DOUBLE_MANAGED: '1' }, matcher: 'send_session_message', timeoutSec: 10,
          }],
        },
      });
      assert.strictEqual(execFileSync(guard.hooks.preToolUse[0].exec, guard.hooks.preToolUse[0].args, {
        input: JSON.stringify({ toolName: 'send_session_message', toolArgs: { message: 'Ready.' } }),
        env: { ...process.env, COPILOT_HOME: h.copilotDir }, encoding: 'utf8',
      }), '{}\n');
      const once = snapshot(h.home);
      h.run('--skip-trust', '--skip-shell');
      assert.deepStrictEqual(snapshot(h.home), once);
      h.run('--hooks', 'remove');
      assert.strictEqual(existsSync(guardFile), false);
      assert.strictEqual(existsSync(join(h.copilotDir, 'extensions', 'double')), false);
      h.run('--skip-trust', '--skip-shell');
      assert.strictEqual(readFileSync(file, 'utf8'), installed);
      h.run('--uninstall', '--skip-trust', '--skip-shell');
      assert.strictEqual(existsSync(file), false);
      assert.strictEqual(existsSync(guardFile), false);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, 'user extension\n');
      const before = snapshot(h.home);
      assert.throws(() => h.run('--skip-trust', '--skip-shell'), /foreign extension/);
      assert.throws(() => h.run('--hooks', 'remove'), /foreign extension/);
      assert.deepStrictEqual(snapshot(h.home), before);
      h.run('--hooks', 'skip', '--skip-trust', '--skip-shell');
      assert.strictEqual(readFileSync(file, 'utf8'), 'user extension\n');
    } finally { h.cleanup(); }
  },
  'double guard ownership rejects every foreign shape before install, removal, or dry-run writes'() {
    const h = withHome();
    try {
      h.run('--skip-trust', '--skip-shell');
      const guardFile = join(h.copilotDir, 'hooks', 'pstack-double.json');
      const entry = {
        type: 'command', exec: process.execPath,
        args: [join(h.copilotDir, 'extensions', 'double', 'extension.mjs'), '--pstack-double-hook', 'preToolUse'],
        env: { PSTACK_DOUBLE_MANAGED: '1' }, matcher: 'send_session_message', timeoutSec: 10,
      };
      for (const patch of [
        { type: 'shell' }, { exec: null }, { matcher: '*' },
        { env: { PSTACK_DOUBLE_MANAGED: '1', FOREIGN: '1' } },
        { args: ['foreign.mjs', '--pstack-double-hook', 'preToolUse'] },
        { args: [...entry.args, 'extra'] }, { args: [entry.args[0], '--foreign', 'preToolUse'] },
        { args: [entry.args[0], '--pstack-double-hook', 'postToolUse'] }, { extra: 'foreign' },
      ]) {
        writeFileSync(guardFile, JSON.stringify({ version: 1, hooks: { preToolUse: [{ ...entry, ...patch }] } }));
        const before = snapshot(h.home);
        for (const args of [
          ['--skip-trust', '--skip-shell'], ['--hooks', 'remove'], ['--hooks', 'remove', '--dry-run'],
          ['--uninstall', '--skip-trust', '--skip-shell'],
        ]) {
          assert.throws(() => h.run(...args), /refusing to replace a foreign hook file/);
          assert.deepStrictEqual(snapshot(h.home), before);
        }
      }
      for (const value of [
        { version: 2, hooks: { preToolUse: [entry] } },
        { version: 1, hooks: { preToolUse: [entry], postToolUse: [entry] } },
        { version: 1, hooks: { preToolUse: [entry, entry] } },
        { version: 1, hooks: { preToolUse: [entry] }, extra: true },
      ]) {
        writeFileSync(guardFile, JSON.stringify(value));
        const before = snapshot(h.home);
        assert.throws(() => h.run('--hooks', 'remove'), /refusing to replace a foreign hook file/);
        assert.deepStrictEqual(snapshot(h.home), before);
      }
    } finally { h.cleanup(); }
  },
  'double runtime refuses a source without its native hook entry before any write'() {
    const h = withHome();
    try {
      const clone = join(h.home, 'incomplete-checkout');
      for (const file of [
        'scripts/install-always-on.mjs', 'scripts/context-hook.mjs', 'scripts/context-routing.mjs',
        'context.default.json', 'models.default.md', 'always-on/copilot-instructions.md', 'extensions/double/extension.mjs',
      ]) {
        mkdirSync(dirname(join(clone, file)), { recursive: true });
        copyFileSync(join(root, file), join(clone, file));
      }
      const source = join(clone, 'extensions', 'double', 'extension.mjs');
      writeFileSync(source, readFileSync(source, 'utf8').replace('export const NATIVE_HOOK_FLAG = "--pstack-double-hook";', ''));
      const before = snapshot(h.home);
      assert.throws(() => execFileSync(process.execPath,
        [join(clone, 'scripts', 'install-always-on.mjs'), '--skip-trust', '--skip-shell'], {
          env: { ...process.env, COPILOT_HOME: h.copilotDir }, encoding: 'utf8',
        }), /missing .*native hook|missing .*hook entry/);
      assert.deepStrictEqual(snapshot(h.home), before);
    } finally { h.cleanup(); }
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
