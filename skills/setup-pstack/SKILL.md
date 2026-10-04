---
name: setup-pstack
description: Configure pstack models, reasoning budget, and persistent delegate context policy. Use for setup-pstack, "configure pstack models", "pstack budget", "configure pstack context", or "context-only setup".
---

# Setup pstack

Write `~/.copilot/pstack-models.md`, a personal override file that sets pstack's model per
role. The skills read it and fall back to `models.default.md` in the pstack fork when a
line is absent, so this is an override layer, not a requirement.

Context policy is independent. Read [context-routing](../context-routing/SKILL.md) for its canonical resolver and personal directory.
For a context-only request, run only **Context policy** below. Do not ask for a budget, rewrite the model map, or change parent/per-agent tier settings.

Copilot has no user-global always-applied rule, so this file is not auto-injected. Every
pstack skill that delegates opens it explicitly as its first step. That is the contract:
this skill writes it, the skills read it.

The file lives outside the pstack fork on purpose, so `git pull` from upstream never
conflicts with your choices.

## Steps

### 1. Detect available models

Read the `model` parameter documentation on the `task` tool in this session. It lists
every model ID you can pass, with the `reasoning_effort` values each one supports. That is
the dependable source. Never write a model ID you have not confirmed is listed there.
`inherit-parent` and `auto` are always valid even though they are not real IDs.

A model choice is two fields in Copilot, `model` and `reasoning_effort`. Record both per role.

### 2. Load current state

Read `<pstack>/models.default.md` for the defaults. If `~/.copilot/pstack-models.md`
already exists, read it and treat its `# budget` line and its role values as the current
choices. A line whose role is not in step 5, such as `how critics`, is from a retired role.
Drop it and say so in step 3c.

### 3. Budget, map, and confirm

**(a) Ask for a budget.** Prefer the `ask_user` tool with choices over free text. Offer
these four options with these exact labels, and name the current budget when the override
file records one.

- `unlimited, keep max`
- `large, xhigh reasoning`
- `medium, high reasoning`
- `small, medium reasoning`

**(b) Apply it.** Build the working table from `models.default.md`, and on a re-run keep
any role the user changed by family, list, or alias (`inherit-parent`, `auto`).
`unlimited` leaves every `reasoning_effort` as in that table. `large`, `medium`, and
`small` set `reasoning_effort` on every real model ID, panel entries included, to `xhigh`,
`high`, or `medium`. Clamp to what the model supports, on the ladder `max` > `xhigh` >
`high` > `medium` > `low`. A model whose maximum is below the target takes its maximum, so
`large` leaves a flash-tier model at `high` rather than marking it unavailable.
`inherit-parent` and `auto` do not change.

**(c) Show the roles and confirm.** Show every role with its model and effort, marking any
ID not in the detected set as needing a choice. Also list each line step 2 dropped. Ask
whether to accept as-is or change specific roles, offering the detected models plus
`inherit-parent` and `auto`. Both aliases mean the role runs on the parent chat model,
which is how Auto users stay on Auto.

For panel roles (arena runners, architect runners, interrogate reviewers) the value is a
list, and one subagent runs per entry, alias entries included, so the list length sets the
count. `arena cross-judge pool` is also a list, but Arena selects one value from it whose
model family differs from the parent's when possible. `swarm workers` is the default for
every worker unless a race or comparison assigns another model per arm.

Keep vendor diversity in the panel roles. The second-opinion rule depends on it, and four
checkpoints from one vendor is not a panel.

### 4. Validate

Every real model ID written must be in the detected set, and every effort value must be one
the model actually supports. `inherit-parent` and `auto` always pass. If a chosen pair is
unavailable, stop and ask again. A config pointing at a model the user cannot use breaks
every delegation that reads it.

### 5. Write the override file

Write `~/.copilot/pstack-models.md`, a `# budget` line with the chosen label and its target
effort, then one line per role, using the same labels `models.default.md` uses and the same
`model / effort` shape. Overwrite the whole file so re-runs stay idempotent. Shape:

```
# pstack model configuration. One line per role.
# Delete a line to fall back to models.default.md in the pstack fork.
# `inherit-parent` or `auto`: the role runs on the parent chat model. Omit `model` and
# `reasoning_effort` on the task call. Alias entries in a panel list still count toward fan-out.
# budget: unlimited (max)
feature, refactoring:                   grok-4.7 / xhigh
bug-fix:                                grok-4.7 / xhigh
perf-issue:                             grok-4.7 / xhigh
hillclimb:                              grok-4.7 / xhigh
judgment and prose:                     claude-opus-5.5 / max
hardest tasks:                          claude-opus-5.5 / max
how explorer:                           grok-4.7 / xhigh
how explainer:                          claude-opus-5.5 / max
why investigators:                      grok-4.7 / xhigh
why synthesizer:                        claude-opus-5.5 / max
reflect tooling:                        gpt-5.6-sol / max
reflect judgment, divergent, synth:     claude-opus-5.5 / max
arena runners:                          claude-opus-5.5 / max, gpt-5.6-sol / max, grok-4.7 / xhigh, gemini-3.8-flash / high
arena cross-judge pool:                 claude-opus-5.5 / max, gpt-5.6-sol / max, grok-4.7 / xhigh, gemini-3.8-flash / high
swarm workers:                          grok-4.7 / xhigh
architect runners:                      claude-opus-5.5 / max, gpt-5.6-sol / max, grok-4.7 / xhigh, gemini-3.8-flash / high
interrogate reviewers:                  claude-opus-5.5 / max, gpt-5.6-sol / max, grok-4.7 / xhigh, gemini-3.8-flash / high
```

### 6. Confirm

Tell the user the file was written and that skills pick it up on their next run, no restart
needed. Re-running this skill updates it.

Then run **Context policy**. Existing model and effort choices do not change when that policy changes.

### 7. Offer a verification skill (optional)

Check whether the project has a way to drive the real app for proof (a `verify-*` skill, or
an existing harness). If not, offer once: "want a project-local verification skill, so
agents can drive the app the way a user does and prove changes work? I can generate one
with the create-verification-skill skill." On yes, invoke it. On no, move on without
pushing.

## Context policy

Run `<pstack>\scripts\context-routing.mjs show` to read the current independent policy.
If the user already chose a policy, use that choice. Otherwise ask one question with these choices:

- `Adaptive, long context for supported large-corpus work (Recommended)`
- `Default context for every delegate`
- `Long context when the selected model and host support it`

Use `adaptive`, `default`, or `long_context` for the corresponding mode.
Write only the personal context file through the canonical command:

```powershell
node "<pstack>\scripts\context-routing.mjs" set-policy --default adaptive
```

For a requested exact-role override, add `--role-policy "role=policy"`.
Keep combined role labels and the existing 17-role model map intact.
Report the returned policy file and mode. Direct workflows and always-on routing read it automatically.
This does not resize the current session. Unknown support is diagnostic under adaptive policy and blocks an explicit long requirement.