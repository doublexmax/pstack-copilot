### Opening a PR

Invoked at the end of every other playbook.

**Worktree.** Work from a git worktree off the default branch (`master` on ADO repos that use it, otherwise `main`). Subagents inherit it. Multiple `task` calls on the same branch each get their own worktree, or `git fetch && git reset --hard origin/<branch>` between them. Dirty branch with unrelated work: patch out, fresh worktree, apply. Snarled worktree: reset from the default branch, redo minimally.

**Commits.** Commit liberally. Rebase into small, ordered commits before opening PRs. Each commit is a future PR: landable, ordered to tell the story. Amend when the fix belongs in a just-made commit. New commit when separable.

**Prose.** Apply the **unslop** skill to the diff, the PR description, and the commit bodies. Run `/no-comments` over the diff before review. Write every PR title, PR description, and commit body with the **technical-writing** skill first, then **unslop**. Apply every technical-writing layer except Diátaxis. Use one word for each action, keep articles, and avoid `-ing` when a plain verb works.

**Titles.** Use Conventional Commits in the form `type(scope): subject`. Use `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, or `perf` as the type. Use the changed area, such as `pstack` or `poteto-mode`, as the scope. Keep the subject short and imperative. Name a real symbol when one carries the change. For example, `fix(pstack): retarget opening-a-pr babysit trigger`. Do not add a trailing period.

**Descriptions.** The PR body is a briefing, not the lab notebook. A reviewer who has the diff should learn why the change exists, what it leaves out, what it could break, and how you proved it works, in under a minute. Write short, simple sentences with few identifiers. Do not write walls of text. The squash commit body is the PR body, so if the body would make that commit longer than about 40 lines, cut the body.

Put each section under a `##` heading, not a bold lead-in, so the sections stand apart. Use these sections in order. Drop a section when it has nothing to say.

- `## Why` gives the problem and the approach in one to three short sentences. Do not list SHAs or rebase genealogy.
- `## What changed` has one to three short bullets. Name a real symbol or path only when it carries the change. Name both sides of a rename or retarget.
- `## Scope` always names what the PR covers and what it deliberately leaves out, for example a related follow-up or a known gap. One to three short items. Do not list symbols or paths, and do not write a file-by-file essay.
- `## Tradeoffs` names only rejected alternatives a reviewer would otherwise ask about. Skip it when there was no real choice.
- `## Blast Radius` gives one or two sentences on who or what the change touches and why that is safe or risky. If the default branch is red, state the cost of leaving it red.
- `## Verification` has one to three bullets. Each names a real run path and its outcome. For a performance change, report one primary number with its unit in `before → after` form, vetted with the **benchmark-checklist** skill. Link the arena or swarm directory for the rest of the evidence. No sample-size methodology, swarm recitals, or metric tables.

After these sections, attach videos or screenshots when they prove a claim. Do not paste full SHAs, swarm or arena lane recitals, file-by-file checklists, or "CLEAN" verdicts. Put those in a linked artifact. A commit body does not restate its subject.

**Opening it.** On a GitHub remote, create the PR with the `create_pull_request` tool and edit it with `update_pull_request`, never `gh pr create` or `gh pr edit`. Those tools track a description later runs can edit, which a CLI-made PR misses. Reply to an inline review thread with `reply_and_resolve_review_thread`, not a top-level comment. On an ADO remote, use the chain mechanics in `../references/ado.md`, and read PR status with `repo_pull_request action=get` before referencing it. Never require Graphite.

**Readiness.** Open every PR ready, never as a draft. The PR tool can default to draft, so set `draft: false` on every creation call.

**Size and chains.** Prefer five narrow PRs to one fat PR. A chain is a base-branch chain. The root PR targets the default branch. Each child branch rebases onto its parent's exact tip and its PR targets the parent branch. Branch off the default branch only for genuinely independent work, and rebase on it before substantial chain work. See `../references/ado.md` for the chain hazards before you build one.

**Babysit.** Opening a PR does not start a babysit. Post the URL and keep building. Finish the phase or chain first. Run a separate babysit pass only when the user asks for one after the whole chain exists. A babysit for each new PR stalls the build and spends checks on commits that later waves restart. Push back when feedback drifts from intent.

A subagent that opens a PR runs `interrogate`, applies **unslop** and `/no-comments`, and returns the PR URL. On ADO that is `https://<org>.visualstudio.com/<project>/_git/<repo>/pullrequest/<id>`, and on GitHub `https://github.com/<owner>/<repo>/pull/<number>`. Then it returns to the parent without babysitting, unless it is an Autopilot-full or Autopilot-stack owner. That owner's brief assigns the babysit loop and is the ask `playbooks/babysit.md` waits for. It starts the loop after its code-ready report and reports merge-ready or STACK-READY as its playbook says. The rules here and in `playbooks/babysit.md` that hold babysitting until a whole chain is built do not apply to that owner.