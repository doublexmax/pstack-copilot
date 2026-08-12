---
name: swarm
description: "Fan out N parallel workers, drain them, and return one report. Use for /swarm, 'swarm this', or parallel coverage, races, gauntlets, and exploration."
---

# Swarm

Fan out N parallel cloud workers. They may cover separate slices, race the same brief, or mix both. The parent waits, aggregates, and returns one report.

## Start

Open a todolist with one entry per phase before launching anything.

1. Frame
2. Fan out
3. Aggregate
4. Report

## Phase A: Frame

1. State the done predicate and the artifact or report the swarm must return.
2. Choose the shape. Partition into slices, race N workers on identical briefs, or mix both. For a race or mixed shape, declare `first pass`, `rank all`, or `best-of` before spawning.
3. Set N from the user or derive it from the shape. N is total workers.
4. Pick the worker model from `swarm workers` in `~/.copilot/pstack-models.md` when present. Otherwise use `grok-4.5 / high`. For a model race, name each arm's model up front.
5. Give each worker its own writable output when it writes. Use a worktree, branch, or `/tmp/swarm-<slug>/worker-<n>/`.

## Phase B: Fan out

Spawn all N workers in one message with `agent_type: "general-purpose"`, `mode: "background"`, and the configured model. Copilot has no `environment` switch on the `task` tool; background subagents run on this machine and share its filesystem, which is what most swarms want.

Escalate to real cloud workers only when the swarm is long-running or larger than this machine should carry, and the repo is GitHub-backed. Then use `create_session` with `execution_location: "cloud"` and a `kickoff.prompt` per worker instead of `task`, and set `base_branch` when a worker must start from a non-default pushed branch. Cloud sessions cannot read local state, so their briefs inline what they need or point at repo paths.

After launching, do your own independent work rather than polling. You are notified as each worker finishes; collect with `read_agent`. A worker that needs a correction takes a `write_agent` follow-up rather than a fresh respawn.

Every brief stands alone. Include the goal, scope, exact slice or race arm, how to verify, and what to report. Reports use `PASS`, `ISSUES`, or `BLOCKED` with evidence.

If a worker drops out, proceed with N-1 and note it.

## Phase C: Aggregate

Read the terminal results. For coverage, every required slice needs a result. For a race, apply the selection rule declared up front. Use first pass, rank all, or best-of. Do not paste raw worker dumps.

Keep a compact result table, one-line evidenced issues, and explicit gaps or dropouts.

## Phase D: Report

Return one consolidated in-chat report with the table, issue one-liners, gaps or dropouts, and the race rule when used.
