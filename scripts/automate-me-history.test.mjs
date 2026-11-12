import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { normalizeRepoKey, readInventory } from '../skills/automate-me/scripts/history.mjs';

const script = fileURLToPath(new URL('../skills/automate-me/scripts/history.mjs', import.meta.url));
const since = '2026-11-01T00:00:00.000Z';
const now = '2026-11-28T00:00:00.000Z';
const privateSummary = 'Private summary that must never appear in plan.json';

function fixture(t, standard = true) {
  const root = mkdtempSync(join(tmpdir(), 'automate-me-test-'));
  const home = join(root, 'profile');
  const repoRoot = join(root, 'app');
  mkdirSync(join(home, 'session-state'), { recursive: true });
  mkdirSync(repoRoot);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = new DatabaseSync(join(home, 'session-store.db'));
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, repository TEXT, repository_host TEXT, host_type TEXT, cwd TEXT, git_root TEXT, created_at TEXT, summary TEXT, name TEXT);
    CREATE TABLE turns (session_id TEXT, turn_index INTEGER, user_message TEXT, assistant_response TEXT, timestamp TEXT);
  `);
  db.close();
  const f = { root, home, repoRoot, plans: 0 };
  if (standard) {
    log(f, 'a1', 'acme/app', '2026-11-02T12:00:00Z', messages('Give short replies.', 'I will keep replies short.'), { summary: privateSummary });
    indexed(f, 'a1', 'acme/app', '2026-11-02T12:00:00Z', [['Indexed duplicate of a1.', 'An indexed reply.']], { summary: privateSummary });
    indexed(f, 'a2', 'acme/app', '2026-11-10T12:00:00Z', [
      ['PSTACK_CONTEXT_V1 automated', 'Do not read this reply.'],
      ['<skill-context name="hidden">', 'A skill reply.'],
      ['<copilot_tauri_workspace>hidden', 'A workspace reply.'],
      ['<cross_session_message>hidden', 'A peer reply.'],
      ['<system_notification>hidden', 'A notification reply.'],
      ['Run the actual tests.', 'The tests passed.'],
    ]);
    log(f, 'a3', 'acme/app', '2026-11-20T12:00:00Z', messages('Use a worktree.', 'A worktree is ready.'));
    log(f, 'a4', null, '2026-11-21T12:00:00Z', messages('Keep the scope narrow.', 'Only the requested files changed.'), { cwd: join(repoRoot, 'src') });
    log(f, 'b1', 'other/secret', '2026-11-05T12:00:00Z', null);
    log(f, 'enterprise', 'acme/app', '2026-11-06T12:00:00Z', messages('Use the enterprise process.'), { repository_host: 'ghe.corp' });
    log(f, 'loose', null, '2026-11-22T12:00:00Z', messages('Ask before broad changes.'), { cwd: join(root, 'elsewhere') });
    log(f, 'old', 'acme/app', '2026-10-01T12:00:00Z', messages('Old preference.'));
  }
  return f;
}

function messages(user, reply = '') {
  return [{ type: 'user.message', data: { content: user } }, { type: 'assistant.message', data: { content: reply } }];
}

function log(f, id, repository, created_at, events, extra = {}) {
  const directory = join(f.home, 'session-state', id);
  mkdirSync(directory);
  const metadata = { repository, created_at, cwd: f.repoRoot, host_type: 'github', ...extra };
  writeFileSync(join(directory, 'workspace.yaml'), Object.entries(metadata).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n'));
  const file = join(directory, 'events.jsonl');
  if (events === null) mkdirSync(file);
  else writeFileSync(file, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
  return file;
}

function indexed(f, id, repository, created_at, turns, extra = {}) {
  const db = new DatabaseSync(join(f.home, 'session-store.db'));
  try {
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      id, repository, extra.repository_host ?? null, extra.host_type ?? 'github', extra.cwd ?? f.repoRoot,
      extra.git_root ?? null, created_at, extra.summary ?? null, extra.name ?? null,
    );
    turns.forEach(([user, reply], index) => {
      db.prepare('INSERT INTO turns VALUES (?, ?, ?, ?, ?)').run(id, index, user, reply ?? '', created_at);
    });
  } finally { db.close(); }
}

function run(f, args, nodeArgs = []) {
  return spawnSync(process.execPath, [...nodeArgs, script, ...args], {
    cwd: f.root, encoding: 'utf8',
    env: { ...process.env, COPILOT_HOME: f.home, NODE_NO_WARNINGS: '1' },
  });
}

function plan(f, args = [], { cutoff = true, nodeArgs = [] } = {}) {
  const out = join(f.root, `plan-${++f.plans}`);
  const result = run(f, ['plan', '--scope', 'repo', '--repo', 'acme/app', '--repo-root', f.repoRoot,
    ...(cutoff ? ['--since', since] : []), '--now', now, '--out', out, ...args], nodeArgs);
  assert.equal(result.status, 0, result.stderr);
  const file = join(out, 'plan.json');
  return { ...result, file, value: JSON.parse(readFileSync(file, 'utf8')) };
}

function sessionIds(value) {
  return value.slices.flatMap((slice) => slice.sessions.map((session) => session.id));
}

function cloudFile(f, rows, wrapped = false) {
  const file = join(f.root, 'cloud.json');
  writeFileSync(file, JSON.stringify(wrapped ? { rows } : rows));
  return file;
}

test('personal, selected-repository, and census consent refusal precedes all history and output I/O', (t) => {
  const f = fixture(t);
  for (const [index, args] of [
    ['plan', '--scope', 'personal'],
    ['plan', '--scope', 'repos', '--repos', 'a/x'],
    ['census'],
  ].entries()) {
    const out = join(f.root, `refused-${index}`);
    const result = run(f, [...args, '--home', join(f.root, 'nonexistent'), '--since-file', join(f.root, 'missing-mode'),
      '--cloud-sessions', join(f.root, 'missing-cloud'), '--out', out]);
    assert.equal(result.status, 2);
    assert.deepEqual(JSON.parse(result.stderr), {
      code: 'E_CONSENT_REQUIRED', message: 'This operation needs explicit user consent for this run.',
    });
    assert.equal(result.stdout, '');
    assert.equal(existsSync(out), false);
  }
  const census = run(f, ['census', '--consent', 'explicit-user', '--since', since, '--now', now]);
  assert.equal(census.status, 0, census.stderr);
  assert.deepEqual(JSON.parse(census.stdout).repositories, [
    { repo: 'acme/app', sessions: 3, 'local-log': 2, 'local-index': 2, 'cloud-index': 0 },
    { repo: null, sessions: 2, 'local-log': 2, 'local-index': 0, 'cloud-index': 0 },
    { repo: 'ghe.corp/acme/app', sessions: 1, 'local-log': 1, 'local-index': 0, 'cloud-index': 0 },
    { repo: 'other/secret', sessions: 1, 'local-log': 1, 'local-index': 0, 'cloud-index': 0 },
  ]);
});

test('repository scope isolates log and index turns before opening an out-of-scope directory trap', (t) => {
  const f = fixture(t);
  const result = plan(f);
  assert.deepEqual(sessionIds(result.value), ['local:a1', 'local:a2', 'local:a3', 'local:a4']);
  assert.deepEqual(result.value.slices.map((slice) => [slice.since, slice.until]), [
    ['2026-11-01T00:00:00.000Z', '2026-11-10T00:00:00.000Z'],
    ['2026-11-10T00:00:00.000Z', '2026-11-19T00:00:00.000Z'],
    ['2026-11-19T00:00:00.000Z', '2026-11-28T00:00:00.000Z'],
  ]);
  assert.deepEqual(result.value.ownerReport.counts, {
    selected: 4, localSessions: 4, cloudSessions: 0, sampledOut: 0, mirrors: 0,
    strippedOpeners: 0, malformedEvents: 0, indexOnly: 1, populatedSlices: 3,
  });
  assert.deepEqual(result.value.ownerReport.skipped, {
    outsideWindow: 1, outsideScope: 3, excluded: 0, noTypedTurns: 0, repeatedOpener: 0,
    unreadable: 0, cloudLocalRows: 0, cloudZeroTurns: 0, unsupported: 0,
  });
  const a1 = result.value.slices[0].sessions[0];
  assert.deepEqual(a1.origins, ['local-log', 'local-index']);
  assert.equal(a1.from, 'local-log');
  assert.equal(result.value.slices[1].sessions[0].from, 'local-index');
  const read = run(f, ['read', '--plan', result.file, '--slice', '1', '--session', 'local:a2']);
  assert.equal(read.status, 0, read.stderr);
  assert.equal(read.stdout, '=== local:a2 | acme/app | 2026-11-10T12:00:00.000Z | local-index | 1 human turns\n[1] user: Run the actual tests.\n[1] reply: The tests passed.\n');
  const serialized = readFileSync(result.file, 'utf8');
  for (const text of ['Give short replies.', 'Run the actual tests.', privateSummary, 'Indexed duplicate of a1.']) {
    assert.equal(serialized.includes(text), false);
  }
});

test('personal scope reconciles local sources and cloud mirrors without a second corroboration vote', (t) => {
  const f = fixture(t);
  const cloud = cloudFile(f, [
    { id: 'a1', repository: 'ACME/APP', created_at: '2026-11-02T12:02:00Z', turn_count: 2, summary: privateSummary },
    { id: 'a3', repository: 'acme/app', created_at: '2026-11-20T12:00:00Z', turn_count: 1, _query_source: 'local' },
    { id: 'stub', repository: 'other/secret', created_at: '2026-11-18T12:00:00Z', turn_count: 0 },
    { id: 'stub-2', repository: null, created_at: '2026-11-18T12:00:00Z', turns: 0 },
    { id: 'remote-1', repository: 'other/secret', created_at: '2026-11-23T12:00:00Z', turns: 3 },
    { id: 'outside-window', repository: 'other/secret', created_at: '2026-09-01T12:00:00Z', turns: 3 },
  ], true);
  const result = plan(f, ['--scope', 'personal', '--consent', 'explicit-user', '--cloud-sessions', cloud, '--cloud-status', 'available']);
  assert.deepEqual(sessionIds(result.value), [
    'local:a1', 'local:enterprise', 'local:a2', 'local:a3', 'local:a4', 'local:loose', 'cloud:remote-1',
  ]);
  assert.deepEqual(result.value.slices[0].sessions[0].origins, ['local-log', 'local-index', 'cloud-index']);
  assert.equal(result.value.ownerReport.counts.mirrors, 1);
  assert.equal(result.value.ownerReport.counts.selected, 7);
  assert.deepEqual(result.value.ownerReport.notes, [{
    code: 'indexLag', logNewest: '2026-11-22T12:00:00.000Z', indexNewest: '2026-11-10T12:00:00.000Z',
  }]);
  assert.deepEqual(result.value.ownerReport.sources.find((source) => source.name === 'cloud-index'), {
    name: 'cloud-index', status: 'available', sessions: 2, mirrors: 1,
  });
  assert.equal(result.value.ownerReport.skipped.cloudLocalRows, 1);
  assert.equal(result.value.ownerReport.skipped.cloudZeroTurns, 2);
  assert.equal(result.value.ownerReport.skipped.unreadable, 1);
  const read = run(f, ['read', '--plan', result.file, '--slice', '2', '--session', 'cloud:remote-1', '--consent', 'explicit-user']);
  assert.equal(read.status, 0, read.stderr);
  assert.deepEqual(JSON.parse(read.stdout).cloudSessions, ['cloud:remote-1']);
});

test('cloud input is filtered by scope even when its exporter omitted the repository predicate', (t) => {
  const f = fixture(t);
  const cloud = cloudFile(f, [
    { id: 'remote-allowed', repository: 'https://github.com/Acme/App.git', created_at: '2026-11-23T12:00:00Z', turns: 1 },
    { id: 'remote-secret', repository: 'other/secret', created_at: '2026-11-23T12:00:00Z', turns: 1 },
    { id: 'remote-enterprise', repository: 'git@ghe.corp:acme/app.git', created_at: '2026-11-23T12:00:00Z', turns: 1 },
    { id: 'remote-unattached', repository: null, created_at: '2026-11-23T12:00:00Z', turns: 1 },
  ]);
  const result = plan(f, ['--cloud-sessions', cloud]);
  assert.deepEqual(sessionIds(result.value), ['local:a1', 'local:a2', 'local:a3', 'local:a4', 'cloud:remote-allowed']);
  assert.equal(result.value.ownerReport.sources.at(-1).status, 'supplied');
  assert.equal(result.value.ownerReport.skipped.outsideScope, 6);
});

for (const encoding of ['utf8', 'utf16le']) {
  test(`${encoding} BOM files retain cloud sessions and local turns in a saved plan`, (t) => {
    const f = fixture(t, false);
    const events = log(f, 'human', 'acme/app', '2026-11-02T12:00:00Z', messages('Keep human evidence.', 'A human reply.'));
    for (const file of [events, join(f.home, 'session-state', 'human', 'workspace.yaml')]) {
      writeFileSync(file, Buffer.from(`\uFEFF${readFileSync(file, 'utf8')}`, encoding));
    }
    const cloud = cloudFile(f, [
      { id: 'remote-bom', repository: 'acme/app', created_at: '2026-11-20T12:00:00Z', turns: 1 },
    ]);
    writeFileSync(cloud, Buffer.from(`\uFEFF${readFileSync(cloud, 'utf8')}`, encoding));
    const result = plan(f, ['--cloud-sessions', cloud]);
    assert.deepEqual(sessionIds(result.value), ['local:human', 'cloud:remote-bom']);
    writeFileSync(result.file, Buffer.from(`\uFEFF${JSON.stringify(result.value)}`, encoding));
    const read = run(f, ['read', '--plan', result.file, '--slice', '0', '--session', 'local:human']);
    assert.equal(read.status, 0, read.stderr);
    assert.equal(read.stderr, '');
    assert.equal(read.stdout, '=== local:human | acme/app | 2026-11-02T12:00:00.000Z | local-log | 1 human turns\n[1] user: Keep human evidence.\n[1] reply: A human reply.\n');
  });
}

test('missing, unreadable, and malformed CLI JSON files report usage errors', (t) => {
  const f = fixture(t, false);
  const invalid = join(f.root, 'invalid.json');
  writeFileSync(invalid, '{invalid');
  const out = join(f.root, 'refused');
  for (const file of [join(f.root, 'missing.json'), f.root, invalid]) {
    for (const args of [
      ['read', '--plan', file, '--slice', '0'],
      ['plan', '--repo', 'acme/app', '--since', since, '--now', now, '--cloud-sessions', file, '--out', out],
    ]) {
      const result = run(f, args);
      assert.equal(result.status, 2, result.stderr);
      assert.equal(JSON.parse(result.stderr).code, 'E_USAGE');
      assert.equal(result.stdout, '');
      assert.equal(existsSync(out), false);
    }
  }
});

test('mirror grouping requires matching repository, time, and an unambiguous local summary', (t) => {
  const f = fixture(t, false);
  log(f, 'one', 'acme/app', '2026-11-02T12:00:00Z', messages('First preference.'), { summary: ' Unique summary ' });
  log(f, 'two', 'acme/app', '2026-11-03T12:00:00Z', messages('Second preference.'), { summary: 'Shared summary' });
  log(f, 'three', 'acme/app', '2026-11-03T12:00:20Z', messages('Third preference.'), { summary: 'Shared summary' });
  log(f, 'unattached', null, '2026-11-04T12:00:00Z', messages('Unattached preference.'), { cwd: f.root });
  const cloud = cloudFile(f, [
    { id: 'summary-mirror', repository: 'acme/app', created_at: '2026-11-02T12:00:30Z', summary: 'Unique summary', turns: 1 },
    { id: 'ambiguous', repository: 'acme/app', created_at: '2026-11-03T12:00:30Z', summary: 'Shared summary', turns: 1 },
    { id: 'one', repository: 'other/secret', created_at: '2026-11-02T12:00:00Z', turns: 1 },
    { id: 'two', repository: 'acme/app', created_at: '2026-11-03T12:06:00Z', turns: 1 },
    { id: 'unattached', repository: null, created_at: '2026-11-04T12:05:00Z', turns: 1 },
  ]);
  const result = plan(f, ['--scope', 'personal', '--consent', 'explicit-user', '--cloud-sessions', cloud]);
  assert.deepEqual(sessionIds(result.value), [
    'cloud:one', 'local:one', 'local:two', 'local:three', 'cloud:ambiguous', 'cloud:two', 'local:unattached',
  ]);
  assert.equal(result.value.ownerReport.counts.mirrors, 2);
  assert.deepEqual(result.value.slices[0].sessions.find((session) => session.id === 'local:one').rawIds, ['one', 'summary-mirror']);
});

test('only original local facts establish mirrors and excluding a proven mirror excludes the whole group', (t) => {
  const f = fixture(t, false);
  log(f, 'current', 'acme/app', '2026-11-02T12:00:00Z', messages('Do not mine the current invocation.'), { summary: 'Original local summary' });
  log(f, 'history', 'acme/app', '2026-11-20T12:00:00Z', messages('Keep a useful historical preference.'));
  const cloud = cloudFile(f, [
    { id: 'current', repository: 'acme/app', created_at: '2026-11-02T12:00:00Z', summary: 'Changed cloud summary', turns: 1 },
    { id: 'distinct', repository: 'acme/app', created_at: '2026-11-02T12:00:30Z', summary: 'Changed cloud summary', turns: 1 },
  ]);
  const result = plan(f, ['--cloud-sessions', cloud, '--exclude-session', 'local:current']);
  assert.deepEqual(sessionIds(result.value), ['cloud:distinct', 'local:history']);
  assert.equal(result.value.ownerReport.counts.mirrors, 1);
  assert.equal(result.value.ownerReport.skipped.excluded, 1);
  const byCloudId = plan(f, ['--cloud-sessions', cloud, '--exclude-session', 'cloud:current']);
  assert.deepEqual(sessionIds(byCloudId.value), ['cloud:distinct', 'local:history']);
});

test('conflicting local repository metadata needs every named repository and unattached scope stays explicit', (t) => {
  const f = fixture(t);
  log(f, 'conflict', 'other/secret', '2026-11-15T12:00:00Z', null);
  indexed(f, 'conflict', 'acme/app', '2026-11-15T12:00:00Z', [['A shared session preference.', 'An indexed reply.']]);
  const restricted = plan(f);
  assert.deepEqual(sessionIds(restricted.value), ['local:a1', 'local:a2', 'local:a3', 'local:a4']);
  assert.equal(restricted.value.ownerReport.skipped.unreadable, 0);
  const selected = plan(f, ['--scope', 'repos', '--repos', 'acme/app,other/secret', '--consent', 'explicit-user']);
  assert.deepEqual(sessionIds(selected.value), ['local:a1', 'local:a2', 'local:conflict', 'local:a3']);
  const unattached = plan(f, ['--scope', 'repos', '--repos', 'acme/app,other/secret', '--unattached', '--consent', 'explicit-user']);
  assert.deepEqual(sessionIds(unattached.value), ['local:a1', 'local:a2', 'local:conflict', 'local:a3', 'local:a4', 'local:loose']);
});

test('human provenance, UTF-16LE logs, and repeated automation openers do not create extra votes', (t) => {
  const f = fixture(t, false);
  const events = [
    { type: 'user.message', agentId: 'delegate', data: { content: 'Subagent instructions.' } },
    { type: 'assistant.message', agentId: 'delegate', data: { content: 'Subagent reply.' } },
    { type: 'user.message', data: { source: 'skill-runtime', content: 'Delivered instructions.' } },
    ...['PSTACK_CONTEXT_V1 kickoff', '<skill-context name="x">', '<copilot_tauri_workspace>', '<cross_session_message>', '<system_notification>', '<canvas-context page="x">']
      .map((content) => ({ type: 'user.message', data: { content } })),
    { type: 'user.message', data: { transformedContent: 'Transformed private text.', encryptedContent: 'Encrypted private text.' } },
    { type: 'user.message', data: { source: null, content: 'Write less.', transformedContent: 'Never read transformed text.' } },
    { type: 'assistant.message', data: { content: 'Short reply.', reasoningText: 'Never read reasoning.', toolRequests: [{ content: 'Never read tools.' }] } },
    { type: 'user.message', data: { source: 'autopilot', content: 'A delivered follow-up.' } },
    { type: 'assistant.message', data: { content: 'Do not attach this reply to the human.' } },
  ];
  const file = log(f, 'utf16', 'acme/app', '2026-11-02T12:00:00Z', []);
  writeFileSync(file, Buffer.from(`\uFEFF${events.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf16le'));
  log(f, 'first-opener', 'acme/app', '2026-11-03T12:00:00Z', messages('Schedule the daily review.'));
  log(f, 'repeat', 'acme/app', '2026-11-12T12:00:00Z', messages('Schedule   the daily\nreview.'));
  log(f, 'follow-up', 'acme/app', '2026-11-21T12:00:00Z', [
    ...messages('Schedule the daily review.'),
    ...messages('Actually, run tests first.', 'I ran the tests.'),
  ]);
  log(f, 'delivered-only', 'acme/app', '2026-11-15T12:00:00Z', [
    { type: 'user.message', data: { source: 'agent-runtime', content: 'This is not typed.' } },
  ]);
  const result = plan(f);
  assert.deepEqual(sessionIds(result.value), ['local:utf16', 'local:first-opener', 'local:follow-up']);
  assert.equal(result.value.ownerReport.skipped.noTypedTurns, 1);
  assert.equal(result.value.ownerReport.skipped.repeatedOpener, 1);
  assert.equal(result.value.ownerReport.counts.strippedOpeners, 1);
  assert.equal(result.value.slices[2].sessions[0].userTurns, 1);
  const read = run(f, ['read', '--plan', result.file, '--slice', '0', '--session', 'local:utf16']);
  assert.equal(read.status, 0, read.stderr);
  assert.equal(read.stdout, '=== local:utf16 | acme/app | 2026-11-02T12:00:00.000Z | local-log | 1 human turns\n[1] user: Write less.\n[1] reply: Short reply.\n');
  const followUp = run(f, ['read', '--plan', result.file, '--slice', '2', '--session', 'local:follow-up']);
  assert.equal(followUp.status, 0, followUp.stderr);
  assert.equal(followUp.stdout, '=== local:follow-up | acme/app | 2026-11-21T12:00:00.000Z | local-log | 1 human turns\n[1] user: Actually, run tests first.\n[1] reply: I ran the tests.\n');
});

for (const source of ['local-log', 'local-index']) {
  test(`${source} filters runtime extension wakes and supervisor notices`, (t) => {
    const f = fixture(t, false);
    const turns = [
      ['Keep only human requests.', 'A human reply.'],
      ['Parent session active; run python skills/double/scripts/double_watch.py', 'A runtime wake reply.'],
      ['[Double Supervisor Notice] Review the latest claims.', 'A supervisor reply.'],
      ['<canvas-context page="preview">', 'A canvas reply.'],
    ];
    if (source === 'local-log') {
      log(f, 'runtime', 'acme/app', '2026-11-02T12:00:00Z', turns.flatMap(([user, reply]) => messages(user, reply)));
    } else {
      indexed(f, 'runtime', 'acme/app', '2026-11-02T12:00:00Z', turns);
    }
    const result = plan(f);
    assert.deepEqual(sessionIds(result.value), ['local:runtime']);
    assert.equal(result.value.slices[0].sessions[0].from, source);
    assert.equal(result.value.slices[0].sessions[0].userTurns, 1);
    const read = run(f, ['read', '--plan', result.file, '--slice', '0', '--session', 'local:runtime']);
    assert.equal(read.status, 0, read.stderr);
    assert.equal(read.stderr, '');
    assert.equal(read.stdout, `=== local:runtime | acme/app | 2026-11-02T12:00:00.000Z | ${source} | 1 human turns\n[1] user: Keep only human requests.\n[1] reply: A human reply.\n`);
  });
}

test('since-file uses the actual tracked commit and discloses an untracked personal file mtime', (t) => {
  const f = fixture(t);
  const trackedRoot = join(f.root, 'tracked');
  mkdirSync(trackedRoot);
  const tracked = join(trackedRoot, 'mode.agent.md');
  writeFileSync(tracked, 'A tracked mode.\n');
  const git = (args, env = {}) => {
    const result = spawnSync('git', ['--no-pager', '-C', trackedRoot, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
    assert.equal(result.status, 0, result.stderr);
    return result;
  };
  git(['init']);
  git(['add', 'mode.agent.md']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Track a mode'], {
    GIT_AUTHOR_DATE: '2026-11-05T03:04:05Z', GIT_COMMITTER_DATE: '2026-11-05T03:04:05Z',
  });
  utimesSync(tracked, new Date('2026-11-25T00:00:00Z'), new Date('2026-11-25T00:00:00Z'));
  const committed = plan(f, ['--since-file', tracked], { cutoff: false });
  assert.equal(committed.value.window.since, '2026-11-05T03:04:05.000Z');
  assert.equal(committed.value.ownerReport.cutoffSource, 'git-commit');
  assert.deepEqual(sessionIds(committed.value), ['local:a2', 'local:a3', 'local:a4']);
  const personal = join(f.root, 'portable-home', '.copilot', 'agents', 'jay.agent.md');
  mkdirSync(join(f.root, 'portable-home', '.copilot', 'agents'), { recursive: true });
  writeFileSync(personal, 'An untracked personal mode.\n');
  utimesSync(personal, new Date('2026-11-19T00:00:00Z'), new Date('2026-11-19T00:00:00Z'));
  const fallback = plan(f, ['--since-file', personal], { cutoff: false });
  assert.equal(fallback.value.window.since, '2026-11-19T00:00:00.000Z');
  assert.equal(fallback.value.ownerReport.cutoffSource, 'file-mtime');
  assert.deepEqual(sessionIds(fallback.value), ['local:a3', 'local:a4']);
  assert.equal(fallback.value.publishableSummary.disclosures.includes('The update cutoff uses the file modification time rather than a git commit.'), true);
  const untracked = join(trackedRoot, 'untracked.agent.md');
  writeFileSync(untracked, 'An untracked file inside git.\n');
  utimesSync(untracked, new Date('2026-11-19T00:00:00Z'), new Date('2026-11-19T00:00:00Z'));
  assert.equal(plan(f, ['--since-file', untracked], { cutoff: false }).value.ownerReport.cutoffSource, 'file-mtime');
});

test('read permits only the requested plan slice and renders the selected main-thread content', (t) => {
  const f = fixture(t);
  const result = plan(f);
  const read = run(f, ['read', '--plan', result.file, '--slice', '0', '--session', 'local:a1']);
  assert.equal(read.status, 0, read.stderr);
  assert.equal(read.stdout, '=== local:a1 | acme/app | 2026-11-02T12:00:00.000Z | local-log | 1 human turns\n[1] user: Give short replies.\n[1] reply: I will keep replies short.\n');
  for (const args of [
    ['--slice', '0', '--session', 'local:b1'],
    ['--slice', '0', '--session', 'local:a2'],
    ['--slice', '9'],
    ['--slice', 'nope'],
  ]) {
    const refused = run(f, ['read', '--plan', result.file, ...args]);
    assert.equal(refused.status, 2);
    assert.equal(JSON.parse(refused.stderr).code, 'E_OUT_OF_PLAN');
    assert.equal(refused.stdout, '');
  }
});

test('publishable output contains no repository, path, session identifier, or conversation text', (t) => {
  const f = fixture(t);
  const result = plan(f, ['--scope', 'personal', '--consent', 'explicit-user', '--cloud-status', 'unauthenticated']);
  assert.deepEqual(JSON.parse(result.stdout), result.value.publishableSummary);
  assert.equal(JSON.parse(result.stdout).scope, 'personal');
  assert.equal(JSON.parse(result.stdout).counts.selected, 6);
  for (const secret of ['acme/app', 'other/secret', 'ghe.corp', f.root, f.home, 'local:a1', 'local:enterprise', 'Give short replies.', privateSummary]) {
    assert.equal(result.stdout.includes(secret), false, secret);
  }
  assert.deepEqual(JSON.parse(result.stdout).sources, [
    { name: 'local-log', status: 'available' }, { name: 'local-index', status: 'available' },
    { name: 'cloud-index', status: 'unauthenticated' },
  ]);
});

test('draft audit reports line diagnostics for private repos, OS homes, and raw UUIDs without quoting the draft', (t) => {
  const f = fixture(t);
  const uuid = '4c918fa7-40ef-4e16-a1ec-6a1a1bba53e4';
  log(f, uuid, 'acme/app', '2026-11-23T12:00:00Z', messages('Review the result.'));
  const result = plan(f, ['--scope', 'personal', '--consent', 'explicit-user']);
  const draft = join(f.root, 'draft.agent.md');
  writeFileSync(draft, [
    'Private other/secret instructions.',
    'Use C:\\Users\\alice\\work for hidden details.',
    'Use /Users/alice/work for hidden details.',
    'Use /home/alice/work for hidden details.',
    `Session ${uuid} contains hidden details.`,
    'Use ghe.corp/acme/app instructions.',
  ].join('\n'));
  const audit = run(f, ['audit-draft', '--plan', result.file, '--draft', draft, '--active-repo', 'acme/app']);
  assert.equal(audit.status, 1, audit.stderr);
  assert.deepEqual(JSON.parse(audit.stdout), { clean: false, diagnostics: [
    { line: 1, column: 9, code: 'repository' },
    { line: 2, column: 5, code: 'home-path' },
    { line: 3, column: 5, code: 'home-path' },
    { line: 4, column: 5, code: 'home-path' },
    { line: 5, column: 9, code: 'session-id' },
    { line: 6, column: 5, code: 'repository' },
  ] });
  assert.equal(audit.stdout.includes('hidden details'), false);
  writeFileSync(draft, 'Keep acme/app instructions in the repository.\nUse ~/.copilot/agents/jay.agent.md or $HOME/.copilot/agents/jay.agent.md.\n');
  const clean = run(f, ['audit-draft', '--plan', result.file, '--draft', draft, '--active-repo', 'https://github.com/Acme/App.git']);
  assert.equal(clean.status, 0, clean.stderr);
  assert.deepEqual(JSON.parse(clean.stdout), { clean: true, diagnostics: [] });
});

test('UTF-16LE BOM drafts are decoded before privacy auditing', (t) => {
  const f = fixture(t, false);
  log(f, 'session-private', 'acme/app', '2026-11-02T12:00:00Z', messages('Keep replies short.'));
  const result = plan(f);
  const draft = join(f.root, 'draft.agent.md');
  writeFileSync(draft, Buffer.from('\uFEFFSession session-private is private.\n', 'utf16le'));
  const audit = run(f, ['audit-draft', '--plan', result.file, '--draft', draft]);
  assert.equal(audit.status, 1, audit.stderr);
  assert.equal(audit.stderr, '');
  assert.deepEqual(JSON.parse(audit.stdout), { clean: false, diagnostics: [
    { line: 1, column: 9, code: 'session-id' },
  ] });
  writeFileSync(draft, Buffer.from('\uFEFFKeep replies short.\n', 'utf16le'));
  const clean = run(f, ['audit-draft', '--plan', result.file, '--draft', draft]);
  assert.equal(clean.status, 0, clean.stderr);
  assert.equal(clean.stderr, '');
  assert.deepEqual(JSON.parse(clean.stdout), { clean: true, diagnostics: [] });
});

test('empty local histories still tile the whole window and provide bounded cloud-only queries', (t) => {
  const f = fixture(t, false);
  const result = plan(f, ['--home', join(f.root, 'no-profile'), '--consent', 'explicit-user', '--cloud-status', 'unavailable']);
  assert.equal(result.value.ownerReport.counts.selected, 0);
  assert.deepEqual(result.value.slices.map((slice) => [slice.since, slice.until, slice.sessions]), [
    ['2026-11-01T00:00:00.000Z', '2026-11-10T00:00:00.000Z', []],
    ['2026-11-10T00:00:00.000Z', '2026-11-19T00:00:00.000Z', []],
    ['2026-11-19T00:00:00.000Z', '2026-11-28T00:00:00.000Z', []],
  ]);
  for (const slice of result.value.slices) {
    assert.match(slice.cloudSessionsSql, new RegExp(`TIMESTAMP '${slice.since.replaceAll('.', '\\.')}'`));
    assert.match(slice.cloudSessionsSql, /EXISTS \(SELECT 1 FROM turns t WHERE t.session_id = s.id\)/);
    assert.match(slice.cloudSessionsSql, /LIMIT 200$/);
    assert.match(slice.cloudTurnsSql, /JOIN sessions s ON s.id = t.session_id/);
    assert.match(slice.cloudTurnsSql, /t.session_id IN \(NULL\)/);
    assert.match(slice.cloudTurnsSql, /'acme\/app'/);
  }
  const read = run(f, ['read', '--plan', result.file, '--slice', '1']);
  assert.equal(read.status, 0, read.stderr);
  assert.equal(read.stdout, '');
  assert.deepEqual(result.value.publishableSummary.sources, [
    { name: 'local-log', status: 'unavailable' }, { name: 'local-index', status: 'unavailable' },
    { name: 'cloud-index', status: 'unavailable' },
  ]);
});

test('a Node host without node:sqlite keeps log coverage instead of crashing or creating an index', (t) => {
  const f = fixture(t);
  const result = plan(f, [], { nodeArgs: ['--no-experimental-sqlite'] });
  assert.deepEqual(sessionIds(result.value), ['local:a1', 'local:a3', 'local:a4']);
  assert.equal(result.value.ownerReport.sources[1].status, 'unavailable');
  assert.deepEqual(result.value.publishableSummary.sources[0], { name: 'local-log', status: 'available' });
});

test('sampling selects sessions across time and exclusions happen before opener deduplication', (t) => {
  const f = fixture(t, false);
  for (const [id, day] of [['one', '02'], ['two', '03'], ['three', '04'], ['four', '10'], ['five', '18'], ['six', '25'], ['seven', '26']]) {
    log(f, id, 'acme/app', `2026-11-${day}T12:00:00Z`, messages(`Preference ${id}.`));
  }
  const sampled = plan(f, ['--slices', '3', '--per-slice', '2']);
  assert.deepEqual(sessionIds(sampled.value), ['local:one', 'local:two', 'local:three', 'local:four', 'local:five', 'local:seven']);
  assert.equal(sampled.value.ownerReport.counts.sampledOut, 1);
  log(f, 'excluded', 'acme/app', '2026-11-05T12:00:00Z', messages('A repeated opener.'));
  log(f, 'retained', 'acme/app', '2026-11-15T12:00:00Z', messages('A repeated opener.'));
  const excluded = plan(f, ['--exclude-session', 'excluded', '--exclude-session', 'local:one']);
  assert.deepEqual(sessionIds(excluded.value), ['local:two', 'local:three', 'local:four', 'local:retained', 'local:five', 'local:six', 'local:seven']);
  assert.equal(excluded.value.ownerReport.skipped.excluded, 2);
  assert.equal(excluded.value.ownerReport.skipped.repeatedOpener, 0);
});

test('repository keys preserve Enterprise hosts and repository resolution never widens to personal', (t) => {
  assert.equal(normalizeRepoKey('https://github.com/Acme/App.git'), 'acme/app');
  assert.equal(normalizeRepoKey('git@ghe.acme.com:Acme/App.git'), 'ghe.acme.com/acme/app');
  assert.equal(normalizeRepoKey('Acme/App', 'github.com'), 'acme/app');
  assert.equal(normalizeRepoKey('Acme/App', 'ghe.acme.com'), 'ghe.acme.com/acme/app');
  const f = fixture(t);
  const missing = run(f, ['plan', '--scope', 'repo', '--cwd', f.root, '--out', join(f.root, 'refused')]);
  assert.equal(missing.status, 2);
  assert.equal(JSON.parse(missing.stderr).code, 'E_REPO_REQUIRED');
  assert.equal(existsSync(join(f.root, 'refused')), false);
  const initialized = spawnSync('git', ['-C', f.repoRoot, 'init'], { encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.stderr);
  const remote = spawnSync('git', ['-C', f.repoRoot, 'remote', 'add', 'origin', 'git@github.com:Acme/App.git'], { encoding: 'utf8' });
  assert.equal(remote.status, 0, remote.stderr);
  const out = join(f.root, 'resolved');
  const result = run(f, ['plan', '--scope', 'repo', '--cwd', f.repoRoot, '--since', since, '--now', now, '--out', out]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(sessionIds(JSON.parse(readFileSync(join(out, 'plan.json'), 'utf8'))), ['local:a1', 'local:a2', 'local:a3', 'local:a4']);
});

test('window options reject conflicting or invalid ranges without writing a plan', (t) => {
  const f = fixture(t);
  for (const args of [
    ['--days', '7', '--since', since],
    ['--days', '-1'],
    ['--since', now],
    ['--since', 'not-a-date'],
    ['--since', '2026-02-31'],
  ]) {
    const out = join(f.root, 'bad-window');
    const result = run(f, ['plan', '--scope', 'repo', '--repo', 'acme/app', '--now', now, '--out', out, ...args]);
    assert.equal(result.status, 2);
    assert.equal(JSON.parse(result.stderr).code, 'E_WINDOW');
    assert.equal(existsSync(out), false);
  }
  const days = plan(f, ['--days', '7'], { cutoff: false });
  assert.equal(days.value.window.since, '2026-11-21T00:00:00.000Z');
  assert.deepEqual(sessionIds(days.value), ['local:a4']);
  assert.deepEqual(readdirSync(join(f.root, 'plan-1')), ['plan.json']);
});

test('interview-only draft audits need no plan or history access and exempt only attachment asset UUIDs', (t) => {
  const f = fixture(t, false);
  const draft = join(f.root, 'draft.agent.md');
  const uuid = '4c918fa7-40ef-4e16-a1ec-6a1a1bba53e4';
  writeFileSync(draft, [
    'Keep replies short.',
    'Use ~/.copilot/agents/me.agent.md or $HOME/.copilot/agents/me.agent.md.',
    `See https://github.com/user-attachments/assets/${uuid}.`,
    `![Screenshot](https://github.com/user-attachments/assets/${uuid})`,
    'See https://example.com/Users/foo and http://example.com/home/bar.',
  ].join('\n'));
  const noHistory = { ...f, home: join(f.root, 'missing-profile') };
  const clean = run(noHistory, ['audit-draft', '--draft', draft]);
  assert.equal(clean.status, 0, clean.stderr);
  assert.deepEqual(JSON.parse(clean.stdout), { clean: true, diagnostics: [] });
  writeFileSync(draft, `${uuid}. ${uuid}.\nhttps://example.com/user-attachments/assets/${uuid}\n`);
  const refused = run(noHistory, ['audit-draft', '--draft', draft]);
  assert.equal(refused.status, 1, refused.stderr);
  assert.deepEqual(JSON.parse(refused.stdout), { clean: false, diagnostics: [
    { line: 1, column: 1, code: 'session-id' },
    { line: 1, column: 39, code: 'session-id' },
    { line: 2, column: 45, code: 'session-id' },
  ] });
});

test('draft audits catch remote aliases, Enterprise tails, every known path, and repeated leaks per line', (t) => {
  const f = fixture(t, false);
  log(f, 'private-repo', 'other/secret', '2026-11-02T12:00:00Z', messages('Keep replies short.'));
  log(f, 'enterprise-tool', 'private/tool', '2026-11-03T12:00:00Z', messages('Run tests.'), { host_type: 'ghe.corp' });
  log(f, 'enterprise-active-tail', 'acme/app', '2026-11-04T12:00:00Z', messages('Verify changes.'), { host_type: 'ghe.corp' });
  log(f, 'ado', 'https://dev.azure.com/org/proj/_git/repo', '2026-11-05T12:00:00Z', messages('Use small commits.'));
  log(f, 'active-github', 'acme/app', '2026-11-06T12:00:00Z', messages('Keep changes scoped.'));
  const result = plan(f, ['--scope', 'personal', '--consent', 'explicit-user']);
  const draft = join(f.root, 'draft.agent.md');
  const lines = [
    'other/secret. other/secret.git https://github.com/other/secret.git git@github.com:other/secret.git',
    'ghe.corp/private/tool. git@ghe.corp:private/tool.git private/tool.',
    'acme/app stays allowed, but ghe.corp/acme/app and git@ghe.corp:acme/app.git do not.',
    'https://dev.azure.com/org/proj/_git/repo git@ssh.dev.azure.com:v3/org/proj/repo.git https://org.visualstudio.com/proj/_git/repo',
    `${f.home} ${f.home} ${homedir()}`,
    '/root/private /workspaces/hidden C:\\Users\\alice\\work /Users/alice/work /home/alice/work',
  ];
  writeFileSync(draft, lines.join('\n'));
  const audit = run(f, ['audit-draft', '--plan', result.file, '--draft', draft, '--active-repo', 'acme/app']);
  assert.equal(audit.status, 1, audit.stderr);
  const diagnostics = JSON.parse(audit.stdout).diagnostics;
  assert.deepEqual(lines.map((_, index) => diagnostics.filter((item) => item.line === index + 1).length), [4, 3, 2, 3, 3, 5]);
  assert.deepEqual(new Set(diagnostics.filter((item) => item.line <= 4).map((item) => item.code)), new Set(['repository']));
  assert.deepEqual(new Set(diagnostics.filter((item) => item.line >= 5).map((item) => item.code)), new Set(['home-path']));
  assert.equal(audit.stdout.includes('other/secret'), false);
  writeFileSync(draft, 'Keep acme/app instructions.\nUse ~/.copilot or $HOME/.copilot.\nhttps://example.com/Users/foo http://example.com/home/bar\n');
  const clean = run(f, ['audit-draft', '--plan', result.file, '--draft', draft, '--active-repo', 'acme/app']);
  assert.equal(clean.status, 0, clean.stderr);
  assert.deepEqual(JSON.parse(clean.stdout), { clean: true, diagnostics: [] });
  writeFileSync(draft, 'Keep acme/app instructions.\n');
  const personal = run(f, ['audit-draft', '--plan', result.file, '--draft', draft]);
  assert.equal(personal.status, 1, personal.stderr);
  assert.deepEqual(JSON.parse(personal.stdout), { clean: false, diagnostics: [
    { line: 1, column: 6, code: 'repository' },
  ] });
  writeFileSync(draft, 'Use ghe.corp/acme/app and https://ghe.corp/acme/app.git.\nUse acme/app.\n');
  const enterprise = run(f, ['audit-draft', '--plan', result.file, '--draft', draft, '--active-repo', 'ghe.corp/acme/app']);
  assert.equal(enterprise.status, 1, enterprise.stderr);
  assert.deepEqual(JSON.parse(enterprise.stdout), { clean: false, diagnostics: [
    { line: 2, column: 5, code: 'repository' },
  ] });
  const repoPlan = plan(f);
  writeFileSync(draft, f.repoRoot);
  const repoPath = run(f, ['audit-draft', '--plan', repoPlan.file, '--draft', draft]);
  assert.equal(repoPath.status, 1, repoPath.stderr);
  assert.deepEqual(JSON.parse(repoPath.stdout), { clean: false, diagnostics: [
    { line: 1, column: 1, code: 'home-path' },
  ] });
});

test('draft audits cover excluded, sampled, unsupported, out-of-window, and zero-turn raw IDs', (t) => {
  const f = fixture(t, false);
  log(f, 'excluded-id', 'acme/app', '2026-11-02T12:00:00Z', messages('Excluded preference.'));
  log(f, 'first-id', 'acme/app', '2026-11-03T12:00:00Z', messages('First preference.'));
  log(f, 'sampled-id', 'acme/app', '2026-11-04T12:00:00Z', messages('Sampled preference.'));
  log(f, 'last-id', 'acme/app', '2026-11-20T12:00:00Z', messages('Last preference.'));
  log(f, 'empty-id', 'acme/app', '2026-11-05T12:00:00Z', []);
  log(f, 'old-id', 'acme/app', '2026-10-05T12:00:00Z', messages('Old preference.'));
  log(f, 'unsupported-id', 'acme/app', 'bad-date', messages('Unsupported preference.'));
  const cloud = cloudFile(f, [
    { id: 'zero-id', repository: 'other/secret', created_at: '2026-11-06T12:00:00Z', turn_count: 0 },
    { id: 'supplement-id', repository: 'acme/app', created_at: '2026-11-06T12:00:00Z', _query_source: 'local' },
  ]);
  const result = plan(f, ['--scope', 'personal', '--consent', 'explicit-user', '--cloud-sessions', cloud,
    '--exclude-session', 'excluded-id', '--slices', '2', '--per-slice', '1']);
  assert.deepEqual(sessionIds(result.value), ['local:first-id', 'local:last-id']);
  const ids = ['excluded-id', 'first-id', 'sampled-id', 'last-id', 'empty-id', 'old-id', 'unsupported-id', 'zero-id', 'supplement-id'];
  assert.deepEqual([...result.value.auditIds].sort(), [...ids].sort());
  const draft = join(f.root, 'draft.agent.md');
  writeFileSync(draft, `${ids.map((id) => `${id}.`).join(' ')}\nother/secret.\n`);
  const audit = run(f, ['audit-draft', '--plan', result.file, '--draft', draft]);
  assert.equal(audit.status, 1, audit.stderr);
  const diagnostics = JSON.parse(audit.stdout).diagnostics;
  assert.equal(diagnostics.filter((item) => item.code === 'session-id').length, ids.length);
  assert.deepEqual(diagnostics.filter((item) => item.code === 'repository'), [
    { line: 2, column: 1, code: 'repository' },
  ]);
});

test('metadata census plans can audit repository aliases and custom profile paths without turns', (t) => {
  const f = fixture(t, false);
  const file = join(f.root, 'metadata-plan.json');
  writeFileSync(file, JSON.stringify({
    home: join(f.root, 'another-profile'), repositories: [{ repo: 'ghe.corp/private/tool' }],
    scope: { repoRoots: [f.repoRoot] }, auditIds: ['private-id'],
  }));
  const draft = join(f.root, 'draft.agent.md');
  writeFileSync(draft, `private/tool. private-id. ${f.home}\n${join(f.root, 'another-profile')} ${f.repoRoot}\n`);
  const audit = run(f, ['audit-draft', '--plan', file, '--draft', draft]);
  assert.equal(audit.status, 1, audit.stderr);
  assert.deepEqual(JSON.parse(audit.stdout).diagnostics.map((item) => item.code), [
    'repository', 'session-id', 'home-path', 'home-path', 'home-path',
  ]);
});

test('alternate profile homes and cross-origin repo overrides require consent before history reads', (t) => {
  const f = fixture(t);
  const git = (args) => {
    const result = spawnSync('git', ['-C', f.repoRoot, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git(['init']);
  git(['remote', 'add', 'origin', 'https://github.com/acme/app.git']);
  for (const args of [
    ['--home', join(f.root, 'another-profile'), '--repo', 'acme/app'],
    ['--repo-root', f.repoRoot, '--repo', 'other/secret'],
    ['--cwd', f.repoRoot, '--repo', 'other/secret'],
  ]) {
    const out = join(f.root, 'refused');
    const result = run(f, ['plan', '--scope', 'repo', ...args, '--since-file', join(f.root, 'missing'), '--out', out]);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(JSON.parse(result.stderr).code, 'E_CONSENT_REQUIRED');
    assert.equal(result.stdout, '');
    assert.equal(existsSync(out), false);
  }
  const same = plan(f, ['--home', join(f.home, '.')]);
  assert.deepEqual(sessionIds(same.value), ['local:a1', 'local:a2', 'local:a3', 'local:a4']);
  const other = plan(f, ['--repo', 'other/secret', '--consent', 'explicit-user']);
  assert.deepEqual(sessionIds(other.value), []);
  assert.equal(other.value.ownerReport.skipped.unreadable, 1);
});

test('repo inventories retain titles and source dates only for eligible repository groups', (t) => {
  const f = fixture(t);
  log(f, 'outside-title', 'other/secret', '2026-11-26T12:00:00Z', messages('Private preference.'), { name: privateSummary });
  indexed(f, 'outside-index', 'other/secret', '2026-11-27T12:00:00Z', [['Private text.']], { name: privateSummary });
  indexed(f, 'eligible-title', 'acme/app', '2026-11-12T12:00:00Z', [['Use short replies.']], { name: 'Useful title' });
  const inventory = readInventory(f.home, { kind: 'repo', repos: new Set(['acme/app']), repoRoots: [f.repoRoot], unattached: false });
  assert.deepEqual([...inventory.sessions.find((session) => session.id === 'local:eligible-title').summaries], ['Useful title']);
  for (const id of ['local:outside-title', 'local:outside-index']) {
    assert.deepEqual([...inventory.sessions.find((session) => session.id === id).summaries], []);
  }
  const result = plan(f);
  assert.deepEqual(result.value.ownerReport.sources.slice(0, 2).map(({ name, sessions, oldest, newest }) => ({ name, sessions, oldest, newest })), [
    { name: 'local-log', sessions: 4, oldest: '2026-10-01T12:00:00.000Z', newest: '2026-11-21T12:00:00.000Z' },
    { name: 'local-index', sessions: 3, oldest: '2026-11-02T12:00:00.000Z', newest: '2026-11-12T12:00:00.000Z' },
  ]);
  assert.equal(result.value.ownerReport.skipped.outsideScope, 5);
  assert.equal(Object.hasOwn(result.value.publishableSummary.skipped, 'outsideScope'), false);
  assert.equal(result.value.publishableSummary.counts.selected, 5);
});

test('census counts optional cloud headers and emits only grouped metadata SQL', (t) => {
  const f = fixture(t);
  const cloud = cloudFile(f, [
    { id: 'a1', repository: 'acme/app', created_at: '2026-11-02T12:01:00Z', summary: privateSummary, turn_count: 1 },
    { id: 'remote-header', repository: 'other/secret', created_at: '2026-11-21T12:00:00Z', summary: privateSummary, turn_count: 0 },
    { id: 'remote-loose', repository: null, created_at: '2026-11-22T12:00:00Z', name: privateSummary },
    { id: 'supplement', repository: 'other/secret', created_at: '2026-11-23T12:00:00Z', _query_source: 'local' },
  ]);
  const result = run(f, ['census', '--consent', 'explicit-user', '--since', since, '--now', now, '--cloud-sessions', cloud]);
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.deepEqual(value.repositories, [
    { repo: null, sessions: 3, 'local-log': 2, 'local-index': 0, 'cloud-index': 1 },
    { repo: 'acme/app', sessions: 3, 'local-log': 2, 'local-index': 2, 'cloud-index': 1 },
    { repo: 'other/secret', sessions: 2, 'local-log': 1, 'local-index': 0, 'cloud-index': 1 },
    { repo: 'ghe.corp/acme/app', sessions: 1, 'local-log': 1, 'local-index': 0, 'cloud-index': 0 },
  ]);
  assert.match(value.cloudCensusSql, /^SELECT .*COUNT\(\*\) AS sessions FROM sessions s WHERE /);
  assert.match(value.cloudCensusSql, /GROUP BY 1 ORDER BY sessions DESC LIMIT 200$/);
  assert.match(value.cloudCensusSql, /COALESCE\(s.agent_name, ''\) <> 'Copilot Code Review'/);
  for (const text of ['cloudTurnsSql', 'cloudSessionsSql', 's.summary', privateSummary]) {
    assert.equal(result.stdout.includes(text), false, text);
  }
});

test('read requires fresh consent for non-repo plans and uses fixed native cloud IDs without discovery', (t) => {
  const f = fixture(t, false);
  log(f, 'same-id', 'acme/app', '2026-11-02T12:00:00Z', messages('Keep replies short.'));
  const cloud = cloudFile(f, [
    { id: 'same-id', repository: 'other/secret', created_at: '2026-11-20T12:00:00Z', turn_count: 1 },
    { id: 'second-id', repository: 'other/secret', created_at: '2026-11-21T12:00:00Z', turn_count: 1 },
  ]);
  for (const scope of [
    ['--scope', 'personal'],
    ['--scope', 'repos', '--repos', 'acme/app,other/secret'],
  ]) {
    const result = plan(f, [...scope, '--consent', 'explicit-user', '--cloud-sessions', cloud]);
    const refused = run(f, ['read', '--plan', result.file, '--slice', '0']);
    assert.equal(refused.status, 2, refused.stderr);
    assert.equal(JSON.parse(refused.stderr).code, 'E_CONSENT_REQUIRED');
    assert.equal(refused.stdout, '');
    for (const slice of ['0', '2']) {
      const ambiguous = run(f, ['read', '--plan', result.file, '--slice', slice, '--session', 'same-id', '--consent', 'explicit-user']);
      assert.equal(ambiguous.status, 2, ambiguous.stderr);
      assert.equal(JSON.parse(ambiguous.stderr).code, 'E_OUT_OF_PLAN');
    }
    const read = run(f, ['read', '--plan', result.file, '--slice', '2', '--session', 'cloud:same-id', '--consent', 'explicit-user']);
    assert.equal(read.status, 0, read.stderr);
    const value = JSON.parse(read.stdout);
    assert.deepEqual(value.cloudSessions, ['cloud:same-id']);
    assert.match(value.cloudTurnsSql, /t.session_id IN \('same-id'\)/);
    assert.equal(value.cloudTurnsSql.includes('second-id'), false);
    assert.equal(read.stdout.includes('cloudSessionsSql'), false);
    assert.equal(read.stdout.includes('<session id>'), false);
    const local = run(f, ['read', '--plan', result.file, '--slice', '0', '--session', 'local:same-id', '--consent', 'explicit-user']);
    assert.equal(local.status, 0, local.stderr);
    assert.match(local.stdout, /\[1\] user: Keep replies short\./);
  }
});

test('read escapes native cloud IDs and accepts a unique unqualified native ID', (t) => {
  const f = fixture(t, false);
  const cloud = cloudFile(f, [{ id: 'remote', repository: 'acme/app', created_at: '2026-11-02T12:00:00Z', turn_count: 1 }]);
  const result = plan(f, ['--cloud-sessions', cloud]);
  const unique = run(f, ['read', '--plan', result.file, '--slice', '0', '--session', 'remote']);
  assert.equal(unique.status, 0, unique.stderr);
  assert.deepEqual(JSON.parse(unique.stdout).cloudSessions, ['cloud:remote']);
  result.value.slices[0].sessions[0].rawId = "remote'quoted";
  writeFileSync(result.file, JSON.stringify(result.value));
  const quoted = run(f, ['read', '--plan', result.file, '--slice', '0']);
  assert.equal(quoted.status, 0, quoted.stderr);
  assert.match(JSON.parse(quoted.stdout).cloudTurnsSql, /t.session_id IN \('remote''quoted'\)/);
  assert.equal(quoted.stdout.includes('cloudSessionsSql'), false);
});

test('repository normalization supports credentials, GitLab subgroups, Azure DevOps, and real host types', () => {
  for (const [repo, host, hostType, expected] of [
    ['https://user:password@gitlab.com/Group/Sub/Repo.git/', '', '', 'gitlab.com/group/sub/repo'],
    ['git@gitlab.com:Group/Sub/Repo.git', '', '', 'gitlab.com/group/sub/repo'],
    ['Group/Sub/Repo', 'gitlab.com', 'gitlab', 'gitlab.com/group/sub/repo'],
    ['Group/Sub/Repo', '', 'gitlab', 'gitlab/group/sub/repo'],
    ['gitlab/Group/Sub/Repo', '', 'gitlab', 'gitlab/group/sub/repo'],
    ['https://dev.azure.com/Org/Proj/_git/Repo/', '', '', 'dev.azure.com/org/proj/repo'],
    ['git@ssh.dev.azure.com:v3/Org/Proj/Repo', '', '', 'dev.azure.com/org/proj/repo'],
    ['https://org.visualstudio.com/Proj/_git/Repo.git', '', '', 'dev.azure.com/org/proj/repo'],
    ['dev.azure.com/Org/Proj/Repo.git/', '', '', 'dev.azure.com/org/proj/repo'],
    ['Acme/App', '', 'github', 'acme/app'],
    ['Acme/App.git/', '', 'github', 'acme/app'],
    ['Acme/App', '', 'github.com', 'acme/app'],
    ['Acme/App', '', 'GHE.CORP', 'ghe.corp/acme/app'],
    ['Acme/App', '', 'gitlab', 'gitlab/acme/app'],
  ]) {
    assert.equal(normalizeRepoKey(repo, host, hostType), expected, repo);
  }
});

test('real host_type metadata isolates non-GitHub sessions and personal scope retains ambiguous repositories', (t) => {
  const f = fixture(t, false);
  log(f, 'github', 'acme/app', '2026-11-02T12:00:00Z', messages('A GitHub preference.'));
  log(f, 'enterprise', 'acme/app', '2026-11-03T12:00:00Z', messages('An Enterprise preference.'), { host_type: 'ghe.corp' });
  indexed(f, 'gitlab', 'acme/app', '2026-11-04T12:00:00Z', [['A GitLab preference.']], { host_type: 'gitlab' });
  log(f, 'exotic', 'opaque::repository', '2026-11-05T12:00:00Z', messages('An exotic preference.'));
  indexed(f, 'index-exotic', 'opaque::repository', '2026-11-06T12:00:00Z', [['An indexed exotic preference.']]);
  const restricted = plan(f);
  assert.deepEqual(sessionIds(restricted.value), ['local:github']);
  assert.equal(restricted.value.ownerReport.skipped.unsupported, 0);
  const enterprise = plan(f, ['--scope', 'repos', '--repos', 'ghe.corp/acme/app,gitlab/acme/app', '--consent', 'explicit-user']);
  assert.deepEqual(sessionIds(enterprise.value), ['local:enterprise', 'local:gitlab']);
  const personal = plan(f, ['--scope', 'personal', '--consent', 'explicit-user']);
  assert.deepEqual(sessionIds(personal.value), ['local:github', 'local:enterprise', 'local:gitlab', 'local:exotic', 'local:index-exotic']);
  assert.equal(personal.value.ownerReport.skipped.unsupported, 0);
});

test('worktree roots include the main checkout even with an explicit repo or an unparseable origin', (t) => {
  const f = fixture(t, false);
  const git = (args) => {
    const result = spawnSync('git', ['-C', f.repoRoot, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git(['init']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'Create worktree fixture']);
  git(['remote', 'add', 'origin', 'opaque::repository']);
  const worktree = join(f.root, 'worktree');
  git(['worktree', 'add', '-b', 'fixture-worktree', worktree]);
  log(f, 'main-root', null, '2026-11-02T12:00:00Z', messages('A main checkout preference.'), { cwd: join(f.repoRoot, 'src') });
  log(f, 'worktree-root', null, '2026-11-03T12:00:00Z', messages('A worktree preference.'), { cwd: join(worktree, 'src') });
  log(f, 'named-root', 'acme/app', '2026-11-04T12:00:00Z', messages('A named root preference.'));
  log(f, 'other-repo', 'other/secret', '2026-11-05T12:00:00Z', messages('An unrelated preference.'));
  log(f, 'conflicting-root', 'acme/app', '2026-11-06T12:00:00Z', messages('A conflicting preference.'));
  indexed(f, 'conflicting-root', 'other/secret', '2026-11-06T12:00:00Z', [['Another attribution.']]);
  const explicit = plan(f, ['--repo-root', worktree]);
  assert.deepEqual(sessionIds(explicit.value), ['local:main-root', 'local:worktree-root', 'local:named-root']);
  assert.deepEqual(explicit.value.scope.repoRoots, [worktree, f.repoRoot].map((path) => process.platform === 'win32'
    ? path.replaceAll('\\', '/').toLowerCase() : path.replaceAll('\\', '/')));
  const out = join(f.root, 'root-only');
  const rootOnly = run(f, ['plan', '--scope', 'repo', '--cwd', worktree, '--since', since, '--now', now, '--out', out]);
  assert.equal(rootOnly.status, 0, rootOnly.stderr);
  const value = JSON.parse(readFileSync(join(out, 'plan.json'), 'utf8'));
  assert.deepEqual(value.scope.repos, []);
  assert.deepEqual(sessionIds(value), ['local:main-root', 'local:worktree-root', 'local:named-root', 'local:other-repo']);
  const root = plan(f, ['--repo-root', parse(f.root).root, '--cwd', f.root]);
  assert.deepEqual(root.value.scope.repoRoots, []);
  assert.deepEqual(sessionIds(root.value), ['local:named-root']);
  const windowsRoot = plan(f, ['--repo-root', 'X:\\', '--cwd', f.root]);
  assert.deepEqual(windowsRoot.value.scope.repoRoots, []);
  assert.deepEqual(sessionIds(windowsRoot.value), ['local:named-root']);
});

test('workspace scalar parsing preserves issue numbers and matches name or summary within five minutes', (t) => {
  const f = fixture(t, false);
  log(f, 'issue', 'acme/app', '2026-11-02T12:00:59Z', messages('Keep the issue scope small.'));
  writeFileSync(join(f.home, 'session-state', 'issue', 'workspace.yaml'), [
    'repository: acme/app', 'host_type: github', `cwd: ${JSON.stringify(f.repoRoot)}`,
    'created_at: 2026-11-02T12:00:59Z', 'name: Fix issue #22', 'summary: |-',
    '  A private multiline summary.',
  ].join('\n'));
  log(f, 'malformed-summary', 'acme/app', '2026-11-03T12:00:00Z', messages('Keep valid metadata.'));
  writeFileSync(join(f.home, 'session-state', 'malformed-summary', 'workspace.yaml'), [
    'repository: acme/app', 'host_type: github', 'created_at: 2026-11-03T12:00:00Z',
    'summary: "unterminated', 'name: A valid name',
  ].join('\n'));
  indexed(f, 'indexed-name', 'acme/app', '2026-11-04T12:00:00Z', [['Keep the indexed preference.']], { name: 'Indexed name' });
  log(f, 'loose-title', null, '2026-11-05T12:00:00Z', messages('Keep unattached preferences.'), { cwd: f.root, name: 'Unattached title', summary: '>' });
  const cloud = cloudFile(f, [
    { id: 'issue-remote', repository: 'acme/app', created_at: '2026-11-02T12:05:59Z', name: 'Fix issue #22', turn_count: 1 },
    { id: 'valid-remote', repository: 'acme/app', created_at: '2026-11-03T12:04:59Z', summary: 'A valid name', turn_count: 1 },
    { id: 'index-remote', repository: 'acme/app', created_at: '2026-11-04T12:02:00Z', summary: 'Indexed name', turn_count: 1 },
    { id: 'loose-remote', repository: null, created_at: '2026-11-05T12:04:00Z', name: 'Unattached title', turn_count: 1 },
  ]);
  const result = plan(f, ['--scope', 'personal', '--consent', 'explicit-user', '--cloud-sessions', cloud]);
  assert.deepEqual(sessionIds(result.value), ['local:issue', 'local:malformed-summary', 'local:indexed-name', 'local:loose-title']);
  assert.equal(result.value.ownerReport.counts.mirrors, 4);
  assert.equal(result.value.ownerReport.skipped.unsupported, 0);
  assert.equal(readFileSync(result.file, 'utf8').includes('Fix issue #22'), false);
});

test('raw-ID mirrors can join path-matched local records without mutating original repo facts', (t) => {
  const f = fixture(t, false);
  log(f, 'path-id', null, '2026-11-02T12:00:00Z', messages('Keep local path evidence.'), { name: 'Original title' });
  const cloud = cloudFile(f, [
    { id: 'path-id', repository: 'acme/app', created_at: '2026-11-02T12:05:00Z', name: 'Original title', turn_count: 1 },
    { id: 'distinct-id', repository: 'acme/app', created_at: '2026-11-02T12:04:00Z', name: 'Original title', turn_count: 1 },
  ]);
  const result = plan(f, ['--cloud-sessions', cloud]);
  assert.deepEqual(sessionIds(result.value), ['local:path-id', 'cloud:distinct-id']);
  assert.equal(result.value.ownerReport.counts.mirrors, 1);
  assert.deepEqual(result.value.slices.flatMap((slice) => slice.sessions).find((session) => session.id === 'local:path-id').origins, ['local-log', 'cloud-index']);
});

test('empty or unreadable local mirrors use their recorded native cloud reader instead of disappearing', (t) => {
  const f = fixture(t, false);
  log(f, 'empty-stub', 'acme/app', '2026-11-02T12:00:00Z', [], { name: 'Empty stub title' });
  log(f, 'unreadable-stub', 'acme/app', '2026-11-20T12:00:00Z', null);
  const cloud = cloudFile(f, [
    { id: 'cloud-empty', repository: 'acme/app', created_at: '2026-11-02T12:01:00Z', summary: 'Empty stub title', turn_count: 2 },
    { id: 'unreadable-stub', repository: 'acme/app', created_at: '2026-11-20T12:00:00Z', turn_count: 1 },
  ]);
  const result = plan(f, ['--cloud-sessions', cloud]);
  assert.deepEqual(sessionIds(result.value), ['cloud:cloud-empty', 'cloud:unreadable-stub']);
  assert.equal(result.value.ownerReport.counts.mirrors, 2);
  assert.equal(result.value.ownerReport.counts.cloudSessions, 2);
  assert.equal(result.value.ownerReport.skipped.noTypedTurns, 0);
  assert.equal(result.value.ownerReport.skipped.unreadable, 0);
  const session = result.value.slices[0].sessions[0];
  assert.equal(session.rawId, 'cloud-empty');
  assert.equal(session.cloudRawId, 'cloud-empty');
  assert.equal(session.from, 'cloud-index');
  assert.equal(session.userTurns, null);
  const read = run(f, ['read', '--plan', result.file, '--slice', '0']);
  assert.equal(read.status, 0, read.stderr);
  assert.deepEqual(JSON.parse(read.stdout).cloudSessions, ['cloud:cloud-empty']);
  assert.match(JSON.parse(read.stdout).cloudTurnsSql, /t.session_id IN \('cloud-empty'\)/);
});

test('missing or deleted since-file paths report E_USAGE before consulting a tracked commit', (t) => {
  const f = fixture(t, false);
  const mode = join(f.repoRoot, 'mode.agent.md');
  writeFileSync(mode, 'Keep replies short.\n');
  for (const args of [
    ['init'], ['add', 'mode.agent.md'],
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Track a mode'],
  ]) {
    const result = spawnSync('git', ['-C', f.repoRoot, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  rmSync(mode);
  for (const file of [mode, join(f.root, 'missing'), f.repoRoot]) {
    const out = join(f.root, 'refused');
    const result = run(f, ['plan', '--repo', 'acme/app', '--since-file', file, '--now', now, '--out', out]);
    assert.equal(result.status, 2, result.stderr);
    assert.deepEqual(JSON.parse(result.stderr), { code: 'E_USAGE', message: '--since-file must name an existing file.' });
    assert.equal(existsSync(out), false);
  }
});

test('clustered sessions split at session quantiles and still tile the complete window', (t) => {
  const f = fixture(t, false);
  for (let index = 0; index < 6; index += 1) {
    log(f, `cluster-${index}`, 'acme/app', `2026-11-02T12:0${index}:00Z`, messages(`Preference ${index}.`));
  }
  const result = plan(f);
  assert.deepEqual(result.value.slices.map((slice) => [slice.since, slice.until, slice.sessions.map((session) => session.id)]), [
    [since, '2026-11-02T12:02:00.000Z', ['local:cluster-0', 'local:cluster-1']],
    ['2026-11-02T12:02:00.000Z', '2026-11-02T12:04:00.000Z', ['local:cluster-2', 'local:cluster-3']],
    ['2026-11-02T12:04:00.000Z', now, ['local:cluster-4', 'local:cluster-5']],
  ]);
  assert.equal(result.value.ownerReport.counts.populatedSlices, 3);
  assert.equal(result.value.publishableSummary.counts.populatedSlices, 3);
  const two = plan(f, ['--per-slice', '1', '--slices', '2']);
  assert.deepEqual(two.value.slices.map((slice) => slice.sessions.map((session) => session.id)), [['local:cluster-0'], ['local:cluster-5']]);
  assert.equal(two.value.ownerReport.counts.populatedSlices, 2);
});

test('rank sampling excludes empty sessions first and deduplicates openers only in the selected corpus', (t) => {
  const f = fixture(t, false);
  log(f, 'empty-first', 'acme/app', '2026-11-01T12:00:00Z', []);
  log(f, 'first', 'acme/app', '2026-11-02T12:00:00Z', messages('First preference.'));
  const unselected = log(f, 'unselected', 'acme/app', '2026-11-03T12:00:00Z', messages('A shared opener.'));
  writeFileSync(unselected, `${readFileSync(unselected, 'utf8')}{malformed\n`);
  log(f, 'middle', 'acme/app', '2026-11-04T12:00:00Z', [...messages('A shared opener.'), ...messages('Keep the follow-up.')]);
  log(f, 'next', 'acme/app', '2026-11-20T12:00:00Z', messages('Next preference.'));
  log(f, 'last', 'acme/app', '2026-11-26T12:00:00Z', messages('Last preference.'));
  log(f, 'empty-last', 'acme/app', '2026-11-27T12:00:00Z', []);
  const result = plan(f, ['--slices', '3', '--per-slice', '1']);
  assert.deepEqual(sessionIds(result.value), ['local:first', 'local:middle', 'local:last']);
  assert.equal(result.value.ownerReport.counts.sampledOut, 2);
  assert.equal(result.value.ownerReport.skipped.noTypedTurns, 2);
  assert.equal(result.value.ownerReport.counts.strippedOpeners, 0);
  assert.equal(result.value.ownerReport.skipped.repeatedOpener, 0);
  assert.equal(result.value.ownerReport.counts.malformedEvents, 0);
  assert.equal(result.value.slices[0].sessions.find((session) => session.id === 'local:middle').userTurns, 2);
});

test('one populated slice is disclosed even when sessions share the same timestamp', (t) => {
  const f = fixture(t, false);
  log(f, 'first', 'acme/app', '2026-11-02T12:00:00Z', messages('First preference.'));
  const one = plan(f);
  assert.equal(one.value.ownerReport.counts.populatedSlices, 1);
  assert.equal(one.value.publishableSummary.disclosures.includes('Fewer than two slices contain selected sessions. Mined preferences cannot meet the cross-slice evidence threshold.'), true);
  log(f, 'second', 'acme/app', '2026-11-02T12:00:00Z', messages('Second preference.'));
  const sameTime = plan(f);
  assert.equal(sameTime.value.ownerReport.counts.populatedSlices, 1);
  assert.deepEqual(sessionIds(sameTime.value), ['local:first', 'local:second']);
  assert.equal(sameTime.value.slices.every((slice) => slice.since < slice.until), true);
  assert.equal(sameTime.value.slices[0].since, since);
  assert.equal(sameTime.value.slices.at(-1).until, now);
});

test('adding unrelated metadata cannot change repo publishable counts, dates, or disclosures', (t) => {
  const f = fixture(t, false);
  log(f, 'allowed', 'acme/app', '2026-11-02T12:00:00Z', messages('Keep replies short.'));
  const before = plan(f);
  log(f, 'outside', 'other/secret', '2026-11-03T12:00:00Z', messages('Private preference.'), { summary: privateSummary });
  log(f, 'old-outside', 'other/secret', '2026-10-03T12:00:00Z', messages('Private old preference.'));
  log(f, 'unsupported-outside', 'other/secret', 'bad-date', messages('Private metadata.'));
  indexed(f, 'indexed-outside', 'other/secret', '2026-11-27T12:00:00Z', [['Private text.']], { name: privateSummary });
  indexed(f, 'unsupported-index', 'other/secret', 'bad-date', [['Private metadata.']]);
  const cloud = cloudFile(f, [
    { id: 'outside-cloud', repository: 'other/secret', created_at: '2026-11-04T12:00:00Z', turn_count: 0 },
    { id: 'old-cloud', repository: 'other/secret', created_at: '2026-10-04T12:00:00Z', turn_count: 1 },
    { id: 'unsupported-cloud', repository: 'other/secret', created_at: 'bad-date' },
    { id: 'local-supplement', repository: 'other/secret', created_at: '2026-11-05T12:00:00Z', _query_source: 'local' },
  ]);
  const after = plan(f, ['--cloud-sessions', cloud, '--cloud-status', 'skipped']);
  assert.deepEqual(after.value.publishableSummary, before.value.publishableSummary);
  assert.equal(after.value.ownerReport.skipped.outsideScope, 6);
  assert.deepEqual(sessionIds(after.value), ['local:allowed']);
});

test('all YAML block scalar indicators stay out of mirror titles without discarding sessions', (t) => {
  const f = fixture(t, false);
  const rows = [];
  for (const [index, indicator] of ['|', '|-', '|+', '>', '>-', '>+'].entries()) {
    const id = `block-${index}`;
    const created_at = `2026-11-0${index + 2}T12:00:00Z`;
    log(f, id, 'acme/app', created_at, messages(`Preference ${index}.`));
    writeFileSync(join(f.home, 'session-state', id, 'workspace.yaml'), [
      'repository: acme/app', 'host_type: github', `created_at: ${created_at}`,
      `summary: ${indicator}`, '  Private multiline summary.',
      `name: ${indicator}`, '  Private multiline name.',
    ].join('\n'));
    rows.push({ id: `remote-${index}`, repository: 'acme/app', created_at, summary: indicator, turn_count: 1 });
  }
  const result = plan(f, ['--cloud-sessions', cloudFile(f, rows)]);
  assert.equal(result.value.ownerReport.counts.mirrors, 0);
  assert.equal(result.value.ownerReport.counts.selected, 12);
  assert.equal(result.value.ownerReport.skipped.unsupported, 0);
  assert.deepEqual(new Set(sessionIds(result.value)), new Set([
    'local:block-0', 'local:block-1', 'local:block-2', 'local:block-3', 'local:block-4', 'local:block-5',
    'cloud:remote-0', 'cloud:remote-1', 'cloud:remote-2', 'cloud:remote-3', 'cloud:remote-4', 'cloud:remote-5',
  ]));
});

test('the slice reader keeps full human turns and caps only assistant replies', (t) => {
  const f = fixture(t, false);
  const user = `Keep all of this human request. ${'human words '.repeat(60)}`;
  log(f, 'long-turn', 'acme/app', '2026-11-02T12:00:00Z', messages(user, 'a'.repeat(500)));
  const result = plan(f);
  const read = run(f, ['read', '--plan', result.file, '--slice', '0']);
  assert.equal(read.status, 0, read.stderr);
  assert.equal(read.stdout, `=== local:long-turn | acme/app | 2026-11-02T12:00:00.000Z | local-log | 1 human turns\n[1] user: ${user}\n[1] reply: ${'a'.repeat(400)}\n`);
});

test('scoped source dates retain each source timestamp after native local records merge', (t) => {
  const f = fixture(t, false);
  log(f, 'shared-id', 'acme/app', '2026-11-02T12:00:00Z', messages('Keep source dates accurate.'));
  indexed(f, 'shared-id', 'acme/app', '2026-11-03T12:00:00Z', [['An indexed mirror.']]);
  const result = plan(f);
  assert.deepEqual(sessionIds(result.value), ['local:shared-id']);
  assert.deepEqual(result.value.ownerReport.sources.slice(0, 2).map(({ oldest, newest }) => [oldest, newest]), [
    ['2026-11-02T12:00:00.000Z', '2026-11-02T12:00:00.000Z'],
    ['2026-11-03T12:00:00.000Z', '2026-11-03T12:00:00.000Z'],
  ]);
});
