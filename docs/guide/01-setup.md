# Set up pstack

In this page you register the skills directory, pick which models pstack uses, and run your first task. Setup is one command plus a short conversation.

## Install pstack

Clone this fork somewhere stable and register its skills directory with the Copilot CLI:

```bash
git clone https://github.com/doublexmax/pstack-copilot ~/.copilot/pstack
copilot skill add ~/.copilot/pstack/skills
```

Then copy the agents so poteto mode is selectable in any repo:

```bash
cp ~/.copilot/pstack/agents/*.agent.md ~/.copilot/agents/
```

Confirm with `copilot skill list`. The pstack skills appear under `Custom skills:`, which means every repo you open sees them. `~/.copilot/agents/` needs no registration; agents there are discovered from any working directory.
The copied agents invoke registered skills by name. Skills remain under the separate pstack checkout.
After updating pstack, repeat the agent copy.

Then turn the mode on by default **and** grant path trust for playbooks:

```bash
node ~/.copilot/pstack/scripts/install-always-on.mjs
```

That one command does four things:

1. Splices a short block into `~/.copilot/copilot-instructions.md`, which Copilot loads into the system prompt of every session in every directory. From then on you describe the task and the mode is already on.
2. Adds the absolute `~/.copilot` path to `trustedFolders` in `~/.copilot/config.json`, preserving any folders you already trusted.
3. Installs a `pstack` CLI wrapper (`~/.copilot/bin/` shims plus a marked block in your PowerShell profile or shell rc) that runs `copilot --add-dir ~/.copilot ...`, so headless runs can read playbooks and `pstack-models.md`.
4. Installs direct-exec Node hooks for [context routing](../../skills/context-routing/SKILL.md). Pstack-managed delegates use a resolved tier. Ordinary delegates remain unchanged.

The block is user-scoped, so a repo you clone next month is covered without any per-repo setup. `--uninstall` removes the managed changes and leaves unrelated content and personal policy untouched. `--skip-shell` leaves profiles and shims alone. `--dry-run` prints what would change.

To install the other integration without native hooks, add `--hooks skip`.
That flag leaves existing hooks unchanged. It does not disable installed hooks.
Use `--hooks remove` to remove only the owned hook config and copied entry.
The default installer or `--hooks install` enables them again.
`--uninstall` cannot be combined with `--hooks`.
Hook removal preserves your instructions, policy, models, trust, wrappers, and session markers.
Explicit routing still works, but native correction and durable opt-out tracking do not.
After re-enabling hooks, submit `/poteto-mode` to clear a previous session opt-out.

If your `config.json` has JSONC comments, use `--skip-trust` to leave that file untouched.
The installer validates the trust configuration before it writes anything.
Keep the existing trust grant or pass `--add-dir` when you start Copilot.
`COPILOT_HOME` selects a different Copilot configuration directory for an isolated installation.

## Let pstack read its own playbooks

`skillDirectories` makes every skill load, but a skill is more than its `SKILL.md`. `poteto-mode` reads playbooks and references from disk while it works, and it reads your model overrides from `~/.copilot/pstack-models.md`. All of that goes through Copilot's path permissions, and Copilot trusts your working directory only unless you grant `~/.copilot`.

After the installer above, prefer:

```bash
pstack --agent poteto -p "..." --allow-all-tools
```

That is the same as:

```bash
copilot --agent poteto -p "..." --allow-all-tools --add-dir ~/.copilot
```

Grant `~/.copilot` rather than `~/.copilot/pstack`. The narrower grant looks tidier but silently disables `~/.copilot/pstack-models.md`, so your model panel would fall back to the defaults with no visible error.

In the Copilot app, approve a path prompt for `~/.copilot` once if a playbook read is still denied. The mode skill is under orders to **stop** on a denied playbook read instead of inventing upstream Graphite or GitHub land steps from memory.

To check it, ask a question whose answer only exists in a playbook, from a directory that is not a pstack checkout:

```bash
pstack --agent poteto -p 'Read the shipping playbook. Which VCS does it target, and what command gives the authoritative merge verdict? Name every file you read.' --allow-all-tools
```

A correct run names `playbooks/shipping.md` and `references/ado.md`, answers Azure DevOps, and quotes `az repos pr policy list`. If it answers GitHub, or names `git patch-id`, the reads were denied and the model filled the gap from training data.


## Pick your models

Run:

```text
/setup-pstack
```

[`/setup-pstack`](../../skills/setup-pstack/SKILL.md) detects the models you have access to, shows you each role (code delegates, judgment, the review panels), and asks what you want. Answer the questions. It writes `~/.copilot/pstack-models.md`, which the context resolver reads.

You only override what you care about. A role with no line in the rule keeps the skill's default. To restore a default, delete that role's line. A rerun of `/setup-pstack` keeps any role whose model differs from the default. A rule written before 0.15.3 pins the old default models, so delete those role lines, or delete the file, then run `/setup-pstack` again.

Set a role to `inherit-parent` or `auto` to omit the subagent model and effort fields.
Copilot selects the child model, which can come from a per-agent or custom-agent preference rather than the parent.
Both values mean the same thing, and neither is a model slug.
The shipped `adaptive` policy keeps these unresolved model choices launchable at the default tier.
The opt-in `always_long` policy blocks them. Choose an explicit role model or change the context policy through `/setup-pstack`.
For a panel role the value is a list, and one subagent runs per entry, so the list length sets the panel size.
Setup also configures `swarm workers`, the default model for every `/swarm` worker unless a race names a model for each arm.

## Configure delegated context

Ask `/setup-pstack` for context-only setup to preserve your model and effort choices.
The shipped default is `adaptive`. Bounded delegates use default context without requiring proven long-context support.
Existing personal policy choices take precedence.
To change only the policy, ask `/setup-pstack` to use `adaptive`, `default`, or `always_long`.
Under adaptive policy, small inputs use `default`, even when the task spans several files.
Adaptive selects `long_context` for a large body of material that one delegate must compare together.
Long-context selection requires declared support for the exact model and launch tool.
These capability sources and workload reasons are agent assertions. The hook enforces consistency, not their truth.
It never changes the parent tier or per-agent defaults.

To set the global policy directly, run:

```powershell
node "$env:USERPROFILE\.copilot\pstack\scripts\context-routing.mjs" set-policy --default adaptive
```

Use `show` to print the effective policy and its source.
Use `show --role "how explainer"` to inspect the selected model choices without reimplementing model-map precedence.
Use `--role-policy "how explainer=default"` with `set-policy` for an exact role override.
Personal policy lives in `pstack-context.json` under `COPILOT_HOME`, or your user `.copilot` directory when that variable is unset.
For example:

```json
{
	"schemaVersion": 1,
	"default": "adaptive",
	"roles": {
		"how explainer": "default"
	}
}
```

An omitted global policy inherits `context.default.json`. Exact role overrides take precedence.
Role-only updates preserve omitted fields. They do not copy inherited defaults or role settings into your personal file.

| Policy | Behavior |
| --- | --- |
| `adaptive` | The shipped default. Default for bounded work. Long for supported large-corpus work. Unknown child identity or unsupported long context selects default. |
| `default` | Default context for every workload. |
| `always_long` | Strict opt-in. Long context for every workload. Unresolved child identity or unproven support blocks the launch. |

Use `set-policy --default always_long` to require long context.
`always_long` selects Copilot's `long_context` tier. The policy name and tier name are separate.
If a preview policy used `"long_context"` as its global or role policy value, replace that value with `"always_long"`.
A known unavailable model blocks in every mode. Pstack never replaces the selected model.
An omitted task model does not prove parent inheritance, even when the parent supports long context.
Model aliases therefore use default context under adaptive policy and block under `always_long`.
Malformed policy, duplicate keys, and unknown role overrides fail with an error.

Managed launches copy the resolver's arguments and declaration.
Native hooks also check them and record decisions in `pstack-context-decisions\<sessionId>`.
Submit the whole command `skip poteto mode` to opt out, or `/poteto-mode` to re-enter.
Native hooks preserve that opt-out across same-session resume.
Disabled hooks and timeouts can bypass native checks, so callers still need explicit routing.
If the hook executable cannot start, Copilot can deny unrelated tool calls too. Remove the owned hooks with `--hooks remove`.
Local hooks do not transfer to cloud workers. Remote launches need their own capability evidence.

For fresh CLI dispatch evidence, run from the checkout:

```powershell
node scripts\verify-context-routing.mjs --cli "<copilot.exe>" --out "<new-evidence-directory>"
```

The verifier uses an isolated Copilot home and compares requested, post-hook, and effective tiers.
Add `--policy always_long` or `--policy default` to verify another policy without changing your personal setup.
Its controlled workloads prove dispatch, not better answers or autonomous workload classification.

## Accept the verification offer, or don't

At the end of setup, `/setup-pstack` looks for a way to prove app behavior in your project, either a `verify-*` skill or an existing harness. If it finds neither, it offers once to generate one with [`/create-verification-skill`](../../skills/create-verification-skill/SKILL.md).

Say yes and it writes `.github/skills/verify-<app>/`, a project-local skill that teaches agents to drive your app the way a user does. It proves the skill works once before handing it over. Say no and setup moves on. You can run the **create-verification-skill** skill yourself any time. [Verify and ship](./06-verify-and-ship.md#create-a-project-verification-skill) covers when it earns its place.

After setup, start a new session. The model file is read per session.

## Run your first task

Pick something real but small, and describe it the way you'd describe it to a colleague:

```text
add a --json flag to this command. text output stays byte-identical. verify both.
```

Watch the todo list. The first item is always "read the Principles section". The rest are the matched playbook's steps copied in, the Feature playbook for this prompt. If a step gets skipped, it stays in the list with `skip: <reason>`, so you can see what it chose not to do.

From here you can type normal follow-ups. With the always-on block installed, the mode is re-asserted in the system prompt on every model request, so `continue` and `keep going` stay on the same playbook even after a long run compacts the conversation. Say "new task" when you switch subjects, and `skip poteto mode` when you want it off for a session. Without the always-on block, type `/poteto-mode` to enter, and the skill body carries the stay-in-the-mode contract from there.

Next: [Route work through `/poteto-mode`](./02-poteto-mode.md).
