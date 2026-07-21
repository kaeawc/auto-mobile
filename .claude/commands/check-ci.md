---
description: Check CI status, analyze failures, reproduce locally, and provide next steps
allowed-tools: Bash, Read, Grep, Glob
argument-hint: [PR number (optional)]
---

Check the CI status for a pull request, analyze failures, check for merge conflicts and PR comments, attempt to reproduce issues locally, and provide an analysis of next steps.

Use the following bash script to check CI status. If an argument is provided, use it as the PR number. Otherwise, auto-detect from the current branch.

```bash
#!/usr/bin/env bash
set -uo pipefail

REPO=kaeawc/auto-mobile
PR_NUM="${1:-$(gh pr view --json number -q .number 2>/dev/null)}"

if [ -z "$PR_NUM" ]; then
  echo "No PR found for the current branch. Usage: /check-ci [PR_NUMBER]" >&2
  exit 1
fi

echo "=== CI status for PR #${PR_NUM} ==="

# Bucket is gh's normalized state: pass | fail | pending | skipping | cancel.
# Branch on it rather than grepping the human-readable output.
CHECKS_JSON=$(gh pr checks "$PR_NUM" --json name,state,bucket,link 2>/dev/null)

printf '%s' "$CHECKS_JSON" | jq -r '
  group_by(.bucket) | map({bucket: .[0].bucket, n: length})
  | sort_by(-.n)[] | "  \(.bucket): \(.n)"'

echo
echo "--- not passing ---"
printf '%s' "$CHECKS_JSON" | jq -r '
  .[] | select(.bucket != "pass" and .bucket != "skipping")
  | "  \(.bucket)\t\(.name)\t\(.link)"'

# skipping and cancel are NOT failures. Only fail is.
FAILED=$(printf '%s' "$CHECKS_JSON" | jq -r '[.[] | select(.bucket == "fail")] | length')

if [ "$FAILED" -eq 0 ]; then
  PENDING=$(printf '%s' "$CHECKS_JSON" | jq -r '[.[] | select(.bucket == "pending")] | length')
  [ "$PENDING" -gt 0 ] && echo "Waiting on ${PENDING} check(s)." || echo "All checks passed."
  exit 0
fi

# Resolve run ids from the check links, then walk run -> jobs -> the failed job's log.
# grep -oE (POSIX-ish) rather than grep -oP: macOS /usr/bin/grep has no -P.
RUN_IDS=$(printf '%s' "$CHECKS_JSON" \
  | jq -r '.[] | select(.bucket == "fail") | .link' \
  | grep -oE 'runs/[0-9]+' | cut -d/ -f2 | sort -u)

mkdir -p scratch
for RUN_ID in $RUN_IDS; do
  echo
  echo "=== run ${RUN_ID} — https://github.com/${REPO}/actions/runs/${RUN_ID} ==="
  gh api "repos/${REPO}/actions/runs/${RUN_ID}/jobs" --paginate \
    --jq '.jobs[] | select(.conclusion == "failure") | "\(.id)\t\(.name)"' \
  | while IFS=$'\t' read -r JOB_ID JOB_NAME; do
      echo "--- job ${JOB_ID}: ${JOB_NAME} ---"
      LOG="scratch/job-${JOB_ID}.log"
      # A finished job's log is readable even while sibling jobs still run.
      if gh api "repos/${REPO}/actions/jobs/${JOB_ID}/logs" > "$LOG" 2>/dev/null; then
        grep -nE '##\[error\]|not ok |FAIL|error:|Error:' "$LOG" | head -30
        echo "  (full log: ${LOG})"
      else
        # Job has not finished; show which step it is on instead.
        gh api "repos/${REPO}/actions/jobs/${JOB_ID}" \
          --jq '.steps[] | select(.status != "completed" or .conclusion == "failure")
                | "  step \(.number)\t\(.status)\t\(.conclusion // "-")\t\(.name)"'
      fi
    done
done
```

## How it works

1. **PR detection** — takes the PR number as an argument, otherwise resolves it from the current branch.
2. **Bucketing** — reads `gh pr checks --json` and branches on `bucket`, gh's normalized
   state. `skipping` and `cancel` are **not** failures; only `fail` is. A `cancelled` check
   is usually a superseded run from a rapid push, though it can still wedge the `green-main`
   ruleset — re-run that run rather than debugging the code.
3. **Run → jobs → job log** — resolves run ids from the failing checks' links, then fetches
   only the failed jobs' logs. A finished job's log is readable **while sibling jobs are
   still running**, so this does not wait on the slowest leg.
4. **Live jobs** — when a job hasn't finished, its log 404s, so the script falls back to
   per-step status and shows which step it is on.
5. **Logs land in `scratch/`** — each is ~100KB+; read the extracted error lines and open the
   file only when you need more.

See the `github-cli` skill for the underlying commands, including review-thread resolution
state, which REST does not expose.

## Additional Analysis Steps

After running the bash script above, continue with these analysis steps:

### Step 1: Check for Merge Conflicts

```bash
# Check if branch is behind main
gh pr view ${PR_NUM} --json mergeable,mergeStateStatus -q '.mergeable, .mergeStateStatus'

# If behind, check details
git fetch origin main
git log HEAD..origin/main --oneline

# Check for merge conflicts
git merge-tree $(git merge-base HEAD origin/main) HEAD origin/main
```

**If conflicts exist**:
- List conflicting files
- Show conflict markers
- Recommend resolution strategy (rebase vs merge)
- Provide commands to resolve

### Step 2: Check PR Comments and Feedback

Resolution state lives only in GraphQL — `gh pr view --json comments` and the REST
`/pulls/N/comments` endpoint both omit it, so they cannot tell you what is still outstanding:

```bash
gh api graphql -f query='
query($owner:String!,$repo:String!,$pr:Int!){
  repository(owner:$owner,name:$repo){ pullRequest(number:$pr){
    reviewThreads(first:100){ nodes{ id isResolved isOutdated path line
      comments(first:5){ nodes{ author{login} body } } } } } } }' \
  -F owner=kaeawc -F repo=auto-mobile -F pr=${PR_NUM} \
  --jq '.data.repository.pullRequest.reviewThreads.nodes[]
        | select(.isResolved|not)
        | "\(.path):\(.line)\t\(.comments.nodes[0].author.login)"'
```

`isOutdated` only means the anchored line moved — not that the finding was addressed.

**Analyze comments**:
- Identify unresolved feedback
- Categorize by type (bug report, suggestion, question, approval)
- Highlight actionable items
- Note if any reviewers requested changes

### Step 3: Reproduce Failures Locally

For each failed CI check, provide commands to reproduce:

**Lint failures**:
```bash
bun run lint
```

**Build failures**:
```bash
bun run build
```

**Test failures**:
```bash
# Run all tests
bun test

# Run specific test file mentioned in logs
bun test <test-file-path>

# Run with coverage
bun test --coverage
```

**TypeScript errors**:
```bash
# Check types
bun run typecheck
# or
tsc --noEmit
```

**Docker build failures**:
```bash
# Rebuild locally
docker build -t auto-mobile .

# Check specific stage
docker build --target <stage> -t auto-mobile .
```

**Android/Gradle failures**:
```bash
cd android
./gradlew clean build

# Run specific task mentioned in logs
./gradlew <task-name>
```

**Attempt to run the commands** that match the failure type and report results.

### Step 4: Analyze Failures

For each failure found:

1. **Identify root cause**:
   - Parse error messages from CI logs
   - Search codebase for related code using Grep
   - Read relevant files to understand context

2. **Categorize the issue**:
   - Syntax error (typo, missing import)
   - Type error (TypeScript)
   - Test failure (assertion failed)
   - Flaky test (timing issue)
   - Integration issue (dependency problem)
   - Configuration issue (CI-specific)

3. **Determine reproducibility**:
   - Can reproduce locally → Direct fix possible
   - Cannot reproduce locally → CI environment issue
   - Intermittent → Flaky test or race condition

### Step 5: Provide Next Steps Analysis

Generate a summary report:

```markdown
## CI Status Report for PR #[number]

### Current State
- **Status**: [All passing / X failing / X pending]
- **Merge conflicts**: [Yes/No]
- **Unresolved comments**: [count]

### Failures Analysis

#### Failure 1: [Check name]
- **Type**: [lint/build/test/etc]
- **Root cause**: [description]
- **Reproducible locally**: [Yes/No]
- **Files affected**: [list]
- **Recommended fix**: [specific action]

#### Failure 2: [Check name]
...

### PR Comments Summary
- **Total comments**: [count]
- **Actionable feedback**: [list key items]
- **Requested changes**: [list]

### Merge Conflicts
- **Status**: [clean / conflicts in X files]
- **Affected files**: [list]
- **Resolution strategy**: [rebase / merge / manual]

### Recommended Next Steps

1. [Priority 1 action with commands]
2. [Priority 2 action with commands]
3. [Priority 3 action with commands]

### Commands to Execute

```bash
# Fix merge conflicts (if any)
git fetch origin main
git rebase origin/main
# [resolve conflicts]

# Apply feedback from PR comments
# [specific changes based on comments]

# Fix failing checks
[specific commands based on failures]

# Validate locally
bun run lint
bun run build
bun test

# Push fixes
git push --force-with-lease
```
```

### Step 6: Execute Fixes (Optional)

If user confirms, execute the recommended fixes:
- Resolve merge conflicts
- Apply PR feedback
- Fix failing checks
- Run local validation
- Commit and push changes

## Usage Examples:

**Simple check**:
```
/check-ci
```
Output: Shows CI status, then analyzes failures, checks conflicts, reviews comments, and provides next steps

**Check specific PR**:
```
/check-ci 83
```

**Typical workflow** (from prompt analysis):
```
/check-ci                    # Analyze current state
[Review analysis]
[Make fixes based on recommendations]
/validate                    # Run local validation
/push                        # Push fixes
/check-ci                    # Verify fixes resolved issues
```
