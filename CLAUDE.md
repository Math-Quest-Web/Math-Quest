# Math Quest - Project Instructions

Math Quest is a single-file (`index.html`) educational math game with a multiplayer boss raid,
hosted on Firebase. The full product description lives in **`docs/spec.md`**.

## Spec-driven workflow (required)

1. **Read `docs/spec.md` before starting any task** that changes behavior. Find the requirement
   IDs (e.g. `BOS-04`, `SHP-05`) that your change touches.
2. **Check the change against the spec.** If a request would contradict an existing requirement,
   say so and ask the user how to resolve it before writing code. Do not silently break a
   requirement.
3. **Keep the spec up to date - always.** Whenever a feature or requirement is added, changed or
   removed (including things the user only says in conversation), update `docs/spec.md` **in the
   same branch/PR as the code**:
   - add or edit the requirement row with its ID and status,
   - update any affected tables (bosses, crates, items, numbers),
   - add a line to the change log (section 14),
   - update "Known issues" (section 12) if you found or fixed a limitation.
4. **The spec must match the code.** If you notice they disagree, fix whichever is wrong and tell
   the user.
5. Before reporting a task done, re-read the requirements you touched and confirm each still holds.

## Tests

- Create a test case **before** writing any new function or code, then validate the code against it
  (also a global rule). The project's self-tests are the `TestSuite` in `index.html` and
  `test.html`. Note that one older test ("Attack timer resets after attack") already fails and is
  unrelated - do not treat it as a regression, and do not add to it silently.
- For gameplay/UI work, also verify in a browser (see "Local testing") and check the console for
  new errors.

## Conventions

- Everything stays in `index.html`. No build tooling, no image assets - art is drawn with canvas
  paths. Files use **CRLF** line endings; some lines have trailing whitespace, so use tolerant
  matching when doing scripted edits.
- **Never write `undefined` to Firebase** (it throws). Use `''`, `0`, `false` or `null`.
- Raid is host-authoritative: only the raid host simulates the boss, bullets and damage. Anything
  a non-host does that affects the fight must be sent to the host (see `RAI-03`).
- Boss attacks must follow the rules in spec section 9.1 (sourced, telegraphed, dodgeable, no
  overlap, vulnerability shown by animation - never by a text label).
- Math prompts are switched off behind `RAID_MATH_ENABLED`; do not reintroduce math into
  gameplay unless asked.
- Hosting deploy is automatic on push to `main` and covers **hosting only**, not database rules.

## Git and safety

- Work on a feature branch, push it and open a PR. **Do not merge, deploy or change shared
  Firebase data without the user saying so.**
- Only commit intended files. Never commit temporary dev files (`.dev-server.js`, `.claude/`),
  the untracked `sprites/` folder, or scratch files.
- `gh` is not installed; PRs are opened and merged through the GitHub REST API using the token
  from `git credential fill` (never print the token).
- Testing against the live Firebase project creates real lobbies. Leave lobbies you created, and
  delete only your own test data afterwards.

## Local testing

- Serve the folder with a tiny Node static server (temporary `.dev-server.js` plus
  `.claude/launch.json`), open it with the browser tool, and delete both files before committing.
- In a hidden preview pane `requestAnimationFrame` does not run: drive frames manually
  (`raidBossUpdate()`, `raidUpdateLocal()`, `raidDraw()`), or export canvas PNGs via a temporary
  save endpoint on the dev server to inspect visuals.
- After editing `index.html`, reload the page - the tab keeps the old JS otherwise.
