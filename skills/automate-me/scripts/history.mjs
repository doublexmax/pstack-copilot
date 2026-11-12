#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, parse, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MACHINE_PREFIXES = [
  'PSTACK_CONTEXT_V1 ', '<skill-context', '<copilot_tauri_workspace>',
  '<cross_session_message>', '<system_notification>',
  'Parent session active; run python ', '[Double Supervisor Notice]',
  '<canvas-context',
];

const SESSION_SETS = ['repos', 'paths', 'origins', 'rawIds', 'summaries', 'refs'];
const METADATA_FIELDS = ['id', 'repository', 'repository_host', 'host', 'host_type', 'cwd', 'git_root', 'created_at'];
const TITLE_FIELDS = ['summary', 'name'];

class UsageError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function readText(file) {
  const bytes = readFileSync(file);
  return bytes.toString(bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf16le' : 'utf8').replace(/^\uFEFF/, '');
}

function readJson(file, flag) {
  try { return JSON.parse(readText(file)); } catch {
    throw new UsageError('E_USAGE', `${flag} needs a readable JSON file.`);
  }
}

function requireConsent(options) {
  if (options.consent !== 'explicit-user') {
    throw new UsageError('E_CONSENT_REQUIRED', 'This operation needs explicit user consent for this run.');
  }
}

export function normalizeRepoKey(repo, host = '', hostType = '') {
  if (repo == null || String(repo).trim() === '') return null;
  let key = String(repo).trim().toLowerCase().replace(/\/+$/, '');
  let hostname = String(host ?? '').trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^.*@/, '').replace(/\/+$/, '');
  const type = String(hostType ?? '').trim().toLowerCase();
  const nonGithub = type && !['github', 'github.com'].includes(type);
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//.test(key)) {
      const url = new URL(key);
      hostname = url.host;
      key = url.pathname;
    } else if (/^[^/@]+@[^:]+:/.test(key)) {
      const [, remoteHost, path] = /^[^/@]+@([^:]+):(.+)$/.exec(key);
      hostname = remoteHost;
      key = path;
    } else if (key.split('/').length > 2 && (/[.:]/.test(key.split('/')[0])
      || key.startsWith(`${hostname}/`) || (!hostname && (!nonGithub || key.startsWith(`${type}/`))))) {
      const [remoteHost, ...path] = key.split('/');
      hostname = remoteHost;
      key = path.join('/');
    }
  } catch {
    throw new UsageError('E_REPO_KEY', 'A repository must be owner/name or a host-qualified repository path.');
  }
  key = key.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
  if (hostname === 'ssh.dev.azure.com') {
    hostname = 'dev.azure.com';
    key = key.replace(/^v3\//, '');
  }
  if (hostname.endsWith('.visualstudio.com')) {
    key = `${hostname.slice(0, -'.visualstudio.com'.length)}/${key}`;
    hostname = 'dev.azure.com';
  }
  if (hostname === 'dev.azure.com') key = key.replace('/_git/', '/');
  if (!hostname && nonGithub) hostname = type;
  if (!/^[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)+$/.test(key) || key.split('/').some((part) => part === '.' || part === '..')
    || (hostname && !/^[a-z0-9.:-]+$/.test(hostname))) {
    throw new UsageError('E_REPO_KEY', 'A repository must be owner/name or a host-qualified repository path.');
  }
  return !hostname || ['github', 'github.com'].includes(hostname) ? key : `${hostname}/${key}`;
}

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

export function parseScope(options) {
  const kind = options.scope ?? 'repo';
  if (kind === 'personal' || kind === 'repos') requireConsent(options);
  if (kind === 'personal') return { kind, repos: 'all', repoRoots: [], unattached: true };
  if (kind === 'repos') {
    const repos = (options.repos ?? '').split(',').map((repo) => normalizeRepoKey(repo));
    if (!repos.length || repos.some((repo) => !repo)) throw new UsageError('E_REPO_REQUIRED', '--repos needs repository keys.');
    return { kind, repos: new Set(repos), repoRoots: [], unattached: Boolean(options.unattached) };
  }
  if (kind !== 'repo') throw new UsageError('E_SCOPE', '--scope must be repo, repos, or personal.');
  let repo = normalizeRepoKey(options.repo);
  const inputCwd = options.repoRoot ?? options.cwd ?? process.cwd();
  const cwd = /^[a-z]:[\\/]|^\\\\/i.test(inputCwd) ? win32.resolve(inputCwd) : resolve(inputCwd);
  const repoRoots = new Set();
  const addRoot = (path) => {
    const root = normalizedPath(path);
    const absolute = /^[a-z]:[\\/]|^\\\\/i.test(path) ? win32.resolve(path) : resolve(path);
    const filesystemRoot = /^[a-z]:[\\/]|^\\\\/i.test(absolute) ? win32.parse(absolute).root : parse(absolute).root;
    if (root === normalizedPath(filesystemRoot)) return;
    if (root === normalizedPath(homedir()) && root !== (options.repoRoot && normalizedPath(options.repoRoot))) return;
    repoRoots.add(root);
  };
  if (options.repoRoot) addRoot(options.repoRoot);
  try { addRoot(git(cwd, ['rev-parse', '--show-toplevel'])); } catch {}
  try {
    const common = resolve(cwd, git(cwd, ['rev-parse', '--git-common-dir']));
    if (/[\\/]\.git$/i.test(common)) addRoot(dirname(common));
  } catch {}
  let origin;
  const origins = new Set();
  for (const directory of new Set([resolve(options.cwd ?? process.cwd()), cwd])) {
    try {
      const key = normalizeRepoKey(git(directory, ['remote', 'get-url', 'origin']));
      if (key) { origins.add(key); origin = key; }
    } catch {}
  }
  if (repo && [...origins].some((key) => key !== repo)) requireConsent(options);
  repo ??= origin;
  if (!repo && !repoRoots.size) {
    throw new UsageError('E_REPO_REQUIRED', 'Provide --repo, --repo-root, or a working directory with a git origin.');
  }
  return { kind, repos: new Set(repo ? [repo] : []), repoRoots: [...repoRoots], rootRepo: origin ?? null, unattached: false };
}

function instant(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let text = value.trim().replace(' ', 'T');
  if (!/^\d{4}-\d\d-\d\d(?:T\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)?)?$/.test(text)) return null;
  const [year, month, day] = text.slice(0, 10).split('-').map(Number);
  if (new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) !== text.slice(0, 10)) return null;
  if (!/Z$|[+-]\d\d:\d\d$/.test(text)) text += text.length === 10 ? 'T00:00:00Z' : 'Z';
  const time = Date.parse(text);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

export function parseWindow(options) {
  if (['days', 'since', 'sinceFile'].filter((key) => options[key] != null).length > 1) {
    throw new UsageError('E_WINDOW', 'Use only one of --days, --since, or --since-file.');
  }
  const until = options.now ? instant(options.now) : new Date().toISOString();
  let since;
  let cutoffSource = 'days';
  if (options.sinceFile) {
    const file = resolve(options.sinceFile);
    if (!existsSync(file) || !statSync(file).isFile()) throw new UsageError('E_USAGE', '--since-file must name an existing file.');
    try { since = instant(git(dirname(file), ['log', '-1', '--format=%cI', '--', basename(file)])); } catch {}
    cutoffSource = since ? 'git-commit' : 'file-mtime';
    since ??= statSync(file).mtime.toISOString();
  } else if (options.since) {
    since = instant(options.since);
    cutoffSource = 'since';
  } else {
    const days = Number(options.days ?? 28);
    if (!Number.isInteger(days) || days < 1) throw new UsageError('E_WINDOW', '--days must be a positive integer.');
    if (until) since = new Date(Date.parse(until) - days * 86_400_000).toISOString();
  }
  if (!since || !until || since >= until) throw new UsageError('E_WINDOW', 'The date window must have a valid start before its end.');
  return { since, until, cutoffSource };
}

function normalizedPath(path) {
  const windows = /^[a-z]:[\\/]|^\\\\/i.test(path);
  let result = (windows ? win32.resolve(path) : resolve(path)).replaceAll('\\', '/').replace(/\/+$/, '');
  if (windows || process.platform === 'win32') result = result.toLowerCase();
  return result;
}

export function inScope(session, scope) {
  if (scope.repos === 'all') return true;
  if (session.ambiguousRepo) return false;
  if (session.repos.size && scope.repos.size) return [...session.repos].every((repo) => scope.repos.has(repo));
  if (scope.kind !== 'repo') return scope.unattached;
  if (session.repos.size > 1 || !session.id.startsWith('local:')) return false;
  if (scope.rootRepo && !scope.repos.has(scope.rootRepo)) return false;
  return [...session.paths].some((path) => {
    const candidate = normalizedPath(path);
    return scope.repoRoots.some((root) => candidate === root || candidate.startsWith(`${root}/`));
  });
}

function addTitles(session, row) {
  for (const key of TITLE_FIELDS) {
    if (typeof row[key] === 'string' && row[key].trim()) session.summaries.add(row[key].trim());
  }
}

function sessionMeta(row, origin, titles = true) {
  const rawId = String(row.id ?? '');
  const createdAt = instant(row.created_at);
  let repo;
  let ambiguousRepo = false;
  try { repo = normalizeRepoKey(row.repository, row.repository_host || row.host, row.host_type); } catch { ambiguousRepo = true; }
  const id = `${origin === 'cloud-index' ? 'cloud' : 'local'}:${rawId}`;
  const session = {
    id, rawId, createdAt, refs: new Set([id]),
    repos: new Set(repo ? [repo] : []), paths: new Set([row.cwd, row.git_root].filter((path) => typeof path === 'string' && path.trim())),
    origins: new Set([origin]), rawIds: new Set([rawId]),
    summaries: new Set(), ambiguousRepo,
  };
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(rawId) || !createdAt) {
    throw Object.assign(new Error('Unsupported session metadata.'), { session });
  }
  if (titles) addTitles(session, row);
  return session;
}

function mergeSession(target, incoming) {
  for (const key of SESSION_SETS) {
    for (const value of incoming[key]) target[key].add(value);
  }
  target.ambiguousRepo ||= incoming.ambiguousRepo;
  if (incoming.createdAt < target.createdAt) target.createdAt = incoming.createdAt;
}

function sourceResult(name, rows, unreadable = 0, auditIds = rows.map((row) => row.rawId)) {
  const dates = rows.map((row) => row.createdAt).sort();
  return { rows, auditIds, status: { name, status: 'available', sessions: rows.length, oldest: dates[0] ?? null, newest: dates.at(-1) ?? null, unreadable } };
}

function workspace(file, fields = METADATA_FIELDS) {
  const row = {};
  for (const line of readText(file).split(/\r?\n/)) {
    const match = /^([a-z_]+):\s*(.*?)\s*$/.exec(line);
    if (!match || !fields.includes(match[1])) continue;
    let value = match[2];
    try {
      if (value.startsWith('"')) value = JSON.parse(value);
      else if (value.startsWith("'")) {
        if (!value.endsWith("'") || value.length < 2) throw new Error('Unterminated scalar.');
        value = value.slice(1, -1).replaceAll("''", "'");
      } else if (/^(?:null|~|[|>][+-]?)?$/.test(value)) value = null;
      row[match[1]] = value;
    } catch { row[match[1]] = null; }
  }
  return row;
}

function openIndex(home) {
  const sqlite = process.getBuiltinModule?.('node:sqlite');
  if (!sqlite) throw new Error('node:sqlite is unavailable.');
  return new sqlite.DatabaseSync(join(home, 'session-store.db'), { readOnly: true });
}

function typedMessage(value) {
  return typeof value === 'string' && value.trim() && !MACHINE_PREFIXES.some((prefix) => value.trimStart().startsWith(prefix));
}

export const LOCAL_SOURCES = [
  {
    name: 'local-log',
    inventory(home, scope) {
      const rows = [];
      const auditIds = [];
      let unreadable = 0;
      for (const entry of readdirSync(join(home, 'session-state'), { withFileTypes: true })) {
        if (!entry.isDirectory() || !existsSync(join(home, 'session-state', entry.name, 'events.jsonl'))) continue;
        auditIds.push(entry.name);
        try {
          rows.push(sessionMeta({ ...workspace(join(home, 'session-state', entry.name, 'workspace.yaml')), id: entry.name }, this.name));
        } catch (error) {
          if (scope?.kind !== 'repo' || (error.session && inScope(error.session, scope))) unreadable += 1;
        }
      }
      return sourceResult(this.name, rows, unreadable, auditIds);
    },
    titles(home, sessions) {
      for (const session of sessions) {
        try { addTitles(session, workspace(join(home, 'session-state', session.rawId, 'workspace.yaml'), TITLE_FIELDS)); } catch {}
      }
    },
    turns(home, id) {
      const text = readText(join(home, 'session-state', id, 'events.jsonl'));
      const turns = [];
      let current = null;
      let malformed = 0;
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        let event;
        try { event = JSON.parse(line); } catch { malformed += 1; continue; }
        if (!event || Object.hasOwn(event, 'agentId')) continue;
        const data = event.data ?? {};
        if (event.type === 'user.message') {
          current = null;
          if (data.source != null || !typedMessage(data.content)) continue;
          current = { user: data.content, reply: '' };
          turns.push(current);
        } else if (event.type === 'assistant.message' && current && typeof data.content === 'string') {
          current.reply = [current.reply, data.content].filter(Boolean).join('\n').slice(0, 400);
        }
      }
      return { turns, malformed };
    },
  },
  {
    name: 'local-index',
    inventory(home, scope) {
      const db = openIndex(home);
      try {
        const columns = new Set(db.prepare('PRAGMA table_info(sessions)').all().map((column) => column.name));
        const fields = METADATA_FIELDS
          .map((key) => columns.has(key) ? `s.${key}` : `NULL AS ${key}`);
        const rows = [];
        const auditIds = [];
        let unreadable = 0;
        for (const row of db.prepare(`SELECT ${fields.join(', ')} FROM sessions s`).all()) {
          auditIds.push(row.id);
          try { rows.push(sessionMeta(row, this.name)); } catch (error) {
            if (scope?.kind !== 'repo' || (error.session && inScope(error.session, scope))) unreadable += 1;
          }
        }
        return sourceResult(this.name, rows, unreadable, auditIds);
      } finally { db.close(); }
    },
    titles(home, sessions) {
      const db = openIndex(home);
      try {
        const columns = new Set(db.prepare('PRAGMA table_info(sessions)').all().map((column) => column.name));
        const fields = TITLE_FIELDS.map((key) => columns.has(key) ? key : `NULL AS ${key}`);
        const query = db.prepare(`SELECT ${fields.join(', ')} FROM sessions WHERE id = ?`);
        for (const session of sessions) addTitles(session, query.get(session.rawId));
      } finally { db.close(); }
    },
    turns(home, id) {
      const db = openIndex(home);
      try {
        const turns = db.prepare('SELECT user_message, assistant_response FROM turns WHERE session_id = ? ORDER BY turn_index').all(id)
          .filter((row) => typedMessage(row.user_message))
          .map((row) => ({ user: row.user_message, reply: String(row.assistant_response ?? '').slice(0, 400) }));
        return { turns, malformed: 0 };
      } finally { db.close(); }
    },
  },
];

export function readInventory(home, scope, titles = true) {
  const sessions = new Map();
  const sources = [];
  const sourceRows = new Map();
  const auditIds = new Set();
  for (const source of LOCAL_SOURCES) {
    try {
      const result = source.inventory(home, scope);
      sources.push(result.status);
      sourceRows.set(source.name, result.rows);
      for (const id of result.auditIds) auditIds.add(id);
      for (const row of result.rows) {
        if (sessions.has(row.id)) mergeSession(sessions.get(row.id), row);
        else sessions.set(row.id, row);
      }
    } catch (error) {
      sources.push({ name: source.name, status: 'unavailable', sessions: 0, reason: error.code ?? error.message });
    }
  }
  const eligible = [...sessions.values()].filter((session) => !scope || inScope(session, scope));
  for (const source of LOCAL_SOURCES) {
    const rows = eligible.filter((session) => session.origins.has(source.name));
    const status = sources.find((item) => item.name === source.name);
    if (status.status !== 'available') continue;
    if (scope?.kind === 'repo') {
      const scoped = sourceRows.get(source.name).filter((row) => inScope(sessions.get(row.id), scope));
      Object.assign(status, sourceResult(source.name, scoped, status.unreadable).status);
    }
    if (titles && rows.length) {
      try { source.titles(home, rows); } catch {}
    }
  }
  return { sessions: [...sessions.values()], sources, auditIds: [...auditIds] };
}

export function loadTurns(home, session) {
  for (const source of LOCAL_SOURCES) {
    if (!session.origins.includes(source.name)) continue;
    try { return { ...source.turns(home, session.rawId), from: source.name }; } catch {}
  }
  throw new Error('No readable local turns remain.');
}

function sqlLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

const CLOUD_REPO_SQL = [
  ['^(https?://|ssh://)([^/@]+@)?', ''], ['^[^/@]+@([^:]+):', '\\1/'],
  ['/+$', ''], ['[.]git$', ''], ['^github[.]com/', ''],
  ['^ssh[.]dev[.]azure[.]com/v3/', 'dev.azure.com/'],
  ['^([^.]+)[.]visualstudio[.]com/', 'dev.azure.com/\\1/'], ['/_git/', '/'],
].reduce((sql, [pattern, replacement]) => `regexp_replace(${sql}, ${sqlLiteral(pattern)}, ${sqlLiteral(replacement)})`, "lower(trim(COALESCE(s.repository, '')))");

function cloudWhere(scope, window) {
  let predicate = 'TRUE';
  if (scope.repos !== 'all') {
    const repos = [...scope.repos];
    predicate = repos.length ? `${CLOUD_REPO_SQL} IN (${repos.map(sqlLiteral).join(', ')})` : 'FALSE';
    if (scope.unattached) predicate = `(${predicate} OR NULLIF(trim(s.repository), '') IS NULL)`;
  }
  return `s.created_at >= TIMESTAMP ${sqlLiteral(window.since)} AND s.created_at < TIMESTAMP ${sqlLiteral(window.until)} AND (${predicate}) AND COALESCE(s.agent_name, '') <> 'Copilot Code Review'`;
}

function cloudTurnsQuery(scope, window, ids) {
  return `SELECT t.session_id, t.turn_index, t.user_message, substr(t.assistant_response, 1, 400) AS reply FROM turns t JOIN sessions s ON s.id = t.session_id WHERE ${cloudWhere(scope, window)} AND t.session_id IN (${ids.length ? ids.map(sqlLiteral).join(', ') : 'NULL'}) ORDER BY t.session_id, t.turn_index LIMIT 200`;
}

function cloudQueries(scope, window, ids) {
  const where = cloudWhere(scope, window);
  return {
    cloudSessionsSql: `SELECT s.id, s.repository, s.created_at, s.summary, (SELECT COUNT(*) FROM turns t WHERE t.session_id = s.id) AS turn_count FROM sessions s WHERE ${where} AND EXISTS (SELECT 1 FROM turns t WHERE t.session_id = s.id) ORDER BY s.created_at, s.id LIMIT 200`,
    cloudTurnsSql: cloudTurnsQuery(scope, window, ids),
  };
}

function reconcileMirrors(locals, remotes) {
  const localFacts = locals.map((session) => ({
    ...session, ...Object.fromEntries(SESSION_SETS.map((key) => [key, new Set(session[key])])), target: session,
  }));
  const sessions = [...locals];
  let mirrors = 0;
  for (const remote of remotes) {
    const sameRepo = (local) => local.repos.size === remote.repos.size && [...remote.repos].every((repo) => local.repos.has(repo));
    const near = (local) => Math.abs(Date.parse(local.createdAt) - Date.parse(remote.createdAt)) <= 300_000;
    let mirror = localFacts.find((local) => local.rawId === remote.rawId && near(local)
      && (sameRepo(local) || !local.repos.size || !remote.repos.size));
    if (!mirror && remote.repos.size <= 1 && !remote.ambiguousRepo && remote.summaries.size) {
      const matches = localFacts.filter((local) => !local.ambiguousRepo && sameRepo(local) && near(local)
        && [...remote.summaries].some((summary) => local.summaries.has(summary)));
      if (matches.length === 1) [mirror] = matches;
    }
    if (mirror) {
      mergeSession(mirror.target, remote);
      mirror.target.cloudRawId = remote.rawId;
      mirrors += 1;
    } else sessions.push(remote);
  }
  return { sessions, mirrors };
}

function sampleInTime(sessions, capacity) {
  if (sessions.length <= capacity) return sessions;
  if (capacity === 1) return [sessions[0]];
  return Array.from({ length: capacity }, (_, index) => sessions[Math.floor(index * (sessions.length - 1) / (capacity - 1))]);
}

export function buildPlan({ home, inventory, scope, window, slices = 3, perSlice = 20, exclude = [], cloudRows = [], cloudStatus = 'skipped' }) {
  const skipped = { outsideWindow: 0, outsideScope: 0, excluded: 0, noTypedTurns: 0, repeatedOpener: 0, unreadable: 0, cloudLocalRows: 0, cloudZeroTurns: 0, unsupported: 0 };
  skipped.unsupported = inventory.sources.reduce((total, source) => total + (source.unreadable ?? 0), 0);
  const auditIds = new Set(inventory.auditIds ?? inventory.sessions.flatMap((session) => [...session.rawIds]));
  const repositories = new Set(inventory.sessions.filter((session) => inScope(session, scope)).flatMap((session) => [...session.repos]));
  const eligible = (session) => {
    if (!inScope(session, scope)) { skipped.outsideScope += 1; return false; }
    if (session.createdAt < window.since || session.createdAt >= window.until) { skipped.outsideWindow += 1; return false; }
    return true;
  };
  const locals = inventory.sessions.filter(eligible);
  const cloud = new Map();
  for (const row of cloudRows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      if (scope.kind !== 'repo') skipped.unsupported += 1;
      continue;
    }
    if (typeof row.id === 'string' && row.id) auditIds.add(row.id);
    try {
      const session = sessionMeta(row, 'cloud-index');
      if (inScope(session, scope)) for (const repo of session.repos) repositories.add(repo);
      if (!eligible(session)) continue;
      if (row._query_source === 'local') { skipped.cloudLocalRows += 1; continue; }
      if (['turn_count', 'turns'].some((key) => row[key] != null && Number(row[key]) === 0)) { skipped.cloudZeroTurns += 1; continue; }
      if (cloud.has(session.id)) mergeSession(cloud.get(session.id), session);
      else cloud.set(session.id, session);
    } catch (error) {
      if (scope.kind !== 'repo' || (error.session && inScope(error.session, scope))) skipped.unsupported += 1;
    }
  }
  const { sessions, mirrors } = reconcileMirrors(locals, [...cloud.values()]);
  const planned = [];
  const localTurns = new Map();
  sessions.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  for (const session of sessions) {
    if ([...session.refs, ...session.rawIds].some((id) => exclude.includes(id))) { skipped.excluded += 1; continue; }
    const meta = {
      id: session.id, rawId: session.rawId, rawIds: [...session.rawIds], repos: [...session.repos],
      origins: [...session.origins], createdAt: session.createdAt, from: 'cloud-index', userTurns: null, skipOpener: false,
      cloudRawId: session.cloudRawId, ambiguousRepo: session.ambiguousRepo,
    };
    if (session.id.startsWith('local:')) {
      let loaded;
      try { loaded = loadTurns(home, meta); } catch {
        if (!meta.cloudRawId) { skipped.unreadable += 1; continue; }
      }
      if (loaded?.turns.length) {
        localTurns.set(meta.id, { opener: loaded.turns[0].user.trim().replace(/\s+/g, ' '), malformed: loaded.malformed });
        meta.from = loaded.from;
        meta.userTurns = loaded.turns.length;
      } else {
        if (!meta.cloudRawId) { skipped.noTypedTurns += 1; continue; }
        meta.rawId = meta.cloudRawId;
        meta.id = `cloud:${meta.cloudRawId}`;
      }
    }
    planned.push(meta);
  }
  const sampled = sampleInTime(planned, slices * perSlice);
  const selected = [];
  const openers = new Set();
  let strippedOpeners = 0;
  let malformedEvents = 0;
  for (const session of sampled) {
    const local = localTurns.get(session.id);
    if (local) {
      if (openers.has(local.opener)) {
        if (session.userTurns === 1) { skipped.repeatedOpener += 1; continue; }
        session.skipOpener = true;
        session.userTurns -= 1;
        strippedOpeners += 1;
      }
      openers.add(local.opener);
      malformedEvents += local.malformed;
    }
    selected.push(session);
  }
  const start = Date.parse(window.since);
  const duration = Date.parse(window.until) - start;
  const tile = (bounds) => bounds.slice(0, -1).map((since, index) => {
    const until = bounds[index + 1];
    const sessions = selected.filter((session) => session.createdAt >= since && session.createdAt < until);
    return { index, since, until, sessions, ...cloudQueries(scope, { since, until }, sessions.filter((session) => session.id.startsWith('cloud:')).map((session) => session.rawId)) };
  });
  let tiled = tile(Array.from({ length: slices + 1 }, (_, index) => new Date(start + Math.floor(duration * index / slices)).toISOString()));
  if (selected.length >= 2 && tiled.filter((slice) => slice.sessions.length).length < 2) {
    const partitions = Math.min(slices, selected.length);
    const cuts = Array.from({ length: partitions - 1 }, (_, index) => selected[Math.floor(selected.length * (index + 1) / partitions)].createdAt);
    tiled = tile([...new Set([window.since, ...cuts, window.until])]);
  }
  const sources = [...inventory.sources, { name: 'cloud-index', status: cloudStatus, sessions: cloud.size, mirrors }];
  const notes = [];
  const log = sources.find((source) => source.name === 'local-log');
  const index = sources.find((source) => source.name === 'local-index');
  if (log.newest && index.newest && log.newest > index.newest) {
    notes.push({ code: 'indexLag', logNewest: log.newest, indexNewest: index.newest });
  }
  const counts = {
    selected: selected.length, localSessions: selected.filter((session) => session.id.startsWith('local:')).length,
    cloudSessions: selected.filter((session) => session.id.startsWith('cloud:')).length,
    sampledOut: planned.length - sampled.length, mirrors, strippedOpeners, malformedEvents,
    indexOnly: selected.filter((session) => session.from === 'local-index').length,
    populatedSlices: tiled.filter((slice) => slice.sessions.length).length,
  };
  const disclosures = [
    'Deleted, purged, and expired sessions are absent. Unsynced sessions on other machines or in other COPILOT_HOME profiles or accounts are absent.',
    'Cloud candidates still need human-turn provenance and repeated-opener checks. Cloud query pages contain at most 200 rows.',
  ];
  if (notes.length) disclosures.push('The local session index is older than the local session logs.');
  if (counts.indexOnly) disclosures.push('Some sessions have only indexed turns because their raw logs are absent or unreadable.');
  if (counts.sampledOut) disclosures.push('The plan samples chronological eligible sessions at evenly spaced ranks.');
  if (counts.populatedSlices < 2) disclosures.push('Fewer than two slices contain selected sessions. Mined preferences cannot meet the cross-slice evidence threshold.');
  if (window.cutoffSource === 'file-mtime') disclosures.push('The update cutoff uses the file modification time rather than a git commit.');
  for (const source of sources) {
    if (['unavailable', 'unauthenticated', 'skipped'].includes(source.status)) disclosures.push(`${source.name} history is ${source.status}.`);
  }
  const ownerReport = { sources, counts, skipped, notes, repositories: [...repositories].sort(), cutoffSource: window.cutoffSource, disclosures };
  const publicSkipped = { ...skipped };
  if (scope.kind === 'repo') delete publicSkipped.outsideScope;
  return {
    version: 1, home, scope: { ...scope, repos: scope.repos === 'all' ? 'all' : [...scope.repos] }, window, slices: tiled, ownerReport,
    auditIds: [...auditIds].sort(),
    publishableSummary: { scope: scope.kind, window, counts, skipped: publicSkipped, sources: sources.map(({ name, status }) => ({ name, status })), disclosures },
  };
}

export function readSlice(plan, sliceIndex, sessionId) {
  const slice = plan.slices.find((item) => item.index === Number(sliceIndex));
  const all = plan.slices.flatMap((item) => item.sessions);
  const matches = sessionId ? all.filter((session) => session.id === sessionId || session.rawId === sessionId) : [];
  if (!slice || (sessionId && (matches.length !== 1 || !slice.sessions.includes(matches[0])))) {
    throw new UsageError('E_OUT_OF_PLAN', 'The requested slice or session is not in this plan.');
  }
  const sessions = sessionId ? matches : slice.sessions;
  const blocks = [];
  for (const session of sessions.filter((item) => item.id.startsWith('local:'))) {
    let loaded;
    try { loaded = loadTurns(plan.home, session); } catch { blocks.push(`${session.id} is no longer readable.`); continue; }
    const turns = session.skipOpener ? loaded.turns.slice(1) : loaded.turns;
    blocks.push([
      `=== ${session.id} | ${session.repos.join(', ') || 'unattached'} | ${session.createdAt} | ${loaded.from} | ${turns.length} human turns`,
      ...turns.flatMap((turn, index) => [`[${index + 1}] user: ${turn.user}`, `[${index + 1}] reply: ${turn.reply}`]),
    ].join('\n'));
  }
  const cloud = sessions.filter((session) => session.id.startsWith('cloud:'));
  if (cloud.length) blocks.push(JSON.stringify({
    cloudSessions: cloud.map((session) => session.id),
    cloudTurnsSql: cloudTurnsQuery(plan.scope, slice, cloud.map((session) => session.rawId)),
  }));
  return blocks.join('\n\n');
}

function escapedRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function repositoryAliases(repo, active) {
  const parts = repo.split('/');
  if (parts.length === 2) return [escapedRegex(repo)];
  const [host, ...path] = parts;
  const aliases = [`${escapedRegex(host)}[:/]${escapedRegex(path.join('/'))}`];
  if (host === 'dev.azure.com' && path.length === 3) {
    const [org, project, name] = path.map(escapedRegex);
    aliases.push(
      `dev\\.azure\\.com/${org}/${project}/_git/${name}`,
      `ssh\\.dev\\.azure\\.com[:/]v3/${org}/${project}/${name}`,
      `${org}\\.visualstudio\\.com/${project}/_git/${name}`,
    );
  }
  const tail = parts.slice(-2).join('/');
  if (tail !== active) aliases.push(escapedRegex(tail));
  return aliases;
}

function repositoryRegex(aliases) {
  return new RegExp(`(?<![a-z0-9_.-])(?:${[...new Set(aliases)].join('|')})(?:\\.git)?(?=\\.*(?:$|[^a-z0-9_.-]))`, 'gi');
}

export function auditDraft(plan, text, activeRepo, defaultHome = process.env.COPILOT_HOME ?? join(homedir(), '.copilot')) {
  const active = normalizeRepoKey(activeRepo);
  const repos = new Set([
    ...(plan?.ownerReport?.repositories ?? []), ...(plan?.repositories ?? []).map((row) => typeof row === 'string' ? row : row.repo),
    ...(plan?.scope?.repos === 'all' ? [] : plan?.scope?.repos ?? []),
    plan?.scope?.rootRepo,
    ...(plan?.slices ?? []).flatMap((slice) => slice.sessions.flatMap((session) => session.repos ?? [])),
  ].filter(Boolean));
  const repositoryPatterns = [];
  for (const key of repos) {
    let repo;
    try { repo = normalizeRepoKey(key); } catch { continue; }
    if (repo && repo !== active) repositoryPatterns.push(...repositoryAliases(repo, active));
  }
  const activePattern = active ? repositoryRegex(repositoryAliases(active, active.split('/').slice(-2).join('/'))) : null;
  const ids = new Set([
    ...(plan?.auditIds ?? []),
    ...(plan?.slices ?? []).flatMap((slice) => slice.sessions.flatMap((session) => session.rawIds ?? [session.rawId])),
  ].filter((id) => typeof id === 'string' && id));
  const paths = [...new Set([plan?.home, defaultHome, homedir(), ...(plan?.scope?.repoRoots ?? []), plan?.scope?.repoRoot])]
    .filter((path) => typeof path === 'string' && path && !/^(?:~|\$HOME)[\\/]\.copilot(?:[\\/]|$)/i.test(path))
    .map((path) => path.replace(/[\\/]+$/, '')).filter(Boolean)
    .map((path) => path.split(/[\\/]/).map(escapedRegex).join('[\\\\/]'));
  const rules = [
    ...(repositoryPatterns.length ? [{
      code: 'repository', pattern: repositoryRegex(repositoryPatterns),
    }] : []),
    ...[...ids].map((id) => ({ code: 'session-id', pattern: new RegExp(`(?<![a-z0-9_-])${escapedRegex(id)}(?![a-z0-9_-])`, 'gi') })),
    ...(plan ? [] : [{
      code: 'session-id', asset: true,
      pattern: /(?<![a-z0-9_-])[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}(?![a-z0-9_-])/gi,
    }]),
    { code: 'home-path', pattern: new RegExp(`(?<![a-z0-9_])(?:${paths.join('|')})(?![a-z0-9_-])`, 'gi') },
    { code: 'home-path', pattern: /(?<![a-z0-9_])(?:[a-z]:[\\/]+Users[\\/]+[^\\/\s"'`<>]+|\/(?:Users|home|workspaces)\/[^/\s"'`<>]+|\/root(?=\/|$|[\s.,"'`<>]))(?:[\\/][^\s"'`<>]*)?/gi },
  ];
  const diagnostics = new Map();
  text.split(/\r?\n/).forEach((line, index) => {
    const urls = [...line.matchAll(/https?:\/\/[^\s"'`<>]+/gi)];
    const allowed = activePattern ? [...line.matchAll(activePattern)] : [];
    for (const rule of rules) {
      for (const match of line.matchAll(rule.pattern)) {
        if (rule.code === 'repository' && allowed.some((item) => match.index >= item.index && match.index + match[0].length <= item.index + item[0].length)) continue;
        const url = urls.find((item) => match.index >= item.index && match.index < item.index + item[0].length);
        if (rule.code === 'home-path' && url) continue;
        if (rule.asset && url && /^https:\/\/github\.com\/user-attachments\/assets\/$/i.test(line.slice(url.index, match.index))
          && /^(?:[?#].*)?[.,;:!?)\]}]*$/.test(url[0].slice(match.index - url.index + match[0].length))) continue;
        const diagnostic = { line: index + 1, column: match.index + 1, code: rule.code };
        diagnostics.set(`${diagnostic.line}:${diagnostic.column}:${diagnostic.code}`, diagnostic);
      }
    }
  });
  return { clean: diagnostics.size === 0, diagnostics: [...diagnostics.values()].sort((a, b) => a.line - b.line || a.column - b.column || a.code.localeCompare(b.code)) };
}

function argumentsFor(argv) {
  const [command, ...args] = argv;
  if (!['census', 'plan', 'read', 'audit-draft'].includes(command)) throw new UsageError('E_USAGE', 'Choose census, plan, read, or audit-draft.');
  const flags = new Set(['scope', 'repo', 'repo-root', 'repos', 'consent', 'home', 'cwd', 'days', 'since', 'since-file', 'now', 'slices', 'per-slice', 'exclude-session', 'cloud-sessions', 'cloud-status', 'out', 'plan', 'slice', 'session', 'draft', 'active-repo']);
  const options = { excludeSession: [] };
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i].slice(2);
    if (args[i] === '--unattached') { options.unattached = true; continue; }
    if (!args[i].startsWith('--') || !flags.has(flag) || args[i + 1] == null || args[i + 1].startsWith('--')) {
      throw new UsageError('E_USAGE', 'An unknown option or a missing option value was supplied.');
    }
    const key = flag.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    if (key === 'excludeSession') options[key].push(args[++i]);
    else options[key] = args[++i];
  }
  return { command, options };
}

function main(argv) {
  try {
    const { command, options } = argumentsFor(argv);
    if (command === 'census' || ['personal', 'repos'].includes(options.scope)) requireConsent(options);
    const defaultHome = resolve(process.env.COPILOT_HOME ?? join(homedir(), '.copilot'));
    const home = resolve(options.home ?? defaultHome);
    if (options.home && normalizedPath(home) !== normalizedPath(defaultHome)) requireConsent(options);
    if (command === 'read' || command === 'audit-draft') {
      if (command === 'read' && !options.plan) throw new UsageError('E_USAGE', 'read requires --plan.');
      if (command === 'audit-draft' && !options.draft) throw new UsageError('E_USAGE', 'audit-draft requires --draft.');
      const plan = options.plan ? readJson(options.plan, '--plan') : null;
      if (command === 'read') {
        if (plan.scope?.kind !== 'repo') requireConsent(options);
        const output = readSlice(plan, options.slice, options.session);
        if (output) console.log(output);
      } else {
        const result = auditDraft(plan, readText(options.draft), options.activeRepo, defaultHome);
        console.log(JSON.stringify(result));
        return result.clean ? 0 : 1;
      }
      return 0;
    }
    const scope = parseScope(command === 'census' ? { ...options, scope: 'personal' } : options);
    const window = parseWindow(options);
    if (options.cloudStatus && !['available', 'unavailable', 'unauthenticated', 'skipped'].includes(options.cloudStatus)) throw new UsageError('E_USAGE', 'Invalid --cloud-status.');
    const exported = options.cloudSessions ? readJson(options.cloudSessions, '--cloud-sessions') : [];
    const cloudRows = Array.isArray(exported) ? exported : exported?.rows;
    if (!Array.isArray(cloudRows)) throw new UsageError('E_USAGE', '--cloud-sessions needs a JSON array or an object with rows.');
    const inventory = readInventory(home, scope, command !== 'census');
    if (command === 'census') {
      const cloud = new Map();
      let unreadable = 0;
      for (const row of cloudRows) {
        if (row?._query_source === 'local') continue;
        try {
          const session = sessionMeta(row, 'cloud-index', false);
          if (session.createdAt < window.since || session.createdAt >= window.until) continue;
          if (cloud.has(session.id)) mergeSession(cloud.get(session.id), session);
          else cloud.set(session.id, session);
        } catch { unreadable += 1; }
      }
      const { sessions, mirrors } = reconcileMirrors(
        inventory.sessions.filter((session) => session.createdAt >= window.since && session.createdAt < window.until), [...cloud.values()],
      );
      const repositories = new Map();
      for (const session of sessions) {
        for (const repo of session.repos.size ? session.repos : [null]) {
          if (!repositories.has(repo)) repositories.set(repo, { repo, sessions: 0, 'local-log': 0, 'local-index': 0, 'cloud-index': 0 });
          const row = repositories.get(repo);
          row.sessions += 1;
          for (const origin of session.origins) row[origin] += 1;
        }
      }
      console.log(JSON.stringify({
        window, repositories: [...repositories.values()].sort((a, b) => b.sessions - a.sessions || (a.repo ?? '').localeCompare(b.repo ?? '')),
        sources: [...inventory.sources, { name: 'cloud-index', status: options.cloudStatus ?? (options.cloudSessions ? 'supplied' : 'skipped'), sessions: cloud.size, mirrors, unreadable }],
        cloudCensusSql: `SELECT NULLIF(${CLOUD_REPO_SQL}, '') AS repository, COUNT(*) AS sessions FROM sessions s WHERE ${cloudWhere(scope, window)} GROUP BY 1 ORDER BY sessions DESC LIMIT 200`,
      }, null, 2));
      return 0;
    }
    const slices = Number(options.slices ?? 3);
    const perSlice = Number(options.perSlice ?? 20);
    if (![slices, perSlice].every((value) => Number.isInteger(value) && value > 0)) throw new UsageError('E_USAGE', '--slices and --per-slice must be positive integers.');
    const plan = buildPlan({
      home, inventory, scope, window, slices, perSlice, exclude: options.excludeSession, cloudRows,
      cloudStatus: options.cloudStatus ?? (options.cloudSessions ? 'supplied' : 'skipped'),
    });
    const out = options.out ? resolve(options.out) : mkdtempSync(join(tmpdir(), 'automate-me-'));
    mkdirSync(out, { recursive: true, mode: 0o700 });
    const file = join(out, 'plan.json');
    const temporary = join(out, `plan-${process.pid}-${Date.now()}.tmp`);
    writeFileSync(temporary, `${JSON.stringify(plan, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, file);
    console.log(JSON.stringify(plan.publishableSummary, null, 2));
    console.error(`Plan written to ${file}`);
    return 0;
  } catch (error) {
    console.error(JSON.stringify({ code: error.code ?? 'E_HISTORY', message: error.message }));
    return error instanceof UsageError ? 2 : 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
