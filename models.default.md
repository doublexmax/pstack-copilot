# pstack model configuration (defaults)

This is the checked-in default panel for the Copilot port. `setup-pstack` writes your
personal overrides to `~/.copilot/pstack-models.md`, outside this repo so `git pull` never
conflicts with it. Every skill reads the override file first and falls back to these values.

A model choice is two fields on the `task` tool, `model` and `reasoning_effort`.
Every row below gives both.

## The panel

Four vendors on purpose. pstack's second-opinion rule is "the same prompt against a
different model, and agreement is high-signal". A panel of four Anthropic checkpoints is
not a panel. Keep the lineages distinct when you edit this.

| Role slot | `model` | `reasoning_effort` | Why |
| --- | --- | --- | --- |
| Fast code | `grok-4.7` | `xhigh` | Every code playbook, plus swarm workers and `how`/`why` explorers. |
| Precise-spec and tooling | `gpt-5.6-sol` | `max` | A specified sequence to execute to the letter, and reflect's tooling lens. |
| Prose, judgment, hardest | `claude-opus-5.5` | `max` | Explanation, synthesis, review, vague intent, and cross-cutting design. |
| Fourth panel seat | `gemini-3.8-flash` | `high` | Keeps the review panels on four vendors. |

`grok-4.7` tops out at `xhigh` and `gemini-3.8-flash` tops out at `high`. Those are their
maximums, not downgrades.

## Per-role defaults

Aliases: `inherit-parent` and `auto` both mean the role runs on the parent chat model.
Implement them by omitting `model` and `reasoning_effort` on the `task` call.

```
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

Panel roles are lists. One subagent runs per entry, alias entries included, so the list
length sets the fan-out. `arena cross-judge pool` is a list Arena selects one value from,
preferring a family different from the parent's.

`setup-pstack` also writes a `# budget` line. It rewrites `reasoning_effort` across every
role at once, clamped to each model's maximum.

## Long-context work

Copilot exposes `context_tier: "long_context"` on the `task` tool, separately from the
model. Set it when a delegate must read a large corpus rather than reaching for a
different model. `claude-opus-5.5`, `gpt-5.6-sol`, `grok-4.7`, and `gemini-3.8-flash` all
support it.

## Panel composition

The four panel roles use four different vendors, so a review panel disagrees for real
reasons rather than repeating one model family's blind spots. Upstream ships a
three-vendor panel (Anthropic, OpenAI, xAI). Gemini holds the fourth seat here. It is a
single-role slot: no playbook routes to it alone, and it exists so the panels read four
lineages.