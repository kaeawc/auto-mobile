---
name: push-pr
description: Canonical repo workflow for publishing one branch or PR: confirm scope, validate, commit, push, create or update the PR with preserved Markdown, and optionally enable automerge. Prefer this over generic publish skills such as github:yeet inside this repo.
---

# Push PR

Use this when local work is ready to publish. This is the canonical publish workflow for this repo and replaces the old `gh-pr-workflow` helper plus any generic `github:yeet` defaults.

- Prefer `push-pr` for one branch or one PR.
- Prefer `push-my-prs` only when the user wants a batch loop across many PRs.
- Use generic plugin publish skills only when this repo-local skill is unavailable.

## Workflow

1. Confirm scope before staging.
   - Inspect `git status --short`, `git diff --stat`, and recent commit style.
   - If the worktree contains unrelated or user-owned changes, stage only explicit paths that belong to the PR.
   - Use `git add -A` only when the whole worktree is confirmed in scope.
2. Determine the branch strategy.
   - Stay on the current branch when it is already a work branch.
   - If publishing from `main`, `master`, or the remote default branch, create a repo-appropriate `work/...` branch unless the user requested a different name.
3. Run the relevant validation before pushing.
   - Prefer repo scripts and documented validation commands.
   - Do not skip validation unless the user explicitly accepts that risk.
4. Commit intentionally with a repository-appropriate message.
   - Keep the commit message terse and descriptive.
   - Do not amend or rewrite unrelated commits unless the user explicitly asks.
5. Push the current branch, setting upstream if needed.
6. Create or update exactly one PR.
   - Prefer `gh pr view --json number,url` to detect an existing PR for the current branch.
   - If no PR exists, create one with `gh pr create`.
   - If a PR exists, update it with `gh pr edit` only when the title/body/base needs to change.
   - Use the GitHub app for PR creation only when the surrounding tool environment already provides it and the repository, base, and head can be resolved unambiguously; otherwise use `gh`.
7. Preserve PR body formatting.
   - Write multiline PR bodies to `scratch/pr-body.md` or another temporary body file.
   - Use `gh pr create --body-file scratch/pr-body.md` or `gh pr edit --body-file scratch/pr-body.md`.
   - Avoid `--body "..."` for multiline Markdown because shell quoting can mangle newlines.
8. Set PR readiness and automerge deliberately.
   - Default to a ready PR when the user asked to publish completed work.
   - Use a draft PR when the user asks for draft status or the work is intentionally incomplete.
   - Enable squash automerge only when that matches the branch's intended workflow and the PR is ready.
9. Summarize branch, commit, PR URL, validation, and any remaining risk.

## Repo Rules

- Use `github-cli` and `validate` conventions.
- Never use destructive git commands.
- Prefer squash automerge unless the repo or existing PR says otherwise.
- Do not create recurring automations, feedback monitors, reminders, or follow-up cron jobs as part of publishing unless the user explicitly asks for ongoing monitoring.

## PR Body Expectations

The PR body should use real Markdown prose and cover:

- what changed
- why it changed
- user or developer impact
- root cause when the PR is a fix
- checks used to validate it
