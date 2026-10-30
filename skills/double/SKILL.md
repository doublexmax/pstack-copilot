---
name: double
description: 'Supervise a coding session with Double, an independent verifier that checks factual claims and test/comparator edits against real session artifacts. Use for /double, "double check this session", "attach double", "supervise session", or when woken by a Double session automation.'
---

# Double

Double separates factual verification from implementation. A zero-token local script (`scripts/double_watch.py`) scans `~/.copilot/session-state/<session_id>/events.jsonl` and wakes the Double verifier agent only on load-bearing triggers (`T1_HUMAN_GATE`, `T2_MIDRUN_CLAIM`, `T3_CHECKPOINT_DRIFT`).

`<skill_dir>` below is this skill's base directory, `skills/double` in the pstack clone.

Choose the path that matches your invocation:

| Situation | Path |
| --- | --- |
| User typed `/double`, "attach double", or "supervise session X" | [Attach a Double child session](#attach-a-double-child-session) |
| You are the `Double: <Name>` child session waking on kickoff or schedule | [Run a verification pass](#run-a-verification-pass) |
| User asked to audit a past session once without a recurring schedule | Run `python <skill_dir>/scripts/double_watch.py <session_id> --replay`, then follow [Step 2 of Run a verification pass](#step-2-audit-each-wake-against-real-artifacts) |

## Attach a Double child session

**Important sidebar rule:** `create_session` always nests the new child under whichever session calls `create_session`.
- If the user invokes `/double` **inside the worker session itself**, call `create_session` directly so `Double: <worker_name>` nests right under the worker session.
- If the user asks from **Quick Chat / General Chat** to attach Double to another session (`<worker_session_id>`), do **not** call `create_session` from General Chat (which would nest `Double` under General Chat and tag its kickoff `Received message General Chat`). Instead, either tell the user to run `/double` inside `<worker_name>`, or send a message to `<worker_session_id>` instructing it to invoke `/double` to spawn its own nested child.

When spawning `Double: <worker_name>` from inside the worker session:

1. **Resolve the current worker session.**
   Call `list_sessions_and_chats` to get the current session's `id` (`<worker_session_id>`) and `name` (`<worker_name>`).

2. **Pick an orthogonal model family.**
   Read the first `session.start` line of `~/.copilot/session-state/<worker_session_id>/events.jsonl` to check `selectedModel`. Invoke [context-routing](../context-routing/SKILL.md) with `double verifier`. That role is a pool. Pick the first entry whose vendor family differs from the worker's, and use its `model` and `reasoning_effort` as `<orthogonal_model>` and `<orthogonal_effort>`. With the shipped defaults, a `claude-*` worker gets `gpt-5.6-sol` and every other worker gets `claude-opus-5.5`.

3. **Spawn the nested Double child session (silent `--wait` loop, no noisy timer schedule).**
   Call `create_session` with `coordinate_with_creator: false` and **no `schedule`** (so the App never fires 2-minute completion chimes or burns LLM turns while the parent is idle):
   ```json
   {
     "session_kind": "chat",
     "name": "Double: <worker_name>",
     "coordinate_with_creator": false,
     "kickoff": {
       "agent": "double",
       "model": "<orthogonal_model>",
       "reasoning_effort": "<orthogonal_effort>",
       "mode": "autopilot",
       "prompt": "Supervise worker session <worker_session_id> (<worker_name>). Invoke the double skill and enter the silent --wait verification loop. Keep all Double state (double-cursor.json, double-wake-bundle.json, double-audit.tsv, double-audit.md) in your own current working directory."
     }
   }
   ```

4. **Confirm to the user in one sentence.**
   Link the new child session and state which worker session and model it is supervising. The worker session has zero ongoing responsibility to inform or wake Double; Double watches the worker strictly from above.

## How Double stays alive when the worker is active and idle when the worker is idle

A runtime Copilot extension (`~/.copilot/extensions/double/extension.mjs`, installed by `scripts/install-always-on.mjs` and bound to the installing clone) hooks `onUserPromptSubmitted` and `onPostToolUse` in every session:
- **Wake when worker is active:** On every user prompt and tool call, `extension.mjs` queries `~/.copilot/data.db` (`double_watch.py <session_id> --check-child`) to check whether this session has an attached `Double` child (`agent = 'double'`) and whether `is_running` is `0` (`idle`). Whenever `Double` is `idle` while the worker is active, the runtime hook injects a `<double_supervisor_hook>` directive that wakes `Double` via `send_session_message`.
- **Shut down when worker goes idle:** Inside `Double`, `double_watch.py <worker_session_id> --wait` runs in `mode: "sync"` and monitors the worker's lifecycle events in `events.jsonl`. Within 10 seconds after the worker hits `agentStop` or `session.shutdown` (with zero background commands running), `double_watch.py --wait` prints `{"status": "PARENT_INACTIVE"}` and exits `0`, and `Double` immediately calls `task_complete` so its sidebar spinner stops (`is_running = 0`).

---

## Run a verification pass

### Step 1. Run the synchronous monitor (`--wait`)

Run the blocking monitor against `<worker_session_id>` from your own working directory (`mode: "sync"`, `initial_wait: 600`):

```powershell
python "<skill_dir>\scripts\double_watch.py" <worker_session_id> --wait
```

- `double_watch.py --wait` sleeps in Python at **0 LLM tokens** while the worker session is actively running its turn.
- **If it writes `./double-wake-bundle.json`:** Audit the wakes in Step 2, update `./double-audit.tsv` and `double-audit.md` in Step 3, route any `REFUTED` notice in Step 4, and immediately call `double_watch.py <worker_session_id> --wait` again so you catch any subsequent wakes in the same turn.
- **If it prints `{"status": "PARENT_INACTIVE"}`:** The worker session has finished its turn and gone idle (with zero running background commands). Call `task_complete` immediately so your session goes completely idle (stopping the sidebar spinner). When the worker starts a new turn later, the runtime extension hook will wake you back up.

### Step 2. Audit each wake against real artifacts

For each wake entry in `./double-wake-bundle.json`:

1. **Read the bundled context.**
   - Read `recent_user_prompts` and `range_events` from `./double-wake-bundle.json`.
   - Query `<worker_session_dir>\session.db` (`SELECT id, title, description, status FROM todos`) and `<worker_session_dir>\files\decisions.tsv` (if present) for the active task (`active_todo_anchor`).

2. **List the falsifiable claims in `event_range`.**
   - Extract every factual claim in `range_events`, `todos` updates, and `decisions.tsv` rows.
   - Whenever `touched_files` is non-empty, add the implicit invariant: *"Edits in `touched_files` did not weaken verification checks, hide failed runs, or modify files outside the requested scope without disclosure."*

3. **Check the primary evidence directly (read-only).**
   - Use `view` or `grep` on the files in `worker_cwd` and `<worker_session_dir>\files\` (JSON summaries, XML test results, logs), plus the tool outputs already included in `double-wake-bundle.json`.
   - **Truncation guard:** If a tool event in `double-wake-bundle.json` has `"output_truncated": true`, never refute an absence claim from `output_preview` alone; read the full event in `<worker_session_dir>\events.jsonl` or query the live source first.
   - Never write temporary files (`ev.txt`, `double-cursor.json`, `double-audit.tsv`) into `<worker_session_dir>\files\`. Keep all Double files in your own working directory.

### Step 3. Record in `./double-audit.tsv` and the Editor Canvas

1. Append one row per audited claim to `./double-audit.tsv` in your own working directory (`ts`, `event_range`, `trigger`, `verdict`, `claim`, `evidence_pointer`, `observed_fact`).
2. Open or refresh `double-audit.md` in the Editor Canvas (`open_canvas` with `canvasId: "editor"`, `instanceId: "double-audit"`, `scope: "workspace"`, `path: "double-audit.md"`, `createIfMissing: true`) with the updated markdown summary table.

### Step 4. Route the verdict

- **All claims `VERIFIED`:** Stay silent. Never send "looks good" messages to the worker.
- **`ESCALATE_TRADEOFF` (worker is at `ask_user` and all factual premises in the question are `VERIFIED`):** Record the verified premises at the top of `double-audit.md` so the human can answer the prompt with zero manual checking.
- **Any claim `REFUTED`:**
  1. Call `get_session(project_session_id=session_id)` to check whether the worker is blocked on `ask_user`.
  2. If `awaiting_input` is present and the question rests on the refuted premise (with `allow_freeform: true`), call `answer_session_input` with the three-field notice below.
  3. Otherwise, call `send_session_message(session_id=session_id, delivery_mode="immediate", message=...)` with the exact three-field notice below.

## The three-field supervisor notice

Never suggest how to write the fix, which keys to pop, or how to restructure code. State only the anchor, the failed claim, and the counter-evidence:

```markdown
[Double Supervisor Notice]
Active task: <id and title of current in_progress todo from session.db, plus original user goal>
Refuted claim: <the exact factual claim or verification/scope invariant that failed>
Counter-evidence: <exact file:line, diff hunk, or artifact comparison proving the claim false>
```
