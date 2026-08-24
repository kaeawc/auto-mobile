---
name: github-pr-feedback
description: "Collect, triage, and safely resolve GitHub pull-request feedback with `gh` and the GitHub API without posting comments. Use for a PR's conversation comments, review submissions, inline comments, or unresolved review threads, especially before addressing feedback or declaring a PR ready."
---

# GitHub PR Feedback

Build one complete, head-SHA-scoped ledger before judging or changing a PR. Flat comment views
are insufficient: an unresolved thread can be absent from them, and an outdated thread still
needs a deliberate disposition. See `github-cli` for the underlying command mechanics.

## Intake

1. Snapshot the PR:
   ```bash
   # Keep the field list on ONE line: a backslash-newline plus indentation turns the
   # remainder into a second positional argument, which `gh pr view` rejects.
   gh pr view <pr> --json number,url,state,mergedAt,mergeCommit,title,body,author,headRefName,headRefOid,baseRefName,mergeable,mergeStateStatus,reviewDecision,closingIssuesReferences
   gh api user -q .login    # is this an open PR authored by the authenticated user?
   ```
   Record `headRefOid`; never apply a disposition to a later head without a fresh snapshot.
2. **Merged or closed ⇒ historical read-only mode.** Compare its merge commit against current
   `origin/main`, classify each item as historical, remediated, or still-open, and do not push,
   resolve, or re-run without explicit authorization for a new follow-up scope.
3. Read every linked issue (`gh issue view <issue> --json number,title,state,body,comments,url`),
   then fetch all four paginated feedback surfaces, saving large snapshots under `scratch/`:
   - conversation: `gh api --paginate "repos/<owner>/<repo>/issues/<pr>/comments?per_page=100"`
   - review verdicts: `gh api --paginate "repos/<owner>/<repo>/pulls/<pr>/reviews?per_page=100"`
   - inline: `gh api --paginate "repos/<owner>/<repo>/pulls/<pr>/comments?per_page=100"`
   - GraphQL review threads: `scripts/ci/pr-review-threads.sh <pr>`, which returns a complete
     JSON array containing `id`, `isResolved`, `isOutdated`, `path`, `line`, `originalLine`,
     `diffSide`, and each requested comment's author, body, URL, and timestamp. Add
     `--unresolved-only` only when the full resolved-thread history is not needed.

   Query thread state even when the flat inline list is empty.

   The three REST endpoints return top-level arrays and `--paginate` merges them, so saving
   and parsing those is safe — do not add `--slurp`, which would yield an array _of pages_ and
   is rejected alongside `--jq`. GraphQL is the opposite, which is why review threads must use
   `pr-review-threads.sh`; a ledger built from only its first page looks complete and is not.

4. Build the ledger — one row per unresolved thread, review request, inline comment, and
   conversation comment: source URL, head SHA, requested behavior, file/line, disposition
   (`fix`, `wrong reason, right change`, `already addressed`, `not actionable`, `duplicate`,
   `ambiguous`, `out of scope`), evidence, targeted validation, and whether resolution is
   allowed.

### Bot findings

`chatgpt-codex-connector[bot]` is the highest-volume reviewer here and encodes severity as a
body badge (`P1 Badge`/`P2 Badge`/`P3 Badge`):

```bash
gh api --paginate "repos/<owner>/<repo>/pulls/<pr>/comments?per_page=100" \
  --jq '.[] | select(.user.login|test("codex"))
        | {id, path, line, sev: (.body|capture("P(?<n>[123]) Badge").n), body: .body[0:400]}'
```

P1 claims to block. It is usually right about mechanism and sometimes wrong about reachability —
verify the call path before acting and equally before dismissing. Over one recent week, 46 of 94
codex threads here merged still unresolved, several P1; that is the failure mode this skill
exists to prevent.

## Triage and resolution boundary

- Verify each claim against current source and PR intent. Neither an automated reviewer nor a
  stale diff position is proof by itself.
- **Judge the mechanism and the suggestion separately.** A reviewer can be wrong about _why_ and
  right about _what_; that is what `wrong reason, right change` is for. Collapsing it into
  `not actionable` is how real fixes get closed — it happened twice in one week here.
- **Refutation carries the higher burden.** Wrongly rejecting a real finding leaves a live bug;
  wrongly accepting a bad one costs a small unnecessary change. Before calling something refuted,
  confirm your test could actually have found it: that it discriminates between the claim and its
  negation, and that your environment or sample matches the claim's stated scope. Record the
  version or platform you tested against, so the limit of the evidence is visible.
- An unresolved, non-outdated thread is actionable until evidence says otherwise. An outdated
  thread is a prompt to check whether the current head fixed the underlying behavior — never a
  reason to silently discard it. On a merged/closed PR, keep it as an explicit historical
  disposition; adjacent code changing in a later PR does not address it.
- **Never post a conversation comment, reply, inline comment, or review.** Return dispositions
  and evidence to the user.
- **A triaged thread gets resolved — that is what addressing it means.** Resolution is the
  disposition made durable, not a reward reserved for fixes. Two routes:
  - Disposition `fix` or `wrong reason, right change`: resolve once the change is committed
    **and pushed**, targeted validation passed, and the fresh head still contains it. For
    `wrong reason, right change`, also tell the user which part of the stated reasoning did not
    hold — otherwise it reads as agreement and the bad rationale becomes precedent.
  - Disposition `already addressed`, `not actionable`, `duplicate`, or `out of scope`:
    resolve too. A finding you verified and declined is handled; leaving it open only makes
    the next reader re-derive your reasoning. Report the reason to the user in-session.
    In both cases the PR must be open and authored by the authenticated user, and the
    resolution must answer _that_ thread rather than a neighbouring one.
- The single exception is `ambiguous`: if you could not determine whether the finding is real,
  leave it open, say so, and ask. Never resolve to make a queue look clean.
- Resolve via GraphQL, never by guessing from a flat comment id:
  ```bash
  gh api graphql -f query='
  mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){ thread{ id isResolved } } }' \
    -F id=<PRRT_…>
  ```
  `threadId` is the `PRRT_…` node id from the `reviewThreads` query, and nothing else is needed.
  Answering instead takes the _comment_ id
  (`gh api repos/<owner>/<repo>/pulls/<pr>/comments/<comment_id>/replies -f body='…'`) — but a
  reply is a comment, so send one only when the user asked you to answer a reviewer, never as
  your own finding.
- After a push, repeat intake from the new head SHA. Do not resolve threads or call CI green
  against the previous head.

## Handoff

Return the ledger and the exact remaining blockers. Pair with `check-ci` for workflow state and
`auto-mobile-code-review` for code-level verification and follow-through.
