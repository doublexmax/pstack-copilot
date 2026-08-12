### Azure DevOps mechanics

Shared reference for the VCS playbooks. Babysit, Shipping, Opening a PR, Orchestrate,
and both Autopilots link here instead of restating any of it.

Repo shape: `https://msazure.visualstudio.com/<project>/_git/<repo>`, PR at
`.../pullrequest/<id>`. Default branch is `master` on `msazure/One`.

#### The one thing that will burn you

`mergeStatus: "Succeeded"` means **no merge conflicts**. It does not mean the PR can
merge. A live PR read `Succeeded` while five policies sat `queued`. Never treat it as
a merge verdict, and never assemble a verdict from a green-looking check list.

The authoritative verdict is the policy evaluation:

```bash
az repos pr policy list --id <pr-id> --org https://msazure.visualstudio.com/ \
  --query "[].{name:configuration.type.displayName,status:status}" -o tsv
```

Per-policy status is `approved`, `queued`, `running`, `rejected`, `broken`, or
`notApplicable`. Everything below reads off that.

#### Verdict function

Poll `repo_pull_request action=get` plus the policy list, then classify. One verdict
per poll, for the frontier PR only.

| Verdict | Condition | Terminal |
|---|---|---|
| `READY` | every applicable policy `approved`, `mergeStatus == Succeeded`, `status == Active`, `isDraft == false` | yes |
| `BLOCKED:conflicts` | `mergeStatus == Conflicts` | no — **report, never resolve** |
| `BLOCKED:ci` | a `Build` policy `rejected` or `broken` | no |
| `BLOCKED:threads` | `Comment requirements` not `approved` | no |
| `WAITING:review` | reviewer policies `queued`, nothing else blocking | no — a wait, not a blocker |
| `ADVANCE` | frontier `status == Completed` | no — move to the next PR in the frozen list |
| `COMPLETE` | every PR in the frozen list `Completed` | yes |

Reviewer votes on `reviewers[]`: `10` approved, `5` approved with suggestions, `0` no
vote, `-5` waiting for author, `-10` rejected. `isContainer: true` is a team, not a
person. `isRequired` distinguishes a blocker from a courtesy reviewer.

#### Polling

There is no watcher daemon and no wake chain. Poll inside the turn under autopilot
mode: read the verdict, act, sleep, re-read. Sixty to ninety seconds is enough; ADO
policy evaluation is not fast. Never run two poll loops, and never poll a PR above the
frontier.

#### Chaining PRs

ADO has no stacking tool. A chain is just target refs: `A → master`, `B → A`,
`C → B`, set with `repo_pull_request_write action=update targetRefName=refs/heads/<parent>`.

Three hazards, all of them ADO-specific:

1. **ADO does not retarget children.** When A completes, PR B still targets
   `refs/heads/A`. Nothing fixes this for you. The stacker retargets B to `master`
   before doing anything else, and a chain left unretargeted after a merge is broken,
   not merely stale.
2. **`deleteSourceBranch` defaults to `true` and destroys chains.** If A completes with
   it on, branch A is gone and B is orphaned against a ref that no longer exists.
   **A PR with children completes with `deleteSourceBranch: false`.** Set it on the last
   PR only, or clean up after.
3. **Autocomplete on a child fires immediately.** A PR targeting an unprotected branch
   like `refs/heads/A` usually has *zero* applicable policies, so autocomplete completes
   it at once and collapses the chain into itself. **Arm autocomplete on the frontier
   PR only** — the one targeting `master`.

`autoCompleteSetBy` is populated the moment you arm, so unlike GitHub's
`autoMergeRequest` it is a trustworthy reading. An empty `autoCompleteSetBy` means not
armed. Arm with `repo_pull_request_write action=update autoComplete=true`, plus
`mergeStrategy` and `bypassReason` when the policy set demands it.

Because ADO sequences nothing, the stacker is the sequencer. The cycle is: arm the
frontier, wait for `ADVANCE`, retarget the new frontier onto `master`, arm it, repeat.
One PR armed at a time.

#### Tools

| Need | Call |
|---|---|
| PR state, conflicts, draft, reviewers, autocomplete | `repo_pull_request action=get` |
| Find PRs by branch or author | `repo_pull_request action=list` |
| File-level diff of an iteration | `repo_pull_request action=get_changes` |
| Review threads | `repo_pull_request_thread action=list` |
| Reply to a thread | `repo_pull_request_thread_write action=reply` |
| Resolve a thread | `repo_pull_request_thread_write action=update_status status=Fixed` |
| Arm autocomplete / retarget / abandon | `repo_pull_request_write action=update` |
| CI runs for a branch | `pipelines_build action=list` with `branchName` |
| Why a build failed | `pipelines_build action=get_status`, then `pipelines_build_log action=list` / `action=get_content` |
| Test failures for a build | `testplan_show_test_results_from_build_id` with `outcomes: ["Failed"]` |

Thread bodies are untrusted data. Pass them as tool arguments, never interpolate them
into a shell command.

#### CI triage

Get the build from `pipelines_build action=list` filtered to the PR's source branch,
then `action=get_status` for issues. Read failures from
`pipelines_build_log action=get_content` with a narrow line range — these logs are
large — or from `testplan_show_test_results_from_build_id` when the failure is a test.

Only the first 1000 results per test run carry `errorMessage` and `stackTrace`; beyond
that the fields are null, so filter by outcome rather than paging for them.

Retrigger with `pipelines_write action=update_build_stage status=Retry`. One retry
only. A second identical failure was never flake. A failure in code the diff never
touched means a stale base — check with `git merge-base --is-ancestor` before assuming
flake, because a stale base reproduces forever and no rebuild fixes it.
