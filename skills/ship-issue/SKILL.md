---
name: ship-issue
description: "Drive one GitHub issue to a merged PR via TDD, with a plan-approval STOP gate, a pre-PR local-validation STOP gate, triaged (not blanket) review, and conservative follow-up capture. Use when asked to implement/ship/close out a specific issue end to end."
---

# Ship Issue

Take a single GitHub issue from reading to a merged PR. All work stays in the
current isolated git worktree — never commit, push, or reset the central clone.
Two phases are hard STOP gates; do not cross them without the stated condition.

## Workflow

0. **Understand** — `gh issue view <n> --comments`; read the body, all comments,
   and linked issues/PRs. Extract acceptance criteria verbatim (mark inferred
   ones). Note prior work so you reuse repo helpers.
1. **Plan — STOP GATE.** Map each acceptance criterion → change → the test that
   pins it. State the risk class. Present the plan + criteria and wait for user
   approval before writing any code.
2. **TDD (red).** Write tests encoding the approved criteria, run them, and
   confirm they fail for the right reason. Honor repo test rules (interface +
   fake + FakeTimer, <100ms units, never resolve the real file-backed
   `getDatabase()`).
3. **Implement (green).** Minimum change to pass the tests and realize the plan;
   no scope creep — extras become follow-ups.
4. **Pre-PR validation — STOP GATE.** Before any PR: `bun run turbo:validate`
   (local Turbo lint/build/test whole suite, for regressions), `bun run typecheck` (new-error gate; run
   `typecheck:update` if you fixed errors), `validate` for touched
   shell/Swift/Docker/schema surfaces, and re-confirm every criterion test is
   green. Never open a PR on red.
5. **PR.** Verify isolation with `git diff --name-only main...HEAD` (intended paths
   only). Create the PR with the repo template if present, linking `Closes #<n>`.
   Do not enable auto-merge yet.
6. **Review (triage).** Run `auto-mobile-code-review`; spawn three review lenses
   (regression, test adequacy, API/interface contract) given the diff + criteria;
   read all PR/inline comments and failing CI (`check-ci`). Triage each finding —
   fix confirmed, reject artifacts with a reason, defer out-of-scope. Never blanket
   "address all"; never grow scope to satisfy a suggestion.
7. **Merge (conditional).** Push all review edits first; only then, on green CI,
   touch auto-merge. Auto-merge only low-risk changes; for DB/migration/runner/
   schema surfaces, STOP and hand the merge decision to the user.
8. **Follow-ups (conservative).** Search existing open issues before filing; one
   issue per discrete unit, linked back to the PR and issue, enough context to act
   cold. Prefer grouping over near-duplicates. End with a status summary.

## Related skills

- `check-ci` — PR CI triage and local repro.
- `auto-mobile-code-review` — the AutoMobile-specific review pass.
- `push-pr` — commit/push/create-PR/auto-merge mechanics.
