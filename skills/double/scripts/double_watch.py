import argparse
import json
import pathlib
import re
import sys
import time

sys.stdout.reconfigure(encoding="utf-8")

ROOT = pathlib.Path.home() / ".copilot" / "session-state"
FACTUAL_CLAIM_RE = re.compile(
    r"\b(succeeded|passed|failed|reduced|matched|differed|reproduced|verified|confirmed|identical|no unrelated|remains additive|completed|is now the|routed correctly|fixed|root cause)\b",
    re.I,
)
VERIFY_OR_SCOPE_RE = re.compile(
    r"(test|spec|bench|verify|assert|\.pop\(|skip|xfail|equivalen|\.build[/\\]|Tables[/\\])",
    re.I,
)


def extract_files(args_obj) -> list[str]:
    raw = str(args_obj)
    found = [l.split("File:", 1)[1].strip() for l in raw.splitlines() if "File:" in l]
    if not found and isinstance(args_obj, dict) and "path" in args_obj:
        found.append(str(args_obj["path"]))
    return found


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
        if t == "assistant.message" and not d.get("parentToolCallId"):
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
            res = str(d.get("result", {}).get("content", ""))
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


def scan_events(session_dir: pathlib.Path, start_idx: int = 0, touched: list[str] | None = None, verify_touched: bool = False):
    lines = (session_dir / "events.jsonl").read_text(encoding="utf-8", errors="replace").splitlines()
    own_start = find_own_session_start(lines, session_dir.name)
    start_idx = max(start_idx, own_start)
    touched = list(touched or [])
    wakes = []
    last_wake_idx = start_idx

    for idx in range(start_idx, len(lines)):
        try:
            ev = json.loads(lines[idx])
        except Exception:
            continue
        ev_type = ev.get("type")
        data = ev.get("data", {})
        if ev_type == "tool.execution_start":
            shell_info = data.get("shellToolInfo") or {}
            if shell_info.get("hasWriteFileRedirection"):
                for p in shell_info.get("possiblePaths") or []:
                    if p not in touched:
                        touched.append(p)
                if VERIFY_OR_SCOPE_RE.search(str(data.get("arguments", ""))):
                    verify_touched = True
            continue
        if ev_type != "assistant.message":
            continue
        content = (data.get("content") or "").strip()
        treqs = data.get("toolRequests") or []
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

        is_subagent = bool(data.get("parentToolCallId"))
        is_gate = not is_subagent and (any(n in ("ask_user", "task_complete") for n in tnames) or (bool(content) and not treqs))
        is_claim = not is_subagent and bool(content and FACTUAL_CLAIM_RE.search(content))
        is_drift = not is_subagent and bool(checkpoint_done and verify_touched and not is_gate and not is_claim)

        if is_gate or is_claim or is_drift:
            trigger = "T1_HUMAN_GATE" if is_gate else ("T2_MIDRUN_CLAIM" if is_claim else "T3_CHECKPOINT_DRIFT")
            wakes.append({
                "worker_session_id": session_dir.name,
                "event_range": [last_wake_idx, idx],
                "trigger": trigger,
                "touched_files": list(touched),
                "trigger_detail": content[:240].replace("\n", " "),
            })
            touched.clear()
            verify_touched = False
            last_wake_idx = idx + 1

    return wakes, lines, own_start, len(lines), last_wake_idx, touched, verify_touched


def load_cursor(cursor_file: pathlib.Path, total_lines: int, own_start: int) -> dict:
    if cursor_file.exists():
        return json.loads(cursor_file.read_text(encoding="utf-8"))
    start = max(own_start, total_lines - 500)
    return {"next_idx": start, "last_wake_idx": start, "touched": [], "verify_touched": False}


def save_cursor(cursor_file: pathlib.Path, state: dict) -> None:
    cursor_file.parent.mkdir(parents=True, exist_ok=True)
    cursor_file.write_text(json.dumps(state, indent=2), encoding="utf-8")


def poll_once(session_dir: pathlib.Path, out_dir: pathlib.Path) -> list[dict]:
    cursor_file = out_dir / "double-cursor.json"
    bundle_file = out_dir / "double-wake-bundle.json"
    lines = (session_dir / "events.jsonl").read_text(encoding="utf-8", errors="replace").splitlines()
    own_start = find_own_session_start(lines, session_dir.name)
    state = load_cursor(cursor_file, len(lines), own_start)
    wakes, _, _, total, last_wake, touched, verify_touched = scan_events(
        session_dir, state["last_wake_idx"], state["touched"], state["verify_touched"]
    )
    new_wakes = [w for w in wakes if w["event_range"][1] >= state["next_idx"]]
    enriched = []
    for w in new_wakes:
        ctx = extract_range_context(session_dir, lines, own_start, w["event_range"][0], w["event_range"][1])
        enriched.append({**w, **ctx})
    if enriched:
        bundle_file.write_text(json.dumps(enriched, indent=2), encoding="utf-8")
        print(f"WROTE {len(enriched)} wake(s) to {bundle_file}", flush=True)
        for w in new_wakes:
            print(json.dumps(w), flush=True)
    save_cursor(cursor_file, {
        "next_idx": total,
        "last_wake_idx": last_wake,
        "touched": touched,
        "verify_touched": verify_touched,
    })
    return new_wakes


def find_double_child(worker_sid: str) -> dict | None:
    import sqlite3
    db = pathlib.Path.home() / ".copilot" / "data.db"
    if not db.exists():
        return None
    conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
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
    if not row:
        return None
    return {"double_session_id": row[0], "title": row[1], "is_running": bool(row[2])}


def check_parent_state(session_dir: pathlib.Path, lines: list[str], idle_grace_seconds: float = 10.0) -> tuple[bool, str]:
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
            for b_idx in range(max(0, idx - 15), idx + 1):
                if "is still running after" in lines[b_idx] or "moved to background" in lines[b_idx]:
                    return True, "background_command_running"
            ev_file = session_dir / "events.jsonl"
            age = time.time() - ev_file.stat().st_mtime
            if age >= idle_grace_seconds:
                return False, "turn_idle"
            return True, "turn_cooldown"
        if t in ("user.message", "assistant.turn_start", "tool.execution_start") or (
            t == "hook.start" and d.get("hookType") == "userPromptSubmitted"
        ):
            return True, "turn_active"
    return False, "no_events"


def wait_for_wake(session_dir: pathlib.Path, out_dir: pathlib.Path, interval: float = 2.0, idle_exit_seconds: float = 10.0) -> None:
    ev_file = session_dir / "events.jsonl"
    last_stat_size = -1

    while True:
        current_size = ev_file.stat().st_size if ev_file.exists() else 0
        if current_size != last_stat_size:
            last_stat_size = current_size
            wakes = poll_once(session_dir, out_dir)
            if wakes:
                return

        lines = ev_file.read_text(encoding="utf-8", errors="replace").splitlines() if ev_file.exists() else []
        active, reason = check_parent_state(session_dir, lines, idle_exit_seconds)
        if not active:
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

    matches = [d for d in ROOT.iterdir() if d.is_dir() and d.name.startswith(args.session_id)]
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

    wakes, _, own_start, total, _, _, _ = scan_events(session_dir, 0)
    print(f"Session {session_dir.name} (own_start={own_start}, total={total} events) -> {len(wakes)} wakes")
    for w in wakes:
        print(json.dumps(w))


if __name__ == "__main__":
    main()
