# Pstack context policy

Pstack routes delegate context without changing your model or reasoning choices.
The default is adaptive. Bounded delegates use `default`.
Large-corpus delegates use `long_context` when current evidence supports that tier for the selected model and launch tool.

## Personal policy

`context.default.json` holds the checked-in policy.
`pstack-context.json` in your Copilot configuration directory overrides it.
The directory is `COPILOT_HOME` when set, otherwise your user `.copilot` directory.
Personal policy lives outside the checkout, so a pull does not overwrite it.
The existing 17-role `pstack-models.md` format remains `model / effort`.

```json
{
	"schemaVersion": 1,
	"default": "adaptive",
	"roles": {
		"how explainer": "default",
		"hardest tasks": "long_context"
	}
}
```

`default` is optional in a personal file. An omitted value inherits the checked-in default.
`roles` is optional. Exact role keys override the global mode.
Combined labels retain their commas. Panel members keep separate model-support decisions.
Unknown policy keys or role overrides, duplicate fields, invalid modes, and malformed model configuration fail loudly.
Retired valid model-role lines produce a diagnostic and remain unchanged during context-only setup.

| Mode | Decision |
| --- | --- |
| `adaptive` | Default for bounded work. Long for eligible joint large-corpus work. Unknown or unsupported long support produces default with a reason. |
| `default` | Default context regardless of workload. |
| `long_context` | Long context only with proven host and exact-model support. Otherwise the launch blocks. |

Known unavailable models block in every mode. Pstack does not replace them.
The caller supplies current support facts from its actual tool schema or host metadata.
Pstack ships no hard-coded model capability catalog or provider-prefix heuristic.
The source of each support fact is part of the decision record.

## Configure policy without changing models

Use `/setup-pstack` with a context-only request.
It skips the model and budget rewrite.
The equivalent command updates only the personal context policy.

```powershell
node "$env:USERPROFILE\.copilot\pstack\scripts\context-routing.mjs" set-policy --default adaptive
```

Set an exact role override with `--role-policy`.

```powershell
node "$env:USERPROFILE\.copilot\pstack\scripts\context-routing.mjs" set-policy `
  --role-policy "how explainer=default"
```

Run `show` to print the effective policy and its source file.
Existing models, effort budgets, parent context, and per-agent context defaults remain unchanged.

## Automatic dispatch

The installed always-on contract invokes [context-routing](../skills/context-routing/SKILL.md) before pstack delegation.
Direct workflow skills invoke the same contract independently.
The executable resolver returns literal tool arguments and one `PSTACK_CONTEXT_V1` declaration.
The caller copies both into the launch. Kickoff uses `kickoff.context_tier`.

The native CLI hook uses a reserved `pstack-` task name or a declaration on the first prompt line to recognize a managed launch.
It changes only the context field and never returns a permission grant.
It leaves ordinary unmanaged calls unchanged, even when the personal context policy is invalid.
Managed missing or malformed declarations deny with a repair reason.

Submit the whole command `skip poteto mode` to opt this session out.
Opt-out leaves arguments unchanged, not forced to default.
It persists when you resume the same session.
Submit the whole command `/poteto-mode` to re-enter.
Quoted text, code, substrings, and extended commands do not toggle this state.
Opt-out follows the host session ID. A separately identified child or new session does not automatically inherit it.

Aliases on `task` use a known effective parent model or report `alias-parent-unresolved`.
An omitted kickoff model does not establish which model the host will choose.
Kickoff aliases therefore report `kickoff-model-unresolved` and cannot satisfy a required long policy.
No decision inherits the parent's context tier.

## Installation and scope

Register the checkout's skills and copy its agents, then run the always-on installer.
The installer adds `hooks\pstack-context.json` and a self-contained `hooks\context-hook.mjs` entry with direct-exec Node hooks.
It refuses a foreign file at that reserved path and preserves other hooks.
Repeated installation is byte-identical for owned files.
Uninstall removes the managed hook and instruction block, not your policy or model map.
After updating pstack or moving the checkout, rerun the installer to refresh the copied entry and its checkout path.

For an already trusted installation with JSONC configuration, preserve trust settings and shell files.

```powershell
node "$env:USERPROFILE\.copilot\pstack\scripts\install-always-on.mjs" --skip-trust --skip-shell
```

Use `--dry-run` first to inspect planned writes.
`COPILOT_HOME` also isolates installation and native decision records.
The installer never changes `settings.json` context tiers or subagent defaults.

## Evidence and limits

Each native event has a content-named JSON record in `pstack-context-decisions\<sessionId>`.
A resolved record includes role, effective model, workload, policy, tier, reason, diagnostics, and evidence sources.
A blocked record has no usable launch arguments.
Post-tool records distinguish a matching observed tier from a mismatch.

The host can disable hooks. Command hook timeouts fail open.
A launch that omits both reserved markers is unmanaged, so the native hook cannot detect a forgotten pstack classification.
The source gate catches missing workflow bindings, not arbitrary agent behavior.
An unavailable hook executable can also break the host's hook execution.
Copilot denies tool calls when a command pre-tool hook crashes or its executable cannot start, including unrelated calls.
The installed entry bypasses unmarked calls before checkout imports or session validation, so a broken pstack checkout does not block them.
If Node or the copied entry is unavailable, remove only `hooks\pstack-context.json` to restore the ordinary permission flow.
These are not universal enforcement guarantees. Copilot App hook behavior is unverified by the CLI receipts.
Local user hooks do not install themselves in cloud workers.
Explicit kickoff arguments are wired, but remote execution needs its own capability evidence.

Nominal model capacity is not available task input.
GitHub's [extended-capability table](https://docs.github.com/en/copilot/reference/ai-models/supported-models#models-with-extended-capabilities) lists GPT-6.1 Sol and Claude Opus 5.5 with extended context.
The observed CLI catalog separately advertises a 922,000-token long prompt limit for GPT-6.1 Sol and a 1,050,000-token nominal window.
System instructions, history, output reservation, and tool content further reduce available input.
Reasoning effort is a separate setting. A larger window does not promise better answers.
`long_context` is a selectable tier, not a promise that every model has a one-million-token window.

The [hook reference](https://docs.github.com/en/copilot/reference/hooks-reference#pretooluse-decision-control) defines `modifiedArgs`, permission decisions, and fail behavior.
Run the committed isolated verifier for fresh requested, post-hook, and effective-tier evidence.
It hashes source files before and after the run and rejects a changing artifact.

```powershell
node scripts\verify-context-routing.mjs --cli "<copilot.exe>" --out "<evidence-directory>" --model gpt-6.1-sol
```
