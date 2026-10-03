#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const STATUSES = new Set(['identical', 'adapted', 'excluded']);
const COLUMNS = ['source', 'status', 'source_sha256', 'local', 'local_sha256', 'reason'];
const BINARY_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico']);

export function hashFile(file) {
  const bytes = readFileSync(file);
  const payload = BINARY_EXTENSIONS.has(extname(file).toLowerCase())
    ? bytes
    : Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
  return createHash('sha256').update(payload).digest('hex');
}

export function parseManifest(text) {
  const errors = [];
  const rows = [];
  const seenSource = new Map();
  const seenLocal = new Map();
  let pin = null;
  let subtree = null;

  text.replace(/\r\n/g, '\n').split('\n').forEach((line, index) => {
    const lineNumber = index + 1;
    if (line.trim() === '') return;
    if (line.startsWith('#')) {
      const [key, value] = line.slice(1).split('\t');
      if (key === 'pin') pin = (value ?? '').trim();
      if (key === 'subtree') subtree = (value ?? '').trim();
      return;
    }
    const fields = line.split('\t');
    if (fields.length !== COLUMNS.length) {
      errors.push(`manifest line ${lineNumber}: ${fields.length} columns, expected ${COLUMNS.length}`);
      return;
    }
    const row = Object.fromEntries(COLUMNS.map((name, i) => [name, fields[i]]));
    row.line = lineNumber;

    if (!STATUSES.has(row.status)) {
      errors.push(`manifest line ${lineNumber}: status \`${row.status}\` is not one of ${[...STATUSES].join(', ')}`);
      return;
    }
    if (!/^[0-9a-f]{64}$/.test(row.source_sha256)) {
      errors.push(`manifest line ${lineNumber}: source_sha256 is not a sha256 digest`);
    }
    if (seenSource.has(row.source)) {
      errors.push(`manifest line ${lineNumber}: duplicate source \`${row.source}\`, first at line ${seenSource.get(row.source)}`);
    }
    seenSource.set(row.source, lineNumber);

    if (row.status === 'excluded') {
      if (row.local !== '') errors.push(`manifest line ${lineNumber}: excluded row claims local \`${row.local}\``);
      if (row.local_sha256 !== '') errors.push(`manifest line ${lineNumber}: excluded row carries a local_sha256`);
    } else {
      if (row.local === '') errors.push(`manifest line ${lineNumber}: ${row.status} row names no local path`);
      else if (seenLocal.has(row.local)) {
        errors.push(`manifest line ${lineNumber}: local \`${row.local}\` already claimed at line ${seenLocal.get(row.local)}`);
      } else seenLocal.set(row.local, lineNumber);
    }

    if (row.status === 'identical') {
      if (row.local_sha256 !== '') errors.push(`manifest line ${lineNumber}: identical row carries a local_sha256, it must equal source_sha256`);
      if (row.reason !== '') errors.push(`manifest line ${lineNumber}: identical row carries a reason, it imports the source verbatim`);
    }
    if (row.status === 'adapted' && !/^[0-9a-f]{64}$/.test(row.local_sha256)) {
      errors.push(`manifest line ${lineNumber}: adapted row has no reviewed local_sha256`);
    }
    if (row.status !== 'identical') {
      if (row.reason.trim() === '') errors.push(`manifest line ${lineNumber}: ${row.status} row has no reason`);
      else if (/\bTODO\b/i.test(row.reason)) errors.push(`manifest line ${lineNumber}: reason is still a TODO placeholder`);
    }
    rows.push(row);
  });

  if (!pin) errors.push('manifest has no `#pin` header');
  if (!subtree) errors.push('manifest has no `#subtree` header');
  return { pin, subtree, rows, errors };
}

export function serializeManifest({ pin, subtree, rows }) {
  const lines = [
    `#pin\t${pin}`,
    `#subtree\t${subtree}`,
    `#columns\t${COLUMNS.join('\t')}`,
    ...rows.map((row) => COLUMNS.map((name) => row[name]).join('\t')),
  ];
  return `${lines.join('\n')}\n`;
}

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function readUpstream(upstream, subtree) {
  const head = git(upstream, ['rev-parse', 'HEAD']);
  const dirty = git(upstream, ['status', '--porcelain', '--', subtree]);
  const listed = git(upstream, ['ls-tree', '-r', 'HEAD', '--name-only', '--', subtree]);
  const files = new Map();
  for (const line of listed.split('\n')) {
    const path = line.trim();
    if (path === '') continue;
    files.set(path.slice(`${subtree}/`.length), join(upstream, path));
  }
  return { head, dirty, files };
}

export function checkSync({ root, manifestPath, upstream }) {
  const failures = [];
  const manifest = parseManifest(readFileSync(manifestPath, 'utf8'));
  failures.push(...manifest.errors);
  if (manifest.errors.length > 0) return { failures, manifest, counts: null };

  const counts = { identical: 0, adapted: 0, excluded: 0 };
  for (const row of manifest.rows) {
    counts[row.status] += 1;
    if (row.status === 'excluded') continue;
    const localPath = join(root, row.local);
    if (!existsSync(localPath) || !statSync(localPath).isFile()) {
      failures.push(`${row.source}: local file \`${row.local}\` is missing`);
      continue;
    }
    const localHash = hashFile(localPath);
    if (row.status === 'identical' && localHash !== row.source_sha256) {
      failures.push(`${row.source}: local \`${row.local}\` drifted from the imported source, re-import it or record it as adapted`);
    }
    if (row.status === 'adapted' && localHash !== row.local_sha256) {
      failures.push(`${row.source}: local \`${row.local}\` drifted from its reviewed hash, review the change then re-record it with --accept`);
    }
  }

  if (upstream) {
    const { head, dirty, files } = readUpstream(upstream, manifest.subtree);
    if (head !== manifest.pin) {
      failures.push(`upstream HEAD is ${head}, manifest pins ${manifest.pin}`);
    }
    if (dirty !== '') {
      failures.push(`upstream checkout has uncommitted changes under ${manifest.subtree}/, its files do not represent the pin`);
    }
    const claimed = new Set(manifest.rows.map((row) => row.source));
    for (const source of files.keys()) {
      if (!claimed.has(source)) {
        failures.push(`${source}: new upstream file, add a manifest row (source_sha256 ${hashFile(files.get(source))})`);
      }
    }
    for (const row of manifest.rows) {
      const file = files.get(row.source);
      if (!file) {
        failures.push(`${row.source}: upstream no longer ships this file, drop the row and the import`);
        continue;
      }
      const sourceHash = hashFile(file);
      if (sourceHash !== row.source_sha256) {
        failures.push(`${row.source}: upstream content changed since review, re-reconcile it then re-record it with --accept`);
      }
    }
  }

  return { failures, manifest, counts };
}

export function accept({ root, manifestPath, upstream, sources }) {
  const manifest = parseManifest(readFileSync(manifestPath, 'utf8'));
  if (manifest.errors.length > 0) return { errors: manifest.errors, accepted: [] };
  const { head, dirty, files } = readUpstream(upstream, manifest.subtree);
  const errors = [];
  const accepted = [];
  if (head !== manifest.pin) errors.push(`upstream HEAD is ${head}, manifest pins ${manifest.pin}`);
  if (dirty !== '') {
    errors.push(`upstream checkout has uncommitted changes under ${manifest.subtree}/, its files do not represent the pin`);
  }
  if (errors.length > 0) return { errors, accepted };
  for (const source of sources) {
    const row = manifest.rows.find((candidate) => candidate.source === source);
    if (!row) {
      errors.push(`--accept ${source}: no manifest row`);
      continue;
    }
    const file = files.get(source);
    if (!file) {
      errors.push(`--accept ${source}: not in the upstream checkout`);
      continue;
    }
    row.source_sha256 = hashFile(file);
    if (row.status === 'adapted') row.local_sha256 = hashFile(join(root, row.local));
    accepted.push(source);
  }
  if (errors.length === 0) writeFileSync(manifestPath, serializeManifest(manifest));
  return { errors, accepted };
}

function parseArgv(argv) {
  const options = { upstream: null, accept: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if ((arg === '--upstream' || arg === '--accept') && (!argv[i + 1] || argv[i + 1].startsWith('--'))) {
      return { error: `${arg} needs a value` };
    }
    if (arg === '--upstream') options.upstream = argv[++i] ?? null;
    else if (arg === '--accept') options.accept.push(argv[++i] ?? '');
    else return { error: `unknown argument \`${arg}\`` };
  }
  if (options.upstream === null && options.accept.length > 0) {
    return { error: '--accept needs --upstream, the source hash is re-read from the pinned checkout' };
  }
  if (options.accept.some((value) => value === '' || value.includes('*'))) {
    return { error: '--accept takes one reviewed source path at a time, not a pattern' };
  }
  return { options };
}

function main(argv) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const manifestPath = join(root, 'scripts', 'upstream-sync.manifest.tsv');
  const { options, error } = parseArgv(argv);
  if (error) {
    console.error(`${error}\nusage: node scripts/check-upstream-sync.mjs [--upstream <checkout>] [--accept <source path>]...`);
    return 2;
  }

  if (options.accept.length > 0) {
    const result = accept({ root, manifestPath, upstream: options.upstream, sources: options.accept });
    for (const message of result.errors) console.error(message);
    if (result.errors.length > 0) return 1;
    for (const source of result.accepted) console.log(`recorded ${source}`);
  }

  const { failures, manifest, counts } = checkSync({ root, manifestPath, upstream: options.upstream });
  if (failures.length > 0) {
    for (const failure of failures) console.error(failure);
    console.error(`\n${failures.length} problems`);
    return 1;
  }
  const scope = options.upstream ? `pin ${manifest.pin}` : 'local integrity only';
  console.log(
    `ok: ${manifest.rows.length} source files (${counts.identical} identical, ${counts.adapted} adapted, ${counts.excluded} excluded), ${scope}`,
  );
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
