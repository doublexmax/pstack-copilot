---
name: create-skill
description: "Author or revise a Copilot SKILL.md. Owns the frontmatter contract, the description-as-router rule, progressive disclosure, and the scope decision (project vs personal vs a registered directory). Use for /create-skill, \"write a skill\", \"turn this into a skill\", \"fix my skill\", or when a skill exists but never fires."
---

# Creating a skill

A skill is a folder holding `SKILL.md`, optionally with reference files beside it. Copilot
reads every skill's `name` and `description` at startup and injects **only those two fields**
into the system prompt. The body is loaded on demand when the skill is invoked.

That single fact drives everything below. The description is not documentation. It is the
router, and it is the only thing the agent sees when deciding whether to open your skill.

## Where it goes

| Scope | Path | Visible in |
| --- | --- | --- |
| Project | `.github/skills/<name>/SKILL.md` | that repo only |
| Personal | `~/.copilot/skills/<name>/SKILL.md` | every repo |
| Registered directory | any dir added with `copilot skill add <dir>` | every repo |

Default to project scope for anything repo-specific: build commands, deploy steps, schema
conventions. Use personal or a registered directory for how *you* work, which travels.

Registered directories are the right home for a set of skills kept under version control,
because the whole tree stays a git repo you can pull from. Check registration with
`copilot skill list`, which segments output as Project, Custom, Personal, and Builtin.

## Frontmatter

Only three keys are supported:

```markdown
---
name: my-skill
description: "What it does. Use for <trigger>, <trigger>, or <situation>."
allowed-tools: ["view", "grep"]
---
```

- `name` must match the folder name. Lowercase, hyphens, no spaces.
- `description` is required and capped at **1024 characters**, enforced at load time. Over
  the cap, the skill fails to load.
- `allowed-tools` is optional. Omit it unless the skill must be restricted; omitting means
  all tools.

**Keys Copilot does not support**, common in skills ported from other agents. They are
ignored at best and can break the load: `disable-model-invocation`, `mode`, `icon`, `color`,
`reminder`, `alwaysApply`, `globs`. Strip them.

## Writing the description

Two sentences. First what it does, second when to fire.

Write the second sentence in the user's words, not yours. The agent matches the user's
phrasing against your description, so a skill named `perf-issue` described as "performance
regression analysis" will lose to one that says `Use for "why is this slow", "this got
slower", or a latency regression`. Quote the literal phrases.

Include the slash form if the skill has one, plus the situations where it should fire even
though nobody named it.

Then write the negative boundary when a sibling skill is adjacent. `Use how for runtime
behavior` at the end of `why` is what stops the two from colliding.

A skill that exists but never fires almost always has a description problem, not a body
problem. Fix the description first.

## Writing the body

Write for an agent that has your body in context and needs to act, not for a human browsing
docs.

- Lead with the decision the reader has to make, not with background.
- Prefer a table or a numbered procedure over paragraphs. Both survive skimming.
- Show the exact command, the exact tool call, the exact file path. An agent cannot infer
  your shell.
- State what *not* to do where a wrong path is tempting, and say why in one clause.
- Cap the body around 500 lines. Past that, split.

## Progressive disclosure

`SKILL.md` is the router. Anything long, optional, or needed by only one branch moves to a
sibling file that the body points at by relative path.

```
skills/my-skill/
  SKILL.md            router and procedure
  references/deep.md  loaded only when the body sends you there
  scripts/run.ts      executable the body invokes
```

Point at them explicitly: `Read references/deep.md before step 3.` An agent will not open a
file you merely mention.

This is what keeps a 44-skill library affordable. Startup cost is names and descriptions
only; bodies are paid for on use.

## Procedure

1. Name the trigger first. Write the literal phrases a user would type. If you cannot list
   three, the skill is too vague to route and probably belongs inside an existing one.
2. Decide the scope from the table above.
3. Create `<scope>/<name>/SKILL.md` with the three-key frontmatter.
4. Write the body as a procedure. Split anything long into `references/`.
5. Run the **unslop** skill over the whole file. Skills are prose an agent reads closely,
   and slop costs accuracy, not just taste.
6. Verify it loads: `copilot skill list` and confirm it appears in the right segment with no
   failure. A new registered directory or a new personal skill may need a CLI restart.
7. Prove it routes. Start a fresh session, type one of your trigger phrases verbatim, and
   confirm the skill fires. If it does not, the description is wrong; go back to step 1.

## Revising a skill that misfires

| Symptom | Cause | Fix |
| --- | --- | --- |
| Never fires | Description is in your vocabulary, not the user's | Rewrite sentence two with quoted user phrasing |
| Fires for the wrong thing | No negative boundary | Add `Use <sibling> for <case>` |
| Fires but the agent ignores the body | Body is background, not procedure | Rewrite as numbered steps with exact commands |
| Fails to load | Unsupported frontmatter key or description over 1024 chars | Strip the key, cut the description |
| Body is huge and half-read | No progressive disclosure | Move branches into `references/` and point at them |

## Do not

- Do not restate the description in the first line of the body. The agent already has it.
- Do not write a skill for something that fires once. Do it inline.
- Do not use `allowed-tools` to express intent. It is a hard restriction, not a hint.
- Do not add narrating comments or phase banners to bundled scripts. The **no-comments**
  skill applies to skill assets too.
