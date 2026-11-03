import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { REQUIRED_BINDINGS } from './check-context-routing.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const watchScript = join(root, 'skills', 'double', 'scripts', 'double_watch.py');

function runPy(code, env = {}) {
  return execFileSync('python', ['-c', code], {
    cwd: root,
    env: { ...process.env, COPILOT_HOME: '', ...env },
    encoding: 'utf8',
  });
}

function runWatcher(code, env = {}) {
  return runPy(`
import importlib.util, json, os, pathlib
spec = importlib.util.spec_from_file_location("dw", ${JSON.stringify(watchScript)})
dw = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dw)
${code}
`, env);
}

function writeEvents(sessionDir, events) {
  writeFileSync(join(sessionDir, 'events.jsonl'), `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
}

const auditHeader = 'ts\tevent_range\ttrigger\tverdict\tclaim\tevidence_pointer\tobserved_fact\n';
const auditRow = (range, verdict = 'VERIFIED', claim = 'claim') => `2026-11-02T00:00:00Z\t${range}\tT1_HUMAN_GATE\t${verdict}\t${claim}\tartifact\tobserved\n`;

test('extract_files parses apply_patch headers and preserves edit/create path when content contains File:', () => {
  const out = runPy(`
import importlib.util, json
spec = importlib.util.spec_from_file_location("dw", ${JSON.stringify(watchScript)})
dw = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dw)

patch_arg = "*** Begin Patch\\n*** Update File: src/app.py\\n@@\\n+# File: comment inside hunk\\n+print('ok')\\n*** Add File: tests/test_app.py\\n+assert True\\n*** End Patch\\n"
edit_arg = {"path": "skills/double/scripts/double_watch.py", "old_str": "a\\nFile: fake.py\\nb", "new_str": "c"}
create_arg = {"path": "docs/note.md", "file_text": "Header\\nFile: another_fake.md\\nBody"}

print(json.dumps({
  "patch": dw.extract_files(patch_arg),
  "edit": dw.extract_files(edit_arg),
  "create": dw.extract_files(create_arg),
}))
`);
  assert.deepEqual(JSON.parse(out), {
    patch: ['src/app.py', 'tests/test_app.py'],
    edit: ['skills/double/scripts/double_watch.py'],
    create: ['docs/note.md'],
  });
});

test('extract_range_context captures failed tool error.message and handles explicit null result', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'double-ctx-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lines = [
    JSON.stringify({ type: 'session.start', data: { sessionId: 'sess-1' } }),
    JSON.stringify({
      type: 'tool.execution_complete',
      data: {
        toolCallId: 'call_fail',
        success: false,
        error: { message: 'Error: Failed to find expected lines in src/app.py', code: 'failure' },
      },
    }),
    JSON.stringify({
      type: 'tool.execution_complete',
      data: {
        toolCallId: 'call_null',
        success: false,
        result: null,
        error: { message: 'Null result failure' },
      },
    }),
  ];
  const out = runPy(`
import importlib.util, json, pathlib
spec = importlib.util.spec_from_file_location("dw", ${JSON.stringify(watchScript)})
dw = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dw)
lines = ${JSON.stringify(lines)}
ctx = dw.extract_range_context(pathlib.Path(${JSON.stringify(dir)}), lines, 0, 0, len(lines) - 1)
print(json.dumps(ctx["range_events"]))
`);
  assert.deepEqual(JSON.parse(out), [
    {
      event: 1,
      type: 'tool.execution_complete',
      success: false,
      output_truncated: false,
      output_total_chars: 50,
      output_preview: 'Error: Failed to find expected lines in src/app.py',
    },
    {
      event: 2,
      type: 'tool.execution_complete',
      success: false,
      output_truncated: false,
      output_total_chars: 19,
      output_preview: 'Null result failure',
    },
  ]);
});

test('scan_events bundles tool.execution_start shell redirections and tool.execution_complete outputs with their triggering assistant.message', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'double-turn-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sessionDir = join(dir, 'worker-1');
  mkdirSync(sessionDir, { recursive: true });
  const events = [
    { type: 'session.start', data: { sessionId: 'worker-1' } },
    {
      type: 'assistant.message',
      data: {
        content: 'All tests passed and output was written.',
        toolRequests: [{ toolCallId: 'call_1', name: 'powershell', arguments: { command: 'pytest > test_out.txt' } }],
      },
    },
    {
      type: 'tool.execution_start',
      data: {
        toolCallId: 'call_1',
        toolName: 'powershell',
        arguments: { command: 'pytest > test_out.txt' },
        shellToolInfo: { hasWriteFileRedirection: true, possiblePaths: ['test_out.txt'] },
      },
    },
    {
      type: 'tool.execution_complete',
      data: {
        toolCallId: 'call_1',
        success: true,
        result: { content: '12 passed in 0.4s' },
      },
    },
  ];
  writeFileSync(join(sessionDir, 'events.jsonl'), `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
  const outDir = join(dir, 'out');
  mkdirSync(outDir, { recursive: true });
  const out = runPy(`
import importlib.util, json, pathlib
spec = importlib.util.spec_from_file_location("dw", ${JSON.stringify(watchScript)})
dw = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dw)
dw.poll_once(pathlib.Path(${JSON.stringify(sessionDir)}), pathlib.Path(${JSON.stringify(outDir)}))
print((pathlib.Path(${JSON.stringify(outDir)}) / "double-wake-bundle.json").read_text(encoding="utf-8"))
`);
  const bundle = JSON.parse(out);
  assert.equal(bundle.length, 1);
  assert.deepEqual(bundle[0].event_range, [0, 3]);
  assert.deepEqual(bundle[0].touched_files, ['test_out.txt']);
  assert.equal(bundle[0].range_events.length, 2);
  assert.equal(bundle[0].range_events[1].output_preview, '12 passed in 0.4s');
});

test('scan_events holds in-flight tool turns until completion, fires ask_user at tool.execution_start, and ignores Double wake send_session_message in is_gate', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'double-inflight-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sessionDir = join(dir, 'worker-2');
  const outDir = join(dir, 'out');
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });

  const initialEvents = [
    { type: 'session.start', data: { sessionId: 'worker-2' } },
    {
      type: 'assistant.message',
      data: {
        content: '',
        reasoningText: 'The failure must be caused by a stale cache entry.',
        toolRequests: [{ toolCallId: 'c_run', name: 'powershell', arguments: { command: 'npm test' } }],
      },
    },
    {
      type: 'tool.execution_start',
      data: { toolCallId: 'c_run', toolName: 'powershell', arguments: { command: 'npm test' } },
    },
  ];
  writeFileSync(join(sessionDir, 'events.jsonl'), `${initialEvents.map((e) => JSON.stringify(e)).join('\n')}\n`);

  const firstPoll = runPy(`
import importlib.util, json, pathlib
spec = importlib.util.spec_from_file_location("dw", ${JSON.stringify(watchScript)})
dw = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dw)
wakes = dw.poll_once(pathlib.Path(${JSON.stringify(sessionDir)}), pathlib.Path(${JSON.stringify(outDir)}))
print(json.dumps(wakes))
`);
  assert.deepEqual(JSON.parse(firstPoll), []);

  const completedEvents = [
    ...initialEvents,
    {
      type: 'tool.execution_complete',
      data: { toolCallId: 'c_run', success: true, result: { content: 'PASS' } },
    },
    {
      type: 'assistant.message',
      data: {
        content: 'Here is the final answer.',
        toolRequests: [
          {
            toolCallId: 'c_wake',
            name: 'send_session_message',
            arguments: {
              session_id: 'double-child-1',
              delivery_mode: 'immediate',
              message: 'Parent session active; run python double_watch.py worker-2 --wait.',
            },
          },
        ],
      },
    },
    {
      type: 'tool.execution_start',
      data: { toolCallId: 'c_wake', toolName: 'send_session_message' },
    },
    {
      type: 'tool.execution_complete',
      data: { toolCallId: 'c_wake', success: true, result: { content: 'accepted' } },
    },
    {
      type: 'assistant.message',
      data: {
        content: 'Which option should we pick?',
        toolRequests: [{ toolCallId: 'c_ask', name: 'ask_user', arguments: { question: 'Pick A or B?' } }],
      },
    },
    {
      type: 'tool.execution_start',
      data: { toolCallId: 'c_ask', toolName: 'ask_user', arguments: { question: 'Pick A or B?' } },
    },
  ];
  writeFileSync(join(sessionDir, 'events.jsonl'), `${completedEvents.map((e) => JSON.stringify(e)).join('\n')}\n`);

  const secondPoll = runPy(`
import importlib.util, json, pathlib
spec = importlib.util.spec_from_file_location("dw", ${JSON.stringify(watchScript)})
dw = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dw)
wakes = dw.poll_once(pathlib.Path(${JSON.stringify(sessionDir)}), pathlib.Path(${JSON.stringify(outDir)}))
print(json.dumps([{"trigger": w["trigger"], "range": w["event_range"]} for w in wakes]))
`);
  assert.deepEqual(JSON.parse(secondPoll), [
    { trigger: 'T2_MIDRUN_CLAIM', range: [0, 3] },
    { trigger: 'T1_HUMAN_GATE', range: [4, 6] },
    { trigger: 'T1_HUMAN_GATE', range: [7, 8] },
  ]);

  const thirdPoll = runPy(`
import importlib.util, json, pathlib
spec = importlib.util.spec_from_file_location("dw", ${JSON.stringify(watchScript)})
dw = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dw)
wakes = dw.poll_once(pathlib.Path(${JSON.stringify(sessionDir)}), pathlib.Path(${JSON.stringify(outDir)}))
bundle_exists = (pathlib.Path(${JSON.stringify(outDir)}) / "double-wake-bundle.json").exists()
cursor = json.loads((pathlib.Path(${JSON.stringify(outDir)}) / "double-cursor.json").read_text(encoding="utf-8"))
print(json.dumps({"wakes": len(wakes), "bundle_exists": bundle_exists, "worker_sid": cursor.get("worker_session_id")}))
`);
  assert.deepEqual(JSON.parse(thirdPoll), {
    wakes: 3,
    bundle_exists: true,
    worker_sid: 'worker-2',
  });
  const pending = JSON.parse(readFileSync(join(outDir, 'double-cursor.json'), 'utf8')).pending_wakes;
  assert.deepEqual(pending.map(({ event_range, delivered_audit_rows }) => ({ event_range, delivered_audit_rows })), [
    { event_range: [0, 3], delivered_audit_rows: 0 },
    { event_range: [4, 6], delivered_audit_rows: 0 },
    { event_range: [7, 8], delivered_audit_rows: 0 },
  ]);

  const ledger = join(outDir, 'double-audit.tsv');
  const partialAudit = auditHeader + auditRow('[0, 3]') + auditRow('4-6');
  writeFileSync(ledger, partialAudit);
  const partial = JSON.parse(runWatcher(`
wakes = dw.poll_once(pathlib.Path(${JSON.stringify(sessionDir)}), pathlib.Path(${JSON.stringify(outDir)}))
print(json.dumps([w["event_range"] for w in wakes]))
`));
  assert.deepEqual(partial, [[7, 8]]);
  assert.deepEqual(JSON.parse(readFileSync(join(outDir, 'double-wake-bundle.json'), 'utf8')).map((w) => w.event_range), [[7, 8]]);
  assert.equal(readFileSync(ledger, 'utf8'), partialAudit);

  appendFileSync(ledger, auditRow('7..8'));
  const fullyAudited = readFileSync(ledger, 'utf8');
  const acknowledged = JSON.parse(runWatcher(`
print(json.dumps(dw.poll_once(pathlib.Path(${JSON.stringify(sessionDir)}), pathlib.Path(${JSON.stringify(outDir)}))))
`));
  assert.deepEqual(acknowledged, []);
  assert.equal(existsSync(join(outDir, 'double-wake-bundle.json')), false);
  assert.deepEqual(JSON.parse(readFileSync(join(outDir, 'double-cursor.json'), 'utf8')).pending_wakes, []);
  assert.equal(readFileSync(ledger, 'utf8'), fullyAudited);
});

test('replay writes double-wake-bundle.json and wait_for_wake handles missing events.jsonl without crashing', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'double-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const stateRoot = join(home, '.copilot', 'session-state');
  const sessionDir = join(stateRoot, 'worker-replay');
  const emptyDir = join(stateRoot, 'worker-empty');
  const outDir = join(home, 'out');
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(emptyDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });

  const events = [
    { type: 'session.start', data: { sessionId: 'worker-replay' } },
    { type: 'assistant.message', data: { content: 'Verified fix works.', toolRequests: [] } },
  ];
  writeFileSync(join(sessionDir, 'events.jsonl'), `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);

  const replay = execFileSync('python', [watchScript, 'worker-replay', '--replay', '--out-dir', outDir], {
    env: { ...process.env, COPILOT_HOME: '', USERPROFILE: home, HOME: home },
    encoding: 'utf8',
  });
  const bundlePath = join(outDir, 'double-wake-bundle.json');
  assert.equal(existsSync(bundlePath), true);
  const bundle = JSON.parse(readFileSync(bundlePath, 'utf8'));
  assert.equal(bundle.length, 1);
  assert.equal(bundle[0].trigger, 'T1_HUMAN_GATE');
  assert.equal(Array.isArray(bundle[0].range_events), true);
  assert.equal(existsSync(join(outDir, 'double-lifecycle.json')), false);
  const [summary, ...replayedWakes] = replay.trim().split(/\r?\n/);
  assert.equal(summary, 'Session worker-replay (own_start=0, total=2 events) -> 1 wakes');
  assert.deepEqual(replayedWakes.map((line) => JSON.parse(line)), bundle);
  const cursor = JSON.parse(readFileSync(join(outDir, 'double-cursor.json'), 'utf8'));
  assert.equal(cursor.next_idx, events.length);
  assert.equal(cursor.last_wake_idx, events.length);
  assert.deepEqual(cursor.pending_wakes.map((wake) => wake.event_range), [[0, 1]]);

  writeFileSync(join(outDir, 'double-audit.tsv'), auditHeader + auditRow('[0, 1]'));
  const auditedReplay = execFileSync('python', [watchScript, 'worker-replay', '--replay', '--out-dir', outDir], {
    env: { ...process.env, COPILOT_HOME: '', USERPROFILE: home, HOME: home },
    encoding: 'utf8',
  });
  assert.equal(auditedReplay.trim(), 'Session worker-replay (own_start=0, total=2 events) -> 0 wakes');
  assert.deepEqual(JSON.parse(readFileSync(bundlePath, 'utf8')), []);
  const resumed = execFileSync('python', [watchScript, 'worker-replay', '--wait', '--out-dir', outDir, '--idle-exit-seconds', '0'], {
    env: { ...process.env, COPILOT_HOME: '', USERPROFILE: home, HOME: home },
    encoding: 'utf8',
  });
  assert.equal(JSON.parse(resumed.trim()).status, 'PARENT_INACTIVE');
  assert.deepEqual(JSON.parse(readFileSync(join(outDir, 'double-cursor.json'), 'utf8')).pending_wakes, []);
  assert.equal(existsSync(bundlePath), false);

  const waitOut = execFileSync('python', [watchScript, 'worker-empty', '--wait', '--out-dir', outDir, '--idle-exit-seconds', '0'], {
    env: { ...process.env, COPILOT_HOME: '', USERPROFILE: home, HOME: home },
    encoding: 'utf8',
  });
  assert.equal(JSON.parse(waitOut.trim()).status, 'PARENT_INACTIVE');
});

test('replay ignores the cursor, starts at the worker history, and flushes unfinished tools', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'double-replay-history-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const sessionDir = join(home, 'session-state', 'worker-history');
  const outDir = join(home, 'out');
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(outDir);
  const events = [
    { type: 'session.start', data: { sessionId: 'other-worker' } },
    { type: 'assistant.message', data: { content: 'Verified another worker.' } },
    { type: 'session.start', data: { sessionId: 'worker-history' } },
    { type: 'assistant.message', data: { content: 'Verified the old artifact.' } },
    ...Array.from({ length: 501 }, () => ({ type: 'session.info', data: {} })),
    { type: 'assistant.message', data: {
      content: 'Verified the unfinished output.',
      toolRequests: [{ name: 'powershell', toolCallId: 'unfinished' }],
    } },
  ];
  writeEvents(sessionDir, events);
  writeFileSync(join(outDir, 'double-cursor.json'), JSON.stringify({
    worker_session_id: 'worker-history', next_idx: events.length, last_wake_idx: events.length, pending_wakes: [],
  }));
  const replay = execFileSync('python', [watchScript, 'worker-history', '--replay', '--out-dir', outDir], {
    env: { ...process.env, COPILOT_HOME: home },
    encoding: 'utf8',
  }).trim().split(/\r?\n/);
  assert.equal(replay[0], 'Session worker-history (own_start=2, total=506 events) -> 2 wakes');
  const bundle = JSON.parse(readFileSync(join(outDir, 'double-wake-bundle.json'), 'utf8'));
  assert.deepEqual(replay.slice(1).map((line) => JSON.parse(line)), bundle);
  assert.deepEqual(bundle.map((wake) => ({ range: wake.event_range, claims: wake.claims })), [
    { range: [2, 3], claims: ['Verified the old artifact.'] },
    { range: [4, 505], claims: ['Verified the unfinished output.'] },
  ]);
  const cursor = JSON.parse(readFileSync(join(outDir, 'double-cursor.json'), 'utf8'));
  assert.equal(cursor.next_idx, events.length);
  assert.equal(cursor.last_wake_idx, events.length);
  assert.deepEqual(cursor.pending_wakes.map((wake) => wake.event_range), [[2, 3], [4, 505]]);
});

test('check_parent_state detects interrupted sessions in data.db and ignores string literals inside viewed files', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'double-state-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const copilotDir = join(home, '.copilot');
  const sessionDir = join(copilotDir, 'session-state', '1f1d0a3e-test');
  mkdirSync(sessionDir, { recursive: true });

  const db = new DatabaseSync(join(copilotDir, 'data.db'));
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, agent TEXT, is_running INTEGER, was_interrupted INTEGER, archived_at TEXT, created_at TEXT)');
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?)').run('1f1d0a3e-test', 'Crashed', 'poteto', 0, 1, null, '2026-10-31T00:00:00Z');
  db.close();

  const crashedLines = [
    JSON.stringify({ type: 'session.start', data: { sessionId: '1f1d0a3e-test' } }),
    JSON.stringify({ type: 'tool.execution_start', data: { toolCallId: 'c1', toolName: 'powershell' } }),
  ];
  const viewedWatchLines = [
    JSON.stringify({ type: 'session.start', data: { sessionId: 'viewed-test' } }),
    JSON.stringify({
      type: 'tool.execution_complete',
      data: {
        toolCallId: 'c2',
        success: true,
        result: { content: 'if "is still running after" in lines[b_idx] or "moved to background" in lines[b_idx]:' },
      },
    }),
    JSON.stringify({ type: 'hook.start', data: { hookType: 'agentStop' } }),
  ];
  const viewedDir = join(copilotDir, 'session-state', 'viewed-test');
  mkdirSync(viewedDir, { recursive: true });
  const evFile = join(viewedDir, 'events.jsonl');
  writeFileSync(evFile, `${viewedWatchLines.join('\n')}\n`);
  const past = new Date(Date.now() - 20_000);
  utimesSync(evFile, past, past);

  const out = runPy(`
import importlib.util, json, pathlib
spec = importlib.util.spec_from_file_location("dw", ${JSON.stringify(watchScript)})
dw = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dw)
crashed = dw.check_parent_state(pathlib.Path(${JSON.stringify(sessionDir)}), ${JSON.stringify(crashedLines)}, 10.0)
viewed = dw.check_parent_state(pathlib.Path(${JSON.stringify(viewedDir)}), ${JSON.stringify(viewedWatchLines)}, 10.0)
print(json.dumps({"crashed": crashed[0], "viewed": viewed[0]}))
`, { USERPROFILE: home, HOME: home });
  assert.deepEqual(JSON.parse(out), { crashed: false, viewed: false });
});

test('double bindings, skill kickoff contract, and documentation stay aligned', () => {
  assert.equal(REQUIRED_BINDINGS.includes('agents/double.agent.md'), true);
  assert.equal(REQUIRED_BINDINGS.includes('skills/double/SKILL.md'), true);

  const skillText = readFileSync(join(root, 'skills', 'double', 'SKILL.md'), 'utf8');
  assert.match(skillText, /--target create_session/);
  assert.match(skillText, /"context_tier":/);
  assert.match(skillText, /"mode":\s*"interactive"/);
  assert.match(skillText, /PSTACK_CONTEXT_V1/);
  assert.match(skillText, /"input":\s*\{/);
  assert.match(skillText, /double-supervised/);
  assert.match(skillText, /gpt-6\.1-sol \/ xhigh/);

  const agentText = readFileSync(join(root, 'agents', 'double.agent.md'), 'utf8');
  assert.match(agentText, /<worker_session_dir>\/files\//);
  assert.match(agentText, /<double_session_dir>\/files\/double-audit\.tsv/);

  const extText = readFileSync(join(root, 'extensions', 'double', 'extension.mjs'), 'utf8');
  assert.match(extText, /double-supervised/);
  assert.match(extText, /--out-dir/);

  const setupSkill = readFileSync(join(root, 'skills', 'setup-pstack', 'SKILL.md'), 'utf8');
  assert.match(setupSkill, /double verifier/);
  assert.match(setupSkill, /18-role model map/);

  const setupDoc = readFileSync(join(root, 'docs', 'guide', '01-setup.md'), 'utf8');
  assert.match(setupDoc, /double/);

  const syncDoc = readFileSync(join(root, 'docs', 'upstream-sync.md'), 'utf8');
  assert.match(syncDoc, /double\.agent\.md/);
});

test('poll_once resets scan state at last_wake_idx across incremental polls and ignores subagent turn_end events', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'double-cursor-replay-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sessionDir = join(dir, 'worker-cursor');
  const outDir = join(dir, 'out');
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });

  const poll1Events = [
    { type: 'session.start', data: { sessionId: 'worker-cursor' } },
    {
      type: 'assistant.message',
      data: {
        content: '',
        toolRequests: [{ toolCallId: 'c1', name: 'edit', arguments: { path: 'src/prod.py', old_str: 'a', new_str: 'b' } }],
      },
    },
    { type: 'tool.execution_complete', data: { toolCallId: 'c1', success: true, result: { content: 'ok' } } },
    {
      type: 'assistant.message',
      data: {
        content: '',
        toolRequests: [{ toolCallId: 'c2', name: 'sql', arguments: { query: "UPDATE todos SET status='done' WHERE id='t1'" } }],
      },
    },
    { type: 'tool.execution_complete', data: { toolCallId: 'c2', success: true, result: { content: 'ok' } } },
    {
      type: 'assistant.message',
      data: {
        content: '',
        toolRequests: [{ toolCallId: 'c3', name: 'edit', arguments: { path: 'tests/test_prod.py', old_str: 'x', new_str: 'y' } }],
      },
    },
    { type: 'tool.execution_complete', data: { toolCallId: 'c3', success: true, result: { content: 'ok' } } },
  ];
  writeFileSync(join(sessionDir, 'events.jsonl'), `${poll1Events.map((e) => JSON.stringify(e)).join('\n')}\n`);

  const first = runPy(`
import importlib.util, json, pathlib
spec = importlib.util.spec_from_file_location("dw", ${JSON.stringify(watchScript)})
dw = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dw)
print(json.dumps(dw.poll_once(pathlib.Path(${JSON.stringify(sessionDir)}), pathlib.Path(${JSON.stringify(outDir)}))))
`);
  assert.deepEqual(JSON.parse(first), []);

  const poll2Events = [
    ...poll1Events,
    {
      type: 'assistant.message',
      data: {
        content: 'Verified the fix works.',
        toolRequests: [{ toolCallId: 'c4', name: 'powershell', arguments: { command: 'pytest' } }],
      },
    },
    {
      type: 'assistant.turn_end',
      data: { turnId: '0', parentToolCallId: 'subagent_call_1' },
    },
  ];
  writeFileSync(join(sessionDir, 'events.jsonl'), `${poll2Events.map((e) => JSON.stringify(e)).join('\n')}\n`);

  const midSubagent = runPy(`
import importlib.util, json, pathlib
spec = importlib.util.spec_from_file_location("dw", ${JSON.stringify(watchScript)})
dw = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dw)
print(json.dumps(dw.poll_once(pathlib.Path(${JSON.stringify(sessionDir)}), pathlib.Path(${JSON.stringify(outDir)}))))
`);
  assert.deepEqual(JSON.parse(midSubagent), []);

  const poll3Events = [
    ...poll2Events,
    { type: 'tool.execution_complete', data: { toolCallId: 'c4', success: true, result: { content: '1 passed' } } },
  ];
  writeFileSync(join(sessionDir, 'events.jsonl'), `${poll3Events.map((e) => JSON.stringify(e)).join('\n')}\n`);

  const final = runPy(`
import importlib.util, json, pathlib
spec = importlib.util.spec_from_file_location("dw", ${JSON.stringify(watchScript)})
dw = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dw)
print(json.dumps(dw.poll_once(pathlib.Path(${JSON.stringify(sessionDir)}), pathlib.Path(${JSON.stringify(outDir)}))))
`);
  assert.deepEqual(JSON.parse(final), [
    {
      worker_session_id: 'worker-cursor',
      event_range: [0, 9],
      trigger: 'T2_MIDRUN_CLAIM',
      touched_files: ['src/prod.py', 'tests/test_prod.py'],
      trigger_detail: 'Verified the fix works.',
      delivered_audit_rows: 0,
    },
  ]);
});

test('wait_for_wake returns flushed final wake before PARENT_INACTIVE and honors COPILOT_HOME', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'double-copilot-home-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const customHome = join(base, 'custom-copilot');
  const sessionDir = join(customHome, 'session-state', 'worker-flush');
  const outDir = join(base, 'out');
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });
  const db = new DatabaseSync(join(customHome, 'data.db'));
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, is_running INTEGER, was_interrupted INTEGER, archived_at TEXT)');
  db.prepare('INSERT INTO sessions VALUES (?, 0, 1, NULL)').run('worker-flush');
  db.close();

  const events = [
    { type: 'session.start', data: { sessionId: 'worker-flush' } },
    {
      type: 'assistant.message',
      data: {
        content: 'Verified the output file matches.',
        toolRequests: [{ toolCallId: 'c_unfin', name: 'powershell', arguments: { command: 'echo ok' } }],
      },
    },
    { type: 'tool.execution_start', data: { toolCallId: 'c_unfin', toolName: 'powershell' } },
  ];
  writeFileSync(join(sessionDir, 'events.jsonl'), `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);

  const firstWait = execFileSync('python', [watchScript, 'worker-flush', '--wait', '--out-dir', outDir, '--idle-exit-seconds', '0'], {
    env: { ...process.env, COPILOT_HOME: customHome },
    encoding: 'utf8',
  });
  assert.doesNotMatch(firstWait, /PARENT_INACTIVE/);
  const bundle = JSON.parse(readFileSync(join(outDir, 'double-wake-bundle.json'), 'utf8'));
  assert.equal(bundle.length, 1);
  assert.deepEqual(bundle[0].event_range, [0, 2]);

  const secondWait = execFileSync('python', [watchScript, 'worker-flush', '--wait', '--out-dir', outDir, '--idle-exit-seconds', '0'], {
    env: { ...process.env, COPILOT_HOME: customHome },
    encoding: 'utf8',
  });
  assert.equal(secondWait.trim(), '');
  assert.deepEqual(JSON.parse(readFileSync(join(outDir, 'double-wake-bundle.json'), 'utf8')), bundle);
  const watching = JSON.parse(readFileSync(join(outDir, 'double-lifecycle.json'), 'utf8'));
  assert.deepEqual({
    phase: watching.phase, queued: watching.queued, monitors: watching.monitors,
    monitor_pid: watching.monitor_pid, wake_accepted: watching.wake_accepted,
  }, { phase: 'watching', queued: 0, monitors: 1, monitor_pid: null, wake_accepted: false });

  writeFileSync(join(outDir, 'double-audit.tsv'), auditHeader + auditRow('0-2'));
  const thirdWait = execFileSync('python', [watchScript, 'worker-flush', '--wait', '--out-dir', outDir, '--idle-exit-seconds', '0'], {
    env: { ...process.env, COPILOT_HOME: customHome },
    encoding: 'utf8',
  });
  assert.equal(JSON.parse(thirdWait.trim()).status, 'PARENT_INACTIVE');
  const idle = JSON.parse(readFileSync(join(outDir, 'double-lifecycle.json'), 'utf8'));
  assert.deepEqual({
    worker_session_id: idle.worker_session_id,
    phase: idle.phase,
    queued: idle.queued,
    monitors: idle.monitors,
    monitor_pid: idle.monitor_pid,
    worker_active: idle.worker_active,
    last_event_size: idle.last_event_size,
  }, {
    worker_session_id: 'worker-flush',
    phase: 'idle',
    queued: 0,
    monitors: 0,
    monitor_pid: null,
    worker_active: false,
    last_event_size: statSync(join(sessionDir, 'events.jsonl')).size,
  });
});

test('poll_once merges and acknowledges wakes without changing lifecycle ownership', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'double-pending-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const sessionDir = join(base, 'worker-pending');
  const outDir = join(base, 'out');
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(outDir);
  const statePath = join(outDir, 'double-lifecycle.json');
  const lifecycle = JSON.stringify({
    worker_session_id: 'worker-pending', double_session_id: 'double-pending',
    phase: 'watching', queued: 0, monitors: 1, monitor_pid: process.pid, wake_accepted: false,
  });
  writeFileSync(statePath, lifecycle);
  const events = [
    { type: 'session.start', data: { sessionId: 'worker-pending' } },
    { type: 'assistant.message', data: { content: 'Verified the first artifact.' } },
  ];
  writeEvents(sessionDir, events);
  const poll = () => JSON.parse(runWatcher(`
print(json.dumps(dw.poll_once(pathlib.Path(${JSON.stringify(sessionDir)}), pathlib.Path(${JSON.stringify(outDir)}))))
`));
  assert.deepEqual(poll().map((w) => w.event_range), [[0, 1]]);
  const db = new DatabaseSync(join(sessionDir, 'session.db'));
  db.exec('CREATE TABLE todos (id TEXT, title TEXT, status TEXT, updated_at TEXT)');
  db.prepare('INSERT INTO todos VALUES (?, ?, ?, ?)').run('pending-task', 'Audit the next artifact', 'in_progress', '2026-11-02');
  db.close();
  writeEvents(sessionDir, [...events, { type: 'assistant.message', data: { content: 'Verified the second artifact.' } }]);
  assert.deepEqual(poll().map((w) => w.event_range), [[0, 1], [2, 2]]);
  assert.deepEqual(poll().map((w) => w.event_range), [[0, 1], [2, 2]]);
  const bundle = JSON.parse(readFileSync(join(outDir, 'double-wake-bundle.json'), 'utf8'));
  assert.deepEqual(bundle.map((w) => w.active_todo_anchor), [
    { id: 'pending-task', title: 'Audit the next artifact', status: 'in_progress' },
    { id: 'pending-task', title: 'Audit the next artifact', status: 'in_progress' },
  ]);
  assert.equal(readFileSync(statePath, 'utf8'), lifecycle);
  writeFileSync(join(outDir, 'double-audit.tsv'), auditHeader + auditRow('0-1') + auditRow('2-2'));
  assert.deepEqual(poll(), []);
  assert.deepEqual(JSON.parse(readFileSync(join(outDir, 'double-cursor.json'), 'utf8')).pending_wakes, []);
  assert.equal(existsSync(join(outDir, 'double-wake-bundle.json')), false);
  assert.equal(readFileSync(statePath, 'utf8'), lifecycle);
  assert.equal(existsSync(join(outDir, 'double-lifecycle.lock')), false);
});

test('audit acknowledgment matches overlapping integer ranges and only falls back to new symbolic rows', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'double-audit-ranges-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const sessionDir = join(base, 'worker-ranges');
  mkdirSync(sessionDir);
  writeEvents(sessionDir, [
    { type: 'session.start', data: { sessionId: 'worker-ranges' } },
    { type: 'assistant.message', data: { content: 'Verified the artifact.' } },
  ]);
  const cases = [
    { range: '0-1', acknowledged: true },
    { range: '[0, 3]', acknowledged: true },
    { range: '1..3', acknowledged: true },
    { range: '1', acknowledged: true },
    { range: 'all', acknowledged: true },
    { range: '*', acknowledged: true },
    { range: '2-8', acknowledged: false },
    { range: '559', acknowledged: false },
    { range: 'W1', acknowledged: true },
    { range: 'W1', existing: true, acknowledged: false },
    { range: 'W1', old: '559', acknowledged: true },
    { range: 'W1', extra: '394-405', acknowledged: false },
    { range: '0-1', existing: true, acknowledged: true },
  ];
  for (const [index, entry] of cases.entries()) {
    const outDir = join(base, `out-${index}`);
    mkdirSync(outDir);
    const ledger = join(outDir, 'double-audit.tsv');
    writeFileSync(ledger, auditHeader + (entry.existing ? auditRow(entry.range) : '') + (entry.old ? auditRow(entry.old) : ''));
    const poll = () => JSON.parse(runWatcher(`
print(json.dumps(dw.poll_once(pathlib.Path(${JSON.stringify(sessionDir)}), pathlib.Path(${JSON.stringify(outDir)}))))
`));
    poll();
    if (!entry.existing) appendFileSync(ledger, auditRow(entry.range));
    if (entry.extra) appendFileSync(ledger, auditRow(entry.extra));
    const before = readFileSync(ledger, 'utf8');
    assert.deepEqual(poll().map((w) => w.event_range), entry.acknowledged ? [] : [[0, 1]], JSON.stringify(entry));
    assert.equal(readFileSync(ledger, 'utf8'), before);
    assert.equal(existsSync(join(outDir, 'double-wake-bundle.json')), !entry.acknowledged);
  }
});

for (const symbolic of ['all', '*']) {
  test(`a new ${symbolic} NOTE acknowledges delivered work but never future wakes or mixed numeric batches`, (t) => {
    const base = mkdtempSync(join(tmpdir(), 'double-symbolic-note-'));
    t.after(() => rmSync(base, { recursive: true, force: true }));
    const sessionDir = join(base, 'worker-symbolic');
    const outDir = join(base, 'out');
    mkdirSync(sessionDir);
    mkdirSync(outDir);
    const events = [
      { type: 'session.start', data: { sessionId: 'worker-symbolic' } },
      { type: 'assistant.message', data: { content: 'Verified the old artifact.' } },
    ];
    writeEvents(sessionDir, events);
    const poll = () => JSON.parse(runWatcher(`
print(json.dumps(dw.poll_once(pathlib.Path(${JSON.stringify(sessionDir)}), pathlib.Path(${JSON.stringify(outDir)}))))
`));
    assert.deepEqual(poll().map((w) => w.event_range), [[0, 1]]);
    const ledger = join(outDir, 'double-audit.tsv');
    writeFileSync(ledger, auditHeader + auditRow(symbolic, 'NOTE'));
    assert.deepEqual(poll(), []);
    writeEvents(sessionDir, [
      ...events,
      { type: 'user.message', data: { content: 'Check the next artifact.' } },
      { type: 'assistant.message', data: { content: 'Verified the new artifact.' } },
    ]);
    assert.deepEqual(poll().map((w) => ({ range: w.event_range, delivered: w.delivered_audit_rows })), [
      { range: [2, 3], delivered: 1 },
    ]);
    appendFileSync(ledger, auditRow('394-405') + auditRow(symbolic, 'NOTE'));
    assert.deepEqual(poll().map((w) => w.event_range), [[2, 3]]);
    assert.deepEqual(JSON.parse(readFileSync(join(outDir, 'double-cursor.json'), 'utf8')).pending_wakes.map((w) => w.event_range), [[2, 3]]);
    appendFileSync(ledger, auditRow('2-3'));
    assert.deepEqual(poll(), []);
  });
}

test('numeric NOTE rows do not acknowledge a factual claim', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'double-numeric-note-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const sessionDir = join(base, 'worker-note');
  const outDir = join(base, 'out');
  mkdirSync(sessionDir);
  mkdirSync(outDir);
  writeEvents(sessionDir, [
    { type: 'session.start', data: { sessionId: 'worker-note' } },
    { type: 'assistant.message', data: { content: 'Verified the artifact.' } },
  ]);
  const poll = () => JSON.parse(runWatcher(`
print(json.dumps(dw.poll_once(pathlib.Path(${JSON.stringify(sessionDir)}), pathlib.Path(${JSON.stringify(outDir)}))))
`));
  assert.deepEqual(poll().map((w) => w.event_range), [[0, 1]]);
  const ledger = join(outDir, 'double-audit.tsv');
  writeFileSync(ledger, auditHeader + auditRow('0-1', ' note '));
  assert.deepEqual(poll().map((w) => w.event_range), [[0, 1]]);
  appendFileSync(ledger, auditRow('0-1'));
  assert.deepEqual(poll(), []);
});

test('a partial multi-claim audit survives repeated polls and idle waits without replacing the markdown', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'double-multi-claim-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const sessionDir = join(home, 'session-state', 'worker-claims');
  const outDir = join(home, 'out');
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(outDir);
  writeEvents(sessionDir, [
    { type: 'session.start', data: { sessionId: 'worker-claims' } },
    { type: 'assistant.message', data: { content: 'Verified artifact A. Verified artifact B.' } },
    { type: 'session.shutdown', data: {} },
  ]);
  const poll = () => JSON.parse(runWatcher(`
print(json.dumps(dw.poll_once(pathlib.Path(${JSON.stringify(sessionDir)}), pathlib.Path(${JSON.stringify(outDir)}))))
`));
  assert.deepEqual(poll().map((w) => w.event_range), [[0, 1]]);
  const markdown = join(outDir, 'double-audit.md');
  writeFileSync(markdown, 'The previous complete audit.\n');
  const past = new Date(Date.now() - 20_000);
  utimesSync(markdown, past, past);
  const ledger = join(outDir, 'double-audit.tsv');
  writeFileSync(ledger, auditHeader + auditRow('0-1', 'VERIFIED', 'Artifact A'));
  for (let pollIndex = 0; pollIndex < 2; pollIndex += 1) {
    assert.deepEqual(poll().map((w) => w.event_range), [[0, 1]]);
    assert.equal(readFileSync(markdown, 'utf8'), 'The previous complete audit.\n');
  }
  const wait = () => execFileSync('python', [watchScript, 'worker-claims', '--wait', '--out-dir', outDir, '--idle-exit-seconds', '0'], {
    env: { ...process.env, COPILOT_HOME: home },
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(wait(), '');
  const bundle = JSON.parse(readFileSync(join(outDir, 'double-wake-bundle.json'), 'utf8'));
  assert.deepEqual(bundle.map((w) => ({ claims: w.claims, claim_count: w.claim_count })), [
    { claims: ['Verified artifact A.', 'Verified artifact B.'], claim_count: 2 },
  ]);
  appendFileSync(ledger, auditRow('0-1', 'VERIFIED', 'Artifact B'));
  const completedLedger = readFileSync(ledger, 'utf8');
  assert.deepEqual(poll(), []);
  assert.equal(existsSync(join(outDir, 'double-wake-bundle.json')), false);
  assert.deepEqual(JSON.parse(readFileSync(join(outDir, 'double-cursor.json'), 'utf8')).pending_wakes, []);
  assert.match(readFileSync(markdown, 'utf8'), /\| Artifact A \|/);
  assert.match(readFileSync(markdown, 'utf8'), /\| Artifact B \|/);
  assert.equal(JSON.parse(wait().trim()).status, 'PARENT_INACTIVE');
  assert.equal(readFileSync(ledger, 'utf8'), completedLedger);
});

test('wake bundles list top-level prose claims, fall back to reasoning, and require one row for claim-free gates', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'double-claim-context-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const sessionDir = join(base, 'worker-context');
  const outDir = join(base, 'out');
  mkdirSync(sessionDir);
  mkdirSync(outDir);
  writeEvents(sessionDir, [
    { type: 'session.start', data: { sessionId: 'worker-context' } },
    { type: 'assistant.message', data: {
      content: 'Verified artifact A. All tests passed!\n```text\nVerified code example.\n```\nThe output matched.',
      reasoningText: 'Verified an omitted reasoning claim.',
    } },
    { type: 'assistant.message', data: { parentToolCallId: 'child', content: 'Verified a child claim.' } },
    { type: 'assistant.message', data: {
      content: 'Continuing.\n```text\nVerified another code example.\n```',
      reasoningText: 'The root cause is stale state.\n```text\nVerified a reasoning code example.\n```\nConfirmed the recovery.',
    } },
    { type: 'assistant.message', data: { content: 'Which option do you prefer?' } },
  ]);
  runWatcher(`dw.poll_once(pathlib.Path(${JSON.stringify(sessionDir)}), pathlib.Path(${JSON.stringify(outDir)}))`);
  const bundle = JSON.parse(readFileSync(join(outDir, 'double-wake-bundle.json'), 'utf8'));
  assert.deepEqual(bundle.map((w) => ({ range: w.event_range, claims: w.claims, count: w.claim_count })), [
    { range: [0, 1], claims: ['Verified artifact A.', 'All tests passed!', 'The output matched.'], count: 3 },
    { range: [2, 3], claims: ['The root cause is stale state.', 'Confirmed the recovery.'], count: 2 },
    { range: [4, 4], claims: [], count: 1 },
  ]);
});

test('symbolic fallback requires one new audit row per extracted claim', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'double-symbolic-claims-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const sessionDir = join(base, 'worker-symbolic-claims');
  const outDir = join(base, 'out');
  mkdirSync(sessionDir);
  mkdirSync(outDir);
  writeEvents(sessionDir, [
    { type: 'assistant.message', data: { content: 'Verified artifact A. Verified artifact B.' } },
  ]);
  const poll = () => JSON.parse(runWatcher(`
print(json.dumps(dw.poll_once(pathlib.Path(${JSON.stringify(sessionDir)}), pathlib.Path(${JSON.stringify(outDir)}))))
`));
  assert.deepEqual(poll().map((w) => w.event_range), [[0, 0]]);
  const ledger = join(outDir, 'double-audit.tsv');
  writeFileSync(ledger, auditHeader + auditRow('all', 'NOTE'));
  assert.deepEqual(poll().map((w) => w.event_range), [[0, 0]]);
  appendFileSync(ledger, auditRow('W1'));
  assert.deepEqual(poll(), []);
});

test('session prefixes must be unambiguous and exact directories take precedence', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'double-prefix-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const stateRoot = join(home, 'session-state');
  for (const name of ['worker-beta', 'worker-alpha-longer', 'worker-alpha']) {
    mkdirSync(join(stateRoot, name), { recursive: true });
  }
  writeFileSync(join(stateRoot, 'worker-file'), '');
  const run = (id) => spawnSync('python', [watchScript, id, '--replay', '--out-dir', join(home, 'out')], {
    env: { ...process.env, COPILOT_HOME: home },
    encoding: 'utf8',
  });
  const ambiguous = run('worker-');
  assert.equal(ambiguous.status, 1);
  assert.equal(ambiguous.stderr.trim(), "Ambiguous session prefix 'worker-' matches 3 sessions: worker-alpha, worker-alpha-longer, worker-beta");
  assert.equal(run('worker-alpha').status, 0);
  assert.match(run('worker-b').stdout, /Session worker-beta /);
  const missing = run('missing');
  assert.equal(missing.status, 1);
  assert.equal(missing.stderr.trim(), 'No session matching missing');
});

test('watcher ignores conversational must-be phrases and shell words but preserves causal claims and file paths', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'double-signal-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const sessionDir = join(base, 'worker-signal');
  mkdirSync(sessionDir);
  const phrases = [
    'I must be mindful.',
    'We must be careful.',
    'The agent must be cautious.',
    'They must be sure about the next step.',
    'They must be able to proceed.',
    'The problem must be a stale cache.',
    'The failure must be caused by a stale cache.',
    'The root cause must be a stale cache.',
  ];
  const out = runWatcher(`
session_dir = pathlib.Path(${JSON.stringify(sessionDir)})
phrases = ${JSON.stringify(phrases)}
counts = []
for phrase in phrases:
    events = [
        {"type": "assistant.message", "data": {"reasoningText": phrase, "toolRequests": [{"name": "powershell", "toolCallId": "c1"}]}},
        {"type": "tool.execution_complete", "data": {"toolCallId": "c1", "success": True}},
    ]
    counts.append(len(dw.scan_events(session_dir, lines=[json.dumps(e) for e in events])[0]))
events = [
    {"type": "assistant.message", "data": {"content": "Verified output.", "toolRequests": [{"name": "powershell", "toolCallId": "c1"}]}},
    {"type": "tool.execution_start", "data": {"shellToolInfo": {"hasWriteFileRedirection": True, "possiblePaths": ${JSON.stringify(['status', 'push', 'throw', '$env:GH_TOKEN', 'Directory', 'no doublexmax token', 'test_out.txt', 'src/app.py', 'skills\\double\\SKILL.md', 'logs/output', '$env:TEMP/out.txt', 'not a path.txt'])}}}},
    {"type": "tool.execution_complete", "data": {"toolCallId": "c1", "success": True}},
]
wakes = dw.scan_events(session_dir, lines=[json.dumps(e) for e in events])[0]
print(json.dumps({"counts": counts, "paths": wakes[0]["touched_files"]}))
`);
  assert.deepEqual(JSON.parse(out), {
    counts: [0, 0, 0, 0, 0, 1, 1, 1],
    paths: ['test_out.txt', 'src/app.py', 'skills\\double\\SKILL.md', 'logs/output'],
  });
});

test('redirected paths preserve spaces while rejecting shell syntax and URLs', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'double-spaced-paths-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const paths = [
    'C:\\work tree\\test results\\assertions.xml', '/tmp/test results/assertions.xml', 'logs with spaces/output',
    'result.xml', 'not a path.txt', 'status', 'https://example.com/result.xml', 'http://example.com/result.xml',
    '$env:TEMP/result.xml', 'logs/*.xml', 'logs/"result.xml"', "logs/'result.xml'", 'logs/<result.xml',
    'logs/>result.xml', 'logs/|result.xml', 'logs/\rresult.xml', 'logs/\nresult.xml', 'logs/\tresult.xml',
  ];
  writeEvents(base, [
    { type: 'assistant.message', data: {
      content: 'Verified the test output.',
      toolRequests: [{ name: 'powershell', toolCallId: 'write' }],
    } },
    { type: 'tool.execution_start', data: {
      toolCallId: 'write',
      shellToolInfo: { hasWriteFileRedirection: true, possiblePaths: paths },
    } },
    { type: 'tool.execution_complete', data: { toolCallId: 'write', success: true } },
  ]);
  const wakes = JSON.parse(runWatcher(`
print(json.dumps(dw.scan_events(pathlib.Path(${JSON.stringify(base)}))[0]))
`));
  assert.deepEqual(wakes.map((w) => w.touched_files), [paths.slice(0, 4)]);
});

test('redirected verification paths trigger checkpoint drift without verification words in the command', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'double-redirect-drift-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  writeEvents(base, [
    { type: 'assistant.message', data: {
      toolRequests: [{ name: 'powershell', toolCallId: 'write', arguments: { command: 'emit' } }],
    } },
    { type: 'tool.execution_start', data: {
      toolCallId: 'write', arguments: { command: 'emit' },
      shellToolInfo: { hasWriteFileRedirection: true, possiblePaths: ['test results/assertions.xml'] },
    } },
    { type: 'tool.execution_complete', data: { toolCallId: 'write', success: true } },
    { type: 'assistant.message', data: {
      toolRequests: [{ name: 'sql', toolCallId: 'checkpoint', arguments: { query: "UPDATE todos SET status='done'" } }],
    } },
    { type: 'tool.execution_complete', data: { toolCallId: 'checkpoint', success: true } },
  ]);
  const wakes = JSON.parse(runWatcher(`
print(json.dumps(dw.scan_events(pathlib.Path(${JSON.stringify(base)}))[0]))
`));
  assert.deepEqual(wakes.map((w) => ({ trigger: w.trigger, touched: w.touched_files })), [
    { trigger: 'T3_CHECKPOINT_DRIFT', touched: ['test results/assertions.xml'] },
  ]);
});

test('range context selects the active todo, falls back to the latest todo, and tolerates a missing database', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'double-todo-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const db = new DatabaseSync(join(base, 'session.db'));
  db.exec('CREATE TABLE todos (id TEXT, title TEXT, status TEXT, updated_at TEXT)');
  db.prepare('INSERT INTO todos VALUES (?, ?, ?, ?)').run('active', 'Finish the lifecycle', 'in_progress', '2026-11-01');
  db.prepare('INSERT INTO todos VALUES (?, ?, ?, ?)').run('latest', 'Check the audit', 'pending', '2026-11-02');
  const context = (dir) => JSON.parse(runWatcher(`
print(json.dumps(dw.extract_range_context(pathlib.Path(${JSON.stringify(dir)}), [], 0, 0, -1)))
`)).active_todo_anchor;
  assert.deepEqual(context(base), { id: 'active', title: 'Finish the lifecycle', status: 'in_progress' });
  db.exec("UPDATE todos SET status = 'done' WHERE id = 'active'");
  assert.deepEqual(context(base), { id: 'latest', title: 'Check the audit', status: 'pending' });
  db.close();
  assert.equal(context(join(base, 'missing')), null);
});

test('tool-only human gates include tool names and arguments in trigger_detail', () => {
  const out = runWatcher(`
events = [
    {"type": "assistant.message", "data": {"toolRequests": [{"name": "task_complete", "toolCallId": "c1", "arguments": {"summary": "Done"}}]}},
    {"type": "tool.execution_complete", "data": {"toolCallId": "c1", "success": True}},
    {"type": "assistant.message", "data": {"toolRequests": [{"name": "ask_user", "toolCallId": "c2", "arguments": {"question": "Which one?"}}]}},
    {"type": "tool.execution_start", "data": {"toolCallId": "c2"}},
]
wakes = dw.scan_events(pathlib.Path("worker-tools"), lines=[json.dumps(e) for e in events])[0]
print(json.dumps([{"trigger": w["trigger"], "detail": w["trigger_detail"]} for w in wakes]))
`);
  assert.deepEqual(JSON.parse(out), [
    { trigger: 'T1_HUMAN_GATE', detail: "task_complete({'summary': 'Done'})" },
    { trigger: 'T1_HUMAN_GATE', detail: "ask_user({'question': 'Which one?'})" },
  ]);
});

test('wait suppresses a duplicate live monitor and recovers a dead monitor', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'double-monitor-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const sessionDir = join(home, 'session-state', 'worker-monitor');
  const outDir = join(home, 'session-state', 'double-monitor', 'files');
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });
  writeEvents(sessionDir, [{ type: 'session.shutdown', data: {} }]);
  const statePath = join(outDir, 'double-lifecycle.json');
  const state = {
    worker_session_id: 'worker-monitor',
    double_session_id: 'double-monitor',
    phase: 'watching',
    queued: 0,
    monitors: 1,
    monitor_pid: process.pid,
    worker_active: true,
    wake_count: 7,
    last_event_size: 0,
    updated_at: Date.now(),
  };
  writeFileSync(statePath, JSON.stringify(state));
  const wait = () => JSON.parse(execFileSync('python', [watchScript, 'worker-monitor', '--wait', '--out-dir', outDir, '--idle-exit-seconds', '0'], {
    env: { ...process.env, COPILOT_HOME: home },
    encoding: 'utf8',
    timeout: 5000,
  }).trim());
  assert.deepEqual(wait(), {
    status: 'DUPLICATE_MONITOR_SUPPRESSED',
    monitor_pid: process.pid,
    worker_session_id: 'worker-monitor',
  });
  assert.deepEqual(JSON.parse(readFileSync(statePath, 'utf8')), state);
  writeFileSync(statePath, JSON.stringify({ ...state, monitor_pid: 2147483647 }));
  assert.equal(wait().status, 'PARENT_INACTIVE');
  const recovered = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(recovered.phase, 'idle');
  assert.equal(recovered.monitors, 0);
  assert.equal(recovered.monitor_pid, null);
  assert.equal(recovered.double_session_id, 'double-monitor');
  assert.equal(recovered.wake_count, 7);
});

test('concurrent wait processes keep one live monitor without failing competing commands', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'double-monitor-race-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const result = JSON.parse(runPy(`
import json, os, pathlib, subprocess, sys, time
observations = []
for wave in range(3):
    home = pathlib.Path(${JSON.stringify(base)}) / str(wave)
    worker = home / "session-state" / "worker-race"
    output = home / "session-state" / "double-race" / "files"
    worker.mkdir(parents=True)
    output.mkdir(parents=True)
    events = worker / "events.jsonl"
    events.write_text(json.dumps({"type": "tool.execution_start", "data": {"toolCallId": "live", "toolName": "powershell"}}) + "\\n", encoding="utf-8")
    command = [sys.executable, ${JSON.stringify(watchScript)}, worker.name, "--wait", "--interval", "0.02", "--idle-exit-seconds", "0", "--out-dir", str(output)]
    processes = [subprocess.Popen(command, env={**os.environ, "COPILOT_HOME": str(home)}, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for _ in range(8)]
    try:
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline and sum(p.poll() is None for p in processes) > 1:
            time.sleep(0.02)
        live = sum(p.poll() is None for p in processes)
        with events.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps({"type": "session.shutdown", "data": {}}) + "\\n")
        statuses, errors = [], []
        for process in processes:
            stdout, stderr = process.communicate(timeout=5)
            if process.returncode == 0:
                statuses.append(json.loads(stdout)["status"])
            else:
                errors.append(stderr.strip().splitlines()[-1] if stderr.strip() else f"exit {process.returncode}")
        observations.append({"live": live, "suppressed": statuses.count("DUPLICATE_MONITOR_SUPPRESSED"), "idle": statuses.count("PARENT_INACTIVE"), "errors": errors})
    finally:
        for process in processes:
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=5)
print(json.dumps(observations))
`));
  assert.deepEqual(result, Array.from({ length: 3 }, () => ({ live: 1, suppressed: 7, idle: 1, errors: [] })));
});

function extensionHarness(t, { sessionId = 'worker-ext', marker = true, workerRunning = 0, doubleRunning = 0 } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'double-ext-test-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const sdkDir = join(base, 'node_modules', '@github', 'copilot-sdk');
  mkdirSync(sdkDir, { recursive: true });
  writeFileSync(join(sdkDir, 'package.json'), JSON.stringify({
    name: '@github/copilot-sdk',
    type: 'module',
    exports: { './extension': './extension.mjs' },
  }));
  writeFileSync(join(sdkDir, 'extension.mjs'), `
export let registeredHooks;
export const deliveries = [];
const listeners = new Set();
let deliveryError;
export function failNextDelivery(message) { deliveryError = new Error(message); }
async function deliver(value) {
  deliveries.push(value);
  if (deliveryError) {
    const error = deliveryError;
    deliveryError = undefined;
    throw error;
  }
}
export const session = {
  sessionId: process.env.DOUBLE_TEST_SESSION_ID,
  rpc: { tools: { execute: async (request) => deliver({ transport: 'rpc', ...request }) } },
  send: async (request) => deliver({ transport: 'send', ...request }),
  on: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
};
export async function emit(event) { await Promise.all([...listeners].map((listener) => listener(event))); }
export async function joinSession(cfg) { registeredHooks = cfg.hooks; return session; }
`);

  const customHome = join(base, 'copilot-home');
  const workerDir = join(customHome, 'session-state', 'worker-ext');
  mkdirSync(workerDir, { recursive: true });
  if (marker) writeFileSync(join(workerDir, 'double-supervised'), 'double-child-99\n');
  const outDir = join(customHome, 'session-state', 'double-child-99', 'files');
  mkdirSync(outDir, { recursive: true });

  const db = new DatabaseSync(join(customHome, 'data.db'));
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, agent TEXT, is_running INTEGER, was_interrupted INTEGER, archived_at TEXT, created_at TEXT);
    CREATE TABLE chat_parent_links (session_id TEXT, parent_session_id TEXT);
  `);
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?)').run('worker-ext', 'Worker', 'poteto', workerRunning, 0, null, '2026-11-01T00:00:00Z');
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?)').run('double-child-99', 'Double: worker', 'double', doubleRunning, 0, null, '2026-11-01T00:00:00Z');
  db.prepare('INSERT INTO chat_parent_links VALUES (?, ?)').run('double-child-99', 'worker-ext');
  db.close();

  const extCopy = join(base, 'extension.mjs');
  const extSrc = readFileSync(join(root, 'extensions', 'double', 'extension.mjs'), 'utf8')
    .replace('const pstackRoot = join(homedir(), ".copilot", "pstack");', `const pstackRoot = ${JSON.stringify(root)};`);
  writeFileSync(extCopy, extSrc);

  const statePath = join(outDir, 'double-lifecycle.json');
  return {
    base, customHome, outDir, statePath, workerDir,
    run(code) {
      const runner = join(base, 'run.mjs');
      writeFileSync(runner, `
import './extension.mjs';
import { registeredHooks, session, deliveries, emit, failNextDelivery } from '@github/copilot-sdk/extension';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
const inv = { sessionId: ${JSON.stringify(sessionId)} };
const statePath = ${JSON.stringify(statePath)};
const readState = () => existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null;
const writeState = (state) => writeFileSync(statePath, JSON.stringify(state));
const setRunning = (id, value) => {
  const db = new DatabaseSync(${JSON.stringify(join(customHome, 'data.db'))});
  db.prepare('UPDATE sessions SET is_running = ? WHERE id = ?').run(value, id);
  db.close();
};
const waitUntil = async (condition) => {
  const deadline = Date.now() + 4000;
  while (!condition() && Date.now() < deadline) await sleep(20);
  if (!condition()) throw new Error('Expected runtime wake or lifecycle transition was not observed.');
};
${code}
`);
      return JSON.parse(execFileSync(process.execPath, [runner], {
        cwd: base,
        env: { ...process.env, COPILOT_HOME: customHome, DOUBLE_TEST_SESSION_ID: sessionId },
        encoding: 'utf8',
        timeout: 10_000,
      }).trim());
    },
  };
}

function lifecycleState(phase, values = {}) {
  return {
    worker_session_id: 'worker-ext',
    double_session_id: 'double-child-99',
    phase,
    queued: 0,
    monitors: 0,
    monitor_pid: null,
    worker_active: false,
    wake_count: 0,
    last_event_size: 0,
    updated_at: Date.now(),
    ...values,
  };
}

function wakePrompt(harness) {
  return `Parent session active; run python "${watchScript}" worker-ext --wait --out-dir "${harness.outDir}" and write double-audit.tsv and double-audit.md in "${harness.outDir}".`;
}

test('worker hooks dispatch one runtime wake with no worker dialogue', (t) => {
  const harness = extensionHarness(t);
  const result = harness.run(`
const results = [];
for (const name of ['onSessionStart', 'onUserPromptSubmitted', 'onPreToolUse', 'onPostToolUse', 'onPostToolUseFailure', 'onSessionEnd']) {
  results.push(await registeredHooks[name]?.({ toolName: 'view' }, inv));
}
await Promise.all(Array.from({ length: 10 }, () => registeredHooks.onPostToolUse({ toolName: 'view' }, inv)));
console.log(JSON.stringify({ results, deliveries, state: readState() }));
`);
  assert.deepEqual(result.results, [null, null, null, null, null, null]);
  assert.deepEqual(result.deliveries, [{
    transport: 'rpc',
    name: 'send_session_message',
    arguments: { session_id: 'double-child-99', delivery_mode: 'immediate', message: wakePrompt(harness) },
  }]);
  assert.equal(result.state.phase, 'wake_pending');
  assert.equal(result.state.queued, 1);
  assert.equal(result.state.monitors, 0);
  assert.equal(result.state.wake_count, 1);
  assert.equal(result.state.worker_session_id, 'worker-ext');
  assert.equal(result.state.double_session_id, 'double-child-99');
});

for (const sessionId of ['worker-ext', 'double-child-99']) {
  test(`accepted wakes stay coalesced past delayed startup through ${sessionId}`, (t) => {
    const harness = extensionHarness(t, { sessionId, workerRunning: 1 });
    writeFileSync(harness.statePath, JSON.stringify(lifecycleState('idle')));
    const result = harness.run(`
await registeredHooks.onUserPromptSubmitted({}, inv);
const accepted = readState();
for (let retry = 0; retry < 3; retry += 1) {
  writeState({ ...readState(), updated_at: Date.now() - 16000 });
  await registeredHooks.onPostToolUse({ toolName: 'view' }, inv);
}
const delayed = readState();
setRunning('double-child-99', 1);
await registeredHooks.onPostToolUse({ toolName: 'view' }, inv);
console.log(JSON.stringify({ accepted, delayed, started: readState(), deliveries }));
`);
    const delivery = sessionId === 'worker-ext'
      ? { transport: 'rpc', name: 'send_session_message', arguments: { session_id: 'double-child-99', delivery_mode: 'immediate', message: wakePrompt(harness) } }
      : { transport: 'send', prompt: wakePrompt(harness) };
    assert.deepEqual(result.deliveries, [delivery]);
    assert.equal(result.accepted.wake_accepted, true);
    assert.deepEqual({
      phase: result.delayed.phase, queued: result.delayed.queued, monitors: result.delayed.monitors,
      monitor_pid: result.delayed.monitor_pid, wake_count: result.delayed.wake_count, wake_accepted: result.delayed.wake_accepted,
    }, { phase: 'wake_pending', queued: 1, monitors: 0, monitor_pid: null, wake_count: 1, wake_accepted: true });
    assert.deepEqual({
      phase: result.started.phase, queued: result.started.queued, monitors: result.started.monitors, wake_accepted: result.started.wake_accepted,
    }, { phase: 'watching', queued: 0, monitors: 1, wake_accepted: false });
  });
}

test('an accepted wake retries after an interrupted supervisor and resets acceptance on failure', (t) => {
  const harness = extensionHarness(t);
  const result = harness.run(`
await registeredHooks.onUserPromptSubmitted({}, inv);
writeState({ ...readState(), updated_at: Date.now() - 16000 });
const db = new DatabaseSync(${JSON.stringify(join(harness.customHome, 'data.db'))});
db.exec("UPDATE sessions SET was_interrupted = 1 WHERE id = 'double-child-99'");
db.close();
failNextDelivery('interrupted transport');
await registeredHooks.onPostToolUse({ toolName: 'view' }, inv);
const failed = readState();
await registeredHooks.onPostToolUse({ toolName: 'view' }, inv);
console.log(JSON.stringify({ failed, retried: readState(), deliveries }));
`);
  assert.deepEqual({
    phase: result.failed.phase, wake_accepted: result.failed.wake_accepted, queued: result.failed.queued,
    monitors: result.failed.monitors, monitor_pid: result.failed.monitor_pid,
  }, { phase: 'idle', wake_accepted: false, queued: 0, monitors: 0, monitor_pid: null });
  assert.deepEqual(result.deliveries.map((d) => d.arguments.message), Array(3).fill(wakePrompt(harness)));
  assert.equal(result.retried.wake_accepted, true);
  assert.equal(result.retried.wake_count, 3);
});

test('legacy Double wake calls are denied while unrelated session messages still activate Double', (t) => {
  const harness = extensionHarness(t);
  const result = harness.run(`
const unrelated = await registeredHooks.onPreToolUse({
  toolName: 'send_session_message', toolArgs: { session_id: 'other-session', message: 'Please --wait for my next update.' },
}, inv);
const denied = await registeredHooks.onPreToolUse({
  toolName: 'send_session_message', toolArgs: { session_id: 'double-child-99', message: 'Parent session active; run double_watch.py worker-ext --wait.' },
}, inv);
const ordinary = await registeredHooks.onPreToolUse({
  toolName: 'send_session_message', toolArgs: { session_id: 'double-child-99', message: 'The requested artifact is ready.' },
}, inv);
console.log(JSON.stringify({ unrelated: unrelated ?? null, denied: denied ?? null, ordinary: ordinary ?? null, deliveries }));
`);
  assert.equal(result.unrelated, null);
  assert.equal(result.ordinary, null);
  assert.deepEqual(result.denied, {
    permissionDecision: 'deny',
    permissionDecisionReason: 'Double supervisor activation is runtime-owned.',
  });
  assert.deepEqual(result.deliveries, [{
    transport: 'rpc',
    name: 'send_session_message',
    arguments: { session_id: 'double-child-99', delivery_mode: 'immediate', message: wakePrompt(harness) },
  }]);
});

test('lifecycle coalesces watching and pending activation, then retries stale connections', (t) => {
  const harness = extensionHarness(t);
  const result = harness.run(`
const observations = [];
writeState({ ...${JSON.stringify(lifecycleState('watching'))}, monitor_pid: process.pid });
await registeredHooks.onPostToolUse({ toolName: 'view' }, inv);
observations.push({ phase: readState().phase, queued: readState().queued, monitors: readState().monitors, worker_active: readState().worker_active });
setRunning('double-child-99', 1);
writeState(${JSON.stringify(lifecycleState('wake_pending', { queued: 1 }))});
await registeredHooks.onPostToolUse({ toolName: 'view' }, inv);
observations.push({ phase: readState().phase, queued: readState().queued, monitors: readState().monitors, worker_active: readState().worker_active });
setRunning('double-child-99', 0);
for (const phase of ['watching', 'wake_pending']) {
  writeState({ ...${JSON.stringify(lifecycleState('idle'))}, phase, updated_at: Date.now() - 16000, monitor_pid: 2147483647 });
  await registeredHooks.onPostToolUse({ toolName: 'view' }, inv);
  observations.push({ phase: readState().phase, queued: readState().queued, monitors: readState().monitors, wake_count: readState().wake_count });
}
for (const phase of ['watching', 'wake_pending']) {
  writeState({ ...${JSON.stringify(lifecycleState('idle'))}, phase, updated_at: Date.now() - 16000, monitor_pid: 2147483647 });
  await registeredHooks.onSessionEnd({}, inv);
  observations.push({ phase: readState().phase, queued: readState().queued, monitors: readState().monitors, wake_count: readState().wake_count });
}
console.log(JSON.stringify({ observations, deliveries }));
`);
  assert.deepEqual(result.observations.slice(0, 2), [
    { phase: 'watching', queued: 0, monitors: 1, worker_active: true },
    { phase: 'watching', queued: 0, monitors: 1, worker_active: true },
  ]);
  assert.deepEqual(result.observations.slice(2, 4), Array.from({ length: 2 }, () => ({
    phase: 'wake_pending', queued: 1, monitors: 0, wake_count: 1,
  })));
  assert.deepEqual(result.observations.slice(4), Array.from({ length: 2 }, () => ({
    phase: 'idle', queued: 0, monitors: 0, wake_count: 0,
  })));
  assert.equal(result.deliveries.length, 2);
  assert.equal(result.deliveries.every((delivery) => delivery.arguments.message === wakePrompt(harness)), true);
});

for (const sessionId of ['worker-ext', 'double-child-99']) {
  test(`failed runtime transport through ${sessionId} leaves idle state and a later hook retries`, (t) => {
    const harness = extensionHarness(t, { sessionId });
    writeFileSync(harness.statePath, JSON.stringify(lifecycleState('idle')));
    const result = harness.run(`
setRunning('worker-ext', 1);
failNextDelivery('transport rejected');
const first = await registeredHooks.onUserPromptSubmitted({}, inv);
const failed = readState();
const second = await registeredHooks.onPostToolUseFailure({ toolName: 'powershell' }, inv);
console.log(JSON.stringify({ first: first ?? null, second: second ?? null, failed, retried: readState(), deliveries }));
`);
    assert.equal(result.first, null);
    assert.equal(result.second, null);
    assert.deepEqual({
      phase: result.failed.phase,
      queued: result.failed.queued,
      monitors: result.failed.monitors,
      monitor_pid: result.failed.monitor_pid,
      wake_accepted: result.failed.wake_accepted,
    }, { phase: 'idle', queued: 0, monitors: 0, monitor_pid: null, wake_accepted: false });
    assert.equal(result.retried.phase, 'wake_pending');
    assert.equal(result.retried.wake_count, 2);
    assert.deepEqual(result.deliveries.map((delivery) => delivery.arguments?.message || delivery.prompt), [wakePrompt(harness), wakePrompt(harness)]);
  });
}

test('unmarked and archived workers do not dispatch supervisor wakes', (t) => {
  const unmarked = extensionHarness(t, { marker: false });
  assert.deepEqual(unmarked.run(`
const response = await registeredHooks.onUserPromptSubmitted({}, inv);
console.log(JSON.stringify({ response: response ?? null, deliveries }));
`), { response: null, deliveries: [] });
  const archived = extensionHarness(t);
  assert.deepEqual(archived.run(`
const db = new DatabaseSync(${JSON.stringify(join(archived.customHome, 'data.db'))});
db.exec("UPDATE sessions SET archived_at = '2026-11-02' WHERE agent = 'double'");
db.close();
const response = await registeredHooks.onUserPromptSubmitted({}, inv);
console.log(JSON.stringify({ response: response ?? null, deliveries }));
`), { response: null, deliveries: [] });
});

test('Double runtime wakes itself on worker activity and pending wakes without worker hooks', (t) => {
  const harness = extensionHarness(t, { sessionId: 'double-child-99', marker: false });
  writeFileSync(harness.statePath, JSON.stringify(lifecycleState('idle')));
  const result = harness.run(`
setRunning('worker-ext', 1);
await waitUntil(() => deliveries.length === 1);
const first = readState();
await emit({ type: 'assistant.turn_start' });
await waitUntil(() => readState()?.phase === 'watching');
const active = readState();
await registeredHooks.onPostToolUse({ toolName: 'view' }, inv);
const whileActive = deliveries.length;
setRunning('worker-ext', 0);
writeState({ ...readState(), phase: 'idle', worker_active: false, monitors: 0 });
writeFileSync(${JSON.stringify(join(harness.outDir, 'double-cursor.json'))}, JSON.stringify({
  worker_session_id: 'worker-ext', pending_wakes: [{ event_range: [1, 2] }],
}));
await emit({ type: 'session.idle' });
await waitUntil(() => deliveries.length === 2);
console.log(JSON.stringify({ first, active, whileActive, deliveries, final: readState() }));
`);
  assert.equal(result.first.phase, 'wake_pending');
  assert.equal(result.first.wake_count, 1);
  assert.equal(result.active.phase, 'watching');
  assert.equal(result.active.monitors, 1);
  assert.equal(result.whileActive, 1);
  assert.deepEqual(result.deliveries, [
    { transport: 'send', prompt: wakePrompt(harness) },
    { transport: 'send', prompt: wakePrompt(harness) },
  ]);
  assert.equal(result.final.wake_count, 2);
});

test('idle Double detects appended worker events but does not wake on unchanged idle state', (t) => {
  const harness = extensionHarness(t, { sessionId: 'double-child-99' });
  writeFileSync(harness.statePath, JSON.stringify(lifecycleState('idle')));
  const result = harness.run(`
await sleep(1100);
const before = [...deliveries];
writeFileSync(${JSON.stringify(join(harness.workerDir, 'events.jsonl'))}, '{"type":"user.message","data":{"content":"Continue"}}\\n');
await waitUntil(() => deliveries.length === 1);
console.log(JSON.stringify({ before, deliveries, state: readState() }));
`);
  assert.deepEqual(result.before, []);
  assert.deepEqual(result.deliveries, [{ transport: 'send', prompt: wakePrompt(harness) }]);
  assert.equal(result.state.phase, 'wake_pending');
  assert.equal(result.state.wake_count, 1);
});

test('concurrent worker hooks share one pending activation', (t) => {
  const harness = extensionHarness(t);
  const result = harness.run(`
await Promise.all(Array.from({ length: 24 }, () => registeredHooks.onUserPromptSubmitted({}, inv)));
console.log(JSON.stringify({ deliveries, state: readState() }));
`);
  assert.deepEqual(result.deliveries, [{
    transport: 'rpc',
    name: 'send_session_message',
    arguments: { session_id: 'double-child-99', delivery_mode: 'immediate', message: wakePrompt(harness) },
  }]);
  assert.equal(result.state.wake_count, 1);
  assert.equal(result.state.queued, 1);
  assert.equal(result.state.monitors, 0);
});

test('fresh Double startup records double_ext_pid without duplicate kickoff wake, worker delegates when double_ext_pid is alive, and read_audit_ranges backfills double-audit.md', (t) => {
  const freshDouble = extensionHarness(t, { sessionId: 'double-child-99', workerRunning: 1 });
  const startup = freshDouble.run(`
console.log(JSON.stringify({ deliveries, state: readState() }));
`);
  assert.deepEqual(startup.deliveries, []);
  assert.equal(startup.state.phase, 'wake_pending');
  assert.equal(startup.state.queued, 1);
  assert.equal(startup.state.wake_count, 0);
  assert.equal(Number.isInteger(startup.state.double_ext_pid) && startup.state.double_ext_pid > 0, true);

  const delegated = extensionHarness(t, { sessionId: 'worker-ext' });
  writeFileSync(delegated.statePath, JSON.stringify(lifecycleState('idle', { double_ext_pid: process.pid })));
  const workerResult = delegated.run(`
await registeredHooks.onUserPromptSubmitted({}, inv);
console.log(JSON.stringify({ deliveries, state: readState() }));
`);
  assert.deepEqual(workerResult.deliveries, []);
  assert.equal(workerResult.state.phase, 'idle');
  assert.equal(workerResult.state.worker_active, true);

  writeFileSync(join(delegated.outDir, 'double-audit.tsv'), auditHeader + auditRow('0-3'));
  const ranges = JSON.parse(runWatcher(`
print(json.dumps(dw.read_audit_ranges(pathlib.Path(${JSON.stringify(delegated.outDir)}))))
`));
  assert.deepEqual(ranges, [[0, 3]]);
  const mdText = readFileSync(join(delegated.outDir, 'double-audit.md'), 'utf8');
  assert.match(mdText, /# Double audit/);
  assert.match(mdText, /\|\s*0-3\s*\|\s*T1_HUMAN_GATE\s*\|\s*VERIFIED\s*\|/);
});

test('extension resolves supervisor pair even when sessions table omits was_interrupted', (t) => {
  const harness = extensionHarness(t);
  const dbPath = join(harness.customHome, 'data.db');
  rmSync(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, agent TEXT, is_running INTEGER, archived_at TEXT, created_at TEXT);
    CREATE TABLE chat_parent_links (session_id TEXT, parent_session_id TEXT);
    INSERT INTO sessions VALUES ('worker-ext', 'Worker', NULL, 1, NULL, '2026-11-02');
    INSERT INTO sessions VALUES ('double-child-99', 'Double: worker', 'double', 0, NULL, '2026-11-02');
    INSERT INTO chat_parent_links VALUES ('double-child-99', 'worker-ext');
  `);
  db.close();
  const result = harness.run(`
await registeredHooks.onUserPromptSubmitted({}, inv);
writeState({ ...readState(), updated_at: Date.now() - 16050 });
await registeredHooks.onPostToolUse({ toolName: 'view' }, inv);
console.log(JSON.stringify({ deliveries: deliveries.length, state: readState() }));
`);
  assert.equal(result.deliveries, 1);
  assert.equal(result.state.phase, 'wake_pending');
  assert.equal(result.state.wake_accepted, true);
  assert.equal(result.state.wake_count, 1);
});
