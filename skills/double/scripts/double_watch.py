from __future__ import annotations

import argparse
from collections import Counter
from contextlib import contextmanager
import csv
import json
import os
import pathlib
import re
import sqlite3
import sys
import time
from typing import NamedTuple

sys.stdout.reconfigure(encoding="utf-8")


def copilot_home() -> pathlib.Path:
    env_home = os.environ.get("COPILOT_HOME")
    if env_home:
        return pathlib.Path(env_home).resolve()
    user_home = os.environ.get("USERPROFILE") or os.environ.get("HOME")
    base = pathlib.Path(user_home) if user_home else pathlib.Path.home()
    return (base / ".copilot").resolve()


PATCH_FILE_RE = re.compile(r"^\*\*\*\s+(?:Add File|Update File|Delete File|Move to):\s*(.+)$")
FACTUAL_CLAIM_RE = re.compile(
    r"\b(succeeded|passed|failed|reduced|matched|differed|reproduced|verified|confirmed|identical|no unrelated|remains additive|completed|is now the|routed correctly|fixed|root cause|because|caused by|(?<!\bi\s)(?<!\bwe\s)must be(?!\s+(?:mindful|careful|cautious|sure\b|able\b))|assumes)\b",
    re.I,
)
VERIFY_OR_SCOPE_RE = re.compile(
    r"(test|spec|bench|verify|assert|\.pop\(|skip|xfail|equivalen|\.build[/\\]|Tables[/\\])",
    re.I,
)
LEDGER_HEADER = ["ts", "event_range"]
NEW_LEDGER_ROW_RE = re.compile(r'^\s*"?\d{4}-\d{2}-\d{2}[T\s][^\t]*\t')
RESOLVED_REFS_RE = re.compile(r"\s*((?:L\d+\b[\s,;]*)+)")
VERDICT_ORDER = ("VERIFIED", "REFUTED", "UNVERIFIED", "NOTE", "RESOLVED")
OPEN_LIMIT, WAKE_LIMIT, CLAIM_LIMIT, RESOLVED_LIMIT, PREMISE_LIMIT, UNMATCHED_LIMIT = 25, 20, 15, 10, 12, 5


class LedgerRow(NamedTuple):
    line: int
    ts: str
    event_range: str
    span: tuple[int, int] | None
    trigger: str
    verdict: str
    claim: str
    evidence: str
    observed: str

    @property
    def acknowledges(self) -> bool:
        return bool(self.verdict) and self.verdict != "RESOLVED" and not (self.span is not None and self.verdict == "NOTE")

    @property
    def resolves(self) -> tuple[int, ...]:
        if self.verdict != "RESOLVED":
            return ()
        refs = []
        evidence_refs = self.evidence[9:] if self.evidence[:9].lower() == "resolves:" else ""
        for text in (self.claim, evidence_refs):
            match = RESOLVED_REFS_RE.match(text)
            if match:
                refs.extend(int(n) for n in re.findall(r"L(\d+)", match.group(1)))
        return tuple(dict.fromkeys(refs))

    @property
    def wake_key(self) -> tuple[int, int] | str:
        return self.span if self.span is not None else self.event_range


class AskGate(NamedTuple):
    event: int
    question: str
    choices: tuple[str, ...]


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


def is_likely_shell_path(path) -> bool:
    if not isinstance(path, str) or not path or re.search(r"[$*\"'<>|\r\n\t]", path):
        return False
    if "/" in path or "\\" in path:
        return not path.startswith(("http://", "https://"))
    return " " not in path and bool(re.match(r"^[A-Za-z0-9_][A-Za-z0-9_.-]*\.[A-Za-z0-9]{1,8}$", path))


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


def extract_wake_claims(lines: list[str], start_idx: int, end_idx: int) -> list[str]:
    claims = []
    for line in lines[start_idx:min(end_idx + 1, len(lines))]:
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        data = event.get("data", {})
        if event.get("type") != "assistant.message" or data.get("parentToolCallId"):
            continue
        for field in ("content", "reasoningText"):
            text = re.sub(r"```[\s\S]*?```", "", data.get(field) or "")
            message_claims = [
                segment.strip() for segment in re.split(r"(?<=[.!?])\s+|\n+", text)
                if segment.strip() and FACTUAL_CLAIM_RE.search(segment)
            ]
            if message_claims:
                claims.extend(message_claims)
                break
    return claims


def extract_range_context(session_dir: pathlib.Path, lines: list[str], own_start: int, start_idx: int, end_idx: int) -> dict:
    end_idx = min(end_idx, len(lines) - 1)
    user_prompts = []
    for idx in range(own_start, end_idx + 1):
        if '"user.message"' in lines[idx]:
            try:
                ev = json.loads(lines[idx])
                if ev.get("type") == "user.message":
                    content = ev["data"].get("content") or ""
                    if "[Double Supervisor Notice]" not in content:
                        user_prompts.append({"event": idx, "content": content[:600]})
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
    active_todo_anchor = None
    session_db = session_dir / "session.db"
    if session_db.exists():
        try:
            conn = sqlite3.connect(f"{session_db.resolve().as_uri()}?mode=ro", uri=True)
            try:
                row = conn.execute(
                    "SELECT id, title, status FROM todos WHERE status = 'in_progress' ORDER BY updated_at DESC LIMIT 1"
                ).fetchone()
                if row is None:
                    row = conn.execute("SELECT id, title, status FROM todos ORDER BY updated_at DESC LIMIT 1").fetchone()
                if row is not None:
                    active_todo_anchor = dict(zip(("id", "title", "status"), row))
            finally:
                conn.close()
        except sqlite3.Error:
            pass
    claims = extract_wake_claims(lines, start_idx, end_idx)
    return {
        "worker_cwd": cwd,
        "recent_user_prompts": user_prompts[-5:],
        "range_events": range_events,
        "active_todo_anchor": active_todo_anchor,
        "claims": claims,
        "claim_count": max(1, len(claims)),
    }


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
                    if is_likely_shell_path(p):
                        if p not in touched:
                            touched.append(p)
                        if VERIFY_OR_SCOPE_RE.search(p):
                            verify_touched = True
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
            if not detail_source and trigger == "T1_HUMAN_GATE":
                detail_source = ", ".join(
                    f"{tr.get('name')}({str(tr.get('arguments') or '')[:80]})"
                    for tr in non_wake_treqs if tr.get("name")
                )
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
        "pending_wakes": [],
    }


def write_json(path: pathlib.Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(value, indent=2), encoding="utf-8")
    temporary.replace(path)


def load_lifecycle(out_dir: pathlib.Path, worker_sid: str, double_sid: str | None = None) -> dict:
    if double_sid is None and out_dir.name == "files":
        double_sid = out_dir.parent.name
    state = {
        "worker_session_id": worker_sid,
        "double_session_id": double_sid,
        "phase": "idle",
        "queued": 0,
        "monitors": 0,
        "monitor_pid": None,
        "double_ext_pid": None,
        "worker_active": False,
        "wake_count": 0,
        "wake_accepted": False,
        "last_event_size": 0,
        "updated_at": int(time.time() * 1000),
    }
    lifecycle_file = out_dir / "double-lifecycle.json"
    if lifecycle_file.exists():
        try:
            saved = json.loads(lifecycle_file.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            pass
        else:
            if isinstance(saved, dict) and saved.get("worker_session_id") == worker_sid:
                state.update(saved)
    return state


def save_lifecycle(out_dir: pathlib.Path, state: dict) -> None:
    state["updated_at"] = int(time.time() * 1000)
    write_json(out_dir / "double-lifecycle.json", state)


def pid_alive(pid: int | None) -> bool:
    if not isinstance(pid, int) or pid <= 0:
        return False
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes

        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.GetExitCodeProcess.argtypes = (wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD))
        kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
        handle = kernel.OpenProcess(0x1000, False, pid)
        if not handle:
            return ctypes.get_last_error() == 5
        try:
            code = wintypes.DWORD()
            return bool(kernel.GetExitCodeProcess(handle, ctypes.byref(code))) and code.value == 259
        finally:
            kernel.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


@contextmanager
def lifecycle_lock(out_dir: pathlib.Path):
    out_dir.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(out_dir / "double-lifecycle.lock", isolation_level=None)
    try:
        conn.execute("BEGIN IMMEDIATE")
        yield
    finally:
        conn.close()


def parse_span(cell: str) -> tuple[int, int] | None:
    numbers = [int(n) for n in re.findall(r"\b\d+\b", cell.strip())]
    return (min(numbers), max(numbers)) if 1 <= len(numbers) <= 2 else None


def decode_ledger_record(lines: list[str], idx: int) -> tuple[list[str], int]:
    raw = lines[idx].rstrip("\r\n")
    if '"' in raw:
        try:
            return next(csv.reader([raw], delimiter="\t", strict=True, skipinitialspace=True)), 1
        except csv.Error:
            try:
                reader = csv.reader(lines[idx:], delimiter="\t", strict=True, skipinitialspace=True)
                cells = next(reader)
                consumed = max(1, reader.line_num)
                if not any(NEW_LEDGER_ROW_RE.match(cont) for cont in lines[idx + 1:idx + consumed]):
                    return cells, consumed
            except csv.Error:
                pass
    return raw.split("\t"), 1


def read_ledger(out_dir: pathlib.Path) -> list[LedgerRow]:
    audit_file = out_dir / "double-audit.tsv"
    if not audit_file.exists():
        return []
    rows = []
    lines = audit_file.read_text(encoding="utf-8-sig", errors="replace").splitlines(keepends=True)
    idx = 0
    while idx < len(lines):
        line_no = idx + 1
        cells, consumed = decode_ledger_record(lines, idx)
        idx += consumed
        stripped = [c.strip() for c in cells]
        if len(stripped) < 2 or stripped[:2] == LEDGER_HEADER:
            continue
        padded = (stripped[:6] + [" ".join(stripped[6:])] + [""] * 7)[:7]
        ts, event_range, trigger, verdict, claim, evidence, observed = (c.strip() for c in padded)
        rows.append(LedgerRow(
            line_no, ts, event_range, parse_span(event_range), trigger, verdict.upper(), claim, evidence, observed,
        ))
    return rows


def find_open_ask_gate(lines: list[str], own_start: int = 0) -> AskGate | None:
    completed_calls = set()
    markers = (
        '"user.message"', '"ask_user"', '"tool.execution_complete"',
        '"assistant.message"', '"assistant.turn_start"', '"session.shutdown"', '"sessionEnd"',
    )
    for idx in range(len(lines) - 1, max(0, own_start) - 1, -1):
        line = lines[idx]
        if not any(marker in line for marker in markers):
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        data = event.get("data", {})
        ev_type = event.get("type")
        if ev_type == "tool.execution_complete":
            completed_calls.add(data.get("toolCallId"))
            continue
        if data.get("parentToolCallId"):
            continue
        if ev_type in ("user.message", "assistant.turn_start", "session.shutdown") or (
            ev_type == "hook.start" and data.get("hookType") == "sessionEnd"
        ):
            return None
        if ev_type != "assistant.message":
            continue
        request = next((tr for tr in data.get("toolRequests") or [] if tr.get("name") == "ask_user"), None)
        if request is None:
            return None
        call_id = request.get("toolCallId")
        if call_id and call_id in completed_calls:
            return None
        args = request.get("arguments") or {}
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except json.JSONDecodeError:
                args = {"question": args}
        if not isinstance(args, dict):
            return None
        return AskGate(idx, str(args.get("question") or ""), tuple(str(c) for c in args.get("choices") or ()))
    return None


def cell(text: str, budget: int) -> str:
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) > budget:
        text = text[:budget - 3].rstrip() + "..."
    return text.replace("|", "\\|")


def table(header: tuple[str, ...], body: list[tuple[str, ...]]) -> list[str]:
    return [
        f"| {' | '.join(header)} |",
        f"| {' | '.join('---' for _ in header)} |",
        *(f"| {' | '.join(row)} |" for row in body),
    ]


def label(key: tuple[int, int] | str) -> str:
    return f"[{key[0]}, {key[1]}]" if isinstance(key, tuple) else cell(key, 60)


def match_resolutions(rows: list[LedgerRow]) -> tuple[
    list[LedgerRow], list[tuple[LedgerRow, LedgerRow]], list[tuple[LedgerRow, int | None]],
]:
    by_line = {r.line: r for r in rows}
    resolved_by: dict[int, LedgerRow] = {}
    unmatched: list[tuple[LedgerRow, int | None]] = []
    for row in rows:
        refs = row.resolves
        if row.verdict == "RESOLVED" and not refs:
            unmatched.append((row, None))
        for ref in refs:
            target = by_line.get(ref)
            if target is not None and target.verdict == "REFUTED" and ref < row.line:
                resolved_by.setdefault(ref, row)
            else:
                unmatched.append((row, ref))
    open_rows = [r for r in reversed(rows) if r.verdict == "REFUTED" and r.line not in resolved_by]
    resolutions = sorted(
        ((by_line[ref], res) for ref, res in resolved_by.items()), key=lambda pair: (-pair[1].line, -pair[0].line),
    )
    return open_rows, resolutions, unmatched


def render_audit_markdown(worker_session_id: str, rows: list[LedgerRow], gate: AskGate | None) -> str:
    open_rows, resolutions, unmatched = match_resolutions(rows)
    newest = list(reversed(rows))
    wakes: dict[tuple[int, int] | str, list[LedgerRow]] = {}
    for row in rows:
        wakes.setdefault(row.wake_key, []).append(row)
    counts = Counter(r.verdict for r in rows)
    spans = [r for r in rows if r.span is not None]
    last = max(spans, key=lambda r: (r.span[1], r.line), default=None)

    def verdict_summary(counts: Counter) -> str:
        names = [v for v in VERDICT_ORDER if counts[v]] + sorted(v for v in counts if v not in VERDICT_ORDER)
        return cell(", ".join(f"{counts[v]} {v or '(blank)'}" for v in names) or "none", 200)

    out = ["# Double audit", ""]
    out += table(("Status", "Value"), [
        ("Worker session", f"`{cell(worker_session_id, 80)}`"),
        ("Last audited event", "none" if last is None else cell(
            f"{last.span[1]} in wake {label(last.wake_key)}, {last.trigger}, {last.ts[:16]}", 280,
        )),
        ("Ledger", f"[double-audit.tsv](double-audit.tsv), {len(rows)} rows across {len(wakes)} wakes"),
        ("Verdicts", verdict_summary(counts)),
        ("Refutations", f"{len(open_rows)} open, {len(resolutions)} resolved"),
    ])

    if gate is not None:
        containing = {
            r.span for r in rows
            if r.span is not None and r.verdict != "RESOLVED" and r.span[0] <= gate.event <= r.span[1]
        }
        gate_span = min(containing, key=lambda span: (span[1] - span[0], -span[1]), default=None)
        premises = [r for r in rows if gate_span is not None and r.span == gate_span and r.verdict != "RESOLVED"]
        out += ["", "## Pending question", "", f"Worker event {gate.event} is waiting on this `ask_user` question.", ""]
        out.append(f"> {cell(gate.question, 400)}")
        if gate.choices:
            out += ["", "Choices:"] + [f"- {cell(choice, 150)}" for choice in gate.choices[:6]]
        out.append("")
        if premises:
            out += table(("Line", "Verdict", "Premise", "Observed fact"), [
                (f"L{r.line}", cell(r.verdict, 40), cell(r.claim, 200), cell(r.observed, 280))
                for r in premises[:PREMISE_LIMIT]
            ])
            if len(premises) > PREMISE_LIMIT:
                out += ["", f"{len(premises) - PREMISE_LIMIT} more premise rows are in double-audit.tsv."]
        else:
            out.append("Double has not recorded verdicts for this question yet.")

    out += ["", f"## Open refutations ({len(open_rows)})", ""]
    if open_rows:
        out += table(("Line", "Event range", "Claim", "Observed fact", "Evidence"), [
            (f"L{r.line}", label(r.wake_key), cell(r.claim, 200), cell(r.observed, 280), cell(r.evidence, 120))
            for r in open_rows[:OPEN_LIMIT]
        ])
        hidden = open_rows[OPEN_LIMIT:]
        if hidden:
            out += ["", f"{len(hidden)} older open refutations, L{hidden[-1].line} to L{hidden[0].line}, are in double-audit.tsv."]
    else:
        out.append("None.")

    recent_wakes = sorted(wakes.items(), key=lambda item: -item[1][-1].line)[:WAKE_LIMIT]
    out += ["", f"## Recent wakes (last {len(recent_wakes)} of {len(wakes)})", ""]
    if recent_wakes:
        out += table(("Event range", "Trigger", "Audited", "Verdicts"), [
            (
                label(key), cell(", ".join(dict.fromkeys(r.trigger for r in group)), 60), cell(group[-1].ts[:16], 16),
                verdict_summary(Counter(r.verdict for r in group)),
            )
            for key, group in recent_wakes
        ])
    else:
        out.append("None.")

    claims = [r for r in newest if r.verdict not in ("REFUTED", "RESOLVED")][:CLAIM_LIMIT]
    out += ["", f"## Recent claims (last {len(claims)})", ""]
    if claims:
        out += table(("Line", "Event range", "Verdict", "Claim", "Observed fact"), [
            (f"L{r.line}", label(r.wake_key), cell(r.verdict, 40), cell(r.claim, 200), cell(r.observed, 240)) for r in claims
        ])
    else:
        out.append("None.")

    out += ["", f"## Resolved refutations ({len(resolutions)})", ""]
    if resolutions:
        out += table(("Line", "Resolved by", "Claim", "Fix evidence"), [
            (f"L{ref.line}", f"L{res.line}", cell(ref.claim, 160), cell(res.evidence or res.observed, 120))
            for ref, res in resolutions[:RESOLVED_LIMIT]
        ])
        if len(resolutions) > RESOLVED_LIMIT:
            out += ["", f"{len(resolutions) - RESOLVED_LIMIT} older resolutions are in double-audit.tsv."]
    else:
        out.append("None.")
    if unmatched:
        out += ["", "These RESOLVED citations close no earlier REFUTED row.", ""]
        out += [
            f"- L{row.line} cites {'no L<line> id' if ref is None else f'L{ref}'}."
            for row, ref in unmatched[-UNMATCHED_LIMIT:]
        ]
        if len(unmatched) > UNMATCHED_LIMIT:
            out += ["", f"{len(unmatched) - UNMATCHED_LIMIT} more unmatched citations are in double-audit.tsv."]
    return "\n".join(out) + "\n"


def sync_audit_markdown(
    out_dir: pathlib.Path,
    worker_session_id: str = "unknown",
    rows: list[LedgerRow] | None = None,
    lines: list[str] | None = None,
    own_start: int = 0,
) -> None:
    if rows is None:
        rows = read_ledger(out_dir)
    if not rows:
        return
    if worker_session_id == "unknown":
        for name in ("double-cursor.json", "double-lifecycle.json"):
            try:
                saved = json.loads((out_dir / name).read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if isinstance(saved, dict) and isinstance(saved.get("worker_session_id"), str) and saved["worker_session_id"]:
                worker_session_id = saved["worker_session_id"]
                break
    if lines is None and worker_session_id != "unknown":
        ev_file = copilot_home() / "session-state" / worker_session_id / "events.jsonl"
        if ev_file.exists():
            lines = ev_file.read_text(encoding="utf-8", errors="replace").splitlines()
            own_start = find_own_session_start(lines, worker_session_id)
    md_file = out_dir / "double-audit.md"
    rendered = render_audit_markdown(worker_session_id, rows, find_open_ask_gate(lines or [], own_start))
    if md_file.exists() and md_file.read_text(encoding="utf-8", errors="replace") == rendered:
        return
    temporary = md_file.with_name(f"{md_file.name}.{os.getpid()}.tmp")
    with temporary.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(rendered)
    temporary.replace(md_file)


def read_audit_ranges(out_dir: pathlib.Path, *, sync_markdown: bool = False) -> list[tuple[int, int] | None]:
    if sync_markdown:
        sync_audit_markdown(out_dir)
    return [row.span for row in read_ledger(out_dir) if row.acknowledges]


def wake_acknowledged(wake: dict, audit_ranges: list[tuple[int, int] | None], lines: list[str] | None = None) -> bool:
    start, end = wake["event_range"]
    required = max(1, len(extract_wake_claims(lines or [], start, end)))
    count = sum(r is not None and max(r[0], start) <= min(r[1], end) for r in audit_ranges)
    if count > 0:
        return count >= required
    new_rows = audit_ranges[wake.get("delivered_audit_rows", 0):]
    return len(new_rows) >= required and all(r is None for r in new_rows)


def poll_once(session_dir: pathlib.Path, out_dir: pathlib.Path, flush_pending: bool = False, replay: bool = False) -> list[dict]:
    out_dir.mkdir(parents=True, exist_ok=True)
    cursor_file = out_dir / "double-cursor.json"
    bundle_file = out_dir / "double-wake-bundle.json"
    ev_file = session_dir / "events.jsonl"
    lines = ev_file.read_text(encoding="utf-8", errors="replace").splitlines() if ev_file.exists() else []
    own_start = find_own_session_start(lines, session_dir.name)
    state = (
        {"next_idx": own_start, "last_wake_idx": own_start, "pending_wakes": []}
        if replay else load_cursor(cursor_file, len(lines), own_start, session_dir.name)
    )
    wakes, _, _, next_idx, last_wake, touched, verify_touched = scan_events(
        session_dir, state["last_wake_idx"],
        lines=lines, flush_pending=flush_pending or replay,
    )
    new_wakes = [w for w in wakes if w["event_range"][1] >= state["next_idx"]]
    rows = read_ledger(out_dir)
    audit_ranges = [row.span for row in rows if row.acknowledges]
    pending = {tuple(w["event_range"]): w for w in state.get("pending_wakes", [])}
    for w in new_wakes:
        pending.setdefault(tuple(w["event_range"]), {**w, "delivered_audit_rows": len(audit_ranges)})
    pending_wakes = [w for w in pending.values() if not wake_acknowledged(w, audit_ranges, lines)]
    if not pending_wakes:
        sync_audit_markdown(out_dir, worker_session_id=session_dir.name, rows=rows, lines=lines, own_start=own_start)
    write_json(cursor_file, {
        "worker_session_id": session_dir.name,
        "next_idx": next_idx,
        "last_wake_idx": last_wake,
        "touched": touched,
        "verify_touched": verify_touched,
        "pending_wakes": pending_wakes,
    })
    open_rows, _, _ = match_resolutions(rows)
    enriched = []
    for w in pending_wakes:
        ctx = extract_range_context(session_dir, lines, own_start, w["event_range"][0], w["event_range"][1])
        enriched.append({
            **w, **ctx,
            "open_refutations": [
                {
                    "line": f"L{r.line}",
                    "event_range": list(r.span) if r.span is not None else r.event_range,
                    "claim": r.claim,
                    "evidence_pointer": r.evidence,
                    "observed_fact": r.observed,
                }
                for r in open_rows[:OPEN_LIMIT]
            ],
        })
    if enriched or replay:
        write_json(bundle_file, enriched)
    elif bundle_file.exists():
        bundle_file.unlink()
    if replay:
        print(f"Session {session_dir.name} (own_start={own_start}, total={len(lines)} events) -> {len(enriched)} wakes")
        for w in enriched:
            print(json.dumps(w))
    elif enriched:
        print(f"WROTE {len(enriched)} wake(s) to {bundle_file}", file=sys.stderr, flush=True)
        for w in pending_wakes:
            print(json.dumps(w), file=sys.stderr, flush=True)
    return pending_wakes


def resolve_session_dir(state_root: pathlib.Path, session_id: str) -> pathlib.Path:
    exact = state_root / session_id
    if exact.is_dir():
        return exact
    matches = [
        d for d in sorted(state_root.iterdir(), key=lambda p: p.name)
        if d.is_dir() and d.name.startswith(session_id)
    ] if state_root.exists() else []
    if not matches:
        raise SystemExit(f"No session matching {session_id}")
    if len(matches) > 1:
        raise SystemExit(
            f"Ambiguous session prefix {session_id!r} matches {len(matches)} sessions: "
            f"{', '.join(m.name for m in matches[:5])}"
        )
    return matches[0]


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
                active_window = max(idle_grace_seconds, 120.0) if d.get("parentToolCallId") else idle_grace_seconds
                age = (time.time() - ev_file.stat().st_mtime) if ev_file.exists() else active_window
                if age >= active_window:
                    return False, "session_inactive"
            return True, "turn_active"
    return False, "no_events"


def wait_for_wake(session_dir: pathlib.Path, out_dir: pathlib.Path, interval: float = 2.0, idle_exit_seconds: float = 10.0) -> None:
    with lifecycle_lock(out_dir):
        lifecycle = load_lifecycle(out_dir, session_dir.name)
        monitor_pid = lifecycle.get("monitor_pid")
        if lifecycle["phase"] == "watching" and monitor_pid != os.getpid() and pid_alive(monitor_pid):
            print(json.dumps({
                "status": "DUPLICATE_MONITOR_SUPPRESSED",
                "monitor_pid": monitor_pid,
                "worker_session_id": session_dir.name,
            }), flush=True)
            return
        lifecycle.update(phase="watching", queued=0, monitors=1, monitor_pid=os.getpid(), wake_accepted=False)
        save_lifecycle(out_dir, lifecycle)
    marker = session_dir / "double-supervised"
    if session_dir.exists() and not marker.exists():
        marker.write_text("active\n", encoding="utf-8")
    ev_file = session_dir / "events.jsonl"
    last_stat_size = -1

    while True:
        current_size = ev_file.stat().st_size if ev_file.exists() else 0
        if current_size != last_stat_size:
            last_stat_size = current_size
            wakes = poll_once(session_dir, out_dir)
            if wakes:
                break

        lines = ev_file.read_text(encoding="utf-8", errors="replace").splitlines() if ev_file.exists() else []
        active, reason = check_parent_state(session_dir, lines, idle_exit_seconds)
        if not active:
            wakes = poll_once(session_dir, out_dir, flush_pending=True)
            if wakes:
                break
            lines = ev_file.read_text(encoding="utf-8", errors="replace").splitlines() if ev_file.exists() else []
            active, reason = check_parent_state(session_dir, lines, idle_exit_seconds)
            if active:
                continue
            with lifecycle_lock(out_dir):
                current_size = ev_file.stat().st_size if ev_file.exists() else 0
                if current_size != last_stat_size:
                    continue
                lifecycle = load_lifecycle(out_dir, session_dir.name)
                lifecycle.update(
                    phase="idle", queued=0, monitors=0, monitor_pid=None, worker_active=False, wake_accepted=False,
                    last_event_size=current_size,
                )
                save_lifecycle(out_dir, lifecycle)
            print(json.dumps({"status": "PARENT_INACTIVE", "reason": reason, "worker_session_id": session_dir.name}), flush=True)
            return

        time.sleep(interval)

    with lifecycle_lock(out_dir):
        lifecycle = load_lifecycle(out_dir, session_dir.name)
        lifecycle.update(phase="watching", queued=0, monitors=1, monitor_pid=None, wake_accepted=False)
        save_lifecycle(out_dir, lifecycle)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("session_id", help="Worker Session ID or prefix under ~/.copilot/session-state")
    parser.add_argument("--out-dir", type=str, default=".", help="Directory for double-cursor.json and double-wake-bundle.json (defaults to Double's own cwd)")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--wait", action="store_true", help="Block at 0 tokens until a new wake fires or parent session goes idle")
    group.add_argument("--once", action="store_true", help="Single incremental poll writing double-wake-bundle.json to --out-dir")
    group.add_argument("--follow", action="store_true", help="Continuous tail loop")
    group.add_argument("--replay", action="store_true", help="Replay from own session start and seed incremental state")
    parser.add_argument("--interval", type=float, default=2.0)
    parser.add_argument("--idle-exit-seconds", type=float, default=10.0)
    args = parser.parse_args()

    state_root = copilot_home() / "session-state"
    session_dir = resolve_session_dir(state_root, args.session_id)
    out_dir = pathlib.Path(args.out_dir).resolve()

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

    poll_once(session_dir, out_dir, replay=True)


if __name__ == "__main__":
    main()
