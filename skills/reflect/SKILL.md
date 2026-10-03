---
name: reflect
description: Spawn three parallel review subagents over the active transcript, surface learnings, and route each to a concrete edit on an existing skill. Use when the user says reflect.
---

# Reflect

Mine the current conversation for durable learnings, then route them into skill edits.

## When to invoke

Invoke when the user says "reflect" or "/reflect". Skip when the conversation is trivial, off-topic, or already covered by an existing skill the parent followed correctly. One-offs are not learnings.

## Process

### 1. Locate the active session

The parent identifies its own session before fanning out, so reviewers read the right conversation.

Use the `session_store_sql` tool at `source: "local"`. Scope to the active repository rather than reading everything; that is a `WHERE` clause here, not a warning.

```sql
SELECT id, summary, branch, created_at
FROM sessions
WHERE repository = '<active repo>'
ORDER BY created_at DESC
LIMIT 10
```

Confirm the match by reading `turns.user_message` at `turn_index = 0` for the top candidate and checking it against this conversation's opening prompt. Take the matching `id`.

Reviewers then pull the conversation with a scoped query rather than a file read:

```sql
SELECT turn_index, user_message, assistant_response
FROM turns
WHERE session_id = '<id>'
ORDER BY turn_index
```

If no session resolves, write a tight digest of the conversation and pass that instead.

### 2. Spawn three reviewers in parallel

One message, three `task` calls, `agent_type: "general-purpose"`, `mode: "background"`, explicit `model` and `reasoning_effort` on each. Do not use `agent_type: "explore"`. Reviewers need MCP access for context lookups (tickets, chat threads, observability traces referenced in the transcript), and `explore` has none. The prompt forbids file writes; the parent applies edits.

Each reviewer and the synthesizer name a role line in `~/.copilot/pstack-models.md` and a default. Set `model` and `reasoning_effort` to that line's values, or to the default if the file or the line is missing. Omit both when the value is `auto` or `inherit-parent`. If the `task` tool rejects a model ID, use the default and say so. If it rejects the default, use the closest valid ID of the same family from its error message.

| Lens | Role line | Default `model` | Prompt template |
|---|---|---|---|
| Judgment | `reflect judgment, divergent, synth` | `claude-opus-5.5 / max` | `references/judgment-reviewer.md` |
| Tooling | `reflect tooling` | `gpt-5.6-sol / max` | `references/tooling-reviewer.md` |
| Divergent | `reflect judgment, divergent, synth` | `claude-opus-5.5 / max` | `references/divergent-reviewer.md` |

Pass each template verbatim, substituting the transcript path or digest where marked. Reviewers return findings in the `task` response body, collected with `read_agent`.

### 3. Synthesize

One `task` call, `agent_type: "general-purpose"`, with `model` and `reasoning_effort` from the `reflect judgment, divergent, synth` line (default `claude-opus-5.5 / max`). Not `explore`; the synthesizer's quality check includes spot-verifying citations, which can require MCP access. Use `references/synthesizer.md` verbatim, with each reviewer's full output inlined where marked. The synthesizer returns a structured Accepted / Rejected / Backlog list.

### 4. Structural enforcement check

Sanity-check the synthesizer's Accepted list. For any item that would be enforced more reliably by a lint rule, script, metadata flag, or runtime check, move it from Accepted to Backlog. See the **encode-lessons-in-structure** principle skill.

### 5. Apply

Before applying any Accepted edit, present the synthesizer's full Accepted/Rejected/Backlog output to the user and wait for explicit approval. The user picks which subset to apply and may redirect routings. Skill changes affect every future agent in the org. Do not auto-apply.

Backlog items file to whatever devex / backlog tracker your team uses automatically. Only the Accepted list waits for approval.

For each approved Accepted item, follow the Routing field exactly:

- Trivial existing-skill edit (a one-line bullet, a tightened sentence, a stale fact corrected): parent does directly.
- Substantive existing-skill edit (a new section, a new pattern table, more than ~10 lines): hand to the **create-skill** skill and run its draft / verify / iterate loop.
- `tune description: <skill path>` (the skill exists but didn't trigger when it should have): hand to `create-skill` and run its description-optimization loop.
- `new skill via create-skill: <kebab-name>`: hand creation to `create-skill`. Do not invent the shape ad hoc.

If your environment ships a SKILL.md validator, run it on every touched skill before declaring done. Skip this step if it doesn't.

### 6. Summarize for the user

Short list, no preamble:

- Edits applied: `<skill path>`. What changed, one line each.
- New skills created: `<skill path>`. One line each (rare).
- Backlog filed to the devex tracker: `<issue title>` (`<tags>`). One line each.
- Dropped: one line per rejected finding + reason from the synthesizer.
