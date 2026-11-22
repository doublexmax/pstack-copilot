# The pstack guide

pstack works best when you stop micromanaging the agent. You describe what you want and how you'll know it's done. `/poteto-mode` picks the playbook, runs the other skills as the steps need them, and shows you the evidence. When the goal sits above a single task, [`/steward`](../../skills/steward/SKILL.md) holds the intended outcome and steers its own team of workers across stages and deliverables. This guide teaches both habits with realistic prompts.

Here's what you'll learn:

1. [Set up pstack](./01-setup.md). Register the skills directory and pick your models.
2. [Route work through `/poteto-mode`](./02-poteto-mode.md). Give it a goal and watch it pick a playbook.
3. [Understand the code](./03-understand.md). `/how`, `/why`, `/teach`, and `/recall` before you edit anything.
4. [Design the change](./04-design.md). `/architect`, `/arena`, `/swarm`, and `/interrogate` before code locks in a shape.
5. [Build and clean the change](./05-build-and-clean.md). The build playbooks, `/tdd`, `/unslop`, and `/no-comments`.
6. [Verify and ship](./06-verify-and-ship.md). Prove behavior on the real app, then open a focused PR and drive it to merged.
7. [Run work while you sleep](./07-overnight.md). An overnight contract, a decision log you can audit, and the playbooks that scale past one agent.
8. [Steer with principle names](./08-principles.md). The 24 names that redirect an agent mid-task.
9. [Make it yours](./09-make-it-yours.md). Your own mode, plus how to test a skill change.
10. [Recipes and pitfalls](./10-recipes-and-pitfalls.md). Prompts to copy and mistakes to skip.

Read the pages in order the first time. After that, each page stands alone.

## If you only remember one thing

Give the agent a goal and a way to check it, in your own words:

```text
/poteto-mode the export writes duplicate rows when a retry lands mid-run. repro first, then fix and verify.
```

You don't need to name a playbook or list skills. "repro first" and a checkable outcome are all the routing signal `/poteto-mode` needs. It matches the Bug fix playbook, copies the steps into a todo list, and calls the right skills as each step fires.

## Step above `/poteto-mode` with `/steward`

`/poteto-mode` is the right level when you already know the bounded engineering task, such as a bug fix, a refactor, or a well-defined feature. Reach for [`/steward`](../../skills/steward/SKILL.md) or launch `copilot --agent steward` when the scope or deliverable format is still open. Steward holds your intended outcome above implementation details and drives its own team of [`poteto-worker`](../../agents/poteto-worker.agent.md) subagents and `poteto-mode` sessions.

### Shape the outcome in chat, then hand off

Start in an ordinary chat, even without a repository open. Talk through who the work is for, what experience matters, and what stays out of scope. Once your intent is clear in the thread, hand ownership to Steward in one line:

```text
/steward take it on from here. understand my goals from our chat and proceed.
```

Steward records the goal, known facts, and open gaps in a session `overview.md` outside the worktree. Before it builds deliverables, Steward researches the domain and checks your available host and CLI tools. If missing context or a tool limit would change what gets built, Steward asks targeted questions first rather than building on guesswork. Once the direction is clear, it dispatches bounded slices to `poteto-worker` subagents or isolated `poteto-mode` sessions and checks their output directly.

### Pull up mid-session to reset the roadmap

When a long engineering chat gets buried in implementation details, switch to `/steward` to check where the work stands against your original goal:

```text
/steward review our chat against my goal. see where we stand, how far along we are, and draft the roadmap for what still needs to be cut or built.
```

Once the roadmap matches what you want, a short reply sends Steward and its worker team through the rest of the work:

```text
good, complete this in steward
```

### Steer in product terms, not worker mechanics

While Steward runs, keep your follow-ups at the product, behavior, and quality level. Ask for plain status checks, test the result against a real input, or change direction when new evidence lands:

```text
so what's the simple status on progress?
```

```text
make sure the file structure fits the whole product before we start the next stage.
```

Steward treats prior drafts as zero sunk cost and routes revisions to fresh `poteto-worker` slices rather than keeping misaligned code. On long unattended runs, Steward attaches [`/double`](../../skills/double/SKILL.md) to check factual claims against real artifacts. Before it hands back multi-step work, Steward runs a read-only rework critic that prefers a different model vendor family. Switch back to direct engineering anytime with `/poteto-mode`, or stand Steward down for the session with `skip steward`.

Next: [Set up pstack](./01-setup.md).
