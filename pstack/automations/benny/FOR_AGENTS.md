# benny automation intent

## what i want to automate

i want two copilot workflows that work together in one intake queue.

### automation 1: triage issue reports

- trigger: when someone posts a new top-level report in my configured intake queue, i want this automation to start on that report and keep its original thread coordinates.
- behavior: i want it to read the thread and attachments, classify the report as a bug or performance issue, feature request, question or feedback, or reroute, and trace the likely owning layer before routing.
- tracker: i want it to search my configured tracker for duplicates, update a confident duplicate, and create a ticket only for a clear net-new bug.
- tools: i want intake read and reply access, my configured tracker integration, and my optional routing map.
- outcome: i want exactly one reply in the source thread with a short verdict and `[benny:bug]`, `[benny:performance]`, or `[benny:other]`. a bug or performance marker may include the tracker url.
- boundary: i never want this automation to post a root message in the intake queue.

### automation 2: reproduce and fix confirmed bugs

- trigger: i want this automation to start from the same new top-level report, or another supported trigger chosen during setup, then wait for the trusted triage marker in the original thread.
- gates: i want it to stop when someone clearly owns the fix. if an existing pull request or merged commit may fix the report, i want verification instead of a competing change.
- behavior: i want it to use my configured control adapter and feature map, reproduce the exact symptom twice through the real ui, and capture screenshots, video, and a read-only state cross-check.
- fix: i want it to verify existing pull requests without authoring over them. after a confirmed repro, it may attempt one bounded root-cause fix, use tdd when the test is cheap, smoke the blast radius, and open a draft pull request only when before-and-after proof passes.
- tools: i want intake read and reply access, repository and history access, draft pull request creation, my configured tracker, and my control adapter.
- outcome: i want evidence and a verified result in the source or optional operations threads, plus an optional draft pull request. updates should be concise.
- boundary: i never want this automation to post a root message in the intake queue.

### shared rules

- i want the intake queue and root thread coordinates to stay immutable for the whole run.
- i treat utility and debug bots as evidence, not delegation or fix ownership.
- i allow subagents to help, but they cannot reply to the intake queue or receive intake write credentials.
- i want this entire pack committed at `.github/automations/benny/` in the target repository. its `SKILL.md` files are direct workflow instructions, not registered skills.
- i rely on pstack being registered globally in `~/.copilot/settings.json`, so shared dependencies such as `how`, `why`, `tdd`, `unslop`, and the required principle skills already resolve in every repository. the target repository needs no skill registration of its own.
- i want each live automation prompt to read its committed operational file directly. i do not want path outside the repositorys, copied excerpts, or slash-skill discovery.
- i keep user-owned configuration, feature maps, routing maps, and secrets outside `.github/automations/benny/` so pack refreshes cannot overwrite them.
- i want both automations to fail closed when channel coordinates, tracker access, the control adapter, or the feature map are missing or uncertain.
- i want draft pull requests only. do not merge or deploy.

### my configuration

- intake queue: `<channel>`
- optional operations channel: `<channel or none>`
- repository and default branch: `<repo>`, `<branch>`
- tracker: `<type, team, project, labels, intake status>`
- routing map: `<path or none>`
- triage identity: `<intake identity>`
- control skill: `<configured skill or adapter>`
- feature map: `<committed same-repo path outside the copied pack, or behavior to paraphrase>`
- models: `<triage, reproduce, code, media review>`
- status emoji strings: `<seen, reproducing, reproduced, blocked, fixing, failed, pull request opened>`
- budgets: `<polling, verdict wait, follow-up, repro, rejection, fix>`
- optional bot token capability: `<none, file download, or editable operations status>`

start from [`configuration.example.yaml`](./templates/configuration.example.yaml) and [`feature-map.example.md`](./skills/reproduce-and-fix-issues/references/feature-map.example.md). copy and fill them outside this pack, for example under `.github/benny/`. keep secret values in a secret manager or environment.

## for the agent

the human enters setup by pointing the agent at this file. do not look for or invoke a discovered benny slash skill.

1. ask which repository will run the workflows.
2. treat the directory containing this `FOR_AGENTS.md` as the source pack.
3. merge the entire source pack into `<target-repository>/.github/automations/benny/`.
4. preserve every destination-only file. never delete unrelated files or overwrite user-owned configuration, feature maps, or routing maps.
5. when an existing destination file at a source-managed path differs, review the diff and merge without discarding local edits. if ownership is ambiguous, stop and ask before replacing it.
6. verify that the copied `FOR_AGENTS.md` and `skills/setup-benny/SKILL.md` exist in the target repository.
7. read and follow `.github/automations/benny/skills/setup-benny/SKILL.md` directly from the target repository.

pstack is registered globally in `~/.copilot/settings.json`, so the target repository needs no skill registration. confirm the shared dependencies actually resolve before continuing: run `copilot skill list` and check that `how`, `why`, `tdd`, `unslop`, and the principle skills benny uses are present and loaded without error. if any of them is missing, stop and explain what failed rather than working around it.

do not add `.github/automations/benny/skills/` to `skillDirectories`. these files are read by path, and registering them would put non-skill instructions into every session's skill list.

tell me that `.github/automations/benny/` and any referenced secret-free configuration must be committed before either workflow is enabled. do not create or update a workflow until i explicitly ask.

## how the automations run

copilot has no event-triggered automation, so each benny automation is a **scheduled workflow** created with the `save_workflow` tool. the trigger is a poll, not a push: the workflow wakes on its interval, looks for reports it has not handled yet, and exits quietly when there are none. every operational file is written to be safe to re-enter, so a repeated poll over an already-handled report is a no-op rather than a duplicate verdict.

for first-time creation, call `save_workflow` once for triage and once for repro and fix. pass `user_confirmation: "dialog"` so i review each one in the workflow editor before it is saved, and finish the first before starting the second.

paraphrase this intent and the finished configuration into each workflow prompt. the triage prompt must read and follow `.github/automations/benny/skills/triage-issue-reports/SKILL.md`. the repro prompt must read and follow `.github/automations/benny/skills/reproduce-and-fix-issues/SKILL.md`. use these repo-relative paths only after confirming they are committed in the repository the workflow runs against.

for existing workflows, use `list_workflows` to find them and `save_workflow` with the returned `workflow_id` to update them in place. never create a second workflow that does the same job. use `run_workflow` for an on-demand test run instead of waiting for the next interval.