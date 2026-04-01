---
name: pr-analysis
description: Use this skill to perform deep analysis of a GitHub PR — read code changes, comments, CI status, assess quality, regression risk, test gaps, and intent alignment. Read-only by default.
---

# PR Analysis

Perform a thorough analysis of a GitHub PR covering code quality, regression risk, test coverage, and intent alignment.

## Step 1: Resolve PR and Gather Metadata

```bash
PR_NUM=<number>
gh pr view ${PR_NUM} --json number,title,body,headRefName,baseRefName,author,state,mergeable,additions,deletions,changedFiles,reviews,comments
```

Store the PR branch, base branch, description, and title.

## Step 2: Gather Context in Parallel

Run all of these:

**Code diff:**
```bash
gh pr diff ${PR_NUM}
gh pr diff ${PR_NUM} --stat
```

**Review comments (inline):**
```bash
gh api repos/{owner}/{repo}/pulls/${PR_NUM}/comments \
  --jq '.[] | {file: .path, line: (.line // .original_line), body: .body, author: .user.login}'
```

**Conversation comments:**
```bash
gh pr view ${PR_NUM} --json comments \
  --jq '.comments[] | {body: .body, author: .author.login}'
```

**Review verdicts:**
```bash
gh pr view ${PR_NUM} --json reviews \
  --jq '.reviews[] | {state: .state, author: .author.login, body: .body}'
```

**Unresolved threads:**
```bash
gh api graphql -f query='{
  repository(owner: "{owner}", name: "{repo}") {
    pullRequest(number: '${PR_NUM}') {
      reviewThreads(first: 100) {
        nodes {
          isResolved
          comments(first: 10) {
            nodes { body author { login } path line }
          }
        }
      }
    }
  }
}' --jq '.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved == false)'
```

**CI status:**
```bash
gh pr checks ${PR_NUM} 2>&1
```

If CI is failing, fetch logs:
```bash
FAILED_RUNS=$(gh pr checks ${PR_NUM} 2>&1 | grep -i "fail" \
  | grep -oE 'runs/[0-9]+' | grep -oE '[0-9]+' | sort -u)
for RUN_ID in $FAILED_RUNS; do
    gh run view ${RUN_ID} --log-failed 2>&1 | tail -60
done
```

## Step 3: Read Changed Files in Full Context

Read the FULL files from the PR branch, not just diff hunks:
```bash
git fetch origin <PR_BRANCH>
git show origin/<PR_BRANCH>:<file> 2>/dev/null
```

Also read the same files from the base branch to understand what changed. Find related test files, interfaces, and callers of modified functions.

## Step 4: Run Validation (if applicable)

If the PR description mentions running tests or validation, or if the project has standard validation, run it locally against the PR branch:

```bash
git checkout origin/<PR_BRANCH> --detach
bun run lint && bun run build && bun test
git checkout -
```

Use `scripts/` validation when available. Skip heavy builds unless the PR specifically asks for it.

## Step 5: Produce Analysis

Structure the output as:

### Intent Analysis
- **Described intent**: What the PR description says
- **Actual changes**: What the diff does
- **Alignment**: Match / partial match / mismatch with explanation

### Code Quality
Per significant changed file:
- Correctness, style consistency, complexity, error handling, naming
- Flag issues with specific file:line references

### Regression Risk
- Modified contracts (function signatures, types, interfaces)
- Behavioral changes visible to callers
- Removed code that other code depends on
- Configuration or dependency changes
- Rate: **Low / Medium / High** with explanation

### Test Coverage
- Are new changes tested?
- What scenarios are NOT tested that should be?
- Suggest specific test cases with file paths

### CI Status
- Current state (passing/failing/pending)
- Failure root cause analysis
- Whether failures are PR-related or pre-existing

### Existing Feedback Summary
- Unresolved comment count and key themes
- Review status (approved / changes requested / pending)

### Actionable Feedback
Prioritized suggestions:
- **Must fix**: Blocks merge
- **Should fix**: Improves quality
- **Consider**: Nice to have
- **Positive notes**: What's done well

## Safety Rules

- This skill is read-only by default — do not modify code, push, or post comments.
- Checkout in detached HEAD mode to avoid branch pollution.
- Always return to the original branch after analysis.
- Do not post review comments to GitHub unless explicitly asked.
