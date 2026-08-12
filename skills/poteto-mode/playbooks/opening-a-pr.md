### Opening a PR

Invoked at the end of every other playbook.

**Worktree.** Work from a git worktree off the default branch (`master` on ADO repos that use it, otherwise `main`); subagents inherit it. Multiple `task` calls on the same branch each get their own worktree, or `git fetch && git reset --hard origin/<branch>` between them. Dirty branch with unrelated work: patch out, fresh worktree, apply. Snarled worktree: reset from the default branch, redo minimally.

**Commits.** Commit liberally; rebase into small, ordered commits before opening PRs. Each commit is a future PR: landable, ordered to tell the story. Amend when the fix belongs in a just-made commit; new commit when separable.

**PRs.** Apply the **unslop** skill to the diff, the PR description, and the commit bodies; `/no-comments` the diff before review. Small PRs, 5 narrow over 1 fat; chain follow-ups, branch off `master` only for genuinely independent work. For chained PRs, each PR's `targetRefName` points at its parent's branch — see `../references/ado.md` for the chain hazards before you build one. Read PR status with `repo_pull_request action=get` before referencing it. Rebase on `master` before substantial chain work. No `## Summary` / `## Test plan` boilerplate on small PRs; commit bodies don't restate the subject. After opening, run `playbooks/babysit.md`; push back when feedback drifts from intent.

A subagent that opens a PR runs `interrogate`, applies **unslop** and `/no-comments`, returns the PR URL (`https://msazure.visualstudio.com/<project>/_git/<repo>/pullrequest/<id>`), and does NOT babysit. Return to the parent.
