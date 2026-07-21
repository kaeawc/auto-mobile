---
name: github-pr-feedback
description: "Collect, triage, and safely resolve GitHub pull-request feedback with `gh` and the GitHub API without posting comments. Use for a PR's conversation comments, review submissions, inline comments, or unresolved review threads, especially before addressing feedback or declaring a PR ready."
---

# GitHub PR Feedback

Build one complete, head-SHA-scoped feedback ledger before judging or changing a
pull request. Flat PR comment views are insufficient: an unresolved review
thread can be absent from them, and an outdated thread still needs a deliberate
disposition.

## Intake

1. Resolve the immutable PR snapshot with `gh pr view <pr> --json
   number,url,state,mergedAt,mergeCommit,title,body,author,headRefName,headRefOid,baseRefName,mergeable,mergeStateStatus,reviewDecision,closingIssuesReferences`.
   Record the `headRefOid`; never apply a disposition to a later head without
   collecting a fresh snapshot.
   Resolve the authenticated user with `gh api user -q .login` and record
   whether this is an open PR authored by that user.
2. If the PR is merged or closed, use historical read-only mode: compare its
   merge commit and the current `origin/main`, classify feedback/CI as historical,
   remediated, or still-open work, and do not push, resolve, or rerun
   without explicit user authorization for a new follow-up scope.
3. Read every linked issue with `gh issue view <issue> --json
   number,title,state,body,comments,url`, then fetch every paginated feedback surface for this
   PR and save large snapshots under `scratch/`:

   - Conversation comments: `gh api --paginate "repos/<owner>/<repo>/issues/<pr>/comments?per_page=100"`
   - Review submissions: `gh api --paginate "repos/<owner>/<repo>/pulls/<pr>/reviews?per_page=100"`
   - Inline comments: `gh api --paginate "repos/<owner>/<repo>/pulls/<pr>/comments?per_page=100"`
   - GraphQL review threads, paginated with `first: 100`, `$endCursor`, and
     `pageInfo`. Request each thread's `id`, `isResolved`, `isOutdated`, `path`,
     `line`, `originalLine`, `diffSide`, and all comment authors, bodies, URLs,
     and timestamps.

   Use GraphQL thread state even if the flat inline-comment list is empty.
4. Make an action ledger for every current unresolved thread, review request,
   inline comment, and conversation comment: source URL, head SHA, requested
   behavior, file/line if applicable, disposition (`fix`, `already addressed`,
   `not actionable`, `duplicate`, `ambiguous`, or `out of scope`), evidence,
   targeted validation, and whether resolution is allowed.

## Triage and resolution boundary

- Verify each claim against the current source and PR intent. Do not treat an
  automated reviewer or a stale diff position as proof by itself.
- For a merged/closed PR, retain an unresolved thread as an explicit historical
  disposition. It is not implicitly addressed merely because a later PR changed
  adjacent code.
- Treat an unresolved, non-outdated thread as actionable until evidence says
  otherwise. Treat an outdated thread as a prompt to check whether the current
  head already fixes its underlying behavior; do not silently discard it.
- Never post a conversation comment, reply, inline comment, or review. Return
  the disposition and evidence to the user instead.
- Resolve only after all of the following: the in-scope fix is committed and
  pushed, targeted validation passed, the fresh PR head still contains the fix,
  the PR is open and authored by the authenticated GitHub user, and the
  resolution directly answers that thread. Leave ambiguous, conflicting, or
  out-of-scope threads unresolved and report the reason.
- Resolve through GitHub GraphQL, not by guessing from a flat comment ID:

  ```graphql
  mutation($threadId: ID!) {
    resolveReviewThread(input: {threadId: $threadId}) {
      thread { id isResolved }
    }
  }
  ```

- After a push, repeat intake from the new head SHA. Do not resolve threads or
  call CI green based on the previous head.

## Handoff

Return the action ledger and the exact remaining blockers. Pair this skill with
`check-ci` for workflow state and `auto-mobile-code-review` for code-level
verification and follow-through.
