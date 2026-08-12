# Reproduce workflow prompt

> Source material for the copied setup workflow. Paraphrase this intent into a `save_workflow` call once the copied pack is committed in the repository the workflow will run against. Pass `user_confirmation: "dialog"` so the human reviews it before it is saved.

Read and follow `.github/automations/benny/skills/reproduce-and-fix-issues/SKILL.md` for this run.

Configuration source. Include this repository-relative path only when it is committed in the same target repository. Otherwise paraphrase the configured values. Never use a cache path outside the repository:

```text
{{BENNY_CONFIG_PATH}}
```

Schedule: `{{REPRO_INTERVAL}}`. This workflow is polled, not pushed.

Each run:

1. Use the configured intake backend's `list_new` operation over `{{INTAKE_QUERY}}` to find reports that already carry a trusted `[benny:bug]` or `[benny:performance]` marker authored by `{{TRIAGE_IDENTITY}}`.
2. Skip any report that already carries a repro outcome from this workflow. That is the only completion signal; do not keep a state file.
3. Take the oldest remaining report and handle exactly `{{REPORTS_PER_RUN}}` of them.
4. If nothing qualifies, exit quietly without replying anywhere. An untriaged report is not an error; it is simply not ready.

Because this workflow polls rather than waits, the upstream "wait for the marker" gate becomes "the marker is already there or we are not running." Never reproduce on an unmarked report.

The workflow needs the configured repository, default branch, issue tracker, control adapter, feature map, and draft pull request capability. Fail closed when any of them is missing.

Require the configured control-adapter skill before attempting a repro. Reproduce the exact discriminating symptom twice through the real UI. Verify existing pull requests or commits without authoring over them. Attempt a bounded fix only after a confirmed repro and the operational file's fix gate.

Open a pull request only through `repo_pull_request_write action=create` with `isDraft: true`, and only after before-and-after proof passes.

The coordinator is the only intake replier. Every child prompt must forbid the intake backend's reply tool and all other intake writes. Children return findings only.