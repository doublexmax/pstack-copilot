# The pstack guide

Describe the result you want and how you'll know it's done. `/poteto-mode` is pstack's core for bounded engineering work. It picks a playbook and verifies the result. `/steward` works above it when you want one agent to own the outcome across tasks or deliverables.

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
11. [Work above `/poteto-mode` with `/steward`](./11-steward.md). Hand off an outcome and steer the work as it changes.

Read the pages in order the first time. After that, each page stands alone.

## If you only remember one thing

Give the agent a goal and a way to check it, in your own words:

```text
/poteto-mode the export writes duplicate rows when a retry lands mid-run. repro first, then fix and verify.
```

You don't need to name a playbook or list skills. "repro first" and a checkable outcome are all the routing signal `/poteto-mode` needs. It matches the Bug fix playbook, copies the steps into a todo list, and calls the right skills as each step fires.

## Step above `/poteto-mode` with `/steward`

`/poteto-mode` is the core execution layer when you already have one bounded engineering task. Step up to [`/steward`](../../skills/steward/SKILL.md) or launch `copilot --agent steward` when the scope is still open or the goal spans multiple slices and deliverables. Steward holds the intended outcome, flags missing context or tool limits early, and directs [`poteto-worker`](../../agents/poteto-worker.agent.md) subagents and `poteto-mode` project sessions until the combined result matches what you meant.

Switch back to direct engineering with `/poteto-mode`, or stand Steward down for the session with `skip steward`. Read [Work above `/poteto-mode` with `/steward`](./11-steward.md) for how Steward works under the hood and five prompts you can copy.

Next: [Set up pstack](./01-setup.md).
