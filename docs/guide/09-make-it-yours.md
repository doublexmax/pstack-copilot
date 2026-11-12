# Make it yours

poteto-mode is one person's style. The machinery underneath, playbooks, routing, model roles, works just as well wearing yours. This page covers generating a personal mode, capturing lessons from a session, authoring a focused skill, and testing a skill change before you trust it.

## Generate your own mode with `/automate-me`

```text
/automate-me
```

[`automate-me`](../../skills/automate-me/SKILL.md) asks what history this run may read unless your request already says.
Choose the active repository, accessible personal history across repositories, specific repositories, or an interview without history.
Repository-only is the default inside a repository.
Cross-repository permission applies only to the current run.
Global installation, `skillDirectories` registration, and personal output paths never grant that permission.

The skill checks repeated preferences across independent sessions and time slices.
It asks which patterns match how you work, then drafts `~/.copilot/agents/<your-name>.agent.md` through [create-skill](../../skills/create-skill/SKILL.md) and [unslop](../../skills/unslop/SKILL.md).
Repository-specific rules stay out of the personal mode.
Before committing or opening a PR, a mechanical audit checks the mode and PR text for private repository keys, home paths, and session IDs.
The personal mode allows no repository names, including the active repository.
Only the PR body can allow its active repository key.
Interview-only and tool-only runs can audit a draft without a history plan or further history access.

Coverage depends on the running `gh copilot` host.
A bundled helper combines the current profile's raw logs and local index, with available personal synced history from the host's cloud tool.
The index can lag newer logs, while pruned logs can leave older sessions available only in the index.
If Node or local profile files are absent, the skill uses available history tools or the interview.
It reports the sources, dates, session counts, skipped records, and any sampling limit before mining.
Repository-only reports do not publish counts of unrelated repositories.
For clustered activity, the helper splits the date window at session timestamps so independent sessions can occupy separate slices.
If fewer than two slices contain sessions, the skill asks you to confirm preferences rather than claiming mined corroboration.

Deleted, purged, expired, and unsynced other-machine sessions are absent.
Sessions in another `COPILOT_HOME` profile or account are absent unless they synced into the current account's accessible history.
Offline hosts and some Enterprise accounts may have no cloud history.
Missing history does not prove that you have no preference.

Run it again whenever your habits drift:

```text
/automate-me update my mode skill with everything since its last edit
```

Update mode resolves scope again on every run.
By default, it mines since the mode file's last git commit.
For an untracked file or a file outside git, it uses the modification time and discloses that estimate.
It keeps rules you have not contradicted, revises rules with new evidence, and adds sections only for new patterns.

## Capture a session's lessons with `/reflect`

Right after a task that taught you something, run:

```text
/reflect that took way too long. capture what we learned so the next run doesn't repeat it.
```

[`/reflect`](../../skills/reflect/SKILL.md) sends the transcript to three parallel reviewers, then a synthesizer sorts the proposals into `Accepted`, `Rejected`, and `Backlog` and waits for your approval before any skill changes. Approve a proposal only if it would change a future decision. One weird session is an anecdote, not a rule.

## Author a focused skill

When you already know the workflow you want to capture:

```text
/poteto-mode write a skill for verifying database migrations in this repo
```

Writing a skill matches the [Authoring or modifying a skill playbook](../../skills/poteto-mode/playbooks/authoring-a-skill.md), which routes through [`create-skill`](../../skills/create-skill/SKILL.md), validates the frontmatter and links, and ships the result through the Opening a PR playbook. Agent-facing prose has a higher bar than human prose, because an unhelpful sentence becomes an instruction some future agent follows. Let the playbook hold that bar rather than writing a `SKILL.md` freehand.

One special case has its own generator. A skill that must drive your app and prove behavior is a verification skill, so use [`/create-verification-skill`](../../skills/create-verification-skill/SKILL.md) and [`/maintain-verification-skill`](../../skills/maintain-verification-skill/SKILL.md) instead. [Verify and ship](./06-verify-and-ship.md#create-a-project-verification-skill) covers both.

## Write docs to a standard with `/technical-writing`

Skills aren't the only prose you ship. For docs, RFCs, readmes, PR descriptions, and commit messages:

```text
/technical-writing review the readme changes
```

[`/technical-writing`](../../skills/technical-writing/SKILL.md) applies a layered standard with one goal, prose a tired engineer understands on the first read. It picks the document's mode first (tutorial, how-to, reference, or explanation), then works sentence by sentence: who does what, one thought per sentence, nothing readable two ways. Use it to review what you or an agent just wrote, or name it up front when you ask for a doc.

## Test a skill change blind

A skill edit affects every future session, so test it like the experiment it is:

```text
/poteto-mode run the eval playbook on this skill change. same task for both variants, candidates stay blind.
```

The [Eval playbook](../../skills/poteto-mode/playbooks/eval.md) is built around one failure mode, the observer effect. An agent that knows it's being evaluated behaves differently. So candidate agents get an organic-looking task in sanitized directories, never the words "eval" or "candidate", and never each other's existence. One judge scores all outputs under neutral labels, and chain-following gets graded from which files each candidate actually read, not from what it claims.

Read every output yourself before accepting the verdict. If you disagree with the judge, suspect the rubric before you suspect your judgment.

**Pitfall:** don't edit a skill mid-task because it's misbehaving. Fix it in its own PR and keep the task moving. A skill edit that ships tangled into feature work is invisible to review and impossible to evaluate.

Next: [Recipes and pitfalls](./10-recipes-and-pitfalls.md).
