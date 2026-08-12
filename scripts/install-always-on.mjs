#!/usr/bin/env node
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceFile = join(root, 'always-on', 'copilot-instructions.md');
const home = process.env.USERPROFILE || process.env.HOME || homedir();
const copilotDir = join(home, '.copilot');
const instructionsFile = join(copilotDir, 'copilot-instructions.md');
const configFile = join(copilotDir, 'config.json');
const binDir = join(copilotDir, 'bin');

const instructionsBegin = '<!-- pstack:begin poteto-mode -->';
const instructionsEnd = '<!-- pstack:end poteto-mode -->';
const shellBegin = '# BEGIN pstack path trust';
const shellEnd = '# END pstack path trust';

const USAGE = `usage: node install-always-on.mjs [--dry-run] [--uninstall] [--skip-shell]

Installs poteto-mode always-on instructions, adds ~/.copilot to config.json
trustedFolders, and installs a pstack wrapper that runs copilot with
--add-dir ~/.copilot so playbooks and pstack-models.md are readable.`;

function parseManagedBlock(text, begin, end) {
  const beginAt = text.indexOf(begin);
  const endAt = text.indexOf(end);

  if (beginAt === -1 && endAt === -1) return null;
  if (
    beginAt === -1 ||
    endAt === -1 ||
    endAt < beginAt ||
    text.indexOf(begin, beginAt + begin.length) !== -1 ||
    text.indexOf(end, endAt + end.length) !== -1
  ) {
    throw new Error(`invalid managed block (${begin} … ${end})`);
  }

  return {
    before: text.slice(0, beginAt),
    managed: text.slice(beginAt + begin.length, endAt),
    after: text.slice(endAt + end.length),
  };
}

function installMarkedBlock(text, begin, end, body) {
  const block = `${begin}\n${body.trimEnd()}\n${end}`;
  const regions = parseManagedBlock(text, begin, end);
  if (regions) return `${regions.before}${block}${regions.after}`;
  const foreign = text.trimEnd();
  return foreign ? `${foreign}\n\n${block}\n` : `${block}\n`;
}

function uninstallMarkedBlock(text, begin, end) {
  const regions = parseManagedBlock(text, begin, end);
  if (!regions) return text;
  const parts = [regions.before, regions.after].map((part) => part.trim()).filter(Boolean);
  return parts.length ? `${parts.join('\n\n')}\n` : '';
}

function requireFile(file) {
  if (!existsSync(file)) throw new Error(`missing required file: ${file}`);
}

function normalizePath(p) {
  return resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function pathsEqual(a, b) {
  return normalizePath(a) === normalizePath(b);
}

function readJson(file) {
  if (!existsSync(file)) return {};
  const raw = readFileSync(file, 'utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`invalid JSON in ${file}`);
  }
}

function installInstructions(removing, dryRun) {
  const current = existsSync(instructionsFile) ? readFileSync(instructionsFile, 'utf8') : '';
  let next;
  if (removing) {
    next = uninstallMarkedBlock(current, instructionsBegin, instructionsEnd);
  } else {
    requireFile(sourceFile);
    const source = readFileSync(sourceFile, 'utf8').replaceAll('\r\n', '\n').trimEnd();
    next = installMarkedBlock(current, instructionsBegin, instructionsEnd, source);
  }
  if (next === current) {
    console.log(`no changes needed at ${instructionsFile}`);
    return;
  }
  if (dryRun) {
    console.log(`would ${removing ? 'uninstall' : 'install'} always-on at ${instructionsFile}`);
    return;
  }
  mkdirSync(dirname(instructionsFile), { recursive: true });
  writeFileSync(instructionsFile, next);
  console.log(`${removing ? 'uninstalled' : 'installed'} always-on at ${instructionsFile}`);
}

function installTrustedFolder(removing, dryRun) {
  const currentObj = readJson(configFile);
  const currentText = existsSync(configFile) ? readFileSync(configFile, 'utf8') : '';
  const folders = Array.isArray(currentObj.trustedFolders) ? [...currentObj.trustedFolders] : [];
  const target = resolve(copilotDir);
  const has = folders.some((f) => typeof f === 'string' && pathsEqual(f, target));

  let nextFolders = folders;
  if (removing) {
    nextFolders = folders.filter((f) => !(typeof f === 'string' && pathsEqual(f, target)));
  } else if (!has) {
    nextFolders = [...folders, target];
  }

  const nextObj = { ...currentObj };
  if (nextFolders.length > 0) nextObj.trustedFolders = nextFolders;
  else delete nextObj.trustedFolders;

  const nextText = `${JSON.stringify(nextObj, null, 2)}\n`;
  if (!removing && has) {
    console.log(`no changes needed for trustedFolders (${target})`);
    return;
  }
  if (removing && !has && !existsSync(configFile)) {
    console.log('no changes needed for trustedFolders');
    return;
  }
  if (nextText === currentText) {
    console.log('no changes needed for trustedFolders');
    return;
  }
  if (dryRun) {
    console.log(`would update trustedFolders in ${configFile}`);
    return;
  }
  mkdirSync(dirname(configFile), { recursive: true });
  writeFileSync(configFile, nextText);
  console.log(`${removing ? 'removed' : 'added'} trustedFolders entry ${target}`);
}

function powershellProfilePath() {
  if (process.env.PSTACK_PROFILE_PATH) return process.env.PSTACK_PROFILE_PATH;
  if (platform() === 'win32') {
    return join(home, 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1');
  }
  return null;
}

function unixRcPath() {
  if (process.env.PSTACK_SHELL_RC) return process.env.PSTACK_SHELL_RC;
  const zsh = join(home, '.zshrc');
  const bash = join(home, '.bashrc');
  if (existsSync(zsh)) return zsh;
  if (existsSync(bash)) return bash;
  return join(home, '.bashrc');
}

function powershellWrapperBody() {
  const dir = resolve(copilotDir).replace(/'/g, "''");
  return [
    '# pstack: copilot with --add-dir for playbooks and pstack-models.md',
    'function pstack {',
    `  copilot --add-dir '${dir}' @args`,
    '}',
  ].join('\n');
}

function unixWrapperBody() {
  const dir = resolve(copilotDir).replace(/'/g, "'\\''");
  return [
    '# pstack: copilot with --add-dir for playbooks and pstack-models.md',
    `pstack() { copilot --add-dir '${dir}' "$@"; }`,
  ].join('\n');
}

function installProfileBlock(file, body, removing, dryRun) {
  if (!file) return;
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const next = removing
    ? uninstallMarkedBlock(current, shellBegin, shellEnd)
    : installMarkedBlock(current, shellBegin, shellEnd, body);
  if (next === current) {
    console.log(`no changes needed at ${file}`);
    return;
  }
  if (dryRun) {
    console.log(`would update ${file}`);
    return;
  }
  if (next === '') {
    if (existsSync(file)) {
      unlinkSync(file);
      console.log(`removed ${file}`);
    }
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, next);
  console.log(`updated ${file}`);
}

function shellQuoteBash(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function installBinShims(removing, dryRun) {
  const sh = join(binDir, 'pstack');
  const cmd = join(binDir, 'pstack.cmd');
  const ps1 = join(binDir, 'pstack.ps1');
  const dir = resolve(copilotDir);

  if (removing) {
    for (const file of [sh, cmd, ps1]) {
      if (!existsSync(file)) continue;
      if (dryRun) {
        console.log(`would remove ${file}`);
        continue;
      }
      unlinkSync(file);
      console.log(`removed ${file}`);
    }
    return;
  }

  const shBody = `#!/usr/bin/env bash\nexec copilot --add-dir ${shellQuoteBash(dir)} "$@"\n`;
  const ps1Body = `#!/usr/bin/env pwsh\ncopilot --add-dir '${dir.replace(/'/g, "''")}' @args\nexit $LASTEXITCODE\n`;
  const cmdBody = `@echo off\r\ncopilot --add-dir "${dir}" %*\r\n`;

  writeShim(sh, shBody, dryRun, true);
  writeShim(ps1, ps1Body, dryRun, false);
  writeShim(cmd, cmdBody, dryRun, false);
}

function writeShim(file, body, dryRun, executable) {
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (current === body) {
    console.log(`no changes needed at ${file}`);
    return;
  }
  if (dryRun) {
    console.log(`would write ${file}`);
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
  if (executable) {
    try {
      chmodSync(file, 0o755);
    } catch {
      // Windows may ignore mode bits.
    }
  }
  console.log(`updated ${file}`);
}

function installShell(removing, dryRun, skipShell) {
  if (skipShell) {
    console.log('skipping shell wrapper (--skip-shell)');
    return;
  }

  installBinShims(removing, dryRun);

  const psProfile = powershellProfilePath();
  if (psProfile) {
    installProfileBlock(psProfile, powershellWrapperBody(), removing, dryRun);
  }

  if (platform() !== 'win32' || process.env.PSTACK_SHELL_RC) {
    installProfileBlock(unixRcPath(), unixWrapperBody(), removing, dryRun);
  }

  if (!removing && !dryRun) {
    console.log(`CLI tip: run \`pstack\` or \`copilot --add-dir "${resolve(copilotDir)}"\``);
    console.log(`Shim directory: ${binDir}`);
  }
}

try {
  const args = process.argv.slice(2);
  const allowed = new Set(['--dry-run', '--uninstall', '--skip-shell', '--help', '-h']);
  const unknown = args.find((arg) => !allowed.has(arg));
  if (unknown) throw new Error(`unknown option: ${unknown}\n${USAGE}`);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    process.exit(0);
  }

  const dryRun = args.includes('--dry-run');
  const removing = args.includes('--uninstall');
  const skipShell = args.includes('--skip-shell');

  installInstructions(removing, dryRun);
  installTrustedFolder(removing, dryRun);
  installShell(removing, dryRun, skipShell);
} catch (error) {
  console.error(`error: ${error.message}`);
  process.exitCode = 1;
}
