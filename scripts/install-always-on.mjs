#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceFile = join(root, 'always-on', 'copilot-instructions.md');
const targetFile = join(homedir(), '.copilot', 'copilot-instructions.md');
const begin = '<!-- pstack:begin poteto-mode -->';
const end = '<!-- pstack:end poteto-mode -->';

function parseManagedBlock(text) {
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
    throw new Error(`invalid poteto-mode managed block in ${targetFile}`);
  }

  return {
    before: text.slice(0, beginAt),
    managed: text.slice(beginAt + begin.length, endAt),
    after: text.slice(endAt + end.length),
  };
}

function install(text, block) {
  const regions = parseManagedBlock(text);
  if (regions) return `${regions.before}${block}${regions.after}`;
  const foreign = text.trimEnd();
  return foreign ? `${foreign}\n\n${block}\n` : `${block}\n`;
}

function uninstall(text) {
  const regions = parseManagedBlock(text);
  if (!regions) return text;
  const parts = [regions.before, regions.after].map((part) => part.trim()).filter(Boolean);
  return parts.length ? `${parts.join('\n\n')}\n` : '';
}

function requireFile(file) {
  if (!existsSync(file)) throw new Error(`missing required file: ${file}`);
}

try {
  const args = process.argv.slice(2);
  const unknown = args.find((arg) => arg !== '--dry-run' && arg !== '--uninstall');
  if (unknown) throw new Error(`unknown option: ${unknown}`);

  const dryRun = args.includes('--dry-run');
  const removing = args.includes('--uninstall');
  const current = existsSync(targetFile) ? readFileSync(targetFile, 'utf8') : '';
  let next;

  if (removing) {
    next = uninstall(current);
  } else {
    requireFile(sourceFile);
    const source = readFileSync(sourceFile, 'utf8').replaceAll('\r\n', '\n').trimEnd();
    next = install(current, `${begin}\n${source}\n${end}`);
  }

  if (next === current) {
    console.log(`no changes needed at ${targetFile}`);
  } else if (dryRun) {
    console.log(`would ${removing ? 'uninstall' : 'install'} poteto mode at ${targetFile}`);
  } else {
    mkdirSync(dirname(targetFile), { recursive: true });
    writeFileSync(targetFile, next);
    console.log(`${removing ? 'uninstalled' : 'installed'} poteto mode at ${targetFile}`);
  }
} catch (error) {
  console.error(`error: ${error.message}`);
  process.exitCode = 1;
}
