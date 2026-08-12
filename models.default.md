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
| Fast code | `grok-4.5` | `high` | Bulk implementation and mechanical edits. |
| Precise-spec code | `gpt-5.6-sol` | `xhigh` | A specified sequence to execute to the letter. |
| Prose and judgment | `gemini-3.1-pro-preview` | `high` | Explanation, synthesis, review, vague intent. |
| Hardest design | `claude-opus-5` | `xhigh` | Cross-cutting design, gnarly concurrency, subtle algorithms. |

`gemini-3.1-pro-preview` tops out at `high`; that is its maximum, not a downgrade.

## Per-role defaults

Aliases: `inherit-parent` and `auto` both mean the role runs on the parent chat model.
Implement them by omitting `model` and `reasoning_effort` on the `task` call.

```
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

Panel roles are lists. One subagent runs per entry, alias entries included, so the list
length sets the fan-out. `arena cross-judge pool` is a list Arena selects one value from,
preferring a family different from the parent's.

## Long-context work

Copilot exposes `context_tier: "long_context"` on the `task` tool, separately from the
model. Set it when a delegate must read a large corpus rather than reaching for a
different model. `claude-sonnet-5`, `claude-opus-5`, `gemini-3.1-pro-preview`,
`grok-4.5`, and the `gpt-5.6-*` family all support it.

## Panel composition

The four panel roles deliberately use four different vendors, so a review panel
disagrees for real reasons rather than repeating one model family's blind spots.
Gemini holds the seat that upstream gave to a second Anthropic model.
