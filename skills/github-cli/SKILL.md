---
name: github-cli
description: Helper skill for GitHub operations in this repo; use it when another workflow needs gh for PRs, issues, review threads, checks, Actions runs, or job logs — including logs from a job that is still running.
---

# GitHub CLI Usage

Use `gh` for GitHub work in this repo. Treat this as a shared dependency for
`check-ci`, `auto-mobile-code-review`, `pr-analysis`, `push-pr`, and `push-my-prs`.

- Prefer `gh pr view`, `gh pr list`, `gh pr create`, and `gh pr edit` for pull requests.
- Prefer `gh issue list` and `gh issue view` for issues.
- Use `gh api` / GraphQL when the subcommands do not expose the data or mutation you need —
  review-thread resolution state and live job logs both fall in that bucket, see below.
- When command output is long, write it to `scratch/` and summarize. Job logs are ~100KB+
  each; never let one into the conversation whole.

## PR feedback: four separate surfaces

There is no single endpoint that returns all PR feedback. Collect all four, each paginated,
or you will miss entire categories:

```bash
# 1. conversation comments (the PR timeline)
gh api --paginate "repos/kaeawc/auto-mobile/issues/<PR>/comments?per_page=100"
# 2. review submissions (approve / request-changes bodies)
gh api --paginate "repos/kaeawc/auto-mobile/pulls/<PR>/reviews?per_page=100"
# 3. inline comments (flat, no resolution state)
gh api --paginate "repos/kaeawc/auto-mobile/pulls/<PR>/comments?per_page=100"
# 4. review threads (the only source of resolution state) — see below
```

Scope everything to the PR's `headRefOid`. After any push, re-collect from the new head:
checks, threads, and comments are all scoped to the SHA they were made against.

For the full triage workflow — the action ledger, disposition vocabulary, and the conditions
under which a thread may be resolved — use the `github-pr-feedback` skill. This section is
just the mechanics.

## Review threads: reading resolution state

`GET /pulls/{n}/comments` (and `gh pr view --json comments`) returns comment bodies but
**not** whether a thread is resolved. Resolution lives only in GraphQL. To see what is
still outstanding on a PR:

```bash
gh api graphql -f query='
query($owner:String!,$repo:String!,$pr:Int!){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$pr){
      reviewThreads(first:100){
        nodes{ id isResolved isOutdated path line
          comments(first:10){ nodes{ author{login} body url } } } } } } }' \
  -F owner=kaeawc -F repo=auto-mobile -F pr=<PR> \
  --jq '.data.repository.pullRequest.reviewThreads.nodes[]
        | select(.isResolved|not)
        | "\(.id)\t\(.path):\(.line)\t\(.comments.nodes[0].author.login)"'
```

`first: 100` is **not** pagination — a PR with more than 100 threads truncates silently, with
no error. When a PR is large, page it properly:

```bash
gh api graphql --paginate -f query='
query($owner:String!,$repo:String!,$pr:Int!,$endCursor:String){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$pr){
      reviewThreads(first:100, after:$endCursor){
        pageInfo{ hasNextPage endCursor }
        nodes{ id isResolved isOutdated path line originalLine diffSide
          comments(first:20){ nodes{ author{login} body url createdAt } } } } } } }' \
  -F owner=kaeawc -F repo=auto-mobile -F pr=<PR>
```

`isOutdated` means the anchored line has since changed — it does **not** mean the finding
was addressed. Judge outdated threads on their content, not their flag.

The thread `id` (`PRRT_…`) is what resolves it. Nothing else is required:

```bash
gh api graphql -f query='
mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){ thread{ isResolved } } }' \
  -F id=<PRRT_…>
```

Only resolve threads on a PR **we** authored and are actively working through, and only
once the finding is genuinely handled — either fixed in a pushed commit, or answered with
a reply explaining why it does not apply. Resolving a thread is a claim that it is done.

To reply in-thread rather than resolve (use `gh api` with the *comment* id, not the thread id):

```bash
gh api repos/kaeawc/auto-mobile/pulls/<PR>/comments/<comment_id>/replies -f body='…'
```

### Bot findings

`chatgpt-codex-connector[bot]` posts inline findings with a severity badge in the body
(`P1 Badge` / `P2 Badge` / `P3 Badge`). Filter and rank them:

```bash
gh api repos/kaeawc/auto-mobile/pulls/<PR>/comments --paginate \
  --jq '.[] | select(.user.login|test("codex"))
        | {id, path, line, sev: (.body|capture("P(?<n>[123]) Badge").n), body: .body[0:400]}'
```

P1 means the bot believes it blocks. Codex is frequently right about mechanism and
occasionally wrong about reachability — verify against the code before acting, and reply
with the reason when declining rather than silently leaving the thread open.

## Checks: what state is a PR actually in

```bash
gh pr checks <PR> --json name,state,bucket,link
```

`bucket` normalizes the state and is what you should branch on:
`pass`, `fail`, `pending`, `skipping`, `cancel`. **`skipping` and `cancel` are not failures.**
A `cancelled` check on the head SHA is usually a superseded run from a rapid push, not a
defect — but it can still wedge the `green-main` ruleset, in which case re-run that run
rather than debugging the code.

Cross-check against the head SHA's check-runs, which is where duplicates show up:

```bash
gh api --paginate "repos/kaeawc/auto-mobile/commits/<HEAD_SHA>/check-runs?per_page=100" \
  --jq '.check_runs[] | "\(.name)\t\(.status)\t\(.conclusion // "-")\t\(.completed_at)"' \
  | sort
```

Watch for the **same check name appearing twice with different conclusions** — typically a
cancelled older run alongside a successful newer one. Take the newest; the stale one is what
parks automerge. An empty legacy combined status is *inconclusive*, not green, and a
`queued`/`in_progress` job is never implicitly green.

## Actions: runs, jobs, and logs

Navigate run → jobs → one job's log. Never download a whole run's logs to read one failure.

```bash
# runs for a branch / the PR head
gh run list --branch <branch> --limit 20 --json databaseId,name,status,conclusion,headSha

# the jobs inside a run — this is where the useful ids are
gh api repos/kaeawc/auto-mobile/actions/runs/<RUN_ID>/jobs \
  --jq '.jobs[] | "\(.id)\t\(.status)\t\(.conclusion // "-")\t\(.name)"'
```

### Reading a job while the run is still going

`gh run view <run> --log` refuses outright on an in-progress run
(`run … is still in progress; logs will be available when it is complete`), and the per-job
log endpoint 404s (`BlobNotFound`) for a job that has not finished. Neither of those means
you have to wait for the whole matrix.

**A finished job's log is readable immediately, even while sibling jobs are still running:**

```bash
gh api repos/kaeawc/auto-mobile/actions/jobs/<JOB_ID>/logs
```

So the efficient live-triage loop is: poll the run's `jobs` list, and pull the log of each
job the moment its `status` becomes `completed` with `conclusion: failure` — rather than
blocking on the slowest leg.

**For a job that is still executing**, step-level state tells you where it is with no log
fetch at all:

```bash
gh api repos/kaeawc/auto-mobile/actions/jobs/<JOB_ID> \
  --jq '.name, (.steps[] | "  \(.number)\t\(.status)\t\(.conclusion // "-")\t\(.name)")'
```

That identifies the running or failed step by name — usually enough to know whether to keep
waiting or start fixing.

To watch to completion without polling by hand: `gh run watch <RUN_ID> --exit-status`.

### Extracting just the failure from a finished job

Fetch once to a file, then search it — do not re-request per grep:

```bash
gh api repos/kaeawc/auto-mobile/actions/jobs/<JOB_ID>/logs > scratch/job-<JOB_ID>.log
grep -nE '##\[error\]|FAIL|✗|Error:|error:' scratch/job-<JOB_ID>.log | head -40
```

`##[error]` is the Actions-native failure marker and is the highest-signal pattern.
`gh run view <RUN_ID> --log-failed` also works, but only once the **whole run** is finished;
`gh run view <RUN_ID> --job <JOB_ID> --log-failed` narrows it to one job.

`gh api --follow` does **not** exist in the installed CLI — use `--paginate`. If console
output is truncated or the failure body isn't in the log, list the run's artifacts and read
the relevant log artifact. When `gh run download` returns an authorization error, report that
exact blocker rather than inferring a root cause from partial evidence.

### Classify before you fix

Every red result is one of: **PR-caused**, **pre-existing on main**, **transient or
infrastructure**, or **unproven**. Ground the call in the job log, the changed paths, and
current `origin/main` — a failing check on an unrelated subsystem is usually not this PR's.
Re-run a job only when the evidence says transient. Never change code for an unrelated or
unproven failure.

## Portability

Repo CI runs macOS legs, and this repo's own scripts are linted for BSD/GNU portability.
In anything you write down or commit, avoid GNU-only invocations: `grep -P`/`grep -oP`,
`sed -i` without an argument, `readlink -f`, `mapfile`, `date -d`. Use `grep -oE`,
`sed -i ''`, and `awk` instead.
