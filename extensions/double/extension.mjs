import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { joinSession } from "@github/copilot-sdk/extension";

export const ENTRY_VERSION = "pstack-double-extension-v1";
const pstackRoot = join(homedir(), ".copilot", "pstack");
const watchScript = join(pstackRoot, "skills", "double", "scripts", "double_watch.py");
const lastWakeSentAt = new Map();
const wakeCooldownMs = 15_000;

function copilotHome() {
    return process.env.COPILOT_HOME || join(process.env.USERPROFILE || process.env.HOME || homedir(), ".copilot");
}

export function hasSupervisorMarker(sessionId, home = copilotHome()) {
    if (typeof sessionId !== "string" || !sessionId) return false;
    const sessionDir = join(home, "session-state", sessionId);
    return existsSync(join(sessionDir, "double-supervised"))
        || existsSync(join(sessionDir, "files", "double-supervised"));
}

function checkDoubleChild(sessionId) {
    if (!hasSupervisorMarker(sessionId)) return Promise.resolve(null);
    return new Promise((resolve) => {
        execFile("python", [watchScript, sessionId, "--check-child"], { timeout: 3000 }, (err, stdout) => {
            if (err || !stdout || !stdout.trim()) {
                resolve(null);
                return;
            }
            try {
                resolve(JSON.parse(stdout.trim()));
            } catch {
                resolve(null);
            }
        });
    });
}

function buildWakeDirective(sessionId, info) {
    if (info?.is_running) {
        lastWakeSentAt.delete(sessionId);
        return undefined;
    }
    if (!info) return undefined;
    const now = Date.now();
    const lastSentAt = lastWakeSentAt.get(sessionId);
    if (lastSentAt !== undefined && now - lastSentAt < wakeCooldownMs) return undefined;
    const outDir = join(copilotHome(), "session-state", info.double_session_id, "files");
    return {
        additionalContext: `<double_supervisor_hook>Runtime hook: your attached Double supervisor (${info.double_session_id}) is currently idle while this session is active. Include send_session_message(session_id="${info.double_session_id}", delivery_mode="immediate", message="Parent session active; run python \\"${watchScript}\\" ${sessionId} --wait --out-dir \\"${outDir}\\".") in your next tool call batch.</double_supervisor_hook>`,
    };
}

await joinSession({
    hooks: {
        onUserPromptSubmitted: async (_input, invocation) => {
            const info = await checkDoubleChild(invocation.sessionId);
            return buildWakeDirective(invocation.sessionId, info);
        },
        onPostToolUse: async (input, invocation) => {
            if (input.toolName === "send_session_message") {
                lastWakeSentAt.set(invocation.sessionId, Date.now());
                return undefined;
            }
            const info = await checkDoubleChild(invocation.sessionId);
            return buildWakeDirective(invocation.sessionId, info);
        },
    },
});
