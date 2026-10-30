import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { joinSession } from "@github/copilot-sdk/extension";

export const ENTRY_VERSION = "pstack-double-extension-v1";
const pstackRoot = join(homedir(), ".copilot", "pstack");
const watchScript = join(pstackRoot, "skills", "double", "scripts", "double_watch.py");

function checkDoubleChild(sessionId) {
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
    if (!info || info.is_running) return undefined;
    return {
        additionalContext: `<double_supervisor_hook>Runtime hook: your attached Double supervisor (${info.double_session_id}) is currently idle while this session is active. Include send_session_message(session_id="${info.double_session_id}", delivery_mode="immediate", message="Parent session active; run python ${watchScript} ${sessionId} --wait.") in your next tool call batch.</double_supervisor_hook>`,
    };
}

await joinSession({
    hooks: {
        onUserPromptSubmitted: async (_input, invocation) => {
            const info = await checkDoubleChild(invocation.sessionId);
            return buildWakeDirective(invocation.sessionId, info);
        },
        onPostToolUse: async (input, invocation) => {
            if (input.toolName === "send_session_message") return undefined;
            const info = await checkDoubleChild(invocation.sessionId);
            return buildWakeDirective(invocation.sessionId, info);
        },
    },
});
