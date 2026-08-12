# benny

benny gives you two scheduled copilot workflows for issue reports. one triages each report. the other reproduces confirmed bugs and may prepare a small draft fix.

the files in this directory are dormant setup and operational sources. they are not registered skills and will not appear in `copilot skill list`.

benny's behavior is unchanged from upstream; only the plumbing differs. workflows are **scheduled and polled** via `save_workflow` rather than fired by an event, and the intake is an **adapter** that defaults to azure devops work items. see [`references/intake.md`](./references/intake.md).

## setup

1. point the agent at [`FOR_AGENTS.md`](./FOR_AGENTS.md) and name the target repository.
2. let setup merge this whole directory into the target at `.github/automations/benny/`. it must preserve destination-only files and review conflicts instead of overwriting local edits.
3. no skill registration is needed. pstack is registered globally in `~/.copilot/settings.json`, so `how`, `why`, `tdd`, `unslop`, and the principle skills already resolve in the target repository. confirm with `copilot skill list`.
4. keep user-owned configuration outside the copied pack, for example in `.github/benny/`. adapt [`configuration.example.yaml`](./templates/configuration.example.yaml) and [`feature-map.example.md`](./skills/reproduce-and-fix-issues/references/feature-map.example.md).
5. commit `.github/automations/benny/` and any secret-free configuration before enabling either workflow.
6. review each workflow draft in the editor (`save_workflow` with `user_confirmation: "dialog"`), then use `run_workflow` to send a harmless test report through and verify every reply stays inside the original report.

## what changed from upstream

| upstream | here |
| --- | --- |
| event-triggered automation | copilot workflow, scheduled and polled |
| `/automate` (creation only) | `save_workflow` (creates **and** updates via `workflow_id`) |
| plugin-local automation dir | `.github/automations/benny/` |
| project-scoped plugin registration | nothing; pstack is global |
| slack channel intake | intake adapter, default azure devops work items |
| `gh` draft pr | `repo_pull_request_write action=create` with `isDraft: true` |

the one genuinely lossy translation is the trigger. copilot has no event hook, so "when someone posts a report" becomes "every hour, look for reports i have not handled yet." every operational file is written to be safe to re-enter, and the completion record is the benny marker in the thread rather than a state file.