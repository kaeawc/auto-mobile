---
name: push-pr
description: "Use this workflow skill to publish the current branch: validate local changes, commit, push, create or update one PR, and optionally enable automerge."
---

# Push PR

Use this when local work is ready to publish.

- Prefer `push-pr` for one branch or one PR.
- Prefer `push-my-prs` only when the user wants a batch loop across many PRs.

## Workflow

1. Inspect `git status --short`, `git diff --stat`, and recent commit style before drafting a commit.
2. Run the relevant validation before pushing.
3. Commit intentionally with a repository-appropriate message.
4. Push the current branch, setting upstream if needed.
5. If no PR exists, create one with `gh pr create` and a body file such as `scratch/pr-body.md`.
6. If a PR already exists, update it as needed with `gh pr edit`.
7. Enable automerge only when that matches the branch’s intended workflow.

## Repo Rules

- Use `github-cli`, `gh-pr-workflow`, and `validate` conventions.
- Never use destructive git commands.
- Do not skip validation unless the user explicitly accepts the risk.
- Prefer squash automerge unless the repo or existing PR says otherwise.
