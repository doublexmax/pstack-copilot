from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import sqlite3
import sys
import time

sys.stdout.reconfigure(encoding="utf-8")


def copilot_home() -> pathlib.Path:
    env_home = os.environ.get("COPILOT_HOME")
    if env_home:
        return pathlib.Path(env_home).resolve()
    user_home = os.environ.get("USERPROFILE") or os.environ.get("HOME")
    base = pathlib.Path(user_home) if user_home else pathlib.Path.home()
    return (base / ".copilot").resolve()


ROOT = copilot_home() / "session-state"
PATCH_FILE_RE = re.compile(r"^\*\*\*\s+(?:Add File|Update File|Delete File|Move to):\s*(.+)$")
FACTUAL_CLAIM_RE = re.compile(
    r"\b(succeeded|passed|failed|reduced|matched|differed|reproduced|verified|confirmed|identical|no unrelated|remains additive|completed|is now the|routed correctly|fixed|root cause|because|caused by|must be|assumes)\b",
    re.I,
)
VERIFY_OR_SCOPE_RE = re.compile(
    r"(test|spec|bench|verify|assert|\.pop\(|skip|xfail|equivalen|\.build[/\\]|Tables[/\\])",
    re.I,
)


def extract_files(args_obj) -> list[str]:
    if isinstance(args_obj, str) and args_obj.lstrip().startswith("{"):
        try:
            args_obj = json.loads(args_obj)
        except json.JSONDecodeError:
            pass
    if isinstance(args_obj, dict):
        path = args_obj.get("path")
        if isinstance(path, str) and path.strip():
            return [path.strip()]
        args_obj = "\n".join(value for value in args_obj.values() if isinstance(value, str))
    found = []
    if isinstance(args_obj, str):
        for line in args_obj.splitlines():
            match = PATCH_FILE_RE.match(line)
            if match:
                path = match.group(1).strip()
                if path and path not in found:
                    found.append(path)
    return found


def is_double_wake_call(tr: dict) -> bool:
    args = str(tr.get("arguments") or "")
    return tr.get("name") == "send_session_message" and ("double_watch.py" in args or "--wait" in args)


def find_own_session_start(lines: list[str], target_sid: str) -> int:
    start_idx = 0
    for idx, line in enumerate(lines):
        if '"hook.start"' in line or '"session.start"' in line or '"session.resume"' in line:
            try:
                ev = json.loads(line)
            except Exception:
                continue
            d = ev.get("data", {})
            sid = d.get("sessionId") or d.get("input", {}).get("sessionId")
            if sid == target_sid:
                start_idx = idx
                break
    return start_idx


def extract_range_context(session_dir: pathlib.Path, lines: list[str], own_start: int, start_idx: int, end_idx: int) -> dict:
    user_prompts = []
    for idx in range(own_start, end_idx + 1):
        if '"user.message"' in lines[idx]:
            try:
                ev = json.loads(lines[idx])
                if ev.get("type") == "user.message":
                    user_prompts.append({"event": idx, "content": (ev["data"].get("content") or "")[:600]})
            except Exception:
                pass

    range_events = []
    for idx in range(start_idx, end_idx + 1):
        try:
            ev = json.loads(lines[idx])
        except Exception:
            continue
        t = ev.get("type")
        d = ev.get("data", {})
        if d.get("parentToolCallId"):
            continue
        if t == "assistant.message":
            treqs = [
                {
                    "name": tr.get("name"),
                    "intent": tr.get("intentionSummary") or tr.get("toolTitle") or "",
                    "args": str(tr.get("arguments"))[:400],
                }
                for tr in (d.get("toolRequests") or [])
            ]
            range_events.append({
                "event": idx,
                "type": t,
                "reasoning": d.get("reasoningText") or "",
                "content": d.get("content") or "",
                "tools": treqs,
            })
        elif t == "tool.execution_complete":
            res_obj = d.get("result")
            err_obj = d.get("error")
            res = str(
                res_obj.get("content") if isinstance(res_obj, dict) and res_obj.get("content") is not None
                else (
                    err_obj.get("message") if isinstance(err_obj, dict) and err_obj.get("message") is not None
                    else (err_obj if isinstance(err_obj, str) else "")
                )
            )
            range_events.append({
                "event": idx,
                "type": t,
                "success": d.get("success"),
                "output_truncated": len(res) > 4000,
                "output_total_chars": len(res),
                "output_preview": res[:4000],
            })

    cwd = ""
    ws = session_dir / "workspace.yaml"
    if ws.exists():
        for wl in ws.read_text(encoding="utf-8", errors="replace").splitlines():
            if wl.startswith("cwd:"):
                cwd = wl.split(":", 1)[1].strip()
    return {"worker_cwd": cwd, "recent_user_prompts": user_prompts[-5:], "range_events": range_events}


def scan_events(
    session_dir: pathlib.Path,
    start_idx: int = 0,
    touched: list[str] | None = None,
    verify_touched: bool = False,
    lines: list[str] | None = None,
    flush_pending: bool = False,
):
    if lines is None:
        ev_file = session_dir / "events.jsonl"
        lines = ev_file.read_text(encoding="utf-8", errors="replace").splitlines() if ev_file.exists() else []
    own_start = find_own_session_start(lines, session_dir.name)
    start_idx = max(start_idx, own_start)
    touched = list(touched or [])
    wakes = []
    last_wake_idx = start_idx
    pending_wake = None

    def emit_pending_wake(end_idx: int) -> None:
        nonlocal pending_wake, last_wake_idx, verify_touched
        wakes.append({
            "worker_session_id": session_dir.name,
            "event_range": [last_wake_idx, end_idx],
            "trigger": pending_wake["trigger"],
            "touched_files": list(touched),
            "trigger_detail": pending_wake["trigger_detail"],
        })
        touched.clear()
        verify_touched = False
        last_wake_idx = end_idx + 1
        pending_wake = None

    for idx in range(start_idx, len(lines)):
        try:
            ev = json.loads(lines[idx])
        except Exception:
            continue
        ev_type = ev.get("type")
        data = ev.get("data", {})
        if data.get("parentToolCallId"):
            continue
        if pending_wake and (
            ev_type in ("user.message", "assistant.turn_start", "assistant.message")
            or (ev_type == "hook.start" and data.get("hookType") == "userPromptSubmitted")
        ):
            emit_pending_wake(max(last_wake_idx, idx - 1))
        if ev_type == "tool.execution_start":
            shell_info = data.get("shellToolInfo") or {}
            if shell_info.get("hasWriteFileRedirection"):
                for p in shell_info.get("possiblePaths") or []:
                    if p not in touched:
                        touched.append(p)
                if VERIFY_OR_SCOPE_RE.search(str(data.get("arguments", ""))):
                    verify_touched = True
        if pending_wake:
            if ev_type == "tool.execution_start":
                pending_wake["wait_start_ids"].discard(data.get("toolCallId"))
            elif ev_type == "tool.execution_complete":
                pending_wake["wait_complete_ids"].discard(data.get("toolCallId"))
            if (
                not pending_wake["wait_start_ids"] and not pending_wake["wait_complete_ids"]
                or ev_type in ("assistant.turn_end", "session.task_complete", "session.usage_checkpoint", "session.shutdown")
                or (ev_type == "hook.start" and data.get("hookType") in ("agentStop", "sessionEnd"))
            ):
                emit_pending_wake(idx)
        if ev_type != "assistant.message":
            continue
        touched_before_msg = list(touched)
        verify_touched_before_msg = verify_touched
        content = (data.get("content") or "").strip()
        reasoning = (data.get("reasoningText") or "").strip()
        claim_text = f"{content}\n{reasoning}".strip()
        treqs = data.get("toolRequests") or []
        non_wake_treqs = [tr for tr in treqs if not is_double_wake_call(tr)]
        tnames = [tr.get("name", "") for tr in treqs]

        checkpoint_done = False
        for tr in treqs:
            name = tr.get("name", "")
            args = tr.get("arguments") or {}
            args_str = str(args)
            if name in ("apply_patch", "edit", "create"):
                for f in extract_files(args):
                    if f not in touched:
                        touched.append(f)
                if VERIFY_OR_SCOPE_RE.search(args_str):
                    verify_touched = True
                if "decisions.tsv" in args_str:
                    checkpoint_done = True
            elif name == "sql" and "status='done'" in args_str.replace(" ", ""):
                checkpoint_done = True

        is_gate = any(n in ("ask_user", "task_complete") for n in tnames) or (bool(content) and not non_wake_treqs)
        is_claim = bool(claim_text and FACTUAL_CLAIM_RE.search(claim_text))
        is_drift = bool(checkpoint_done and verify_touched and not is_gate and not is_claim)

        if is_gate or is_claim or is_drift:
            trigger = "T1_HUMAN_GATE" if is_gate else ("T2_MIDRUN_CLAIM" if is_claim else "T3_CHECKPOINT_DRIFT")
            wait_start_ids = {
                tr.get("toolCallId") for tr in treqs if tr.get("toolCallId") and tr.get("name") == "ask_user"
            }
            wait_complete_ids = {
                tr.get("toolCallId") for tr in treqs if tr.get("toolCallId") and tr.get("name") != "ask_user"
            }
            detail_source = content or reasoning
            pending_wake = {
                "msg_idx": idx,
                "trigger": trigger,
                "trigger_detail": detail_source[:240].replace("\n", " "),
                "wait_start_ids": wait_start_ids,
                "wait_complete_ids": wait_complete_ids,
                "pre_touched": touched_before_msg,
                "pre_verify_touched": verify_touched_before_msg,
            }
            if not wait_start_ids and not wait_complete_ids:
                emit_pending_wake(idx)

    next_idx = len(lines)
    if pending_wake:
        if flush_pending:
            emit_pending_wake(len(lines) - 1)
        else:
            touched = pending_wake["pre_touched"]
            verify_touched = pending_wake["pre_verify_touched"]
            next_idx = pending_wake["msg_idx"]
    return wakes, lines, own_start, next_idx, last_wake_idx, touched, verify_touched


def load_cursor(cursor_file: pathlib.Path, total_lines: int, own_start: int, worker_session_id: str) -> dict:
    if cursor_file.exists():
        try:
            state = json.loads(cursor_file.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            pass
        else:
            if isinstance(state, dict) and state.get("worker_session_id") == worker_session_id:
                return state
    start = max(own_start, total_lines - 500)
    return {
        "worker_session_id": worker_session_id,
        "next_idx": start,
        "last_wake_idx": start,
        "touched": [],
        "verify_touched": False,
    }


def save_cursor(cursor_file: pathlib.Path, state: dict) -> None:
    cursor_file.parent.mkdir(parents=True, exist_ok=True)
    cursor_file.write_text(json.dumps(state, indent=2), encoding="utf-8")


def poll_once(session_dir: pathlib.Path, out_dir: pathlib.Path, flush_pending: bool = False) -> list[dict]:
    out_dir.mkdir(parents=True, exist_ok=True)
    cursor_file = out_dir / "double-cursor.json"
    bundle_file = out_dir / "double-wake-bundle.json"
    ev_file = session_dir / "events.jsonl"
    lines = ev_file.read_text(encoding="utf-8", errors="replace").splitlines() if ev_file.exists() else []
    own_start = find_own_session_start(lines, session_dir.name)
    state = load_cursor(cursor_file, len(lines), own_start, session_dir.name)
    wakes, _, _, next_idx, last_wake, touched, verify_touched = scan_events(
        session_dir, state["last_wake_idx"],
        lines=lines, flush_pending=flush_pending,
    )
    new_wakes = [w for w in wakes if w["event_range"][1] >= state["next_idx"]]
    enriched = []
    for w in new_wakes:
        ctx = extract_range_context(session_dir, lines, own_start, w["event_range"][0], w["event_range"][1])
        enriched.append({**w, **ctx})
    if enriched:
        bundle_file.write_text(json.dumps(enriched, indent=2), encoding="utf-8")
        print(f"WROTE {len(enriched)} wake(s) to {bundle_file}", file=sys.stderr, flush=True)
        for w in new_wakes:
            print(json.dumps(w), file=sys.stderr, flush=True)
    elif bundle_file.exists():
        bundle_file.unlink()
    save_cursor(cursor_file, {
        "worker_session_id": session_dir.name,
        "next_idx": next_idx,
        "last_wake_idx": last_wake,
        "touched": touched,
        "verify_touched": verify_touched,
    })
    return new_wakes


def find_double_child(worker_sid: str) -> dict | None:
    home = copilot_home()
    db = home / "data.db"
    if not db.exists():
        return None
    conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    try:
        row = conn.execute(
            """
            SELECT c.session_id, s.title, s.is_running
            FROM chat_parent_links c
            JOIN sessions s ON s.id = c.session_id
            WHERE c.parent_session_id = ? AND s.agent = 'double' AND s.archived_at IS NULL
            ORDER BY s.created_at DESC LIMIT 1
            """,
            (worker_sid,),
        ).fetchone()
    finally:
        conn.close()
    marker = home / "session-state" / worker_sid / "double-supervised"
    if not row:
        if marker.exists():
            marker.unlink()
        return None
    if marker.parent.exists() and not marker.exists():
        marker.write_text(row[0] + "\n", encoding="utf-8")
    return {"double_session_id": row[0], "title": row[1], "is_running": bool(row[2])}


def check_parent_state(session_dir: pathlib.Path, lines: list[str], idle_grace_seconds: float = 10.0) -> tuple[bool, str]:
    db_row = None
    db = copilot_home() / "data.db"
    if db.exists():
        conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        try:
            db_row = conn.execute(
                "SELECT is_running, was_interrupted, archived_at FROM sessions WHERE id = ?",
                (session_dir.name,),
            ).fetchone()
        finally:
            conn.close()
        if db_row:
            if db_row[2] is not None:
                return False, "session_archived"
            if not db_row[0] and db_row[1]:
                return False, "session_interrupted"
    ev_file = session_dir / "events.jsonl"
    for idx in range(len(lines) - 1, -1, -1):
        try:
            ev = json.loads(lines[idx])
        except Exception:
            continue
        t = ev.get("type")
        d = ev.get("data", {})
        if t == "session.shutdown" or (t == "hook.start" and d.get("hookType") == "sessionEnd"):
            return False, "session_shutdown"
        if t in ("session.usage_checkpoint", "session.task_complete") or (t == "hook.start" and d.get("hookType") == "agentStop"):
            if db_row and db_row[0]:
                return True, "session_running"
            age = (time.time() - ev_file.stat().st_mtime) if ev_file.exists() else idle_grace_seconds
            if age >= idle_grace_seconds:
                return False, "turn_idle"
            return True, "turn_cooldown"
        if t in ("user.message", "assistant.turn_start", "tool.execution_start") or (
            t == "hook.start" and d.get("hookType") == "userPromptSubmitted"
        ):
            if db_row and not db_row[0]:
                age = (time.time() - ev_file.stat().st_mtime) if ev_file.exists() else idle_grace_seconds
                if age >= idle_grace_seconds:
                    return False, "session_inactive"
            return True, "turn_active"
    return False, "no_events"


def wait_for_wake(session_dir: pathlib.Path, out_dir: pathlib.Path, interval: float = 2.0, idle_exit_seconds: float = 10.0) -> None:
    marker = session_dir / "double-supervised"
    if session_dir.exists() and not marker.exists():
        marker.write_text("active\n", encoding="utf-8")
    ev_file = session_dir / "events.jsonl"
    last_stat_size = -1

    while True:
        current_size = ev_file.stat().st_size if ev_file.exists() else 0
        if ev_file.exists() and current_size != last_stat_size:
            last_stat_size = current_size
            wakes = poll_once(session_dir, out_dir)
            if wakes:
                return

        lines = ev_file.read_text(encoding="utf-8", errors="replace").splitlines() if ev_file.exists() else []
        active, reason = check_parent_state(session_dir, lines, idle_exit_seconds)
        if not active:
            if ev_file.exists():
                wakes = poll_once(session_dir, out_dir, flush_pending=True)
                if wakes:
                    return
            print(json.dumps({"status": "PARENT_INACTIVE", "reason": reason, "worker_session_id": session_dir.name}), flush=True)
            return

        time.sleep(interval)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("session_id", help="Worker Session ID or prefix under ~/.copilot/session-state")
    parser.add_argument("--out-dir", type=str, default=".", help="Directory for double-cursor.json and double-wake-bundle.json (defaults to Double's own cwd)")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--check-child", action="store_true", help="Print attached Double child session status from data.db")
    group.add_argument("--wait", action="store_true", help="Block at 0 tokens until a new wake fires or parent session goes idle")
    group.add_argument("--once", action="store_true", help="Single incremental poll writing double-wake-bundle.json to --out-dir")
    group.add_argument("--follow", action="store_true", help="Continuous tail loop")
    group.add_argument("--replay", action="store_true", help="Stateless full replay from own session start")
    parser.add_argument("--interval", type=float, default=2.0)
    parser.add_argument("--idle-exit-seconds", type=float, default=10.0)
    args = parser.parse_args()

    state_root = copilot_home() / "session-state"
    matches = [d for d in state_root.iterdir() if d.is_dir() and d.name.startswith(args.session_id)] if state_root.exists() else []
    if not matches:
        raise SystemExit(f"No session matching {args.session_id}")
    session_dir = matches[0]
    out_dir = pathlib.Path(args.out_dir).resolve()

    if args.check_child:
        info = find_double_child(session_dir.name)
        if info:
            print(json.dumps(info))
        return

    if args.wait:
        wait_for_wake(session_dir, out_dir, args.interval, args.idle_exit_seconds)
        return

    if args.once:
        poll_once(session_dir, out_dir)
        return

    if args.follow:
        while True:
            poll_once(session_dir, out_dir)
            time.sleep(args.interval)

    wakes, lines, own_start, total, _, _, _ = scan_events(session_dir, 0, flush_pending=True)
    enriched = [
        {**w, **extract_range_context(session_dir, lines, own_start, w["event_range"][0], w["event_range"][1])}
        for w in wakes
    ]
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "double-wake-bundle.json").write_text(json.dumps(enriched, indent=2), encoding="utf-8")
    print(f"Session {session_dir.name} (own_start={own_start}, total={total} events) -> {len(wakes)} wakes")
    for w in enriched:
        print(json.dumps(w))


if __name__ == "__main__":
    main()
