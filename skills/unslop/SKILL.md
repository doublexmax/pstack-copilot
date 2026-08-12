---
name: unslop
description: Cut AI tells from prose and AI code slop from diffs. Use for unslop, deslop, cleaning writing or a branch diff before commit. Must always apply.
---

# Unslop

Two jobs in one skill. Upstream split them as `unslop` (prose) and `deslop` (code). Here both live in this file. Pick the path that matches the surface, or run both when a PR has writing and a code diff.

| Surface | Path |
| --- | --- |
| Reply, docs, PR body, commit message, comments-as-prose | [Prose](#prose) |
| Branch or working-tree code diff | [Code](#code) |
| Both | Code first, then prose on the PR/commit text |

When the user says `deslop`, `deslop it`, or "clean the diff", run the [Code](#code) path. When they say `unslop` without a code target, run [Prose](#prose). Before commit, poteto-mode runs both over the diff and the commit/PR text.

## Prose

Edit text to remove AI patterns and add human voice.

### Process

1. Scan for the patterns below.
2. Rewrite. Preserve meaning, match intended tone.
3. Add soul (see next section).
4. Self-audit: "What makes this obviously AI generated?" Fix remaining tells.

### Adding soul

Removing patterns is half the job. Sterile, voiceless writing is just as obvious.

- **Have opinions.** React to facts instead of neutrally listing pros and cons.
- **Vary rhythm.** Short sentences. Then longer ones that take their time. Mix it up.
- **Acknowledge complexity.** "Impressive but also kind of unsettling" beats "impressive."
- **Use "I" when it fits.** First person isn't unprofessional.
- **Let some mess in.** Perfect structure looks machine-made.
- **Be specific.** Not "this is concerning" but "there's something unsettling about agents churning away at 3am."

### Patterns to detect and fix

#### Content

1. **Puffery.** "pivotal moment", "testament to", "evolving landscape", "setting the stage for", "indelible mark", "deeply rooted". Cut puffery, state what happened.
2. **Name-dropping.** Listing media outlets without context. Pick one, say what was said.
3. **Superficial -ing phrases.** "highlighting...", "ensuring...", "reflecting...", "showcasing...", "fostering...". Delete or expand with real sources.
4. **Promotional language.** "nestled", "vibrant", "breathtaking", "groundbreaking", "renowned", "stunning", "must-visit". Use neutral descriptions.
5. **Vague attributions.** "Experts believe", "Industry reports suggest", "Some critics argue". Name the source or delete.
6. **Formulaic challenges.** "Despite challenges... continues to thrive." Replace with specific facts.

#### Language

7. **AI vocabulary.** Additionally, crucial, delve, enduring, enhance, fostering, garner, interplay, intricate, landscape (abstract), pivotal, showcase, tapestry (abstract), testament, underscore, vibrant. Replace with plain words.
8. **Fancy ways to say "is".** "serves as", "stands as", "boasts", "features". Just say "is" or "has".
9. **"Not just X, but Y."** State the point directly instead.
10. **Rule of three.** Forcing ideas into groups of three. Use the natural number.
11. **Synonym cycling.** Protagonist, main character, central figure, hero all in one paragraph. Pick one, repeat it.
12. **False ranges.** "from X to Y" where X and Y aren't on a meaningful scale. List topics directly.

#### Style

13. **Em dash overuse.** Avoid em dashes entirely. Use periods or commas only (no parentheses, no en dashes, no hyphen-as-dash substitutes). Em dashes are an AI tell, and reaching for parentheses instead just trades one tell for another. If a thought needs separation, end the sentence or use a comma.
14. **Colon overuse.** Colons are fine before a list or example. Not as mid-sentence connectors. "If you're coming from traditional automation: instead of registering event handlers, you describe conditions" adds nothing with the colon. Rewrite to let the point stand on its own without comparison framing. "Describing when the scheduler should fire works best as plain English." Same meaning, no crutch punctuation.
15. **Boldface overuse.** Don't bold every proper noun or acronym.
16. **Inline-header lists.** The tell is a bold label and colon that restates the line: "**Performance:** Performance improved...". Convert those to prose. A bold lead-in that ends in a period, names the item, and is followed by genuinely new detail ("**Schema in TypeScript.** Tables live in one file.") is fine, not a tell.
17. **Title case headings.** Use sentence case.
18. **Decorative emojis.** Remove from headings and bullets.
19. **Curly quotes.** Replace with straight quotes.

#### Communication artifacts

20. **Chatbot phrases.** "I hope this helps!", "Let me know if...", "Of course!", "Certainly!", "Found the smoking gun!" Remove.
21. **Cutoff disclaimers.** "While specific details are limited..." Find sources or remove.
22. **Sycophantic tone.** "Great question! You're absolutely right!" Respond directly.

#### Filler

23. **Filler phrases.** "In order to" becomes "To". "Due to the fact that" becomes "Because". "It is important to note that" gets deleted.
24. **Excessive hedging.** "could potentially possibly be argued that it might" becomes "may".
25. **Generic conclusions.** "The future looks bright." State specific plans or facts.

#### Jargon

26. **Abstract metaphor nouns.** Substrate, wedge, vector, locus, vantage, nexus, primitive (as noun), harness (as metaphor), surface (as in "API surface"), bedrock, scaffolding (as metaphor), modality, paradigm, gold-plating, ratchet (as metaphor), evacuate (for moving code), endgame, north star, flywheel. These read as technical but usually have a plainer concrete word. "Substrate" becomes "base". "Wedge in" becomes "add". "Vector" becomes "way" or "method". "Gold-plating" becomes "more than the job needs". "Ratchet" becomes the mechanism's real name or "a limit that only tightens". "Evacuate" becomes "move out". "Endgame" becomes "the last phase". Pick the concrete word.

#### Plain speech

27. **Say what it does, not how it feels.** "the database stays close at hand", "SQL you can read", "types that follow your schema" name a feeling. The fix names the mechanism or a number: "`.toSQL()` returns the exact string sent to the database", "a column rename fails the build". Ask what the sentence tells the reader to do or know, then write that. If you can't restate it as a concrete instruction, fact, or number, cut it. One more check: if the sentence could appear unchanged in another project's docs, it says nothing about this one. Cut it.
28. **Shorten or split dense sentences.** If the reader has to backtrack to parse a sentence, break it in two or drop clauses. One idea per sentence.
29. **Active voice.** Prefer it. Catch "is/are/was/were + past participle" and name the actor: "queries are validated" becomes "the compiler validates queries", "the file is parsed by the loader" becomes "the loader parses the file". Passive is fine only when the actor is unknown or genuinely doesn't matter.
30. **Cut adverbs, or use a stronger verb.** "runs quickly" becomes "is fast" or the number. "significantly improves" becomes the measured delta. An adverb propping up a weak verb means the verb is wrong.
31. **Prefer the plain word.** "utilize" becomes "use", "leverage" becomes "use", "facilitate" becomes "help", "numerous" becomes "many", "in the event that" becomes "if". The fancier synonym is rarely clearer.

## Code

Ported from upstream `deslop` (cursor-team-kit). Check the diff against the default branch and remove AI-generated code slop introduced on this branch. Match the local file's style. Do not restyle the whole tree.

### Process

1. Diff against the base branch (default `main` or the repo's default). Include the working tree.
2. Walk only the added and changed hunks. Leave pre-existing slop outside the diff unless it blocks the change.
3. Apply the focus areas below. Prefer deletion over rewrite.
4. Re-read the diff. Behavior stays the same unless you fixed a clear bug the slop was hiding.
5. Hand narrating comments and comment corpses to `/no-comments` when the pass is for review. This path still deletes obvious new narrating comments in the hunk so the commit is not padded.
6. Summarize in 1-3 short sentences.

### Focus areas

- **Extra comments** that are unnecessary or inconsistent with local style. Phase banners, restated next-line prose, commented-out corpses.
- **Defensive checks or try/catch** that are abnormal for trusted internal paths. Nil-guards that silence bugs, catch-all that swallow errors, "just in case" branches with no evidence.
- **Casts to `any`** (or equivalent escape hatches) used only to bypass type issues instead of fixing the type.
- **Deep nesting** that should flatten with early returns or a helper the file already uses.
- **Dead weight in the hunk.** Unused imports, unused variables, unreachable branches, compatibility shims for callers you already migrated, feature flags with no reader, duplicated helpers the file already has.
- **Abstraction and ceremony the hunk does not need.** Single-use wrappers, unnecessary indirection, config objects with one field, "future-proof" parameters nobody passes.
- **Other patterns inconsistent** with the file and surrounding codebase. Match naming, error style, and module shape already in the tree.

### Guardrails

- Keep behavior unchanged unless fixing a clear bug.
- Prefer minimal, focused edits over broad rewrites.
- Bias to deletion (**principle-laziness-protocol**). If the clean version is fewer lines and the tests or real surface still pass, take it.
- Do not expand scope into unrelated files to "while I'm here" clean.
- After the code pass, run the [Prose](#prose) path on any commit message or PR body you are about to write.
