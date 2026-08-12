---
name: setup-benny
description: Configure Benny and prepare its triage and repro workflows. Use when installing Benny or changing its intake, tracker, repository, routing, control, model, schedule, or budget settings.
---

# Set up Benny

Benny ships as a dormant workflow pack inside pstack. The global skill registration exposes only pstack's normal skill root; this file and the two operational files are not registered skills.

The human enters setup by pointing the agent at the pack's `FOR_AGENTS.md`. The bootstrap flow copies the whole pack into the target repository, then reads this file directly at `.github/automations/benny/skills/setup-benny/SKILL.md`.

Benny needs external configuration and two live Copilot workflows.

Do not create or update an automation until the user explicitly asks. Never put a secret value in pack files, prompts, or committed configuration.

## 1. Copy the pack and confirm shared pstack skills

Do this before asking for Benny configuration and before invoking the `save_workflow` tool.

Ask which repository will run the workflows. The source pack is the directory containing `FOR_AGENTS.md`. The destination is `<target-repository>/.github/automations/benny/`.

Merge the entire source pack into the destination:

1. Create the destination when it is absent.
2. Copy every source file to the same relative path.
3. Preserve destination-only files. Never delete unrelated files during install or refresh.
4. Keep user-owned configuration, feature maps, and routing maps outside the destination. Never overwrite them.
5. When an existing source-managed file differs, inspect the diff and merge without discarding local edits. If ownership is ambiguous, stop and ask before replacing it.
6. Verify that the destination contains `FOR_AGENTS.md`, this setup file, both operational files, their references, and the templates.

If this file is already being read from the target destination, treat the copy as complete and run the same verification before continuing.

pstack is registered globally in `~/.copilot/settings.json`, so the target repository needs no skill registration of its own. That is the whole of the dependency step in this fork. Confirm the shared skills actually load by running `copilot skill list` and checking for:

- `how`
- `why`
- `tdd`
- `unslop`
- `principle-separate-before-serializing-shared-state`
- `principle-minimize-reader-load`
- `principle-guard-the-context-window`
- `principle-sequence-verifiable-units`
- `principle-fix-root-causes`
- `principle-prove-it-works`

If any of them is missing or reports a load error, stop and explain the failure. Do not work around it by inlining the skill's content into a workflow prompt.

The Benny files are read directly from `.github/automations/benny/`. Do not add that directory to `skillDirectories`. These files are long operational instructions, not skills, and registering them would push them into every session's skill list.

Tell the user that `.github/automations/benny/` and any referenced secret-free configuration must be committed before either workflow is enabled. Do not commit them unless the user asks.

Once this check passes, live workflow prompts may read the committed operational files by their stable repository-relative paths. They must not embed an absolute path outside the repository or copy the file contents.

## 2. Adapt the configuration

Open these copied examples:

- `../../templates/configuration.example.yaml`
- `../reproduce-and-fix-issues/references/feature-map.example.md`

Create user-owned copies outside `.github/automations/benny/`. These are configuration files, not pack files. Example locations:

- Project config, such as `.github/benny/configuration.yaml`
- Project feature map, such as `.github/benny/feature-map.md`
- Project routing map, such as `.github/benny/routing.md`
- User config, such as `~/.config/benny/configuration.yaml`
- User feature map, such as `~/.config/benny/feature-map.md`

Fill one feature-map section for every user-facing feature the automation may reproduce. Keep it at the user point of view. Do not freeze implementation details or current code paths in the map.

Do not edit the copied examples. Pack refreshes may update source-managed files after conflict review, but they must never touch the user-owned copies.

Prefer committed, secret-free files in the target repository when a fresh automation checkout must read them. Otherwise paraphrase the required values into the live prompt. Reference a repository file only after the `save_workflow` tool confirms that the file is committed in the repository where the automation runs.

Use stable repository-relative paths for committed pack and configuration files. Never reference the pstack source directory or any other path outside the target repository from a live workflow.

## 3. Fill the required choices

Ask for or confirm:

- Intake backend (`azure-devops` or `slack`) and its queue coordinates: an ADO organization, project, and work-item query, or a Slack channel ID
- Optional operations or status thread for detailed progress
- Repository URL and default branch
- Triage identity, so the repro workflow can trust a marker
- Issue tracker type, team, project, labels, and intake status. `type: intake` reuses the intake backend as the tracker
- Tracker adapter skill or MCP actions, when the tracker is a separate system
- Optional routing map path
- Required control skill name
- Required user-facing feature-map path
- Status marker strings
- Pull request URL format
- Schedule interval for each workflow and how many reports one run may handle
- Polling and effort budgets
- Model slug for triage, repro, code work, and media review

Use only model slugs shown as available in the model panel in pstack's `models.default.md` rule. Do not guess a slug and do not carry over a private default.

The intake queue, triage identity, repository, tracker adapter, control skill, and feature map must be explicit. Fail setup if any required value stays ambiguous.

Use pstack's `unslop` skill on the final automation names, descriptions, and prompt shims before saving them.

## 4. Check integration capabilities

The triage workflow needs:

- Read access to the configured intake queue and its threads
- Reply access on an existing report in that queue
- Attachment metadata and file download access when reports include media
- Search, read, create, and update access through the configured issue-tracker adapter

The repro workflow needs:

- Read access to the source thread
- Reply access on that thread
- Optional post and edit access on the configured operations thread
- Repository read and history access
- `repo_pull_request_write` to open a draft pull request
- The configured control-adapter skill

Resolve every one of these through the backend table in [`../../references/intake.md`](../../references/intake.md). With the `slack` backend, prefer configured Slack MCP actions for reads and posts; the optional `BENNY_SLACK_BOT_TOKEN` may fill a narrow gap such as editing one operations status message or downloading an attachment. Store the value in a secret manager or environment, not in YAML. With the `azure-devops` backend no token is needed, because the ADO MCP carries its own auth.

Do not use undocumented integration endpoints.

## 5. Prepare the routing map

If the user wants reroutes or owner pings:

1. Copy `../triage-issue-reports/references/routing.example.md` outside `.github/automations/benny/`.
2. Replace every placeholder with public or organization-local values.
3. Keep owner pings off by default.
4. Allow a ping only for a configured feature owner or a confirmed likely regression author.

If no routing map is configured, triage may classify a report but must not guess a destination or owner.

## 6. Verify the control adapter

Read `../reproduce-and-fix-issues/references/control-adapter.md` and the user's completed feature map.

Confirm that the named skill can:

- Bring up the target app
- Navigate every mapped feature through the real UI
- Exercise mapped states through declared adapter actions
- Inspect state without forcing the result
- Capture screenshots
- Start and stop a recording
- Clean up its processes and temporary data

If any capability is missing, leave the repro automation disabled. It must fail closed rather than claim a reproduction it did not perform.

## 7. Prepare the live automations

Ask whether this is first-time creation or configuration of existing automations.

Read `../../FOR_AGENTS.md` from the copied pack as the primary user-intent source for either path. Use it to understand the two triggers, tools, instructions, outcomes, and shared rules.

### First-time creation

Create one workflow at a time.

For each workflow:

1. Read the matching copied prompt template as secondary internal source material.
2. Turn `FOR_AGENTS.md`, the finished Benny configuration, and the template intent into a complete natural-language prompt. Substitute every `{{PLACEHOLDER}}` in the template with a real configured value.
3. Tell the prompt to read and follow its exact committed operational file under `.github/automations/benny/`.
4. Use the stable repository-relative path. Do not copy the operational file contents into the prompt.
5. Verify yourself that the copied pack and any referenced configuration files are committed in the repository the workflow will run against. `save_workflow` does not check this for you.
6. Call `save_workflow` with `name`, `prompt`, `project_id`, `interval` and its schedule fields from `schedule` in the configuration, `mode: "autopilot"`, the configured `model`, and `user_confirmation: "dialog"` so the human reviews the draft in the workflow editor before it is saved.
7. Leave `enabled` false until the thread-safety test in section 8 passes.
8. Finish the editor handoff for this workflow before starting the next one.

Give the triage workflow this complete intent, filled from configuration:

- Name `benny-triage`.
- Read and follow `.github/automations/benny/skills/triage-issue-reports/SKILL.md` for every run.
- Poll the configured intake queue on the configured interval for reports that do not yet carry a benny marker.
- Read the selected report and reply only inside it.
- Use the configured issue-tracker integration.
- Classify, inspect evidence, trace cause, dedupe, and create only clear new bugs.
- End one thread-only verdict with the configured `[benny:bug]`, `[benny:performance]`, or `[benny:other]` marker and optional tracker URL.
- Never open a new item in the intake queue.
- Exit quietly when nothing needs triage.

After the triage handoff is complete, give the repro and fix workflow this intent:

- Name `benny-reproduce`.
- Read and follow `.github/automations/benny/skills/reproduce-and-fix-issues/SKILL.md` for every run.
- Poll the same intake queue for reports that already carry a trusted triage marker and no repro outcome.
- Use the configured repository and default branch.
- Read the source thread and reply only inside it.
- Include pull request creation and the configured tracker, control-adapter, and feature-map requirements. Paraphrase mapped user paths and states unless the file is committed in the same repository.
- Reproduce the exact symptom twice through the mapped real UI and capture evidence.
- Verify an existing fix without authoring over it.
- Attempt an optional bounded fix only after confirmed repro, then open a draft pull request through `repo_pull_request_write action=create` with `isDraft: true` when proof and checks pass.
- Never open a new item in the intake queue.
- Exit quietly when nothing qualifies.

### Existing workflows

Unlike Cursor's creation-only `/automate`, `save_workflow` can update in place. Use `list_workflows` to find the existing `benny-triage` and `benny-reproduce`, then call `save_workflow` with the returned `workflow_id` and only the fields that change. Never create a second workflow that does the same job.

Finish configuration, routing, control-adapter, and feature-map validation first. Then confirm each existing workflow still carries:

For triage:

- Name and description
- Direct instruction to read `.github/automations/benny/skills/triage-issue-reports/SKILL.md`
- The configured intake queue, poll interval, and reports-per-run
- Intake read and reply capabilities
- Issue-tracker integration
- Paraphrased triage instructions, thread-only rule, and Benny verdict markers

For repro:

- Name and description
- Direct instruction to read `.github/automations/benny/skills/reproduce-and-fix-issues/SKILL.md`
- The same intake queue and a compatible interval
- Repository and default branch
- Intake read and reply capabilities
- Draft pull request capability
- Tracker, control-adapter, and feature-map requirements
- Paraphrased marker gate, evidence, verification, and bounded-fix instructions

Use `run_workflow` for an on-demand test run rather than waiting for the next tick.

### Creation boundary

Never call an external automation backend service. Never use a browser URL that carries draft fields. Never build or open an editor deep link. The only finish path is `save_workflow`.

Do not enable either workflow until the thread-safety test passes.


## 8. Test thread safety

Use a test channel or a harmless test report.

Before testing, confirm that `.github/automations/benny/` and every referenced secret-free configuration file are committed on the branch the workflow checkout uses. Confirm that both prompts point at their exact committed operational files. If any check fails, stop. Tell the user that the workflow cannot be enabled yet.

Trigger the run with `run_workflow` rather than waiting for the interval.

Verify:

1. Triage captures the report's coordinates once and posts exactly one verdict as a reply inside it.
2. The verdict contains one configured marker.
3. Repro accepts the marker only from the configured triage identity.
4. Repro keeps the same immutable source coordinates.
5. No new intake-queue item appears.
6. A delegated worker cannot use the intake backend's reply tool.
7. Missing coordinates, a deleted parent, or a failed preflight produces no reply and no tracker issue.
8. A second `run_workflow` on the same already-handled report is a no-op. This is the check that upstream did not need, because Cursor fired once per event and Copilot polls.

Enable normal traffic only after all eight checks pass.
