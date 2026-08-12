---
name: setup-pstack
description: Configure which models pstack uses per role. Detects the models available to the task tool and writes a personal override file that the skills read. Use for setup-pstack, "configure pstack models", or changing pstack's model choices.
---

# Setup pstack

Write `~/.copilot/pstack-models.md`, a personal override file that sets pstack's model per
role. The skills read it and fall back to `models.default.md` in the pstack fork when a
line is absent, so this is an override layer, not a requirement.

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
already exists, read it and treat its values as the current choices.

### 3. Map and confirm

Show every role with its current model and effort, marking any ID not in the detected set
as needing a choice. Ask whether to accept as-is or change specific roles, offering the
detected models plus `inherit-parent` and `auto`. Prefer the `ask_user` tool with choices
over free text.

For panel roles (how critics, arena runners, architect runners, interrogate reviewers) the
value is a list, and one subagent runs per entry, alias entries included, so the list
length sets the count. `arena cross-judge pool` is also a list, but Arena selects one value
from it whose model family differs from the parent's when possible. `swarm workers` is the
default for every worker unless a race or comparison assigns another model per arm.

Keep vendor diversity in the panel roles. The second-opinion rule depends on it, and four
checkpoints from one vendor is not a panel.

### 4. Validate

Every real model ID written must be in the detected set, and every effort value must be one
the model actually supports. If a chosen pair is unavailable, stop and ask again. A config
pointing at a model the user cannot use breaks every delegation that reads it.

### 5. Write the override file

Write `~/.copilot/pstack-models.md`, one line per role, using the same labels
`models.default.md` uses and the same `model / effort` shape. Overwrite the whole file so
re-runs stay idempotent. Shape:

```
# pstack model configuration. One line per role.
# Delete a line to fall back to models.default.md in the pstack fork.
# `inherit-parent` or `auto`: the role runs on the parent chat model. Omit `model` and
# `reasoning_effort` on the task call. Alias entries in a panel list still count toward fan-out.
feature, refactoring:                   grok-4.5 / high
bug-fix:                                gpt-5.6-sol / xhigh
perf-issue:                             gpt-5.6-sol / xhigh
hillclimb:                              gpt-5.6-sol / xhigh
judgment and prose:                     gemini-3.1-pro-preview / high
hardest tasks:                          claude-opus-5 / xhigh
how explorer:                           grok-4.5 / high
how explainer:                          gemini-3.1-pro-preview / high
how critics:                            gemini-3.1-pro-preview / high, gpt-5.6-sol / xhigh, grok-4.5 / high, claude-opus-5 / xhigh
why investigators:                      grok-4.5 / high
why synthesizer:                        gemini-3.1-pro-preview / high
reflect tooling:                        gpt-5.6-sol / xhigh
reflect judgment, divergent, synth:     gemini-3.1-pro-preview / high
arena runners:                          gemini-3.1-pro-preview / high, gpt-5.6-sol / xhigh, grok-4.5 / high, claude-opus-5 / xhigh
arena cross-judge pool:                 gemini-3.1-pro-preview / high, gpt-5.6-sol / xhigh, grok-4.5 / high, claude-opus-5 / xhigh
swarm workers:                          grok-4.5 / high
architect runners:                      gemini-3.1-pro-preview / high, gpt-5.6-sol / xhigh, grok-4.5 / high, claude-opus-5 / xhigh
interrogate reviewers:                  gemini-3.1-pro-preview / high, gpt-5.6-sol / xhigh, grok-4.5 / high, claude-opus-5 / xhigh
```

### 6. Confirm

Tell the user the file was written and that skills pick it up on their next run, no restart
needed. Re-running this skill updates it.

### 7. Offer a verification skill (optional)

Check whether the project has a way to drive the real app for proof (a `verify-*` skill, or
an existing harness). If not, offer once: "want a project-local verification skill, so
agents can drive the app the way a user does and prove changes work? I can generate one
with the create-verification-skill skill." On yes, invoke it. On no, move on without
pushing.
