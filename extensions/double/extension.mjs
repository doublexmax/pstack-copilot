import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

export const ENTRY_VERSION = "pstack-double-extension-v1";
export const NATIVE_HOOK_FLAG = "--pstack-double-hook";
const pstackRoot = join(homedir(), ".copilot", "pstack");
const watchScript = join(pstackRoot, "skills", "double", "scripts", "double_watch.py");
const wakeTimeoutMs = 15_000;
const wakeAcceptedTimeoutMs = 300_000;
const wakeGrantFile = "double-wake-grant.json";
const wakeGrantProtocol = "pstack-double-wake-grant-v1";
const sessionIdPattern = /^[A-Za-z0-9_-]+$/;
const denyWake = Object.freeze({
    permissionDecision: "deny",
    permissionDecisionReason: "Double supervisor activation is runtime-owned.",
});
const ignoredWakeToolCalls = new Set();
let session;
let ownTurnActive = false;
let doubleRuntimeReady = false;

function copilotHome() {
    return process.env.COPILOT_HOME || join(process.env.USERPROFILE || process.env.HOME || homedir(), ".copilot");
}

function buildWakePrompt(workerSessionId, outDir) {
    return `Parent session active; run python "${watchScript}" ${workerSessionId} --wait --out-dir "${outDir}" and append audit rows to double-audit.tsv in "${outDir}".`;
}

export function hasSupervisorMarker(sessionId, home = copilotHome()) {
    if (typeof sessionId !== "string" || !sessionIdPattern.test(sessionId)) return false;
    const sessionDir = join(home, "session-state", sessionId);
    return existsSync(join(sessionDir, "double-supervised"))
        || existsSync(join(sessionDir, "files", "double-supervised"));
}

function findPair(column, sessionId, home = copilotHome()) {
    if (typeof sessionId !== "string" || !sessionIdPattern.test(sessionId)) return null;
    const path = join(home, "data.db");
    if (!existsSync(path)) return null;
    let db;
    try {
        const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
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

function supervisorFor(sessionId, home = copilotHome()) {
    return (hasSupervisorMarker(sessionId, home) ? findPair("c.parent_session_id", sessionId, home) : null)
        || findPair("c.session_id", sessionId, home);
}

function isWakeLike(message) {
    return typeof message === "string" && (message.includes("double_watch.py") || message.includes("--wait"));
}

function toolArguments(value) {
    if (typeof value === "string") {
        try {
            value = JSON.parse(value);
        } catch {
            return null;
        }
    }
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function issueWakeGrant(outDir, info, wakeCount, message, now) {
    const grant = {
        protocol: wakeGrantProtocol,
        grant_id: randomUUID(),
        issuer_pid: process.pid,
        worker_session_id: info.worker_session_id,
        double_session_id: info.double_session_id,
        wake_count: wakeCount,
        message,
        expires_at: now + wakeTimeoutMs,
    };
    const path = join(outDir, wakeGrantFile);
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(grant));
    renameSync(temporary, path);
    return grant;
}

function readGrant(path) {
    const grant = readJson(path);
    return grant?.protocol === wakeGrantProtocol && typeof grant.grant_id === "string" && grant.grant_id
        ? grant : null;
}

function revokeWakeGrant(outDir, grant) {
    const path = join(outDir, wakeGrantFile);
    try {
        if (readGrant(path)?.grant_id === grant.grant_id) rmSync(path, { force: true });
    } catch {}
}

function grantAuthorizes(grant, request, info, now) {
    return Boolean(grant)
        && grant.worker_session_id === info.worker_session_id
        && grant.double_session_id === info.double_session_id
        && grant.double_session_id === request.targetSessionId
        && grant.message === request.message
        && Number.isSafeInteger(grant.wake_count) && grant.wake_count >= 1
        && Number.isSafeInteger(grant.expires_at) && now <= grant.expires_at
        && pidAlive(grant.issuer_pid);
}

function claimWakeGrant(outDir, request, info, now) {
    const path = join(outDir, wakeGrantFile);
    if (!grantAuthorizes(readGrant(path), request, info, now)) return false;
    const claimed = `${path}.${process.pid}.${randomUUID()}.claim`;
    for (let retry = 0; ; retry += 1) {
        try {
            renameSync(path, claimed);
            break;
        } catch (error) {
            if (!["EPERM", "EBUSY"].includes(error.code) || retry >= 3) return false;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
    }
    try {
        return grantAuthorizes(readGrant(claimed), request, info, now);
    } finally {
        rmSync(claimed, { force: true });
    }
}

export function guardPreToolUse(event, { home = copilotHome(), now = Date.now() } = {}) {
    if (event?.toolName !== "send_session_message") return {};
    const args = toolArguments(event.toolArgs);
    if (!isWakeLike(args?.message) || typeof event.sessionId !== "string" || !sessionIdPattern.test(event.sessionId)) return {};
    const info = supervisorFor(event.sessionId, home);
    if (!info || args.session_id !== info.double_session_id) return {};
    const request = { targetSessionId: args.session_id, message: args.message };
    try {
        const outDir = join(home, "session-state", info.double_session_id, "files");
        return claimWakeGrant(outDir, request, info, now) ? {} : denyWake;
    } catch {
        return denyWake;
    }
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
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
    const db = new DatabaseSync(join(outDir, "double-lifecycle.lock"));
    try {
        db.exec("PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE");
    } catch (error) {
        db.close();
        throw error;
    }
    return () => db.close();
}

function selfTurnActive(info) {
    return session?.sessionId === info.double_session_id && ownTurnActive;
}

async function reconcileSupervisorLifecycle(sessionId, workerActivity = false, info = supervisorFor(sessionId)) {
    if (!info) return;
    const outDir = join(copilotHome(), "session-state", info.double_session_id, "files");
    let wakePrompt;
    let wakeCount = 0;
    let wakeGrant;
    const release = lifecycleLock(outDir);
    try {
        const now = Date.now();
        const lifecyclePath = join(outDir, "double-lifecycle.json");
        const hadLifecycleFile = existsSync(lifecyclePath);
        const state = loadLifecycle(outDir, info);
        const priorUpdatedAt = state.updated_at;
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
            if (info.is_running || selfTurnActive(info) || pidAlive(state.monitor_pid)) {
                state.queued = 0;
                state.monitors = 1;
                saveLifecycle(outDir, state);
                return;
            }
            transition(outDir, state, "idle", now);
        }
        if (state.phase === "wake_pending") {
            if (info.is_running || selfTurnActive(info)) {
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
        if (!info.is_running && session?.sessionId === info.double_session_id) {
            ownTurnActive = false;
        }
        const eventsPath = join(copilotHome(), "session-state", info.worker_session_id, "events.jsonl");
        const eventSize = existsSync(eventsPath) ? statSync(eventsPath).size : 0;
        const cursor = readJson(join(outDir, "double-cursor.json"));
        const hasPending = cursor?.worker_session_id === info.worker_session_id && cursor?.pending_wakes?.length > 0;
        const needsAttention = state.worker_active || Boolean(info.worker_is_running) || hasPending || eventSize > state.last_event_size;
        if (!needsAttention || info.is_running || selfTurnActive(info)) {
            saveLifecycle(outDir, state);
            return;
        }
        if (session?.sessionId !== info.double_session_id && pidAlive(state.double_ext_pid) && now - priorUpdatedAt <= 3000) {
            saveLifecycle(outDir, state);
            return;
        }
        wakeCount = state.wake_count + 1;
        wakePrompt = buildWakePrompt(info.worker_session_id, outDir);
        if (session?.sessionId !== info.double_session_id) {
            wakeGrant = issueWakeGrant(outDir, info, wakeCount, wakePrompt, now);
        }
        state.wake_count = wakeCount;
        state.wake_accepted = false;
        transition(outDir, state, "wake_pending", now);
    } finally {
        release();
    }
    try {
        try {
            if (wakeGrant) {
                if (typeof session?.rpc?.tools?.execute !== "function") {
                    throw new Error("Double supervisor runtime transport is missing.");
                }
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
            } else {
                if (typeof session?.send !== "function") {
                    throw new Error("Double supervisor runtime transport is missing.");
                }
                await session.send({ prompt: wakePrompt });
            }
        } finally {
            if (wakeGrant) revokeWakeGrant(outDir, wakeGrant);
        }
        const release = lifecycleLock(outDir);
        try {
            const state = loadLifecycle(outDir, info);
            if (state.phase === "wake_pending" && state.wake_count === wakeCount) {
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
            if (state.phase === "wake_pending" && state.wake_count === wakeCount) {
                transition(outDir, state, "idle", Date.now());
            }
        } finally {
            release();
        }
    }
}

const activityEvents = new Set(["user.message", "tool.execution_start", "tool.execution_complete"]);
const settleEvents = new Set(["session.idle", "session.usage_checkpoint", "session.task_complete", "session.shutdown"]);

async function onSessionEvent(event) {
    const type = event?.type;
    const settle = settleEvents.has(type)
        || ((type === "hook.start" || type === "hook.end") && event.data?.hookType === "agentStop");
    if (type !== "assistant.turn_start" && !activityEvents.has(type) && !settle) return;
    const toolCallId = event.data?.toolCallId ?? event.toolCallId;
    if (type === "tool.execution_complete" && ignoredWakeToolCalls.delete(toolCallId)) return;
    if (type === "assistant.turn_start") ownTurnActive = true;
    if (settle) ownTurnActive = false;
    if (type === "session.shutdown") ignoredWakeToolCalls.clear();
    try {
        const info = supervisorFor(session.sessionId);
        if (type === "tool.execution_start" && (event.data?.toolName ?? event.toolName) === "send_session_message") {
            const args = toolArguments(event.data?.arguments ?? event.data?.toolArgs ?? event.toolArgs);
            if (info && args?.session_id === info.double_session_id && isWakeLike(args.message)) {
                if (typeof toolCallId === "string") ignoredWakeToolCalls.add(toolCallId);
                return;
            }
        }
        await reconcileSupervisorLifecycle(session.sessionId, !settle, info);
    } catch (error) {
        console.error("Double lifecycle reconciliation failed", error);
    }
}

function ensureDoubleRuntime() {
    if (doubleRuntimeReady) return;
    doubleRuntimeReady = true;
    setInterval(() => {
        reconcileSupervisorLifecycle(session.sessionId).catch((error) => console.error("Double lifecycle reconciliation failed", error));
    }, 1000).unref();
}

async function runNativeHook(phase) {
    let decision = {};
    try {
        if (phase === "preToolUse") decision = guardPreToolUse(JSON.parse(readFileSync(0, "utf8")));
    } catch (error) {
        console.error(JSON.stringify({ scope: "pstack-double-guard", error: error.message }));
    }
    process.stdout.write(`${JSON.stringify(decision)}\n`);
}

if (process.argv[2] === NATIVE_HOOK_FLAG) {
    await runNativeHook(process.argv[3]);
} else {
    const { joinSession } = await import("@github/copilot-sdk/extension");
    session = await joinSession({});
    session.on(onSessionEvent);
    await reconcileSupervisorLifecycle(session.sessionId, true)
        .catch((error) => console.error("Double lifecycle reconciliation failed", error));
}
