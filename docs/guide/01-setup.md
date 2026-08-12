# Set up pstack

In this page you register the skills directory, pick which models pstack uses, and run your first task. Setup is one command plus a short conversation.

## Install pstack

Clone this fork somewhere stable and register its skills directory with the Copilot CLI:

```bash
git clone https://github.com/maxxtandon_microsoft/pstack-copilot ~/.copilot/pstack
copilot skill add ~/.copilot/pstack/skills
```

Then copy the agents so poteto mode is selectable in any repo:

```bash
cp ~/.copilot/pstack/agents/*.agent.md ~/.copilot/agents/
```

Confirm with `copilot skill list`. The pstack skills appear under `Custom skills:`, which means every repo you open sees them. `~/.copilot/agents/` needs no registration; agents there are discovered from any working directory.

Then turn the mode on by default **and** grant path trust for playbooks:

```bash
node ~/.copilot/pstack/scripts/install-always-on.mjs
```

That one command does three things:

1. Splices a short block into `~/.copilot/copilot-instructions.md`, which Copilot loads into the system prompt of every session in every directory. From then on you describe the task and the mode is already on.
2. Adds the absolute `~/.copilot` path to `trustedFolders` in `~/.copilot/config.json`, preserving any folders you already trusted.
3. Installs a `pstack` CLI wrapper (`~/.copilot/bin/` shims plus a marked block in your PowerShell profile or shell rc) that runs `copilot --add-dir ~/.copilot ...`, so headless runs can read playbooks and `pstack-models.md`.

The block is user-scoped, so a repo you clone next month is covered without any per-repo setup. `--uninstall` reverses all three and leaves unrelated content untouched. `--skip-shell` installs only always-on and `trustedFolders`. `--dry-run` prints what would change.

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

[`/setup-pstack`](../../skills/setup-pstack/SKILL.md) detects the models you have access to, shows you each role (code delegates, judgment, the review panels), and asks what you want. Answer the questions. It writes `~/.copilot/pstack-models.md`, a small rule every pstack skill reads.

You only override what you care about. A role with no line in the rule keeps the skill's default. To restore a default later, delete that role's line, or just run `/setup-pstack` again.

You might be wondering what happens if you use Auto. Set a role to `inherit-parent` or `auto` and pstack omits the subagent `model` field, so the subagent inherits your parent chat model. Both values mean the same thing, and neither is a model slug. For a panel role the value is a list, and one subagent runs per entry, so the list length sets the panel size. Setup also configures `swarm workers`, the default model for every `/swarm` worker unless a race names a model for each arm.

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
