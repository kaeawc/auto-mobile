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
array, so redirecting to a file and parsing it with `jq` is safe. Verified on gh 2.96 against
PR [#4117](https://github.com/kaeawc/auto-mobile/pull/4117) with `per_page=2`: five GET requests, one top-level document, element count matching
the unpaginated result. (The `gh api` manual describes pages as separate documents — true for
GraphQL and for object-shaped responses, but not for these array endpoints on this version. If
you are on an older gh, re-check before relying on it.) Do **not** add `--slurp`
here: on an array endpoint it produces an array _of pages_ (`[[…],[…]]`), and it is rejected
outright when combined with `--jq` (`the --slurp option is not supported with --jq or
--template`). GraphQL is the opposite case — see below.

Scope everything to the PR's `headRefOid`; after any push, re-collect from the new head. For
the triage workflow — ledger, dispositions, resolution conditions — use `github-pr-feedback`.
This is just the mechanics.

## Review threads: resolution state

`GET /pulls/{n}/comments` and `gh pr view --json comments` return bodies but **not** whether a
thread is resolved; that lives only in GraphQL. Collect threads through the tested helper:

```bash
scripts/ci/pr-review-threads.sh <PR> --unresolved-only
```

It paginates review threads, emits one clean JSON array, and fails closed rather than returning a
partial feedback ledger. Do not replace it with a saved `gh api graphql --paginate` response:
GraphQL emits one JSON document per page, unlike the REST array endpoints above.

`--paginate` advances the **outer** `reviewThreads` connection only. The nested
`comments(first:20)` is a separate connection: a thread with more replies than that silently
truncates, and the later replies are exactly where a rebuttal or fix-evidence lives. For a
thread you are about to resolve on the strength of its discussion, read the full comment list
from REST instead, which paginates properly:

```bash
gh api --paginate "repos/kaeawc/auto-mobile/pulls/<PR>/comments?per_page=100" \
  --jq '.[] | select(.in_reply_to_id == <root_comment_id> or .id == <root_comment_id>)
        | "\(.user.login): \(.body)"'
```

`isOutdated` means the anchored line changed, **not** that the finding was addressed — judge
outdated threads on content.

Resolving needs only the thread's `PRRT_…` id:

```bash
gh api graphql -f query='
mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){ thread{ isResolved } } }' \
  -F id=<PRRT_…>
```

Only resolve on a PR **we** authored and are actively working, once the finding is genuinely
handled — fixed in a pushed commit, or verified and declined. Both count: resolving claims the
thread is dealt with, not that the reviewer was right. Leave it open only when you could not
determine whether the finding is real.
Replying instead takes the _comment_ id, not the thread id:

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
reachability — verify before acting and equally before dismissing, and keep those two judgements
apart: a false mechanism often arrives attached to a good suggestion, so evaluate the proposed
change on its own reasoning before rejecting it. Refuting also carries the higher burden than
accepting, since a wrong rejection leaves a live bug. When you do decline, **report the reason
in-session and resolve the thread**; do not post a reply. `github-pr-feedback` and
`auto-mobile-code-review` both forbid posting, and a decline is not an exception.

## Checks

```bash
gh pr checks <PR> --json name,state,bucket,link
```

Branch on `bucket`: `pass`, `fail`, `pending`, `skipping`, `cancel`. **Only `fail` is a
failure.** A `cancelled` check on the head SHA is usually a superseded run from a rapid push,
but it can still wedge the `green-main` ruleset — re-run it rather than debugging code.

Cross-check the head SHA's check-runs, where duplicates surface:

```bash
# filter defaults to `latest`, which hides exactly the stale duplicate you are looking for.
gh api --paginate "repos/kaeawc/auto-mobile/commits/<HEAD_SHA>/check-runs?per_page=100&filter=all" \
  --jq '.check_runs[] | "\(.name)\t\(.status)\t\(.conclusion // "-")\t\(.completed_at)"' | sort
```

The **same name twice with different conclusions** — a cancelled older run beside a successful
newer one — is what parks automerge; take the newest. An empty legacy combined status is
_inconclusive_, not green, and a `queued`/`in_progress` job is never implicitly green.

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
