# Intake adapter

Benny reads issue reports from an **intake queue** and replies **inside the report it was triggered by**. Upstream benny hard-wired that queue to Slack. This fork treats it as an adapter, because the queue and the tracker are frequently the same system and the rest of benny does not care which one you use.

Set `intake.backend` in the configuration. Two backends are supported.

## The five operations

Every backend must supply these. If a backend cannot supply one, benny fails closed rather than approximating it.

| Operation | What benny needs it for |
| --- | --- |
| `list_new` | find reports the workflow has not handled yet |
| `read_thread` | the original report plus every follow-up comment, in order, with authors |
| `read_attachments` | screenshots, video, logs attached to the report |
| `reply` | append exactly one verdict or status to that report |
| `identity` | the author of a comment, so the repro workflow can trust a triage marker |

There is deliberately no `create_root` operation. Benny must never open a new item in the intake queue; that is the boundary that keeps it from talking to itself.

## Backend: `azure-devops` (default)

The intake queue is an ADO work-item query. A "thread" is one work item, and a "thread reply" is one work-item comment.

| Operation | Tool |
| --- | --- |
| `list_new` | `search_workitem` with the configured `intake.query`, or `wit_query action=get_results` for a saved query |
| `read_thread` | `wit_work_item action=get` then `wit_work_item action=list_comments` |
| `read_attachments` | `wit_work_item_attachment` for each attachment on the item |
| `reply` | `wit_work_item_comment_write action=add` |
| `identity` | the `createdBy` field on each comment |

Coordinates are the work-item id. It is immutable for the whole run, which makes the upstream `thread_ts` discipline automatic.

**Has benny already run?** Benny is polled, not pushed, so it re-reads items it may already have handled. Determine this by reading the comments for one authored by the configured `intake.triage_identity` containing a benny marker. Do not use a state file; the queue is the state.

**Dedupe.** With this backend the intake queue and the tracker are usually the same ADO project, so duplicate search is a `search_workitem` over that project rather than a second integration. Prefer that: one system, one query, no cross-system id mapping.

## Backend: `slack`

Only available when a Slack MCP is configured in this session. Check the tool list before selecting it; a missing Slack MCP is a setup failure, not a runtime fallback.

| Operation | Tool |
| --- | --- |
| `list_new` | the MCP's channel-history action over `intake.source_channel_id` |
| `read_thread` | the MCP's thread-replies action, keyed by the root `thread_ts` |
| `read_attachments` | the MCP's file action, or `intake.optional_bot_token_env` when the MCP cannot download files |
| `reply` | the MCP's thread-post action, always with the root `thread_ts` |
| `identity` | the `user` field on each message |

Coordinates are `(channel_id, thread_ts)`. Capture them once at the start of the run and never recompute them. Every post is a thread reply; a root post in the source channel is the one thing benny must never do.

## Worker isolation

This rule survives the abstraction and is the reason it is written down. **Only the coordinator may call `reply`.** Delegated workers are read-only, return findings, and get an explicit ban on the reply tool for the active backend in their prompt:

- `azure-devops`: ban `wit_work_item_comment_write` and every other work-item write tool.
- `slack`: ban `SendSlackMessage`, `PostToSlack`, `chat.postMessage`, and every other Slack write.

If a worker would need the reply tool to do its job, do not launch it. Do the work in the coordinator instead.

## Polling, not pushing

Copilot workflows are scheduled, so both benny workflows run on an interval and must be safe to re-enter.

- Handle **one** report per run unless the operational file says otherwise. A poll that finds five unhandled reports should take the oldest and leave the rest for the next tick.
- Treat "already carries my marker" as the only stop condition that matters. Timestamps drift; markers do not.
- Exit quietly and without a reply when there is nothing to do. A workflow that comments "nothing to triage" on every tick is worse than one that stays silent.
