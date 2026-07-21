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
   gh pr view <pr> --json number,url,state,mergedAt,mergeCommit,title,body,author,\
   headRefName,headRefOid,baseRefName,mergeable,mergeStateStatus,reviewDecision,closingIssuesReferences
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
   - GraphQL review threads, paginated with `first: 100`, `$endCursor`, and `pageInfo`,
     requesting `id`, `isResolved`, `isOutdated`, `path`, `line`, `originalLine`, `diffSide`,
     and every comment's author, body, URL, and timestamp.

   Query thread state even when the flat inline list is empty.
4. Build the ledger — one row per unresolved thread, review request, inline comment, and
   conversation comment: source URL, head SHA, requested behavior, file/line, disposition
   (`fix`, `already addressed`, `not actionable`, `duplicate`, `ambiguous`, `out of scope`),
   evidence, targeted validation, and whether resolution is allowed.

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
- An unresolved, non-outdated thread is actionable until evidence says otherwise. An outdated
  thread is a prompt to check whether the current head fixed the underlying behavior — never a
  reason to silently discard it. On a merged/closed PR, keep it as an explicit historical
  disposition; adjacent code changing in a later PR does not address it.
- **Never post a conversation comment, reply, inline comment, or review.** Return dispositions
  and evidence to the user.
- Resolve only once all hold: the in-scope fix is committed **and pushed**, targeted validation
  passed, the fresh head still contains the fix, the PR is open and authored by the
  authenticated user, and the resolution directly answers *that* thread. Leave ambiguous,
  conflicting, or out-of-scope threads unresolved and report why.
- Resolve via GraphQL, never by guessing from a flat comment id:
  ```bash
  gh api graphql -f query='
  mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){ thread{ id isResolved } } }' \
    -F id=<PRRT_…>
  ```
  `threadId` is the `PRRT_…` node id from the `reviewThreads` query, and nothing else is needed.
  Answering instead takes the *comment* id
  (`gh api repos/<owner>/<repo>/pulls/<pr>/comments/<comment_id>/replies -f body='…'`) — but a
  reply is a comment, so send one only when the user asked you to answer a reviewer, never as
  your own finding.
- After a push, repeat intake from the new head SHA. Do not resolve threads or call CI green
  against the previous head.

## Handoff

Return the ledger and the exact remaining blockers. Pair with `check-ci` for workflow state and
`auto-mobile-code-review` for code-level verification and follow-through.
