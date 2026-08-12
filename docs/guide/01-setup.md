# Set up pstack

In this page you install the plugin, pick which models pstack uses, and run your first task. Setup is one command plus a short conversation.

## Install pstack

Clone this fork somewhere stable and register its skills directory with the Copilot CLI:

```bash
git clone -b copilot-port <your-fork-url> ~/.copilot/pstack
copilot skill add ~/.copilot/pstack/skills
```

Then copy the agents so poteto mode is selectable in any repo:

```bash
cp ~/.copilot/pstack/agents/*.agent.md ~/.copilot/agents/
```

Confirm with `copilot skill list`. The pstack skills appear under `Custom skills:`, which means every repo you open sees them. `~/.copilot/agents/` needs no registration; agents there are discovered from any working directory.

## Let pstack read its own playbooks

`skillDirectories` makes every skill load, but a skill is more than its `SKILL.md`. `poteto-mode` reads playbooks and references from disk while it works, and it reads your model overrides from `~/.copilot/pstack-models.md`. All of that goes through Copilot's path permissions, and Copilot trusts your working directory only. It does not trust `~/.copilot`.

Interactively, approve the prompt once and you are done.

Non-interactively, `-p` cannot prompt, so the read simply fails, and a capable model will often answer from memory rather than stop. The answer you get back is then upstream's behavior, not this fork's. Pass the directory:

```bash
copilot --agent poteto -p "..." --allow-all-tools --add-dir ~/.copilot
```

Grant `~/.copilot` rather than `~/.copilot/pstack`. The narrower grant looks tidier but silently disables `~/.copilot/pstack-models.md`, so your model panel would fall back to the defaults with no visible error.

There is no config key or environment variable for `--add-dir`, so wrap it. PowerShell, in `$PROFILE.CurrentUserAllHosts`:

```powershell
function pstack { copilot --add-dir "$HOME\.copilot\pstack" @args }
```

bash or zsh:

```bash
pstack() { copilot --add-dir "$HOME/.copilot" "$@"; }
```

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
/poteto-mode add a --json flag to this command. text output stays byte-identical. verify both.
```

Watch the todo list. The first item is always "read the Principles section". The rest are the matched playbook's steps copied in, the Feature playbook for this prompt. If `/poteto-mode` skips a step, the step stays in the list with `skip: <reason>`, so you can see what it chose not to do.

From here you can type normal follow-ups. `/poteto-mode` is sticky. It stays on for the conversation until you opt out by saying so.

Next: [Route work through `/poteto-mode`](./02-poteto-mode.md).
