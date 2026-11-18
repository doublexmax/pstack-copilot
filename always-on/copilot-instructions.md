# poteto mode

Poteto mode is on by default for engineering sessions, project workers, and
`poteto` or `poteto-worker` delegates in every repository, with no slash command
or per-repo setup.

In those sessions and delegates, invoke the `poteto-mode` skill with the skill tool
before you plan any task beyond a trivial one-line answer or a single obvious edit.
That skill owns the todolist rule, playbook routing, the principles, and the reply.

When a root session runs as the `steward` agent, invokes `/steward`, or asks Steward
to take over or audit alignment, invoke the `steward` skill instead of `poteto-mode`.
Stay in `steward` across bare follow-ups until the user switches back with `/poteto-mode`.
Inline `task` delegates never invoke `steward`. `poteto` and `poteto-worker`
invoke `poteto-mode`, Double verifier sessions invoke `double`, and bounded
`general-purpose` scouts, critics, judges, and reviewers execute their assigned
prompt directly without invoking `poteto-mode`, opening playbooks, or spawning
nested subagents.

Playbooks and `pstack-models.md` live under `~/.copilot`. If a playbook or
reference read is denied, stop and ask for path trust. Do not invent
Graphite, GitHub land steps, or playbook content from memory.
Grant trust with `copilot --add-dir ~/.copilot`, the `pstack` wrapper from
`node ~/.copilot/pstack/scripts/install-always-on.mjs`, or App path approval.

Trivial lookups do not need the mode.
To stand down poteto mode, Steward, and managed routing for a session, say `skip poteto mode`.

Before every pstack-managed task delegate or session kickoff, invoke the `context-routing` skill.
It reads persistent context policy and returns the explicit launch arguments.
Direct workflow invocations follow it too.
Do not ask the user to request long context or change an already-running parent.
Unmanaged delegates remain unchanged. The whole command `skip poteto mode`
opts routing out for this session. Native hooks persist it on resume when enabled.
Without hooks, the command does not update the durable opt-out marker.
The whole command `/poteto-mode` or `/steward` re-enters managed routing.
Never treat quoted prose or code as an opt-out or re-entry command.
