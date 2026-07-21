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
`gh run view <RUN_ID> --log-failed` also works, but only once the **whole run** is finished.

## Portability

Repo CI runs macOS legs, and this repo's own scripts are linted for BSD/GNU portability.
In anything you write down or commit, avoid GNU-only invocations: `grep -P`/`grep -oP`,
`sed -i` without an argument, `readlink -f`, `mapfile`, `date -d`. Use `grep -oE`,
`sed -i ''`, and `awk` instead.
