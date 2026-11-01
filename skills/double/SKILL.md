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
| User asked to audit a past session once without a recurring schedule | Run `python "<skill_dir>\scripts\double_watch.py" <session_id> --replay --out-dir "<double_artifacts_dir>"`, then follow [Step 2 of Run a verification pass](#step-2-audit-each-wake-against-real-artifacts) |

## Attach a Double child session

`<double_artifacts_dir>` below is the `artifacts_dir` (`~/.copilot/session-state/<double_session_id>/files`) of the session running `double_watch.py`, never the supervised worker's `<worker_session_dir>/files`.

**Important sidebar rule:** `create_session` always nests the new child under whichever session calls `create_session`.
- If the user invokes `/double` **inside the worker session itself**, call `create_session` directly so `Double: <worker_name>` nests right under the worker session.
- If the user asks from **Quick Chat / General Chat** to attach Double to another session (`<worker_session_id>`), do **not** call `create_session` from General Chat (which would nest `Double` under General Chat and tag its kickoff `Received message General Chat`). Instead, either tell the user to run `/double` inside `<worker_name>`, or send a message to `<worker_session_id>` instructing it to invoke `/double` to spawn its own nested child.

When spawning `Double: <worker_name>` from inside the worker session:

1. **Resolve the current worker session.**
   Call `list_sessions_and_chats` to get the current session's `id` (`<worker_session_id>`) and `name` (`<worker_name>`).

2. **Resolve the orthogonal model and kickoff context through `context-routing`.**
   Read the first `session.start` line of `~/.copilot/session-state/<worker_session_id>/events.jsonl` to check `selectedModel`. Invoke [context-routing](../context-routing/SKILL.md) and run `show --role "double verifier"` to inspect the pool entries. Pick the zero-based `<member_index>` of the first entry whose vendor family differs from the worker's. With the shipped defaults, a `claude-*` worker selects member `1` (`gpt-5.6-sol / xhigh`) and every other worker selects member `0` (`claude-opus-5.5 / high`). Then resolve the session kickoff with `--target create_session` and `--member <member_index>`:

   ```powershell
   node "<pstack>\scripts\context-routing.mjs" resolve `
     --target create_session `
     --role "double verifier" --member <member_index> `
     --workload bounded --why "Supervise worker session claims and verification artifacts." `
     --input "<worker_events_jsonl>" `
     --host-context supported --host-source "Current create_session kickoff.context_tier schema" `
     --support supported --source "Current exact-model create_session schema"
   ```

   Copy `toolArguments.kickoff` (`model`, `reasoning_effort`, and `context_tier`, omitting `model` and `reasoning_effort` when an alias is configured) and prepend the returned `declaration` line (`PSTACK_CONTEXT_V1 ...`) as line 1 of `kickoff.prompt`.

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
       "context_tier": "<resolved_context_tier>",
       "mode": "autopilot",
       "prompt": "PSTACK_CONTEXT_V1 {...}\nSupervise worker session <worker_session_id> (<worker_name>). Invoke the double skill and enter the silent --wait verification loop. Keep all Double state (double-cursor.json, double-wake-bundle.json, double-audit.tsv, double-audit.md) in your own session artifacts_dir (<double_session_dir>/files)."
     }
   }
   ```

4. **Write the supervisor marker and confirm to the user in one sentence.**
   Write `~/.copilot/session-state/<worker_session_id>/double-supervised` containing the new `<double_session_id>` so `~/.copilot/extensions/double/extension.mjs` activates only for supervised sessions. Link the new child session and state which worker session and model it is supervising. The worker session never manually summarizes or reports claims to Double; when a new worker turn starts while Double is idle, the runtime extension hook injects a one-shot wake directive.

## How Double stays alive when the worker is active and idle when the worker is idle

A runtime Copilot extension (`~/.copilot/extensions/double/extension.mjs`, installed by `scripts/install-always-on.mjs` and bound to the installing clone) hooks `onUserPromptSubmitted` and `onPostToolUse` in every session:
- **Wake when worker is active:** On a user prompt or tool call, `extension.mjs` first checks `existsSync` for `~/.copilot/session-state/<session_id>/double-supervised` in Node so un-supervised sessions pay zero Python subprocess cost. When the marker exists, it queries `~/.copilot/data.db` (`double_watch.py <session_id> --check-child`) to check whether the attached `Double` child (`agent = 'double'`) has `is_running = 0` (`idle`), and injects a throttled `<double_supervisor_hook>` directive that wakes `Double` via `send_session_message`. `double_watch.py` ignores that wake call when evaluating `T1_HUMAN_GATE`.
- **Shut down when worker goes idle:** Inside `Double`, `double_watch.py <worker_session_id> --wait --out-dir "<double_artifacts_dir>"` runs in `mode: "sync"` and monitors the worker's state in `data.db` and `events.jsonl`. Once the worker is interrupted, shuts down, or stays idle past the grace window after `agentStop`, `double_watch.py --wait` prints `{"status": "PARENT_INACTIVE"}` and exits `0`, and `Double` immediately ends its turn with a brief status line and no further tool calls so its sidebar spinner stops (`is_running = 0`).

---

## Run a verification pass

### Step 1. Run the synchronous monitor (`--wait`)

Run the blocking monitor against `<worker_session_id>`, writing state files to your own `<double_artifacts_dir>` (`<double_session_dir>\files` from `<copilot_artifacts>`, `mode: "sync"`, `initial_wait: 600`):

```powershell
python "<skill_dir>\scripts\double_watch.py" <worker_session_id> --wait --out-dir "<double_artifacts_dir>"
```

- `double_watch.py --wait` sleeps in Python at **0 LLM tokens** while the worker session is actively running its turn.
- **If it writes `<double_artifacts_dir>\double-wake-bundle.json`:** Audit the wakes in Step 2, update `<double_artifacts_dir>\double-audit.tsv` and `<double_artifacts_dir>\double-audit.md` in Step 3, route any `REFUTED` notice in Step 4, and immediately call `double_watch.py <worker_session_id> --wait --out-dir "<double_artifacts_dir>"` again so you catch any subsequent wakes in the same turn.
- **If it prints `{"status": "PARENT_INACTIVE"}`:** The worker session has finished its turn and gone idle. End your turn immediately with a brief status line and no further tool calls so your session goes completely idle (stopping the sidebar spinner). When the worker starts a new turn later, the runtime extension hook will wake you back up.

### Step 2. Audit each wake against real artifacts

For each wake entry in `<double_artifacts_dir>\double-wake-bundle.json`:

1. **Read the bundled context.**
   - Read `recent_user_prompts` and `range_events` from `<double_artifacts_dir>\double-wake-bundle.json`.
   - Query `<worker_session_dir>\session.db` (`SELECT id, title, description, status FROM todos`) and `<worker_session_dir>\files\decisions.tsv` (if present) for the active task (`active_todo_anchor`).

2. **List the falsifiable claims in `event_range`.**
   - Extract every factual claim in `range_events` (both `content` and `reasoning`), `todos` updates, and `decisions.tsv` rows.
   - Compare `reasoning` (`reasoningText`) against user-facing `content` to catch **thought-vs-reply omissions**, where the worker discovers a discrepancy, side-effect, or unexpected table/file write in its intermediate thoughts but omits or contradicts it in the final reply.
   - Whenever `touched_files` is non-empty (including PowerShell write redirections captured via `shellToolInfo`), add the implicit invariant: *"Edits in `touched_files` did not weaken verification checks, hide failed runs, or modify files outside the requested scope without disclosure."*

3. **Check the primary evidence directly (read-only).**
   - Use `view` or `grep` on the files in `worker_cwd` and `<worker_session_dir>\files\` (JSON summaries, XML test results, logs), plus the tool outputs already included in `double-wake-bundle.json`.
   - **Truncation guard:** If a tool event in `double-wake-bundle.json` has `"output_truncated": true`, never refute an absence claim from `output_preview` alone; read the full event in `<worker_session_dir>\events.jsonl` or query the live source first.
   - Never write temporary files (`ev.txt`, `double-cursor.json`, `double-audit.tsv`) into `<worker_session_dir>\files\`. Keep all Double files in your own `<double_artifacts_dir>` (`<double_session_dir>\files\`).

### Step 3. Record in `<double_artifacts_dir>\double-audit.tsv` and the Editor Canvas

1. Append one row per audited claim to `<double_artifacts_dir>\double-audit.tsv` (`ts`, `event_range`, `trigger`, `verdict`, `claim`, `evidence_pointer`, `observed_fact`).
2. Write the updated markdown summary table to `<double_artifacts_dir>\double-audit.md` and open or refresh it in the Editor Canvas (where `scope: "workspace"` resolves relative to `<double_session_dir>\files\`):
   ```json
   {
     "canvasId": "editor",
     "instanceId": "double-audit",
     "input": {
       "scope": "workspace",
       "path": "double-audit.md",
       "title": "Double audit",
       "createIfMissing": true,
       "content": "<updated markdown summary table>"
     }
   }
   ```

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
