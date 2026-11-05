import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { joinSession } from "@github/copilot-sdk/extension";

export const ENTRY_VERSION = "pstack-double-extension-v1";
const pstackRoot = join(homedir(), ".copilot", "pstack");
const watchScript = join(pstackRoot, "skills", "double", "scripts", "double_watch.py");
const wakeTimeoutMs = 15_000;
const wakeAcceptedTimeoutMs = 300_000;
let session;
let doubleTurnActive = false;
let doubleRuntimeReady = false;
let runtimeWakeDispatches = 0;

function copilotHome() {
    return process.env.COPILOT_HOME || join(process.env.USERPROFILE || process.env.HOME || homedir(), ".copilot");
}

function buildWakePrompt(workerSessionId, outDir) {
    return `Parent session active; run python "${watchScript}" ${workerSessionId} --wait --out-dir "${outDir}" and append audit rows to double-audit.tsv in "${outDir}".`;
}

export function hasSupervisorMarker(sessionId, home = copilotHome()) {
    if (typeof sessionId !== "string" || !sessionId) return false;
    const sessionDir = join(home, "session-state", sessionId);
    return existsSync(join(sessionDir, "double-supervised"))
        || existsSync(join(sessionDir, "files", "double-supervised"));
}

function findPair(column, sessionId) {
    if (typeof sessionId !== "string" || !sessionId) return null;
    const path = join(copilotHome(), "data.db");
    if (!existsSync(path)) return null;
    let db;
    try {
        db = new DatabaseSync(path, { readOnly: true });
        return db.prepare(`
            SELECT s.*, c.parent_session_id AS worker_session_id, c.session_id AS double_session_id,
                   w.is_running AS worker_is_running
            FROM chat_parent_links c
            JOIN sessions s ON s.id = c.session_id
            LEFT JOIN sessions w ON w.id = c.parent_session_id
            WHERE ${column} = ? AND s.agent = 'double' AND s.archived_at IS NULL
            ORDER BY s.created_at DESC LIMIT 1
        `).get(sessionId) || null;
    } catch {
        return null;
    } finally {
        db?.close();
    }
}

function supervisorFor(sessionId) {
    return (hasSupervisorMarker(sessionId) ? findPair("c.parent_session_id", sessionId) : null)
        || findPair("c.session_id", sessionId);
}

function readJson(path) {
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
        if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
        throw error;
    }
}

function loadLifecycle(outDir, info) {
    const state = {
        worker_session_id: info.worker_session_id,
        double_session_id: info.double_session_id,
        phase: "idle",
        queued: 0,
        monitors: 0,
        monitor_pid: null,
        double_ext_pid: null,
        worker_active: false,
        wake_count: 0,
        wake_accepted: false,
        last_event_size: 0,
        updated_at: Date.now(),
    };
    const saved = readJson(join(outDir, "double-lifecycle.json"));
    return saved?.worker_session_id === info.worker_session_id && saved?.double_session_id === info.double_session_id
        ? { ...state, ...saved } : state;
}

function saveLifecycle(outDir, state) {
    const path = join(outDir, "double-lifecycle.json");
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(state, null, 2));
    renameSync(temporary, path);
}

function transition(outDir, state, phase, now) {
    Object.assign(state, {
        phase,
        queued: phase === "wake_pending" ? 1 : 0,
        monitors: phase === "watching" ? 1 : 0,
        monitor_pid: phase === "watching" ? state.monitor_pid : null,
        wake_accepted: phase === "wake_pending" ? state.wake_accepted : false,
        updated_at: now,
    });
    saveLifecycle(outDir, state);
}

function pidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error.code === "EPERM";
    }
}

function lifecycleLock(outDir) {
    mkdirSync(outDir, { recursive: true });
    const db = new DatabaseSync(join(outDir, "double-lifecycle.lock"));
    try {
        db.exec("PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE");
    } catch (error) {
        db.close();
        throw error;
    }
    return () => db.close();
}

async function reconcileSupervisorLifecycle(sessionId, workerActivity = false, info = supervisorFor(sessionId)) {
    if (!info) return;
    const outDir = join(copilotHome(), "session-state", info.double_session_id, "files");
    let wakePrompt;
    const release = lifecycleLock(outDir);
    try {
        const now = Date.now();
        const lifecyclePath = join(outDir, "double-lifecycle.json");
        const hadLifecycleFile = existsSync(lifecyclePath);
        const state = loadLifecycle(outDir, info);
        if (session?.sessionId === info.double_session_id) {
            ensureDoubleRuntime();
            state.double_ext_pid = process.pid;
            if (!hadLifecycleFile) {
                transition(outDir, state, "wake_pending", now);
                return;
            }
        }
        state.worker_active ||= Boolean(info.worker_is_running) || (workerActivity && sessionId === info.worker_session_id);
        if (state.phase === "watching") {
            if (info.is_running || doubleTurnActive || pidAlive(state.monitor_pid)) {
                state.queued = 0;
                state.monitors = 1;
                saveLifecycle(outDir, state);
                return;
            }
            transition(outDir, state, "idle", now);
        }
        if (state.phase === "wake_pending") {
            if (info.is_running || doubleTurnActive) {
                transition(outDir, state, "watching", now);
                return;
            }
            if ((state.wake_accepted && !info.was_interrupted && now - state.updated_at <= wakeAcceptedTimeoutMs)
                || now - state.updated_at <= wakeTimeoutMs) {
                state.queued = 1;
                state.monitors = 0;
                state.monitor_pid = null;
                saveLifecycle(outDir, state);
                return;
            }
            transition(outDir, state, "idle", now);
        }
        if (state.phase !== "idle") return;
        if (state.phase === "idle" && !info.is_running) {
            doubleTurnActive = false;
        }
        const eventsPath = join(copilotHome(), "session-state", info.worker_session_id, "events.jsonl");
        const eventSize = existsSync(eventsPath) ? statSync(eventsPath).size : 0;
        const cursor = readJson(join(outDir, "double-cursor.json"));
        const hasPending = cursor?.worker_session_id === info.worker_session_id && cursor?.pending_wakes?.length > 0;
        const needsAttention = state.worker_active || Boolean(info.worker_is_running) || hasPending || eventSize > state.last_event_size;
        if (!needsAttention || info.is_running || doubleTurnActive) {
            saveLifecycle(outDir, state);
            return;
        }
        if (session?.sessionId !== info.double_session_id && pidAlive(state.double_ext_pid) && now - state.updated_at <= 3000) {
            saveLifecycle(outDir, state);
            return;
        }
        state.wake_count += 1;
        state.wake_accepted = false;
        transition(outDir, state, "wake_pending", now);
        wakePrompt = buildWakePrompt(info.worker_session_id, outDir);
    } finally {
        release();
    }
    try {
        if (session?.sessionId === info.double_session_id && typeof session.send === "function") {
            await session.send({ prompt: wakePrompt });
        } else if (typeof session?.rpc?.tools?.execute === "function") {
            runtimeWakeDispatches += 1;
            try {
                const result = await session.rpc.tools.execute({
                    name: "send_session_message",
                    arguments: { session_id: info.double_session_id, delivery_mode: "immediate", message: wakePrompt },
                });
                if (result?.permissionDecision === "deny"
                    || (typeof result?.resultType === "string" && result.resultType !== "success")
                    || Boolean(result?.error)
                    || (typeof result?.textResultForLlm === "string" && result.textResultForLlm.startsWith("Denied by preToolUse hook:"))
                    || (typeof result === "string" && result.startsWith("Denied by preToolUse hook:"))) {
                    throw new Error("Double supervisor runtime wake was denied or failed.");
                }
            } finally {
                runtimeWakeDispatches -= 1;
            }
        } else {
            throw new Error("Double supervisor runtime transport is missing.");
        }
        const release = lifecycleLock(outDir);
        try {
            const state = loadLifecycle(outDir, info);
            if (state.phase === "wake_pending") {
                state.wake_accepted = true;
                saveLifecycle(outDir, state);
            }
        } finally {
            release();
        }
    } catch {
        const release = lifecycleLock(outDir);
        try {
            const state = loadLifecycle(outDir, info);
            transition(outDir, state, "idle", Date.now());
        } finally {
            release();
        }
    }
}

const onWorkerActivity = (_input, invocation) => reconcileSupervisorLifecycle(invocation.sessionId, true);

session = await joinSession({
    hooks: {
        onSessionStart: onWorkerActivity,
        onUserPromptSubmitted: onWorkerActivity,
        onPreToolUse: async (input, invocation) => {
            const info = supervisorFor(invocation.sessionId);
            const message = input.toolArgs?.message;
            if (input.toolName === "send_session_message" && info
                && input.toolArgs?.session_id === info.double_session_id && typeof message === "string"
                && (message.includes("double_watch.py") || message.includes("--wait"))) {
                const outDir = join(copilotHome(), "session-state", info.double_session_id, "files");
                if (runtimeWakeDispatches > 0 && message === buildWakePrompt(info.worker_session_id, outDir)) {
                    return undefined;
                }
                return {
                    permissionDecision: "deny",
                    permissionDecisionReason: "Double supervisor activation is runtime-owned.",
                };
            }
            await reconcileSupervisorLifecycle(invocation.sessionId, true, info);
        },
        onPostToolUse: onWorkerActivity,
        onPostToolUseFailure: onWorkerActivity,
        onSessionEnd: async (_input, invocation) => {
            await reconcileSupervisorLifecycle(invocation.sessionId);
        },
    },
});

function ensureDoubleRuntime() {
    if (doubleRuntimeReady) return;
    doubleRuntimeReady = true;
    session.on((event) => {
        if (event.type === "assistant.turn_start") doubleTurnActive = true;
        if (
            event.type === "session.idle"
            || event.type === "session.usage_checkpoint"
            || event.type === "session.task_complete"
            || ((event.type === "hook.start" || event.type === "hook.end") && event.data?.hookType === "agentStop")
        ) {
            doubleTurnActive = false;
            return reconcileSupervisorLifecycle(session.sessionId);
        }
    });
    setInterval(() => {
        reconcileSupervisorLifecycle(session.sessionId).catch((error) => console.error("Double lifecycle reconciliation failed", error));
    }, 1000).unref();
}

await reconcileSupervisorLifecycle(session.sessionId);
