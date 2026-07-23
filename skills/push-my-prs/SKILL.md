---
name: push-my-prs
description: Use this workflow skill to iterate through multiple open PRs authored by the current user, address feedback and CI issues, and push follow-up fixes across the set.
---

# Push My PRs

Iterate through your open PRs in the current repo and keep them moving.

- Prefer `push-pr` when the task is about the current branch or a single PR.
- Prefer `push-my-prs` only for batch PR maintenance.

## Workflow

1. Get the current GitHub user with `gh api user -q .login`.
2. List open PRs for that author with `gh pr list --author "$GH_USER" --state open`.
3. For each PR, gather CI status, mergeability, review verdicts, unresolved threads, and top-level comments.
4. Check out the PR branch, pull the latest changes, and address actionable feedback.
5. Reproduce CI failures locally with the lightest relevant validation.
6. Resolve review threads only when the underlying issue is actually addressed.
7. Commit and push only when there are real changes.
8. Re-enable automerge if appropriate.

## Repo Rules

- Use `github-cli`, `push-pr`, `check-ci`, and `validate` conventions.
- Prefer repo validations and scripts over ad hoc commands.
- Never force push unless a rebase made it necessary, and then use `--force-with-lease` only.
- Leave ambiguous comments unresolved and note them in the summary.
- Write logs or thread snapshots you need to keep under `scratch/`.
