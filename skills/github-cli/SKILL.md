---
name: github-cli
description: Helper skill for GitHub operations in this repo; use it when another workflow needs gh for PRs, issues, checks, logs, or repository metadata.
---

# GitHub CLI Usage

Use `gh` for GitHub work in this repo. Resolve `owner/repo` once with
`gh repo view --json nameWithOwner -q .nameWithOwner`; record a PR's
`headRefOid` before correlating comments, checks, runs, or jobs.

- Prefer `gh pr view`, `gh pr list`, `gh pr create`, and `gh pr edit` for pull requests.
- Prefer `gh issue list` and `gh issue view` for issues.
- Prefer `gh pr checks` and `gh run view` for CI status and completed-job logs.
- Use paginated REST calls for comments, inline comments, review submissions,
  check runs, workflow runs/jobs, and artifacts. Use GraphQL for review-thread
  resolution/outdated state and the `resolveReviewThread` mutation; flat
  comments cannot provide it.
- For a job that is still running, poll its job state and retrieve an available
  log archive with `gh api "repos/<owner>/<repo>/actions/jobs/<job-id>/logs"`
  into `scratch/`; do not wait for `gh run view --log` to become available.
- Use `gh api` or GraphQL only when `gh` subcommands do not expose the data or mutation you need. Preserve command/API failures such as artifact-download
  authorization; they are evidence, not permission to guess.
- When command output is long, write it to `scratch/` and summarize the result.
- Treat this as a shared dependency for `check-ci`, `pr-analysis`, `push-pr`, and `push-my-prs`.
