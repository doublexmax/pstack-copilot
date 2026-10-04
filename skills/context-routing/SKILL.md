---
name: context-routing
description: Resolve pstack delegate context from persistent policy, explicit workload, and current host/model evidence. Use automatically before every pstack task delegate or session kickoff, for "context policy", "adaptive context", or "configure pstack context"; no user reminder is required.
---

# Context routing

Run this contract before each pstack-managed delegate, including direct workflow invocations.
Do not ask the user to request a larger window.
If the session opted out with the whole command `skip poteto mode`, leave launches unmanaged and their arguments unchanged.
The whole command `/poteto-mode` re-enters.
Native hooks persist opt-out on same-session resume.
With hooks disabled, these commands do not update the native marker. Follow the conversational opt-out, but do not claim durable tracking.

## Resolve before the launch

1. Locate the pstack checkout from this skill's base directory, two levels up.
   Use that checkout's `scripts\context-routing.mjs`, not a script relative to the user's repository.
   The resolver reads `context.default.json`, the existing model map, and the optional personal `pstack-context.json`.
   `COPILOT_HOME` selects the personal directory. Without it, use the normal user `.copilot` directory.
2. Name the exact configured role. Keep combined labels such as `feature, refactoring` intact.
   Select panel members separately with zero-based `--member`.
   Use `judgment and prose` for an ad-hoc reviewer unless the workflow names another role.
   Preserve the workflow's selected model and effort. For an explicit race or fallback, pass both `--model` and `--effort`.
   Aliases `auto` and `inherit-parent` omit both launch fields. Pass `--parent-model` only when the effective parent model is known.
   An omitted kickoff model does not prove inheritance from the parent, so kickoff aliases remain explicitly unresolved.
3. Classify the delegate's actual inputs, not its role, prompt length, or model family.
   `bounded` covers a named helper, limited diff, or independent slice.
   `large-corpus` covers evidence that the delegate must hold and compare together across a large body of material.
   Give a concrete `--why` and one `--input` per input reference. A corpus needs input references.
4. Read this session's actual tool schema or current host metadata.
   Set `--host-context supported` only if this launch tool exposes the context field.
   Set `--support supported` only if current evidence supports long context for the exact selected model on that target.
   A model's presence in a picker, a nominal window, billing keys alone, or reasoning `max` is insufficient.
   Use `unsupported`, `unknown`, or `unavailable` when that is what the evidence says.
   Record the evidence in `--source` and `--host-source`. Do not borrow another panel member's support.
5. Run the resolver. This PowerShell example assumes the two support facts in step 4 were observed.

```powershell
node "<pstack>\scripts\context-routing.mjs" resolve `
  --role "how explainer" --workload bounded --why "Read one named helper." `
  --input "scripts\install-always-on.mjs" `
  --host-context supported --host-source "Current task context_tier schema" `
  --support supported --source "Current exact-model task schema"
```

   For kickoff, add `--target create_session`, `open_pr_session`, or `open_issue_session`.
   A resolved result has `decision`, `declaration`, and literal `toolArguments`.
   A blocked result has no tool arguments and exits nonzero. Fix the reported cause; do not drop the context field.
6. Copy the returned arguments into the real tool call.
   For `task`, copy the returned model, effort, and `context_tier`.
   For kickoff, copy `toolArguments.kickoff` into the kickoff object.
   Omit model and effort when the result omits them. Do not replace the selected model to obtain a tier.
   Prefix the task name with `pstack-`. Start its prompt, or `kickoff.prompt`, with the exact returned `declaration` line, then a newline and the brief.
   Do not add a second declaration. Keep the other arguments unchanged.

## Policy and observations

Adaptive selects `default` for bounded work.
It selects `long_context` for eligible large-corpus work.
Unknown or unsupported model support selects `default` with an explicit diagnostic.
Known unavailable models block. Explicit long policy blocks when support is unproven.
The exact role override wins over the global policy.

Native CLI hooks call the same resolver and can correct a missing or mismatched tier on a managed launch.
They never grant tool permissions. Unmanaged calls remain untouched.
Missing or malformed declarations deny only calls that claim the reserved pstack scope.
Decisions appear in `pstack-context-decisions\<sessionId>` under the active Copilot home.
Read the decision and report a downgrade or denial with its reason.
Post-hook arguments and effective `subagent.configured` metadata prove dispatch; original tool requests can retain pre-hook values.

Disabled hooks, timeouts, unmarked launches, and an unavailable hook runtime can bypass native checks.
Copying the resolver's explicit arguments remains necessary.
`install-always-on.mjs --hooks remove` disables only the owned native hooks.
`--hooks skip` leaves existing hooks unchanged; it does not disable them.
Local hooks do not transfer to a cloud worker. Give remote descendants access to this contract and resolver before they delegate.
This contract never changes an already-running parent or per-agent defaults.
Larger context is not a quality promise. Available input also includes system instructions, history, and tool output.

See [the policy reference](../../docs/context-routing.md) for setup, errors, and the real CLI verification command.
