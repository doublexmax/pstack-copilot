# Upstream sync

This fork is a Copilot port of the `pstack` plugin from `cursor/plugins`. The port is not a
mirror. Most skills here trace to an upstream source file, but the Copilot host has
different tools, different frontmatter, and a different PR surface, so many files carry a
deliberate local adaptation.

This page is the source of record for which upstream file each local file came from, what
was changed, and what was left out. `scripts/check-upstream-sync.mjs` enforces it.

## The source pin

| | |
| --- | --- |
| Upstream repo | `cursor/plugins` |
| Subtree | `pstack` |
| Pinned commit | `9511e60321f7e533a187d62854a3d53a53752874` |
| Previous pin | `c5b04a544585702f2525d1d199f61e28dde4184a` |

The checker reads the pin from the `#pin` header of `scripts/upstream-sync.manifest.tsv`.

## The manifest

`scripts/upstream-sync.manifest.tsv` has one row per upstream source file, including the
ones nobody has touched, so an upstream addition or removal cannot pass unnoticed. Columns:

| Column | Meaning |
| --- | --- |
| `source` | Path under the upstream `pstack/` subtree. |
| `status` | `identical`, `adapted`, or `excluded`. |
| `source_sha256` | Hash of the upstream file at the pin. Text is hashed with `\n` line endings. |
| `local` | Path in this repo. Empty for `excluded`. |
| `local_sha256` | Hash of the reviewed local file. Only for `adapted`. |
| `reason` | Why this file differs, or why it is not imported. Required for `adapted` and `excluded`. |

An `identical` row claims the local file is byte-for-byte the upstream source after line-ending
normalisation, so it carries no second hash and no reason. An `adapted` row claims a reviewed
difference, so it carries both hashes and a concrete reason. An `excluded` row claims no local
file at all.

At the current pin: 161 source files, 39 identical, 107 adapted, 15 excluded.

## Running the checks

```
node scripts/check-upstream-sync.mjs
node scripts/check-upstream-sync.mjs --upstream <path to a cursor/plugins checkout>
node scripts/check-copilot-port.mjs
node --test scripts/check-copilot-port.test.mjs
node --test scripts/check-upstream-sync.test.mjs
node --test scripts/install-always-on.test.mjs
```

Without `--upstream` the gate checks local integrity only, which needs no network and no
clone. It still catches an imported file edited in place and an adapted file that drifted
from its reviewed hash, because both hashes are recorded.

With `--upstream` it also checks that the checkout's `HEAD` matches the pin, that the
checkout is clean under the subtree, that the upstream inventory matches the manifest
exactly, and that every source file still hashes to its recorded value.

The gate fails loudly and never rewrites an imported or adapted local file. It has no
bulk "accept everything" mode.

## Updating after an upstream bump

1. Fetch the new upstream commit into a checkout of `cursor/plugins`.
2. Set `#pin` in the manifest to the new commit.
3. Run `node scripts/check-upstream-sync.mjs --upstream <checkout>`. It now lists every
   source file that changed, was added, or disappeared.
4. For each **changed** file, read the upstream diff from the old pin to the new one and
   reconcile it against the local file by hand. A three-way merge with the old upstream
   version as the base is the cheapest way in. Inspect every semantic merge.
5. For each **added** file, decide `identical`, `adapted`, or `excluded`, and write the row.
   The gate prints the computed `source_sha256` next to the path so you can paste it.
6. For each **removed** file, delete the row, delete the local import, and migrate its
   callers before you delete anything.
7. Once a file is reconciled and reviewed, re-record its hashes one path at a time:

   ```
   node scripts/check-upstream-sync.mjs --upstream <checkout> --accept skills/foo/SKILL.md
   ```

   `--accept` takes one reviewed source path per flag. It rejects a pattern, and it refuses
   to run without `--upstream` because the source hash has to come from the pinned checkout.
   A mismatched pin or dirty source checkout fails before the manifest changes.
   Re-recording an unreviewed file is the one failure this design is built to prevent, so
   there is no flag that accepts the whole tree.
8. Re-run every check in the list above, plus `node skills/poteto-mode/scripts/check-plan.mjs`
   against a real plan if you touched the plan skeleton.

A `reason` containing the word `TODO` fails the gate. Write the real reason when you record
the row.

## Host adaptations

These differences are deliberate and apply across the port. Individual manifest rows name the
file-level specifics.

| Upstream | Here |
| --- | --- |
| `.cursor-plugin/plugin.json` and `/add-plugin` | a `skillDirectories` entry in `~/.copilot/settings.json` |
| `subagent_type`, `run_in_background`, `readonly`, `environment` on `Task` | `agent_type`, `mode`, `context_tier` on `task`, plus `create_session` for cloud work |
| one model slug per role | `model` and `reasoning_effort`, two fields |
| `~/.cursor/rules/pstack-models.mdc`, always applied | `~/.copilot/pstack-models.md`, read explicitly by each skill |
| `AskQuestion` | the `ask_user` tool |
| `AGENTS.md` subagent contract | `agents/*.agent.md` spawned through `task` |
| `/loop` | autopilot mode, or `save_session_automation` for a fixed tick |
| Cursor transcript files under `agent-transcripts/` | the local session store through `session_store_sql` |
| a separate `deslop` command | the Code path inside `skills/unslop/SKILL.md` |
| `control-cli` and `control-ui` from `cursor-team-kit` | the project's own `.github/skills/verify-*` skill, or one generated by `create-verification-skill` |
| Cursor's built-in `create-skill` | `skills/create-skill/SKILL.md`, authored here |
| Graphite and `gh` or Origin stacking | Azure DevOps PR chains, with GitHub PRs opened through `create_pull_request` |
| frontmatter keys `disable-model-invocation`, `paths`, `is_background`, `alwaysApply`, `globs` | stripped, because Copilot ignores them |

`scripts/check-copilot-port.mjs` enforces the token and frontmatter side of this table, so a
future import cannot quietly reintroduce a Cursor-only name.

### The model panel

Upstream ships a three-vendor panel (Anthropic, OpenAI, xAI). This port keeps a fourth seat on
a Gemini model so the review panels in `arena`, `architect`, and `interrogate` read four
lineages rather than three. The second-opinion rule is "the same prompt against a different
model, and agreement is high-signal", and a seat that repeats a family already on the panel
does not buy that. The role-to-model mapping otherwise follows upstream. `models.default.md`
holds the table and the per-role lines.

### Webhooks and host commands

`make-bot-ui` uses the chosen webhook provider's documented request and wake contracts.
Copilot does not supply Cursor's webhook routine. URLs and credentials stay in a server-side
credential store, not in chat or browser code. Success requires both the provider's accepted
response and evidence that the bot received the expected fields.

`benchmark-checklist` selects tools for the actual host. Linux utilities are conditional
examples. Windows probes use PowerShell or the runtime's profiler.

## Deliberate exclusions

| Source | Why |
| --- | --- |
| `.cursor-plugin/plugin.json` | Cursor plugin manifest. Copilot has no equivalent to port. |
| `.gitignore` | Subtree-level ignore file. The port root ships its own. |
| `assets/logo.png` | Cursor plugin listing art. The port has no listing. |
| `skills/poteto-mode/scripts/watch-pr/` (12 files) | GitHub-only PR watcher in TypeScript. The port reads PR state through host tools and `skills/poteto-mode/references/ado.md`, and ships no bun toolchain for it. |

## Local-only files

The port also ships files with no upstream source. The manifest does not track these, because
it is a source-coverage gate, not a tree inventory.

- `scripts/check-copilot-port.mjs`, `scripts/check-upstream-sync.mjs`, `scripts/install-always-on.mjs`, and their tests.
- `always-on/copilot-instructions.md`, the managed block the installer writes.
- `agents/poteto-worker.agent.md`. The other two agents map to upstream sources in the manifest.
- `skills/create-skill/SKILL.md`.
- `skills/poteto-mode/references/ado.md`.
- `models.default.md`, `CONTRIBUTING.md`, `.github/`, and this page.
