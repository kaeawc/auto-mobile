---
name: push-my-prs
description: Use this skill to iterate through all open PRs authored by the current user, read comments and CI status, address feedback, resolve threads, and push fixes. Designed for autonomous PR maintenance loops.
---

# Push My PRs

Iterate through all open PRs owned by the current GitHub user. For each PR: read feedback, check CI, fix issues, resolve addressed comments, push changes.

## Step 1: List Open PRs

```bash
GH_USER=$(gh api user -q .login)
gh pr list --author "$GH_USER" --state open --json number,title,headRefName,url \
  --jq '.[] | "\(.number)\t\(.headRefName)\t\(.title)"'
```

If no open PRs, report "No open PRs" and stop.

## Step 2: For Each PR — Gather Context

For each PR number, run all of these:

```bash
PR_NUM=<number>

# CI status
gh pr checks ${PR_NUM} 2>&1

# Mergeability
gh pr view ${PR_NUM} --json mergeable,mergeStateStatus \
  --jq '{mergeable: .mergeable, mergeState: .mergeStateStatus}'

# Review verdicts
gh pr view ${PR_NUM} --json reviews \
  --jq '.reviews[] | {state: .state, author: .author.login, body: .body}'

# Unresolved review threads
gh api graphql -f query='{
  repository(owner: "{owner}", name: "{repo}") {
    pullRequest(number: '${PR_NUM}') {
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          comments(first: 10) {
            nodes { body author { login } path line }
          }
        }
      }
    }
  }
}' --jq '.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved == false)'

# Top-level comments
gh pr view ${PR_NUM} --json comments \
  --jq '.comments[] | {body: .body, author: .author.login}'
```

## Step 3: For Each PR — Address Feedback

Checkout the PR branch:

```bash
PR_BRANCH=<headRefName>
git fetch origin "$PR_BRANCH"
git checkout "$PR_BRANCH"
git pull origin "$PR_BRANCH"
```

For each unresolved review thread:
1. Read the file at the referenced path and line.
2. Understand the feedback — bug, style, missing test, logic change.
3. Make the fix.
4. If the comment is a false positive or already addressed, note it.

If the PR has merge conflicts:
```bash
git fetch origin main
git rebase origin/main
# Resolve conflicts, then validate
```

## Step 4: Handle CI Failures

If CI checks are failing, fetch failure logs:

```bash
FAILED_RUNS=$(gh pr checks ${PR_NUM} 2>&1 | grep -i "fail" \
  | grep -oE 'runs/[0-9]+' | grep -oE '[0-9]+' | sort -u)

for RUN_ID in $FAILED_RUNS; do
    gh run view ${RUN_ID} --log-failed 2>&1 | tail -80
done
```

Reproduce locally with the appropriate command:
- TypeScript: `bun run lint && bun run build && bun test`
- Android: `(cd android && ./gradlew build)`
- iOS: `(cd ios && swift build)`
- MkDocs: `bash scripts/mkdocs/validate_mkdocs_nav.sh` (if it exists)

Fix the root cause and validate the fix passes locally.

## Step 5: Validate Locally

Run validation appropriate to the changed files before committing:

```bash
# TypeScript changes
bun run lint && bun run build && bun test

# Android changes
(cd android && ./gradlew build)

# Use scripts/ when available
ls scripts/*.sh
```

## Step 6: Resolve Addressed Threads

For each thread that has been addressed by your changes, resolve it via GraphQL:

```bash
THREAD_ID=<thread id from Step 2>
gh api graphql -f query='
mutation {
  resolveReviewThread(input: {threadId: "'$THREAD_ID'"}) {
    thread { isResolved }
  }
}'
```

Only resolve comments that have actually been addressed. Leave ambiguous or discussion-worthy comments unresolved.

## Step 7: Commit and Push

Write the PR body to a file to preserve formatting (per `gh-pr-workflow` skill):

```bash
if ! git diff --quiet HEAD; then
    git add -A
    git commit -m "address PR feedback"
    git push
else
    echo "No changes needed for PR #${PR_NUM}"
fi
```

## Step 8: Enable Automerge

```bash
gh pr merge ${PR_NUM} --auto --squash 2>&1 || true
```

## Step 9: Report and Continue

Output a brief status line per PR:

```
PR #1234 (branch-name): 3 comments addressed, 1 CI fix, pushed.
PR #1235 (other-branch): All green, no new comments. Automerge enabled.
```

Then move to the next PR.

## Safety Rules

- Never force push. Use `git push` (or `--force-with-lease` only after rebase).
- Never resolve comments that haven't been addressed.
- Never dismiss reviews.
- If a comment is ambiguous, leave it unresolved and note it.
- Always validate locally before pushing.
- Prefer existing `scripts/` validation over ad-hoc commands.
