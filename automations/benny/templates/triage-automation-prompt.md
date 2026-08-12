# Triage workflow prompt

> Source material for the copied setup workflow. Paraphrase this intent into a `save_workflow` call once the copied pack is committed in the repository the workflow will run against. Pass `user_confirmation: "dialog"` so the human reviews it before it is saved.

Read and follow `.github/automations/benny/skills/triage-issue-reports/SKILL.md` for this run.

Configuration source. Include this repository-relative path only when it is committed in the same target repository. Otherwise paraphrase the configured values. Never use a cache path outside the repository:

```text
{{BENNY_CONFIG_PATH}}
```

Schedule: `{{TRIAGE_INTERVAL}}`. This workflow is polled, not pushed.

Each run:

1. Use the configured intake backend's `list_new` operation over `{{INTAKE_QUERY}}` to find reports.
2. Skip any report that already carries a benny marker from `{{TRIAGE_IDENTITY}}`. That marker is the only completion signal; do not keep a state file.
3. Take the oldest remaining report, handle exactly `{{REPORTS_PER_RUN}}` of them, and leave the rest for the next tick.
4. If nothing is left to handle, exit quietly without replying anywhere.

Capture the report's coordinates once at the start and treat them as immutable. If they are missing or do not match configuration, stop without replying or writing to the issue tracker.

The committed operational file owns classification, attachment review, cause tracing, routing, dedupe, tracker writes, and the final verdict. Post no progress messages. Never open a new item in the intake queue.

The coordinator is the only intake replier. Any delegated worker must be read-only, return findings only, and receive an explicit ban on every intake write action.

End the single verdict with exactly one configured marker:

```text
[benny:bug]
[benny:performance]
[benny:other]
```

A bug or performance marker may add `tracker=<URL>`.