#!/usr/bin/env node
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const DESCRIPTION_LIMIT = 1024;

const UNSUPPORTED_FRONTMATTER = [
  'disable-model-invocation',
  'mode',
  'icon',
  'color',
  'reminder',
  'alwaysApply',
  'globs',
];

const FOREIGN_TOKENS = [
  { pattern: /\bAskQuestion\b/, use: 'the ask_user tool' },
  { pattern: /\bsubagent_type\b/, use: 'agent_type' },
  { pattern: /\brun_in_background\b/, use: 'mode: "background"' },
  { pattern: /(?<![\w/.])\/loop\b/, use: 'autopilot mode' },
  { pattern: /\bloop skill\b/i, use: 'autopilot mode' },
  { pattern: /\/add-plugin\b/, use: 'copilot skill add' },
  { pattern: /\.mdc\b/, use: '.md' },
  { pattern: /install the plugin/i, use: 'register the skills directory' },
  { pattern: /`Task`/, use: '`task`' },
  { pattern: /\bTask tool\b/, use: 'task tool' },
  { pattern: /\bTask subagent\b/, use: 'task subagent' },
  { pattern: /\bfull Task schema\b/i, use: 'task tool fields' },
  { pattern: /\bincluding `environment`\b/, use: 'no environment on task; omit' },
  { pattern: /\bno gt\b/i, use: 'no Graphite; ADO chains only' },
  { pattern: /`Poteto-Mode`/, use: '`poteto-mode`' },
  { pattern: /\bvia the control skill\b/i, use: 'project verify-* skill' },
  { pattern: /\bthe control skill\b/i, use: 'project verify-* skill' },
  { pattern: /\bcontrol-skill path\b/i, use: 'verify-* path' },
];

const TOKEN_ROOTS = ['skills', 'agents', 'docs'];

const violations = [];

function fail(file, rule, detail) {
  violations.push({ file: relative(root, file).split('\\').join('/'), rule, detail });
}

function read(file) {
  return readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function parseFrontmatter(text) {
  if (!text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return null;
  const block = text.slice(text.indexOf('\n') + 1, end);
  const fields = new Map();
  for (const line of block.split('\n')) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s?(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    const quoted =
      (value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'));
    if (quoted && value.length > 1) value = value.slice(1, -1);
    fields.set(match[1], value);
  }
  return fields;
}

function checkManifest(file, expectedName) {
  const fields = parseFrontmatter(read(file));
  if (!fields) {
    fail(file, 'frontmatter', 'no YAML frontmatter block');
    return;
  }

  const name = fields.get('name');
  if (!name) fail(file, 'frontmatter', 'missing required key `name`');
  else if (name !== expectedName) {
    fail(file, 'name-matches-path', `name is \`${name}\`, must be \`${expectedName}\``);
  }

  const description = fields.get('description');
  if (!description) fail(file, 'frontmatter', 'missing required key `description`');
  else if (description.length > DESCRIPTION_LIMIT) {
    fail(file, 'description-length', `${description.length} chars, limit is ${DESCRIPTION_LIMIT}`);
  }

  for (const key of UNSUPPORTED_FRONTMATTER) {
    if (fields.has(key)) {
      fail(file, 'unsupported-frontmatter', `Copilot ignores \`${key}\`, strip it`);
    }
  }
}

function checkForeignTokens(file) {
  read(file)
    .split('\n')
    .forEach((line, index) => {
      for (const { pattern, use } of FOREIGN_TOKENS) {
        if (pattern.test(line)) {
          fail(file, 'foreign-token', `line ${index + 1} matches /${pattern.source}/, use ${use}`);
        }
      }
    });
}

function checkLinks(file) {
  const text = read(file);
  const linkPattern = /\]\(([^)\s]+)\)/g;
  let match;
  while ((match = linkPattern.exec(text)) !== null) {
    const target = match[1];
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    const path = target.split('#')[0];
    if (!path) continue;
    if (!path.includes('/') && !path.includes('.')) continue;
    if (!existsSync(resolve(dirname(file), decodeURIComponent(path)))) {
      fail(file, 'broken-link', `${target} does not resolve`);
    }
  }
}

const skillsDir = join(root, 'skills');
const skillDirs = readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory());
for (const entry of skillDirs) {
  const manifest = join(skillsDir, entry.name, 'SKILL.md');
  if (!existsSync(manifest)) {
    fail(join(skillsDir, entry.name), 'frontmatter', 'directory has no SKILL.md');
    continue;
  }
  checkManifest(manifest, entry.name);
}

for (const file of walk(join(root, 'agents'))) {
  if (!file.endsWith('.agent.md')) continue;
  checkManifest(file, basename(file).replace(/\.agent\.md$/, ''));
}

const markdown = TOKEN_ROOTS.flatMap((dir) => walk(join(root, dir))).filter((f) => f.endsWith('.md'));
for (const file of markdown) {
  checkForeignTokens(file);
  checkLinks(file);
}
checkLinks(join(root, 'README.md'));

if (violations.length === 0) {
  console.log(`ok: ${skillDirs.length} skills, ${markdown.length} markdown files`);
  process.exit(0);
}

const byRule = new Map();
for (const v of violations) {
  if (!byRule.has(v.rule)) byRule.set(v.rule, []);
  byRule.get(v.rule).push(v);
}
for (const [rule, items] of [...byRule].sort()) {
  console.log(`\n${rule} (${items.length})`);
  for (const item of items) console.log(`  ${item.file}: ${item.detail}`);
}
console.log(`\n${violations.length} violations`);
process.exit(1);
