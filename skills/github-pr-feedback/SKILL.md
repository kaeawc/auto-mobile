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

### Bot findings

`chatgpt-codex-connector[bot]` is the highest-volume reviewer on this repo and encodes
severity as a badge in the comment body (`P1 Badge` / `P2 Badge` / `P3 Badge`). Rank by it:

```bash
gh api --paginate "repos/<owner>/<repo>/pulls/<pr>/comments?per_page=100" \
  --jq '.[] | select(.user.login|test("codex"))
        | {id, path, line, sev: (.body|capture("P(?<n>[123]) Badge").n), body: .body[0:400]}'
```

P1 means the bot believes it blocks. It is usually right about mechanism and sometimes wrong
about reachability — verify the call path before acting, and equally before dismissing. Over
one recent week, 46 of 94 codex threads on this repo were merged still unresolved, several of
them P1; that is the failure mode this skill exists to prevent.

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

  ```bash
  gh api graphql -f query='
  mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){ thread{ id isResolved } } }' \
    -F id=<PRRT_…>
  ```

  `threadId` is the `PRRT_…` node id from the `reviewThreads` query — not an inline-comment
  id, and nothing else is required. To answer a thread instead of resolving it, reply with
  the *comment* id: `gh api repos/<owner>/<repo>/pulls/<pr>/comments/<comment_id>/replies
  -f body='…'`. A reply is a comment; per the boundary above, only send one when the user has
  asked you to answer a reviewer, never as your own review finding.

- After a push, repeat intake from the new head SHA. Do not resolve threads or
  call CI green based on the previous head.

## Handoff

Return the action ledger and the exact remaining blockers. Pair this skill with
`check-ci` for workflow state and `auto-mobile-code-review` for code-level
verification and follow-through.
