# Contributing

PRs are welcome. A few ground rules to keep things smooth:

## Workflow

- `main` is protected — all changes land via pull request, direct pushes are
  blocked.
- Fork or branch, make your change, open a PR against `main`.
- Keep PRs focused: one skill/playbook/fix per PR is easier to review than a
  grab-bag.
- At least one approving review is required before merge.

## Adding or changing a skill/playbook

- Follow the conventions already in `skills/` and `poteto-mode/playbooks/` —
  frontmatter, description-as-router, progressive disclosure.
- If you're touching `poteto-mode`, skim `skills/create-skill/SKILL.md` first.
- Run `node scripts/check-copilot-port.mjs` and
  `node scripts/check-upstream-sync.mjs` before opening the PR. There is no CI
  gate, so these are the checks.

## Changing a file that came from upstream

Most skills here are ports of files in `cursor/plugins`. Editing one in place
breaks the source-coverage gate, which is the point: the change needs a reason
on the record. Read `docs/upstream-sync.md`, make the edit, then re-record that
one path with
`node scripts/check-upstream-sync.mjs --upstream <checkout> --accept <source path>`.

## Reporting issues

- Use the issue templates (bug report / feature request) so we have enough
  context to act on it.

## Code of conduct

Be respectful. Assume good intent. Disagree on substance, not people.
