import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

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
    wakes: 0,
    bundle_exists: false,
    worker_sid: 'worker-2',
  });
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

  execFileSync('python', [watchScript, 'worker-replay', '--replay', '--out-dir', outDir], {
    env: { ...process.env, USERPROFILE: home, HOME: home },
  });
  const bundlePath = join(outDir, 'double-wake-bundle.json');
  assert.equal(existsSync(bundlePath), true);
  const bundle = JSON.parse(readFileSync(bundlePath, 'utf8'));
  assert.equal(bundle.length, 1);
  assert.equal(bundle[0].trigger, 'T1_HUMAN_GATE');
  assert.equal(Array.isArray(bundle[0].range_events), true);

  const waitOut = execFileSync('python', [watchScript, 'worker-empty', '--wait', '--out-dir', outDir, '--idle-exit-seconds', '0'], {
    env: { ...process.env, USERPROFILE: home, HOME: home },
    encoding: 'utf8',
  });
  assert.equal(JSON.parse(waitOut.trim()).status, 'PARENT_INACTIVE');
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
  assert.match(skillText, /PSTACK_CONTEXT_V1/);
  assert.match(skillText, /"input":\s*\{/);
  assert.match(skillText, /double-supervised/);
  assert.doesNotMatch(skillText, /call `task_complete`/i);

  const agentText = readFileSync(join(root, 'agents', 'double.agent.md'), 'utf8');
  assert.doesNotMatch(agentText, /call `task_complete`/i);
  assert.match(agentText, /<worker_session_dir>\/files\//);
  assert.match(agentText, /<double_session_dir>\/files\/double-audit\.tsv/);

  const extText = readFileSync(join(root, 'extensions', 'double', 'extension.mjs'), 'utf8');
  assert.match(extText, /double-supervised/);

  const setupSkill = readFileSync(join(root, 'skills', 'setup-pstack', 'SKILL.md'), 'utf8');
  assert.match(setupSkill, /double verifier/);
  assert.match(setupSkill, /18-role model map/);

  const setupDoc = readFileSync(join(root, 'docs', 'guide', '01-setup.md'), 'utf8');
  assert.match(setupDoc, /double/);

  const syncDoc = readFileSync(join(root, 'docs', 'upstream-sync.md'), 'utf8');
  assert.match(syncDoc, /double\.agent\.md/);
});
