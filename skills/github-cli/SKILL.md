---
name: github-cli
description: Helper skill for GitHub operations in this repo; use it when another workflow needs gh for PRs, issues, checks, logs, or repository metadata.
---

# GitHub CLI Usage

Use `gh` for GitHub work in this repo.

- Prefer `gh pr view`, `gh pr list`, `gh pr create`, and `gh pr edit` for pull requests.
- Prefer `gh issue list` and `gh issue view` for issues.
- Prefer `gh pr checks` and `gh run view` for CI status and logs.
- Use `gh api` or GraphQL only when `gh` subcommands do not expose the data or mutation you need.
- When command output is long, write it to `scratch/` and summarize the result.
- Treat this as a shared dependency for `check-ci`, `pr-analysis`, `push-pr`, and `push-my-prs`.
