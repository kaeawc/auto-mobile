---
description: Drive one GitHub issue to a merged PR via TDD, with a plan-approval gate, a pre-PR local validation gate, triaged review, and conservative follow-up capture.
allowed-tools: Bash, Read, Edit, Write, Grep, Glob, Task, WebFetch, Skill
argument-hint: [issue number]
---

Take GitHub issue **#$ARGUMENTS** from reading to a merged PR. Do all work in the
current isolated git worktree — never commit, push, or reset the central clone at
`~/kaeawc/auto-mobile`. Work through the phases below in order. Two phases are
hard **STOP** gates: do not cross them without the stated condition being met.

## Phase 0 — Understand the issue

1. `gh issue view $ARGUMENTS --comments` and read the full body, every comment,
   and any linked issues/PRs.
2. Extract the issue's **acceptance criteria** verbatim. If the issue has none,
   write the criteria you infer and mark them as inferred — you will confirm them
   at the plan gate.
3. Note related prior work referenced in the issue so you reuse existing repo
   helpers and conventions instead of reinventing them.

## Phase 1 — Plan  🚦 STOP GATE (plan approval)

1. Produce a plan that maps **each acceptance criterion → the change that
   satisfies it → the test that pins it**. Every criterion must be traceable to a
   test; if one can't be, say so.
2. State the risk class of the change (see Phase 6). Call out anything touching DB
   lifecycle/migrations, the runner protocol, or public tool schemas.
3. **STOP and present the plan + acceptance criteria to the user for approval.**
   Do not write any implementation or test code until the user approves or
   redirects. A wrong reading of the issue caught here is free; caught after a PR
   it is not.

## Phase 2 — TDD (red first)

1. Write tests that encode the approved acceptance criteria — derived from the
   issue, not invented to match a preferred implementation.
2. Run them and **confirm they fail for the right reason** (red). A test that
   passes before the change is not pinning anything — fix it.
3. Honor repo test rules: interface + fake + FakeTimer, unit tests < 100ms, never
   resolve the real file-backed `getDatabase()` (see CLAUDE.md).

## Phase 3 — Implement (green)

1. Implement the minimum to make the new tests pass and satisfy the plan.
2. Continue until every acceptance criterion's test is green and the plan is fully
   realized. Do not expand scope beyond the issue — capture extras as follow-ups
   (Phase 8), don't build them.

## Phase 4 — Pre-PR local validation  🚦 STOP GATE (must be green)

Do **not** open a PR until all of these pass locally. Fixing here is far cheaper
than a CI round-trip.

1. `turbo run lint build test` (or `bun test` for a fast full pass) — the **whole**
   suite, to catch regressions, not just the new tests.
2. `bun run typecheck` — the new-error gate. If you fixed type errors, run
   `bun run typecheck:update` and commit the smaller baseline.
3. `/validate` for any shell/Swift/Docker/schema surfaces you touched.
4. Re-confirm each acceptance-criterion test is green.

If anything here is red, fix it before proceeding. Do not open a PR on red.

## Phase 5 — PR

1. Verify worktree isolation before committing: `git diff --name-only main...HEAD`
   must contain only your intended paths. Concurrent sessions share the checkout
   and can move refs — commit/push/PR only from this worktree.
2. Create the PR using the repo PR template if one exists
   (`.github/PULL_REQUEST_TEMPLATE.md` or `.github/pull_request_template.md`);
   otherwise use clear Summary / Changes / Testing / Acceptance-criteria sections.
   Link the PR to issue #$ARGUMENTS (`Closes #$ARGUMENTS`).
3. Do **not** enable auto-merge yet.

## Phase 6 — Review (triage, not obey)

1. Run `/auto-mobile-code-review` on the PR.
2. Spawn **three review subagents as orthogonal lenses** (not personalities),
   each given the diff and the acceptance criteria:
   - **Regression / behavioral compatibility** — what existing behavior could this
     break?
   - **Test adequacy** — do the tests actually pin each acceptance criterion, and
     do they fail without the change?
   - **API-contract / interface surface** — tool schemas, public interfaces, and
     the Interface+Fake seams.
3. Read all PR review comments, inline comments, and any failing CI
   (delegate to `/check-ci`).
4. **Triage every finding** — do not blanket "address all." For each one:
   reproduce/verify it against the diff and the acceptance criteria, then:
   - **Fix** confirmed issues.
   - **Reject** false positives / session-or-env artifacts with a one-line reason.
   - **Defer** valid-but-out-of-scope items to a follow-up (Phase 8).
   Do not grow scope to satisfy a suggestion — file a follow-up instead.

## Phase 7 — Merge (conditional)

1. Make **all** review edits and push them **first**. Only after the final commit
   is pushed and CI is green do you touch auto-merge — enabling it earlier can
   merge+delete the PR before your follow-up commit lands.
2. Gate auto-merge on risk class:
   - **Low-risk** (self-contained, well-covered, no DB/migration/runner/schema
     surface): enable auto-merge.
   - **Higher-risk** (DB lifecycle, migrations, runner protocol, public tool
     schemas, or anything you flagged in Phase 1): **STOP** — summarize state and
     hand off to the user for the merge decision.

## Phase 8 — Follow-ups (conservative)

1. Collect deferred items and any review feedback intentionally not addressed.
2. For each, **search existing open issues first** (`gh issue list --search ...`);
   only file if it isn't already tracked.
3. File one issue per discrete unit, each linking back to this PR and issue
   #$ARGUMENTS with enough context to be picked up cold. Prefer a single grouped
   issue over several near-duplicates. For minor observations, a note in the PR may
   be lighter than a new issue.
4. End with a short summary: what merged (or awaits merge), which criteria are
   satisfied, what was deferred and where it's tracked.
