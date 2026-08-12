### Authoring or modifying a skill

**You own the skill's voice.** Agent-facing prose has a higher bar than human prose; unhelpful sentences become instructions.

1. Use the **create-skill** skill, which owns Copilot's SKILL.md authoring conventions.
2. Validate mechanically, then by hand. Run `node scripts/check-copilot-port.mjs` from the pstack checkout; it fails on a `name` that does not match its folder, a missing or over-long `description`, an unsupported frontmatter key, a broken relative link, and tokens carried over from another agent runtime. Then confirm by eye that the referenced playbooks and references say what the skill claims they say.
3. Test cases if structural; skip if subjective.
4. Run **Opening a PR**.

When in doubt, delete; prose earns its keep by changing a decision. Tell it to do the thing and skip the reason. Explain only when the rule is confusing without one. Match tone to scope. Point at structural sources (types, READMEs, config); hardcoded details go stale (the **encode-lessons-in-structure** principle skill). Delegate to other skills by path; don't restate. A workflow you keep hitting but isn't captured → propose a new skill.

**Reply:** summary of the skill, key design decisions, validation notes.
