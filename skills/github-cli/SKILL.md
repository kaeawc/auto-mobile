---
name: github-cli
description: Helper skill for GitHub operations in this repo; use it when another workflow needs gh for PRs, issues, review threads, checks, Actions runs, or job logs — including logs from a job that is still running.
---

# GitHub CLI Usage

Shared dependency for `check-ci`, `github-pr-feedback`, `auto-mobile-code-review`,
`pr-analysis`, `push-pr`, and `push-my-prs`.

- Prefer `gh pr view|list|create|edit` and `gh issue list|view`.
- Reach for `gh api`/GraphQL only where the subcommands fall short — review-thread resolution
  state and live job logs are the two cases that matter here.
- Write long output to `scratch/` and summarize. Job logs run 100KB+; never let one into the
  conversation whole.

## PR feedback: four separate surfaces

No single endpoint returns all PR feedback. Collect all four, paginated, or miss whole
categories:

```bash
gh api --paginate "repos/kaeawc/auto-mobile/issues/<PR>/comments?per_page=100"  # conversation
gh api --paginate "repos/kaeawc/auto-mobile/pulls/<PR>/reviews?per_page=100"    # review verdicts
gh api --paginate "repos/kaeawc/auto-mobile/pulls/<PR>/comments?per_page=100"   # inline (no resolution state)
# review threads — the only source of resolution state — below
```

These three return **top-level JSON arrays**, and `--paginate` merges the pages into one flat
array, so redirecting to a file and parsing it with `jq` is safe. Do **not** add `--slurp`
here: on an array endpoint it produces an array *of pages* (`[[…],[…]]`), and it is rejected
outright when combined with `--jq` (`the --slurp option is not supported with --jq or
--template`). GraphQL is the opposite case — see below.

Scope everything to the PR's `headRefOid`; after any push, re-collect from the new head. For
the triage workflow — ledger, dispositions, resolution conditions — use `github-pr-feedback`.
This is just the mechanics.

## Review threads: resolution state

`GET /pulls/{n}/comments` and `gh pr view --json comments` return bodies but **not** whether a
thread is resolved; that lives only in GraphQL. Note `first: 100` is not pagination — a PR with
more than 100 threads truncates silently, with no error — so page properly:

```bash
gh api graphql --paginate -f query='
query($owner:String!,$repo:String!,$pr:Int!,$endCursor:String){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$pr){
      reviewThreads(first:100, after:$endCursor){
        pageInfo{ hasNextPage endCursor }
        nodes{ id isResolved isOutdated path line originalLine diffSide
          comments(first:20){ nodes{ author{login} body url createdAt } } } } } } }' \
  -F owner=kaeawc -F repo=auto-mobile -F pr=<PR> \
  --jq '.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved|not)
        | "\(.id)\t\(.path):\(.line)\t\(.comments.nodes[0].author.login)"'
```

**GraphQL `--paginate` does not merge.** Unlike the REST array endpoints above, it emits one
complete JSON *document per page*, concatenated. The `--jq` form above is safe because jq
streams every document — but redirecting the same query to a file and parsing it afterwards
reads **only the first page**, silently, with no error. Verified on PR #4098 with `first: 2`
against 4 threads: the saved file yields `nodes | length` = 2, and `pageInfo` appears twice.

So when you need the whole result as a file, add `--slurp` (which cannot be combined with
`--jq`) and index through the page array:

```bash
gh api graphql --paginate --slurp -f query='…' -F pr=<PR> > scratch/threads.json
jq '[.[].data.repository.pullRequest.reviewThreads.nodes[]]' scratch/threads.json
```

Otherwise keep `--jq` and consume the stream directly. Never save a non-slurped GraphQL
`--paginate` result and parse it as one document.

`isOutdated` means the anchored line changed, **not** that the finding was addressed — judge
outdated threads on content.

Resolving needs only the thread's `PRRT_…` id:

```bash
gh api graphql -f query='
mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){ thread{ isResolved } } }' \
  -F id=<PRRT_…>
```

Only resolve on a PR **we** authored and are actively working, once the finding is genuinely
handled — fixed in a pushed commit, or answered with a reason. Resolving claims it is done.
Replying instead takes the *comment* id, not the thread id:

```bash
gh api repos/kaeawc/auto-mobile/pulls/<PR>/comments/<comment_id>/replies -f body='…'
```

### Bot findings

`chatgpt-codex-connector[bot]` encodes severity as a body badge (`P1 Badge`/`P2 Badge`/`P3 Badge`):

```bash
gh api repos/kaeawc/auto-mobile/pulls/<PR>/comments --paginate \
  --jq '.[] | select(.user.login|test("codex"))
        | {id, path, line, sev: (.body|capture("P(?<n>[123]) Badge").n), body: .body[0:400]}'
```

P1 claims to block. Codex is usually right about mechanism and sometimes wrong about
reachability — verify before acting, and reply with the reason when declining rather than
leaving the thread silently open.

## Checks

```bash
gh pr checks <PR> --json name,state,bucket,link
```

Branch on `bucket`: `pass`, `fail`, `pending`, `skipping`, `cancel`. **Only `fail` is a
failure.** A `cancelled` check on the head SHA is usually a superseded run from a rapid push,
but it can still wedge the `green-main` ruleset — re-run it rather than debugging code.

Cross-check the head SHA's check-runs, where duplicates surface:

```bash
gh api --paginate "repos/kaeawc/auto-mobile/commits/<HEAD_SHA>/check-runs?per_page=100" \
  --jq '.check_runs[] | "\(.name)\t\(.status)\t\(.conclusion // "-")\t\(.completed_at)"' | sort
```

The **same name twice with different conclusions** — a cancelled older run beside a successful
newer one — is what parks automerge; take the newest. An empty legacy combined status is
*inconclusive*, not green, and a `queued`/`in_progress` job is never implicitly green.

## Actions: runs, jobs, logs

Navigate run → jobs → one job's log; never download a whole run to read one failure.

```bash
gh run list --branch <branch> --limit 20 --json databaseId,name,status,conclusion,headSha
gh api repos/kaeawc/auto-mobile/actions/runs/<RUN_ID>/jobs \
  --jq '.jobs[] | "\(.id)\t\(.status)\t\(.conclusion // "-")\t\(.name)"'
```

### While the run is still going

`gh run view <run> --log` refuses on an in-progress run (`run … is still in progress; logs will
be available when it is complete`), and the per-job log endpoint 404s (`BlobNotFound`) for an
unfinished job. Neither means waiting for the whole matrix — **a finished job's log is readable
immediately, even while siblings run**:

```bash
gh api repos/kaeawc/auto-mobile/actions/jobs/<JOB_ID>/logs
```

So the live-triage loop is: poll the run's `jobs`, and pull each job's log the moment its
`status` is `completed` with `conclusion: failure`. For a job still executing, step state
locates it with no log fetch at all:

```bash
gh api repos/kaeawc/auto-mobile/actions/jobs/<JOB_ID> \
  --jq '.name, (.steps[] | "  \(.number)\t\(.status)\t\(.conclusion // "-")\t\(.name)")'
```

`gh run watch <RUN_ID> --exit-status` waits to completion without hand-polling.

### Extracting the failure

Fetch once to a file, then search — don't re-request per grep:

```bash
gh api repos/kaeawc/auto-mobile/actions/jobs/<JOB_ID>/logs > scratch/job-<JOB_ID>.log
grep -nE '##\[error\]|FAIL|✗|Error:|error:' scratch/job-<JOB_ID>.log | head -40
```

`##[error]` is the Actions-native marker and the highest-signal pattern. `gh run view <RUN_ID>
--log-failed` works only once the **whole run** finishes; `--job <JOB_ID> --log-failed` narrows
to one job. `gh api --follow` does not exist in the installed CLI — use `--paginate`. If the log
is truncated or lacks the failure body, list the run's artifacts and read the relevant one; when
`gh run download` returns an authorization error, report that exact blocker rather than
inferring a cause.

### Classify before you fix

Every red result is **PR-caused**, **pre-existing on main**, **transient/infrastructure**, or
**unproven** — grounded in the job log, changed paths, and current `origin/main`. A failure in a
subsystem the diff never touches is usually not this PR's. Re-run only on evidence of
transience; never change code for an unrelated or unproven failure.

## Portability

CI runs macOS legs and this repo lints its own scripts for BSD/GNU portability. Avoid GNU-only
invocations in anything you write down: `grep -P`/`grep -oP`, `sed -i` without an argument,
`readlink -f`, `mapfile`, `date -d`. Use `grep -oE`, `sed -i ''`, and `awk`.
